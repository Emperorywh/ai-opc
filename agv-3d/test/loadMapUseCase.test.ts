import { describe, expect, it } from 'vitest'
import { LoadSessionController } from '../src/features/agv-map/application/loadSession'
import { startBackgroundMapLoad } from '../src/features/agv-map/application/loadMapUseCase'
import type { MapCompilerPort } from '../src/features/agv-map/application/mapCompilerPort'
import type { RenderPacket } from '../src/features/agv-map/domain/renderPacket'
import type {
  CompileRequest,
  CompilationEvent,
} from '../src/features/agv-map/domain/compilerProtocol'

/**
 * 后台地图加载用例验证（SPEC §5.2、§5.3、§5.4、TASK-006/007）。
 *
 * 用例把后台编译事件流翻译为状态机命令。这里用一个实现 MapCompilerPort 端口的伪造客户端
 * 直接注入事件，在不启动 Worker 与浏览器的前提下验证：阶段顺序与进度单调、成功挂载数据包、
 * 错误映射、过期会话隔离与 dispose 取消/终止。用例只依赖端口抽象，伪造客户端印证该边界。
 */

/** 伪造编译客户端：实现应用层端口 MapCompilerPort，捕获监听器供测试主动 emit 事件并记录终止。 */
class FakeCompilerClient implements MapCompilerPort {
  listener: ((requestId: number, event: CompilationEvent) => void) | null = null
  lastRequest: CompileRequest | null = null
  terminateCount = 0

  start(request: CompileRequest, onEvent: (requestId: number, event: CompilationEvent) => void): void {
    this.lastRequest = request
    this.listener = onEvent
  }

  cancel(): void {
    this.terminate()
  }

  terminate(): void {
    // 与真实 MapCompilerClient.terminate 一致幂等：已终止后不再重复计数。
    if (this.terminateCount > 0) return
    this.terminateCount += 1
  }

  /** 以给定 requestId 发射一条事件。 */
  emit(requestId: number, event: CompilationEvent): void {
    this.listener?.(requestId, event)
  }

  get terminated(): boolean {
    return this.terminateCount > 0
  }
}

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

/** 用伪造客户端按阶段顺序发射一条完整成功事件流。 */
function emitSuccessStream(c: FakeCompilerClient, requestId: number, packet: RenderPacket): void {
  c.emit(requestId, { kind: 'download-progress', received: 6516343, total: 6516343 })
  c.emit(requestId, { kind: 'parse', stage: 'parse-start' })
  c.emit(requestId, { kind: 'parse', stage: 'parse-done' })
  c.emit(requestId, { kind: 'validate-progress', processed: 4813, total: 4813 })
  c.emit(requestId, { kind: 'compile-progress', report: { phase: 'nodes', processed: 1768, total: 1768 } })
  c.emit(requestId, { kind: 'compile-progress', report: { phase: 'paths', processed: 3045, total: 3045 } })
  c.emit(requestId, { kind: 'success', packet })
}

describe('成功路径：事件流驱动状态机到 preparing/creating-scene（SPEC §5.3、TASK-007）', () => {
  it('完整成功事件流后状态为 preparing/creating-scene 并携带 packet', () => {
    const controller = new LoadSessionController()
    const client = new FakeCompilerClient()
    const handle = startBackgroundMapLoad(controller, client, 'fake://map.json')
    const packet = emptyPacket()
    emitSuccessStream(client, handle.requestId, packet)

    const state = controller.getState()
    expect(state).toMatchObject({ status: 'preparing', stage: 'creating-scene' })
    if (state?.status !== 'preparing') throw new Error('unreachable')
    expect(state.packet).toBe(packet)
  })

  it('客户端收到带正确 requestId 的编译请求与资产 URL', () => {
    const controller = new LoadSessionController()
    const client = new FakeCompilerClient()
    const handle = startBackgroundMapLoad(controller, client, 'fake://map.json')
    expect(client.lastRequest).toEqual({
      type: 'compile',
      requestId: handle.requestId,
      assetUrl: 'fake://map.json',
    })
  })
})

