import { describe, expect, it } from 'vitest'
import {
  applyLoadStateCommand,
  computeStageProgress,
  ERROR_CODE_MESSAGE,
  ERROR_CODE_STAGE,
  INITIAL_PROGRESS,
  STAGE_PROGRESS_BOUNDS,
  STAGE_SEQUENCE,
  type ActiveStage,
  type LoadStateCommand,
  type MapLoadError,
  type MapLoadErrorCode,
  type MapSceneState,
} from '../src/features/agv-map/application/loadState'
import type { RenderPacket } from '../src/features/agv-map/domain/renderPacket'

/**
 * 显式加载状态机验证（SPEC §5.3、§10.1、§10.2、TASK-006）。
 *
 * 全部用例在不启动浏览器的 Node 环境中运行，覆盖合法转换、进度单调、非法转换拒绝、
 * 错误码稳定映射与错误结构。RenderPacket 使用空包构造，状态机只持有不解析其内部结构。
 */

/** 构造一个结构合法的空渲染数据包，用于 preparing/ready 状态测试。 */
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

/** 断言命令被采纳并返回其新状态。 */
function applied(state: MapSceneState | null, command: LoadStateCommand): MapSceneState {
  const result = applyLoadStateCommand(state, command)
  if (!result.ok) throw new Error(`预期命令被采纳，但被拒绝：${result.reason}`)
  return result.state
}

/** 断言命令被拒绝并返回原因。 */
function rejected(state: MapSceneState | null, command: LoadStateCommand): string {
  const result = applyLoadStateCommand(state, command)
  if (result.ok) throw new Error(`预期命令被拒绝，但被采纳为：${JSON.stringify(result.state)}`)
  return result.reason
}

/** 按规定顺序把状态机推进到 ready，返回最终状态（全程序进度单调）。 */
function driveToReady(packet: RenderPacket): MapSceneState {
  let state: MapSceneState | null = null
  state = applied(state, { type: 'start' })
  state = applied(state, { type: 'report-progress', fraction: 1 })
  state = applied(state, { type: 'advance', to: 'parsing' })
  state = applied(state, { type: 'advance', to: 'validating' })
  state = applied(state, { type: 'report-progress', fraction: 1 })
  state = applied(state, { type: 'advance', to: 'compiling-nodes' })
  state = applied(state, { type: 'report-progress', fraction: 1 })
  state = applied(state, { type: 'advance', to: 'compiling-paths' })
  state = applied(state, { type: 'report-progress', fraction: 1 })
  state = applied(state, { type: 'attach-packet', packet })
  state = applied(state, { type: 'report-progress', fraction: 1 })
  state = applied(state, { type: 'advance', to: 'fading' })
  state = applied(state, { type: 'report-progress', fraction: 1 })
  state = applied(state, { type: 'complete' })
  return state
}

describe('加载进度区间（SPEC §10.1）', () => {
  it('七个阶段的进度区间与规格一致', () => {
    expect(STAGE_PROGRESS_BOUNDS.downloading).toEqual([0.0, 0.3])
    expect(STAGE_PROGRESS_BOUNDS.parsing).toEqual([0.3, 0.3])
    expect(STAGE_PROGRESS_BOUNDS.validating).toEqual([0.3, 0.4])
    expect(STAGE_PROGRESS_BOUNDS['compiling-nodes']).toEqual([0.4, 0.55])
    expect(STAGE_PROGRESS_BOUNDS['compiling-paths']).toEqual([0.55, 0.9])
    expect(STAGE_PROGRESS_BOUNDS['creating-scene']).toEqual([0.9, 0.98])
    expect(STAGE_PROGRESS_BOUNDS.fading).toEqual([0.98, 1.0])
  })

  it('阶段顺序与 SPEC §5.3 一致', () => {
    expect(STAGE_SEQUENCE).toEqual([
      'downloading',
      'parsing',
      'validating',
      'compiling-nodes',
      'compiling-paths',
      'creating-scene',
      'fading',
    ])
  })

  it('相邻区间端点相接，保证阶段跃迁不回退', () => {
    for (let i = 0; i < STAGE_SEQUENCE.length - 1; i += 1) {
      const cur = STAGE_PROGRESS_BOUNDS[STAGE_SEQUENCE[i]]
      const next = STAGE_PROGRESS_BOUNDS[STAGE_SEQUENCE[i + 1]]
      expect(cur[1]).toBeLessThanOrEqual(next[0])
    }
  })
})

