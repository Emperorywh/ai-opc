import { describe, expect, it } from 'vitest'
import {
  createMapLoadCoordinator,
  type MapLoadCoordinator,
} from '../src/features/agv-map/application/mapLoadCoordinator'
import type { MapCompilerPort } from '../src/features/agv-map/application/mapCompilerPort'
import type {
  CompileRequest,
  CompilationEvent,
} from '../src/features/agv-map/domain/compilerProtocol'
import type { RenderPacket } from '../src/features/agv-map/domain/renderPacket'
import { getOverlayDisplay } from '../src/features/agv-map/presentation/loadDisplay'

/**
 * 加载协调器验证（SPEC §5.1、§5.3、§5.4、§10.1、TASK-006）。
 *
 * 协调器是面向展示层的窄应用边界：展示层只提交外部事实（首帧成功、淡入完成、创建失败），
 * 由协调器翻译为状态机命令。会话控制器不离开应用层。全部用例在不启动浏览器/Worker 的
 * Node 环境运行，用一个实现 MapCompilerPort 的伪造端口注入编译事件。
 */

/** 构造一个结构合法的空渲染数据包。 */
function emptyPacket(): RenderPacket {
  return {
    nodeInstances: {
      node: { count: 0, matrices: new Float32Array(0) },
      work: { count: 0, matrices: new Float32Array(0) },
      charge: { count: 0, matrices: new Float32Array(0) },
      park: { count: 0, matrices: new Float32Array(0) },
    },
    pathGeometry: {
      positions: new Float32Array(0),
      normals: new Float32Array(0),
      pathU: new Float32Array(0),
      flowDirections: new Float32Array(0),
      indices: new Uint32Array(0),
      edgeVertexRanges: new Uint32Array(0),
    },
    renderBounds: { min: [0, 0, 0], max: [1, 1, 1] },
    report: { nodeCount: 0, edgeLaneCount: 0, bidirectionalGroupCount: 0, unpairedEdgeCount: 0 },
  }
}

/** 伪造编译端口：实现 MapCompilerPort，捕获监听器供测试主动 emit 事件并记录终止次数。 */
class FakeCompilerPort implements MapCompilerPort {
  listener: ((requestId: number, event: CompilationEvent) => void) | null = null
  lastRequest: CompileRequest | null = null
  terminateCount = 0

  start(
    request: CompileRequest,
    onEvent: (requestId: number, event: CompilationEvent) => void,
  ): void {
    this.lastRequest = request
    this.listener = onEvent
  }

  terminate(): void {
    // 与真实适配器一致幂等：已终止后不再重复计数。
    if (this.terminateCount > 0) return
    this.terminateCount += 1
  }

  /** 以给定 requestId 发射一条事件。 */
  emit(requestId: number, event: CompilationEvent): void {
    this.listener?.(requestId, event)
  }
}

/** 用伪造端口按阶段顺序发射一条完整成功事件流，推进到 preparing/creating-scene。 */
function emitSuccessStream(port: FakeCompilerPort, requestId: number, packet: RenderPacket): void {
  port.emit(requestId, { kind: 'download-progress', received: 6516343, total: 6516343 })
  port.emit(requestId, { kind: 'parse', stage: 'parse-start' })
  port.emit(requestId, { kind: 'parse', stage: 'parse-done' })
  port.emit(requestId, { kind: 'validate-progress', processed: 4813, total: 4813 })
  port.emit(requestId, { kind: 'compile-progress', report: { phase: 'nodes', processed: 1768, total: 1768 } })
  port.emit(requestId, { kind: 'compile-progress', report: { phase: 'paths', processed: 3045, total: 3045 } })
  port.emit(requestId, { kind: 'success', packet })
}