describe('进度映射：各阶段按真实记录数映射到全局区间（SPEC §10.1）', () => {
  it('下载完成 → 0.30；校验完成 → 0.40；节点完成 → 0.55；路径完成 → 0.90', () => {
    const controller = new LoadSessionController()
    const client = new FakeCompilerClient()
    const handle = startBackgroundMapLoad(controller, client, 'fake://map.json')
    const rid = handle.requestId

    client.emit(rid, { kind: 'download-progress', received: 6516343, total: 6516343 })
    expect(controller.getState()).toMatchObject({ progress: 0.3 })

    client.emit(rid, { kind: 'parse', stage: 'parse-start' })
    client.emit(rid, { kind: 'parse', stage: 'parse-done' })
    client.emit(rid, { kind: 'validate-progress', processed: 4813, total: 4813 })
    expect(controller.getState()).toMatchObject({ progress: 0.4 })

    client.emit(rid, { kind: 'compile-progress', report: { phase: 'nodes', processed: 1768, total: 1768 } })
    expect(controller.getState()).toMatchObject({ progress: 0.55 })

    client.emit(rid, { kind: 'compile-progress', report: { phase: 'paths', processed: 3045, total: 3045 } })
    expect(controller.getState()).toMatchObject({ progress: 0.9 })
  })

  it('下载阶段中间进度按已读字节占比映射到 0%～30%', () => {
    const controller = new LoadSessionController()
    const client = new FakeCompilerClient()
    const handle = startBackgroundMapLoad(controller, client, 'fake://map.json')
    client.emit(handle.requestId, { kind: 'download-progress', received: 3258172, total: 6516343 })
    // 约一半 → 0.15（浮点容差吸收字节占比的舍入）。
    const state = controller.getState()
    expect(state && 'progress' in state ? state.progress : NaN).toBeCloseTo(0.15, 6)
  })

  it('全流程进度始终单调不下降', () => {
    const controller = new LoadSessionController()
    const client = new FakeCompilerClient()
    const handle = startBackgroundMapLoad(controller, client, 'fake://map.json')
    const rid = handle.requestId
    const log: number[] = []
    const record = () => {
      const s = controller.getState()
      if (s && 'progress' in s) log.push(s.progress)
    }
    client.emit(rid, { kind: 'download-progress', received: 2000000, total: 6516343 }); record()
    client.emit(rid, { kind: 'download-progress', received: 6516343, total: 6516343 }); record()
    client.emit(rid, { kind: 'parse', stage: 'parse-start' }); record()
    client.emit(rid, { kind: 'parse', stage: 'parse-done' }); record()
    client.emit(rid, { kind: 'validate-progress', processed: 2400, total: 4813 }); record()
    client.emit(rid, { kind: 'validate-progress', processed: 4813, total: 4813 }); record()
    client.emit(rid, { kind: 'compile-progress', report: { phase: 'nodes', processed: 800, total: 1768 } }); record()
    client.emit(rid, { kind: 'compile-progress', report: { phase: 'nodes', processed: 1768, total: 1768 } }); record()
    client.emit(rid, { kind: 'compile-progress', report: { phase: 'paths', processed: 1500, total: 3045 } }); record()
    client.emit(rid, { kind: 'compile-progress', report: { phase: 'paths', processed: 3045, total: 3045 } }); record()
    for (let i = 1; i < log.length; i += 1) {
      expect(log[i]).toBeGreaterThanOrEqual(log[i - 1] - 1e-9)
    }
  })
})

describe('错误映射：Worker 错误码稳定映射到状态机错误码（SPEC §10.2）', () => {
  it('DOWNLOAD_FAILED → ASSET_DOWNLOAD_FAILED', () => {
    const controller = new LoadSessionController()
    const client = new FakeCompilerClient()
    const handle = startBackgroundMapLoad(controller, client, 'fake://map.json')
    client.emit(handle.requestId, {
      kind: 'error',
      code: 'DOWNLOAD_FAILED',
      message: '网络中断',
      details: ['timeout'],
    })
    const state = controller.getState()
    expect(state?.status).toBe('error')
    if (state?.status !== 'error') throw new Error('unreachable')
    expect(state.error.code).toBe('ASSET_DOWNLOAD_FAILED')
    expect(state.error.message).toBe('网络中断')
    expect(state.error.details).toEqual(['timeout'])
  })

  it('INTEGRITY_FAILED → ASSET_INTEGRITY_FAILED，stage 为 downloading', () => {
    const controller = new LoadSessionController()
    const client = new FakeCompilerClient()
    const handle = startBackgroundMapLoad(controller, client, 'fake://map.json')
    client.emit(handle.requestId, {
      kind: 'error',
      code: 'INTEGRITY_FAILED',
      message: '指纹不符',
      details: [],
    })
    const state = controller.getState()
    if (state?.status !== 'error') throw new Error('unreachable')
    expect(state.error.code).toBe('ASSET_INTEGRITY_FAILED')
    expect(state.error.stage).toBe('downloading')
  })

  it('VALIDATION_FAILED → SCHEMA_VALIDATION_FAILED', () => {
    const controller = new LoadSessionController()
    const client = new FakeCompilerClient()
    const handle = startBackgroundMapLoad(controller, client, 'fake://map.json')
    // 推进到 validating 阶段后报校验失败，stage 应为 validating。
    client.emit(handle.requestId, { kind: 'parse', stage: 'parse-start' })
    client.emit(handle.requestId, { kind: 'parse', stage: 'parse-done' })
    client.emit(handle.requestId, {
      kind: 'error',
      code: 'VALIDATION_FAILED',
      message: '结构非法',
      details: ['nodes:x'],
    })
    const state = controller.getState()
    if (state?.status !== 'error') throw new Error('unreachable')
    expect(state.error.code).toBe('SCHEMA_VALIDATION_FAILED')
    expect(state.error.stage).toBe('validating')
  })

  it('COMPILE_FAILED → GEOMETRY_COMPILE_FAILED，推进到编译阶段后 stage 为编译阶段', () => {
    const controller = new LoadSessionController()
    const client = new FakeCompilerClient()
    const handle = startBackgroundMapLoad(controller, client, 'fake://map.json')
    const rid = handle.requestId
    // 真实流程：核心按顺序发出下载→解析→校验→（采样前的 processed=0 节点进度），
    // 状态机据此推进到 compiling-nodes；随后采样失败发出 COMPILE_FAILED。
    client.emit(rid, { kind: 'download-progress', received: 6516343, total: 6516343 })
    client.emit(rid, { kind: 'parse', stage: 'parse-start' })
    client.emit(rid, { kind: 'parse', stage: 'parse-done' })
    client.emit(rid, { kind: 'validate-progress', processed: 4813, total: 4813 })
    client.emit(rid, {
      kind: 'compile-progress',
      report: { phase: 'nodes', processed: 0, total: 1768 },
    })
    client.emit(rid, {
      kind: 'error',
      code: 'COMPILE_FAILED',
      message: '几何错误',
      details: [],
    })
    const state = controller.getState()
    if (state?.status !== 'error') throw new Error('unreachable')
    expect(state.error.code).toBe('GEOMETRY_COMPILE_FAILED')
    // 采样期几何失败时 stage 归属编译阶段，与错误码一致（SPEC §10.2、TASK-007）。
    expect(state.error.stage).toBe('compiling-nodes')
  })
})