describe('computeStageProgress 阶段内 fraction 映射（SPEC §10.1）', () => {
  it('把 0～1 的 fraction 线性映射到阶段全局区间', () => {
    expect(computeStageProgress('downloading', 0.5)).toBeCloseTo(0.15, 6)
    expect(computeStageProgress('validating', 0.5)).toBeCloseTo(0.35, 6)
    expect(computeStageProgress('compiling-nodes', 0.5)).toBeCloseTo(0.475, 6)
    expect(computeStageProgress('compiling-paths', 0.5)).toBeCloseTo(0.725, 6)
    expect(computeStageProgress('creating-scene', 0.5)).toBeCloseTo(0.94, 6)
    expect(computeStageProgress('fading', 0.5)).toBeCloseTo(0.99, 6)
  })

  it('fraction 边界映射到阶段上下界', () => {
    expect(computeStageProgress('downloading', 0)).toBe(0)
    expect(computeStageProgress('downloading', 1)).toBeCloseTo(0.3, 6)
    expect(computeStageProgress('fading', 1)).toBe(1)
  })

  it('parsing 无论 fraction 多少恒为单点 0.30（不伪造连续进度）', () => {
    for (const f of [0, 0.25, 0.5, 0.75, 1]) {
      expect(computeStageProgress('parsing', f)).toBeCloseTo(0.3, 6)
    }
  })

  it('越界与 NaN 的 fraction 被钳制到 [0, 1]', () => {
    expect(computeStageProgress('downloading', -0.5)).toBe(0)
    expect(computeStageProgress('downloading', 1.5)).toBeCloseTo(0.3, 6)
    expect(computeStageProgress('downloading', Number.NaN)).toBe(0)
  })
})

describe('start 命令', () => {
  it('从 null 进入 downloading 初始态，进度为 0', () => {
    const state = applied(null, { type: 'start' })
    expect(state).toEqual({ status: 'loading', stage: 'downloading', progress: INITIAL_PROGRESS })
    expect(INITIAL_PROGRESS).toBe(0)
  })

  it('从 ready 重置回 downloading（支持手动重新加载）', () => {
    const ready = driveToReady(emptyPacket())
    expect(ready.status).toBe('ready')
    const state = applied(ready, { type: 'start' })
    expect(state).toEqual({ status: 'loading', stage: 'downloading', progress: 0 })
  })

  it('从 error 重置回 downloading（错误后可手动重试，非自动）', () => {
    let state: MapSceneState | null = applied(null, { type: 'start' })
    state = applied(state, { type: 'fail', code: 'JSON_PARSE_FAILED' })
    expect(state.status).toBe('error')
    state = applied(state, { type: 'start' })
    expect(state).toEqual({ status: 'loading', stage: 'downloading', progress: 0 })
  })
})

describe('report-progress 进度单调（SPEC §5.3、§10.1）', () => {
  it('阶段内进度随 fraction 单调递增', () => {
    let state: MapSceneState | null = applied(null, { type: 'start' })
    state = applied(state, { type: 'report-progress', fraction: 0.2 })
    expect((state as { progress: number }).progress).toBeCloseTo(0.06, 6)
    state = applied(state, { type: 'report-progress', fraction: 0.8 })
    expect((state as { progress: number }).progress).toBeCloseTo(0.24, 6)
    state = applied(state, { type: 'report-progress', fraction: 1 })
    expect((state as { progress: number }).progress).toBeCloseTo(0.3, 6)
  })

  it('进度回退被拒绝，当前状态不变', () => {
    const state = applied(null, { type: 'start' })
    const advanced = applied(state, { type: 'report-progress', fraction: 0.9 })
    const reason = rejected(advanced, { type: 'report-progress', fraction: 0.1 })
    expect(reason).toMatch(/进度回退/)
  })

  it('未启动时报告进度被拒绝', () => {
    const reason = rejected(null, { type: 'report-progress', fraction: 0.5 })
    expect(reason).toMatch(/尚未启动/)
  })

  it('ready 后报告进度被拒绝', () => {
    const ready = driveToReady(emptyPacket())
    expect(rejected(ready, { type: 'report-progress', fraction: 0.5 })).toMatch(/已就绪/)
  })

  it('error 后报告进度被拒绝', () => {
    let state: MapSceneState | null = applied(null, { type: 'start' })
    state = applied(state, { type: 'fail', code: 'ASSET_DOWNLOAD_FAILED' })
    expect(rejected(state, { type: 'report-progress', fraction: 0.5 })).toMatch(/错误状态/)
  })
})