/** 启动协调器并推进到 preparing/creating-scene，返回端口、停止函数与 packet。 */
function setupAtCreatingScene(): {
  coordinator: MapLoadCoordinator
  port: FakeCompilerPort
  packet: RenderPacket
  stop: () => void
} {
  const coordinator = createMapLoadCoordinator()
  const port = new FakeCompilerPort()
  const stop = coordinator.start(port, 'fake://map.json')
  const packet = emptyPacket()
  emitSuccessStream(port, port.lastRequest!.requestId, packet)
  return { coordinator, port, packet, stop }
}

describe('协调器窄边界：不暴露会话控制器内部对象（SPEC §5.1、TASK-006）', () => {
  it('对外只暴露 subscribe/getState/scene/start，不泄露 apply/cancel/controller', () => {
    const coordinator = createMapLoadCoordinator()
    expect(Object.keys(coordinator).sort()).toEqual(['getState', 'scene', 'start', 'subscribe'])
    // 会话控制器的变更方法不得出现在窄边界上。
    expect(coordinator).not.toHaveProperty('apply')
    expect(coordinator).not.toHaveProperty('cancel')
    expect(coordinator).not.toHaveProperty('controller')
    expect(coordinator).not.toHaveProperty('getCurrentRequestId')
  })
})

describe('场景生命周期：提交外部事实驱动 creating-scene → fading → ready（SPEC §10.1）', () => {
  it('notifyFirstFrameRendered 把 creating-scene 推进到 fading', () => {
    const { coordinator } = setupAtCreatingScene()
    expect(coordinator.getState()).toMatchObject({ status: 'preparing', stage: 'creating-scene' })
    coordinator.scene.notifyFirstFrameRendered()
    expect(coordinator.getState()).toMatchObject({ status: 'preparing', stage: 'fading' })
  })

  it('notifyFadeComplete 把 fading 推进到 ready，携带同一数据包', () => {
    const { coordinator, packet } = setupAtCreatingScene()
    coordinator.scene.notifyFirstFrameRendered()
    coordinator.scene.notifyFadeComplete()
    const state = coordinator.getState()
    expect(state!.status).toBe('ready')
    if (state!.status !== 'ready') throw new Error('unreachable')
    expect(state!.packet).toBe(packet)
  })

  it('完整流程进度单调：download 0.30 → validate 0.40 → nodes 0.55 → paths 0.90', () => {
    const coordinator = createMapLoadCoordinator()
    const port = new FakeCompilerPort()
    coordinator.start(port, 'fake://map.json')
    const rid = port.lastRequest!.requestId

    port.emit(rid, { kind: 'download-progress', received: 6516343, total: 6516343 })
    expect(coordinator.getState()).toMatchObject({ progress: 0.3 })
    port.emit(rid, { kind: 'parse', stage: 'parse-start' })
    port.emit(rid, { kind: 'parse', stage: 'parse-done' })
    port.emit(rid, { kind: 'validate-progress', processed: 4813, total: 4813 })
    expect(coordinator.getState()).toMatchObject({ progress: 0.4 })
    port.emit(rid, { kind: 'compile-progress', report: { phase: 'nodes', processed: 1768, total: 1768 } })
    expect(coordinator.getState()).toMatchObject({ progress: 0.55 })
    port.emit(rid, { kind: 'compile-progress', report: { phase: 'paths', processed: 3045, total: 3045 } })
    expect(coordinator.getState()).toMatchObject({ progress: 0.9 })
  })
})