describe('会话隔离：过期结果不得覆盖当前状态（SPEC §5.4、TASK-007）', () => {
  it('不匹配 requestId 的事件被忽略，状态不变', () => {
    const controller = new LoadSessionController()
    const client = new FakeCompilerClient()
    const handle = startBackgroundMapLoad(controller, client, 'fake://map.json')
    // 用错误的 requestId 发射成功事件。
    client.emit(handle.requestId + 999, { kind: 'success', packet: emptyPacket() })
    expect(controller.getState()).toMatchObject({ status: 'loading', stage: 'downloading' })
  })

  it('重复 start：旧句柄的后续事件被隔离，不覆盖新会话', () => {
    const controller = new LoadSessionController()
    const client = new FakeCompilerClient()
    const oldHandle = startBackgroundMapLoad(controller, client, 'fake://map.json')
    const newHandle = startBackgroundMapLoad(controller, client, 'fake://map.json')
    expect(newHandle.requestId).toBe(oldHandle.requestId + 1)
    // 旧 requestId 的成功事件不应影响新会话。
    client.emit(oldHandle.requestId, { kind: 'success', packet: emptyPacket() })
    expect(controller.getState()).toMatchObject({ status: 'loading', stage: 'downloading' })
  })
})

describe('dispose：取消会话并终止 Worker，后台执行单元归零（SPEC §5.4、TASK-007）', () => {
  it('dispose 后客户端被终止恰好一次', () => {
    const controller = new LoadSessionController()
    const client = new FakeCompilerClient()
    const handle = startBackgroundMapLoad(controller, client, 'fake://map.json')
    expect(client.terminated).toBe(false)
    handle.dispose()
    expect(client.terminated).toBe(true)
    expect(client.terminateCount).toBe(1)
  })

  it('dispose 后即使收到匹配 requestId 的成功事件也不再进入 ready', () => {
    const controller = new LoadSessionController()
    const client = new FakeCompilerClient()
    const handle = startBackgroundMapLoad(controller, client, 'fake://map.json')
    handle.dispose()
    client.emit(handle.requestId, { kind: 'success', packet: emptyPacket() })
    // 取消后会话冻结，不会进入 preparing/ready。
    expect(controller.getState()).toMatchObject({ status: 'loading', stage: 'downloading' })
    expect(controller.isActive(handle.requestId)).toBe(false)
  })

  it('dispose 幂等：多次调用不重复终止', () => {
    const controller = new LoadSessionController()
    const client = new FakeCompilerClient()
    const handle = startBackgroundMapLoad(controller, client, 'fake://map.json')
    handle.dispose()
    handle.dispose()
    handle.dispose()
    expect(client.terminateCount).toBe(1)
  })
})

describe('大块二进制零拷贝：success 事件携带的 packet 原样挂载（SPEC §5.4、TASK-007）', () => {
  it('attach 的 packet 与事件中的 packet 为同一引用（不复制）', () => {
    const controller = new LoadSessionController()
    const client = new FakeCompilerClient()
    const handle = startBackgroundMapLoad(controller, client, 'fake://map.json')
    const packet = emptyPacket()
    emitSuccessStream(client, handle.requestId, packet)
    const state = controller.getState()
    if (state?.status !== 'preparing') throw new Error('应进入 preparing')
    expect(state.packet).toBe(packet)
    // 节点矩阵与路径顶点缓冲同样为同一引用。
    expect(state.packet.nodeInstances.node.matrices).toBe(packet.nodeInstances.node.matrices)
    expect(state.packet.pathGeometry.positions).toBe(packet.pathGeometry.positions)
  })
})