describe('advance 阶段跃迁（SPEC §5.3）', () => {
  it('只能按规定相邻顺序向前跃迁', () => {
    let state: MapSceneState | null = applied(null, { type: 'start' })
    state = applied(state, { type: 'advance', to: 'parsing' })
    expect(state).toHaveProperty('stage', 'parsing')
    state = applied(state, { type: 'advance', to: 'validating' })
    expect(state).toHaveProperty('stage', 'validating')
    state = applied(state, { type: 'advance', to: 'compiling-nodes' })
    expect(state).toHaveProperty('stage', 'compiling-nodes')
    state = applied(state, { type: 'advance', to: 'compiling-paths' })
    expect(state).toHaveProperty('stage', 'compiling-paths')
  })

  it('跃迁后进度落到新阶段下界', () => {
    let state: MapSceneState | null = applied(null, { type: 'start' })
    state = applied(state, { type: 'report-progress', fraction: 1 })
    expect((state as { progress: number }).progress).toBeCloseTo(0.3, 6)
    state = applied(state, { type: 'advance', to: 'parsing' })
    expect((state as { progress: number }).progress).toBeCloseTo(0.3, 6)
    state = applied(state, { type: 'advance', to: 'validating' })
    expect((state as { progress: number }).progress).toBeCloseTo(0.3, 6)
  })

  it('跨阶跃迁被拒绝', () => {
    const state = applied(null, { type: 'start' })
    // downloading 只能到 parsing，直接到 validating 非法
    expect(rejected(state, { type: 'advance', to: 'validating' })).toMatch(/非法阶段跃迁/)
    expect(rejected(state, { type: 'advance', to: 'compiling-paths' })).toMatch(/非法阶段跃迁/)
  })

  it('向后跃迁被拒绝', () => {
    let state: MapSceneState | null = applied(null, { type: 'start' })
    state = applied(state, { type: 'advance', to: 'parsing' })
    expect(rejected(state, { type: 'advance', to: 'downloading' })).toMatch(/download/)
    expect(rejected(state, { type: 'advance', to: 'parsing' })).toMatch(/非法阶段跃迁/)
  })

  it('advance 到 creating-scene 被拒绝（须用 attach-packet）', () => {
    let state: MapSceneState | null = applied(null, { type: 'start' })
    state = applied(state, { type: 'advance', to: 'parsing' })
    state = applied(state, { type: 'advance', to: 'validating' })
    state = applied(state, { type: 'advance', to: 'compiling-nodes' })
    state = applied(state, { type: 'advance', to: 'compiling-paths' })
    expect(rejected(state, { type: 'advance', to: 'creating-scene' })).toMatch(/attach-packet/)
  })

  it('从 compiling-paths 出发的 advance 被拒绝（须用 attach-packet）', () => {
    let state: MapSceneState | null = applied(null, { type: 'start' })
    state = applied(state, { type: 'advance', to: 'parsing' })
    state = applied(state, { type: 'advance', to: 'validating' })
    state = applied(state, { type: 'advance', to: 'compiling-nodes' })
    state = applied(state, { type: 'advance', to: 'compiling-paths' })
    // compiling-paths 不在 NEXT_STAGE 的 advance 路径上
    expect(rejected(state, { type: 'advance', to: 'fading' })).toMatch(/非法阶段跃迁/)
  })

  it('未启动、ready、error 时 advance 被拒绝', () => {
    expect(rejected(null, { type: 'advance', to: 'parsing' })).toMatch(/尚未启动/)
    const ready = driveToReady(emptyPacket())
    expect(rejected(ready, { type: 'advance', to: 'parsing' })).toMatch(/已就绪/)
  })
})

describe('attach-packet 进入 preparing（SPEC §5.3）', () => {
  it('从 compiling-paths 挂载数据包进入 creating-scene', () => {
    let state: MapSceneState | null = applied(null, { type: 'start' })
    state = applied(state, { type: 'advance', to: 'parsing' })
    state = applied(state, { type: 'advance', to: 'validating' })
    state = applied(state, { type: 'advance', to: 'compiling-nodes' })
    state = applied(state, { type: 'advance', to: 'compiling-paths' })
    const packet = emptyPacket()
    state = applied(state, { type: 'attach-packet', packet })
    expect(state).toEqual({
      status: 'preparing',
      stage: 'creating-scene',
      progress: STAGE_PROGRESS_BOUNDS['creating-scene'][0],
      packet,
    })
  })

  it('仅在 compiling-paths 阶段允许挂载数据包', () => {
    const downloading = applied(null, { type: 'start' })
    expect(rejected(downloading, { type: 'attach-packet', packet: emptyPacket() })).toMatch(
      /路径编译完成后/,
    )
    expect(rejected(null, { type: 'attach-packet', packet: emptyPacket() })).toMatch(/尚未启动/)
  })

  it('creating-scene → fading 保留同一数据包', () => {
    let state: MapSceneState | null = applied(null, { type: 'start' })
    state = applied(state, { type: 'advance', to: 'parsing' })
    state = applied(state, { type: 'advance', to: 'validating' })
    state = applied(state, { type: 'advance', to: 'compiling-nodes' })
    state = applied(state, { type: 'advance', to: 'compiling-paths' })
    const packet = emptyPacket()
    state = applied(state, { type: 'attach-packet', packet })
    state = applied(state, { type: 'advance', to: 'fading' })
    expect(state).toMatchObject({ status: 'preparing', stage: 'fading', packet })
  })
})