describe('场景创建失败：notifySceneCreateFailed 进入统一 error（SPEC §10.2）', () => {
  it('在 creating-scene 提交失败 → error(WEBGL_RESOURCE_FAILED)，保留阶段与详情', () => {
    const { coordinator } = setupAtCreatingScene()
    coordinator.scene.notifySceneCreateFailed({
      message: 'InstancedMesh 创建失败',
      details: ['max instances exceeded'],
    })
    const state = coordinator.getState()
    expect(state!.status).toBe('error')
    if (state!.status !== 'error') throw new Error('unreachable')
    expect(state!.error.code).toBe('WEBGL_RESOURCE_FAILED')
    expect(state!.error.stage).toBe('creating-scene')
    expect(state!.error.message).toBe('InstancedMesh 创建失败')
    expect(state!.error.details).toEqual(['max instances exceeded'])
  })

  it('未提供消息时使用错误码默认中文说明', () => {
    const { coordinator } = setupAtCreatingScene()
    coordinator.scene.notifySceneCreateFailed()
    const state = coordinator.getState()
    if (state!.status !== 'error') throw new Error('unreachable')
    expect(state!.error.message).toBe('场景资源创建失败')
    expect(state!.error.details).toEqual([])
  })

  it('fading 阶段提交失败 → error，stage 为 fading', () => {
    const { coordinator } = setupAtCreatingScene()
    coordinator.scene.notifyFirstFrameRendered()
    coordinator.scene.notifySceneCreateFailed({ details: ['framebuffer incomplete'] })
    const state = coordinator.getState()
    if (state!.status !== 'error') throw new Error('unreachable')
    expect(state!.error.stage).toBe('fading')
  })
})

describe('非法场景事实被拒绝，当前状态不变（SPEC §5.3、TASK-006）', () => {
  it('未进入 creating-scene 前提交首帧事实被拒绝', () => {
    const coordinator = createMapLoadCoordinator()
    const port = new FakeCompilerPort()
    coordinator.start(port, 'fake://map.json')
    expect(coordinator.getState()).toMatchObject({ stage: 'downloading' })
    coordinator.scene.notifyFirstFrameRendered()
    // downloading 不能跃迁到 fading，状态不变。
    expect(coordinator.getState()).toMatchObject({ stage: 'downloading' })
  })

  it('未进入 fading 前提交淡入完成被拒绝', () => {
    const { coordinator } = setupAtCreatingScene()
    // creating-scene 直接 complete 非法。
    coordinator.scene.notifyFadeComplete()
    expect(coordinator.getState()).toMatchObject({ stage: 'creating-scene' })
  })

  it('ready 终态后再提交事实被拒绝', () => {
    const { coordinator } = setupAtCreatingScene()
    coordinator.scene.notifyFirstFrameRendered()
    coordinator.scene.notifyFadeComplete()
    expect(coordinator.getState()!.status).toBe('ready')
    coordinator.scene.notifyFirstFrameRendered()
    coordinator.scene.notifyFadeComplete()
    expect(coordinator.getState()!.status).toBe('ready')
  })
})

describe('取消隔离：stop 取消会话后场景事实与旧事件不得覆盖状态（SPEC §5.4、TASK-006）', () => {
  it('stop 后首帧与淡入事实被会话隔离，状态冻结在 creating-scene', () => {
    const { coordinator, stop } = setupAtCreatingScene()
    expect(coordinator.getState()).toMatchObject({ stage: 'creating-scene' })
    stop()
    coordinator.scene.notifyFirstFrameRendered()
    expect(coordinator.getState()).toMatchObject({ stage: 'creating-scene' })
    coordinator.scene.notifyFadeComplete()
    expect(coordinator.getState()).toMatchObject({ stage: 'creating-scene' })
    expect(coordinator.getState()!.status).toBe('preparing')
  })

  it('stop 后 notifySceneCreateFailed 不再写入 error', () => {
    const { coordinator, stop } = setupAtCreatingScene()
    stop()
    coordinator.scene.notifySceneCreateFailed({ details: ['x'] })
    expect(coordinator.getState()).toMatchObject({ stage: 'creating-scene' })
    expect(coordinator.getState()!.status).toBe('preparing')
  })

  it('stop 后端口的后续成功事件被隔离（会话已取消）', () => {
    const { coordinator, port, stop } = setupAtCreatingScene()
    const rid = port.lastRequest!.requestId
    stop()
    // 端口虽已被 terminate，伪造端口仍可 emit；旧 requestId 会话已取消，事件被隔离。
    port.emit(rid, { kind: 'success', packet: emptyPacket() })
    expect(coordinator.getState()).toMatchObject({ stage: 'creating-scene' })
  })
})