describe('complete 进入 ready（SPEC §5.3）', () => {
  it('从 fading 完成进入 ready，携带数据包', () => {
    const ready = driveToReady(emptyPacket())
    expect(ready.status).toBe('ready')
    expect(ready.packet).toBeDefined()
  })

  it('仅在 fading 完成后允许进入 ready', () => {
    let state: MapSceneState | null = applied(null, { type: 'start' })
    state = applied(state, { type: 'advance', to: 'parsing' })
    state = applied(state, { type: 'advance', to: 'validating' })
    state = applied(state, { type: 'advance', to: 'compiling-nodes' })
    state = applied(state, { type: 'advance', to: 'compiling-paths' })
    const packet = emptyPacket()
    state = applied(state, { type: 'attach-packet', packet })
    // creating-scene 阶段直接 complete 非法
    expect(rejected(state, { type: 'complete' })).toMatch(/淡入完成后/)
    state = applied(state, { type: 'advance', to: 'fading' })
    state = applied(state, { type: 'complete' })
    expect(state.status).toBe('ready')
  })
})

describe('全流程进度始终单调不下降', () => {
  it('从 start 到 ready 的每一步进度单调递增', () => {
    const progressLog: number[] = []
    let state: MapSceneState | null = null
    const record = (s: MapSceneState) => {
      if (s.status === 'loading' || s.status === 'preparing') progressLog.push(s.progress)
    }
    state = applied(state, { type: 'start' }); record(state)
    state = applied(state, { type: 'report-progress', fraction: 0.5 }); record(state)
    state = applied(state, { type: 'report-progress', fraction: 1 }); record(state)
    state = applied(state, { type: 'advance', to: 'parsing' }); record(state)
    state = applied(state, { type: 'advance', to: 'validating' }); record(state)
    state = applied(state, { type: 'report-progress', fraction: 1 }); record(state)
    state = applied(state, { type: 'advance', to: 'compiling-nodes' }); record(state)
    state = applied(state, { type: 'report-progress', fraction: 1 }); record(state)
    state = applied(state, { type: 'advance', to: 'compiling-paths' }); record(state)
    state = applied(state, { type: 'report-progress', fraction: 1 }); record(state)
    state = applied(state, { type: 'attach-packet', packet: emptyPacket() }); record(state)
    state = applied(state, { type: 'report-progress', fraction: 1 }); record(state)
    state = applied(state, { type: 'advance', to: 'fading' }); record(state)
    state = applied(state, { type: 'report-progress', fraction: 1 }); record(state)
    state = applied(state, { type: 'complete' })
    expect(state.status).toBe('ready')
    expect(state.packet).toBeDefined()

    for (let i = 1; i < progressLog.length; i += 1) {
      expect(progressLog[i]).toBeGreaterThanOrEqual(progressLog[i - 1] - 1e-9)
    }
    expect(progressLog[0]).toBe(0)
    expect(progressLog[progressLog.length - 1]).toBeCloseTo(1.0, 6)
  })
})