describe('会话取代：新 start 使旧 requestId 失效（SPEC §5.4）', () => {
  it('两次 start 后，旧端口事件被隔离，只新会话可推进', () => {
    const coordinator = createMapLoadCoordinator()
    const oldPort = new FakeCompilerPort()
    coordinator.start(oldPort, 'fake://map.json')
    const oldRid = oldPort.lastRequest!.requestId
    // 旧端口报告完整下载进度。
    oldPort.emit(oldRid, { kind: 'download-progress', received: 6516343, total: 6516343 })
    expect(coordinator.getState()).toMatchObject({ progress: 0.3 })

    const newPort = new FakeCompilerPort()
    coordinator.start(newPort, 'fake://map.json')
    // 新 start 重置状态为 downloading/0。
    expect(coordinator.getState()).toMatchObject({ stage: 'downloading', progress: 0 })
    // 旧端口再发成功事件 → 过期，不影响新会话。
    oldPort.emit(oldRid, { kind: 'success', packet: emptyPacket() })
    expect(coordinator.getState()).toMatchObject({ stage: 'downloading' })
  })

  it('会话取代后场景事实作用于新会话，不沿用旧进度', () => {
    const coordinator = createMapLoadCoordinator()
    const oldPort = new FakeCompilerPort()
    coordinator.start(oldPort, 'fake://map.json')
    // 新会话启动前，旧会话已被取代；场景事实经当前 requestId 提交到新会话。
    const newPort = new FakeCompilerPort()
    coordinator.start(newPort, 'fake://map.json')
    expect(coordinator.getState()).toMatchObject({ stage: 'downloading' })
    // 新会话尚在 downloading，首帧事实应被拒绝（不能从 downloading 跃迁到 fading）。
    coordinator.scene.notifyFirstFrameRendered()
    expect(coordinator.getState()).toMatchObject({ stage: 'downloading' })
  })
})

describe('订阅与停止幂等（SPEC §5.4）', () => {
  it('subscribe 在状态变化时回调，取消后停止', () => {
    const coordinator = createMapLoadCoordinator()
    const port = new FakeCompilerPort()
    let calls = 0
    const unsubscribe = coordinator.subscribe(() => { calls += 1 })
    coordinator.start(port, 'fake://map.json')
    expect(calls).toBe(1)
    port.emit(port.lastRequest!.requestId, { kind: 'download-progress', received: 1, total: 10 })
    expect(calls).toBe(2)
    unsubscribe()
    port.emit(port.lastRequest!.requestId, { kind: 'download-progress', received: 2, total: 10 })
    expect(calls).toBe(2)
  })

  it('start 返回的停止函数幂等：多次调用不重复终止端口', () => {
    const coordinator = createMapLoadCoordinator()
    const port = new FakeCompilerPort()
    const stop = coordinator.start(port, 'fake://map.json')
    stop()
    stop()
    stop()
    expect(port.terminateCount).toBe(1)
  })

  it('多实例协调器互不干扰（无隐式全局状态）', () => {
    const a = createMapLoadCoordinator()
    const b = createMapLoadCoordinator()
    const portA = new FakeCompilerPort()
    a.start(portA, 'fake://map.json')
    expect(a.getState()).toMatchObject({ stage: 'downloading' })
    expect(b.getState()).toBeNull()
    // a 的端口事件不影响 b。
    portA.emit(portA.lastRequest!.requestId, { kind: 'download-progress', received: 10, total: 10 })
    expect(b.getState()).toBeNull()
  })
})