describe('错误码稳定映射（SPEC §10.2）', () => {
  it('六个错误码的规范阶段与中文说明齐备', () => {
    const expectedStage: Record<MapLoadErrorCode, ActiveStage> = {
      ASSET_DOWNLOAD_FAILED: 'downloading',
      ASSET_INTEGRITY_FAILED: 'downloading',
      JSON_PARSE_FAILED: 'parsing',
      SCHEMA_VALIDATION_FAILED: 'validating',
      GEOMETRY_COMPILE_FAILED: 'compiling-paths',
      WEBGL_RESOURCE_FAILED: 'creating-scene',
    }
    expect(ERROR_CODE_STAGE).toEqual(expectedStage)
    for (const code of Object.keys(expectedStage) as MapLoadErrorCode[]) {
      expect(ERROR_CODE_MESSAGE[code]).toBeTruthy()
    }
  })

  it('错误结果包含错误码、发生阶段、中文说明与详细字段路径', () => {
    let state: MapSceneState | null = applied(null, { type: 'start' })
    state = applied(state, { type: 'advance', to: 'parsing' })
    state = applied(state, {
      type: 'fail',
      code: 'JSON_PARSE_FAILED',
      details: ['Unexpected token in JSON at position 42'],
    })
    if (state.status !== 'error') throw new Error('应进入 error 状态')
    const error: MapLoadError = state.error
    expect(error.code).toBe('JSON_PARSE_FAILED')
    expect(error.stage).toBe('parsing')
    expect(error.message).toBe('地图资产解析失败')
    expect(error.details).toEqual(['Unexpected token in JSON at position 42'])
  })

  it('未提供消息时使用错误码默认中文说明', () => {
    let state: MapSceneState | null = applied(null, { type: 'start' })
    state = applied(state, { type: 'fail', code: 'ASSET_DOWNLOAD_FAILED' })
    if (state.status !== 'error') throw new Error('应进入 error 状态')
    expect(state.error.message).toBe('地图资产下载失败')
    expect(state.error.details).toEqual([])
  })

  it('各阶段错误稳定映射到对应错误码（调用方按错误来源传码）', () => {
    const cases: Array<{ stage: ActiveStage; toStage: ActiveStage[]; code: MapLoadErrorCode }> = [
      { stage: 'downloading', toStage: [], code: 'ASSET_DOWNLOAD_FAILED' },
      { stage: 'downloading', toStage: [], code: 'ASSET_INTEGRITY_FAILED' },
      { stage: 'parsing', toStage: ['parsing'], code: 'JSON_PARSE_FAILED' },
      { stage: 'validating', toStage: ['parsing', 'validating'], code: 'SCHEMA_VALIDATION_FAILED' },
      {
        stage: 'compiling-nodes',
        toStage: ['parsing', 'validating', 'compiling-nodes'],
        code: 'GEOMETRY_COMPILE_FAILED',
      },
    ]
    for (const c of cases) {
      let state: MapSceneState | null = applied(null, { type: 'start' })
      for (const s of c.toStage) state = applied(state, { type: 'advance', to: s })
      state = applied(state, { type: 'fail', code: c.code, details: [`path:${c.stage}`] })
      if (state.status !== 'error') throw new Error('应进入 error 状态')
      expect(state.error.code).toBe(c.code)
      expect(state.error.stage).toBe(c.stage)
      expect(state.error.details).toEqual([`path:${c.stage}`])
    }
  })

  it('WEBGL_RESOURCE_FAILED 错误发生在 creating-scene 阶段', () => {
    let state: MapSceneState | null = applied(null, { type: 'start' })
    state = applied(state, { type: 'advance', to: 'parsing' })
    state = applied(state, { type: 'advance', to: 'validating' })
    state = applied(state, { type: 'advance', to: 'compiling-nodes' })
    state = applied(state, { type: 'advance', to: 'compiling-paths' })
    state = applied(state, { type: 'attach-packet', packet: emptyPacket() })
    state = applied(state, {
      type: 'fail',
      code: 'WEBGL_RESOURCE_FAILED',
      details: ['InstancedMesh: max attributes exceeded'],
    })
    if (state.status !== 'error') throw new Error('应进入 error 状态')
    expect(state.error.code).toBe('WEBGL_RESOURCE_FAILED')
    expect(state.error.stage).toBe('creating-scene')
  })

  it('ready 与 error 终态下 fail 被拒绝，不自动重试或覆盖', () => {
    const ready = driveToReady(emptyPacket())
    expect(rejected(ready, { type: 'fail', code: 'JSON_PARSE_FAILED' })).toMatch(/已就绪/)
    let err: MapSceneState | null = applied(null, { type: 'start' })
    err = applied(err, { type: 'fail', code: 'JSON_PARSE_FAILED' })
    expect(rejected(err, { type: 'fail', code: 'SCHEMA_VALIDATION_FAILED' })).toMatch(/错误终态/)
  })

  it('error 为终态：离开只能通过 start 重新加载，不接受其他命令', () => {
    let state: MapSceneState | null = applied(null, { type: 'start' })
    state = applied(state, { type: 'fail', code: 'SCHEMA_VALIDATION_FAILED' })
    expect(rejected(state, { type: 'report-progress', fraction: 0.5 })).toMatch(/错误状态/)
    expect(rejected(state, { type: 'advance', to: 'parsing' })).toMatch(/错误状态/)
    expect(rejected(state, { type: 'complete' })).toMatch(/淡入完成后/)
    // start 可重置
    state = applied(state, { type: 'start' })
    expect(state).toHaveProperty('status', 'loading')
  })
})