describe('终态封闭：终态后过期端口事件不改变状态与覆盖层（TASK-008）', () => {
  /**
   * TASK-008 终态路径验证：error 或 ready 后即使端口继续提交旧进度（requestId 仍匹配当前
   * 未取消会话），phase 镜像与状态机双重隔离使状态不回退，覆盖层展示恒保持终态——
   * ready 恒为空（场景保持露出），error 恒为错误展示（不回到加载态，不暴露半成品场景）。
   */
  it('ready 后过期 download-progress 被隔离，覆盖层恒为空', () => {
    const { coordinator, port } = setupAtCreatingScene()
    coordinator.scene.notifyFirstFrameRendered()
    coordinator.scene.notifyFadeComplete()
    expect(coordinator.getState()!.status).toBe('ready')
    expect(getOverlayDisplay(coordinator.getState())).toBe(null)

    // 过期 download-progress：requestId 仍匹配当前会话，但 phase 镜像已过 downloading，
    // 即便绕过镜像，ready 终态也拒绝 report-progress——状态与覆盖层均不变。
    port.emit(port.lastRequest!.requestId, { kind: 'download-progress', received: 1, total: 10 })
    expect(coordinator.getState()!.status).toBe('ready')
    expect(getOverlayDisplay(coordinator.getState())).toBe(null)
  })

  it('ready 后过期 success 被状态机拒绝，覆盖层恒为空', () => {
    const { coordinator, port, packet } = setupAtCreatingScene()
    coordinator.scene.notifyFirstFrameRendered()
    coordinator.scene.notifyFadeComplete()
    expect(getOverlayDisplay(coordinator.getState())).toBe(null)

    // 过期 success：attach-packet 仅在 compiling-paths 允许，ready 终态被状态机拒绝。
    port.emit(port.lastRequest!.requestId, { kind: 'success', packet })
    expect(coordinator.getState()!.status).toBe('ready')
    expect(getOverlayDisplay(coordinator.getState())).toBe(null)
  })

  it('error 后过期 download-progress 被隔离，覆盖层恒为错误展示', () => {
    const coordinator = createMapLoadCoordinator()
    const port = new FakeCompilerPort()
    coordinator.start(port, 'fake://map.json')
    const rid = port.lastRequest!.requestId
    // 下载阶段即失败 → error(ASSET_DOWNLOAD_FAILED, stage=downloading)。
    port.emit(rid, {
      kind: 'error',
      code: 'DOWNLOAD_FAILED',
      message: '网络中断',
      details: ['status 503'],
    })
    expect(coordinator.getState()!.status).toBe('error')
    expect(getOverlayDisplay(coordinator.getState())?.kind).toBe('error')

    // 过期 download-progress：phase 镜像仍为 downloading 会尝试 report-progress，
    // 但状态机拒绝在 error 终态上写入，状态与覆盖层恒为错误展示，不回到加载态。
    port.emit(rid, { kind: 'download-progress', received: 5, total: 10 })
    expect(coordinator.getState()!.status).toBe('error')
    expect(getOverlayDisplay(coordinator.getState())?.kind).toBe('error')
  })

  it('error 后过期 success 被状态机拒绝，覆盖层恒为错误展示', () => {
    const coordinator = createMapLoadCoordinator()
    const port = new FakeCompilerPort()
    coordinator.start(port, 'fake://map.json')
    const rid = port.lastRequest!.requestId
    port.emit(rid, {
      kind: 'error',
      code: 'DOWNLOAD_FAILED',
      message: '网络中断',
      details: ['status 503'],
    })
    expect(getOverlayDisplay(coordinator.getState())?.kind).toBe('error')

    // 过期 success：attach-packet 在 error 终态被状态机拒绝，不暴露半成品场景。
    port.emit(rid, { kind: 'success', packet: emptyPacket() })
    expect(coordinator.getState()!.status).toBe('error')
    expect(getOverlayDisplay(coordinator.getState())?.kind).toBe('error')
  })
})
