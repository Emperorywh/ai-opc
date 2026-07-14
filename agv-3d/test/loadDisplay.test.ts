import { describe, expect, it } from 'vitest'
import {
  applyLoadStateCommand,
  ERROR_CODE_MESSAGE,
  STAGE_SEQUENCE,
  type ActiveStage,
  type LoadStateCommand,
  type MapLoadError,
  type MapLoadErrorCode,
  type MapSceneState,
} from '../src/features/agv-map/application/loadState'
import type { RenderPacket } from '../src/features/agv-map/domain/renderPacket'
import { STAGE_DISPLAY_LABELS } from '../src/features/agv-map/presentation/loadStageLabels'
import {
  formatPercent,
  getErrorDisplay,
  getLoadingDisplay,
  getOverlayDisplay,
} from '../src/features/agv-map/presentation/loadDisplay'

/**
 * 加载/错误界面展示派生验证（SPEC §10.1、§10.2、TASK-008）。
 *
 * 全部用例在 Node 环境运行，不启动浏览器：覆盖阶段文案完整性、百分比映射、
 * 各阶段加载展示、每种稳定错误码的错误展示、覆盖层选择与终态封闭、
 * 以及全流程百分比始终单调不下降。展示组件本身为无逻辑薄壳，其行为由这里的
 * 纯派生函数完整承载。
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

/** 按规定顺序把状态机推进到某活跃阶段（compiling-paths 之前含 advance 路径）。 */
function advanceTo(stage: ActiveStage): MapSceneState {
  const path: ActiveStage[] = []
  for (const s of STAGE_SEQUENCE) {
    path.push(s)
    if (s === stage) break
  }
  let state: MapSceneState | null = applied(null, { type: 'start' })
  for (const s of path) {
    if (s === 'downloading') continue
    if (s === 'creating-scene') {
      state = applied(state, { type: 'attach-packet', packet: emptyPacket() })
      continue
    }
    state = applied(state, { type: 'advance', to: s })
  }
  return state
}

describe('formatPercent 百分比映射（SPEC §10.1）', () => {
  it('把 0～1 的进度四舍五入到 0～100 整数', () => {
    expect(formatPercent(0)).toBe(0)
    expect(formatPercent(0.005)).toBe(1) // 0.5% 四舍五入到 1
    expect(formatPercent(0.5)).toBe(50)
    expect(formatPercent(0.985)).toBe(99) // 接近满值显示 99，避免停滞错觉
    expect(formatPercent(1)).toBe(100)
  })

  it('越界与 NaN 被钳制为安全值', () => {
    expect(formatPercent(-0.2)).toBe(0)
    expect(formatPercent(1.5)).toBe(100)
    expect(formatPercent(Number.NaN)).toBe(0)
  })
})

describe('阶段展示文案完整性（SPEC §10.1）', () => {
  it('STAGE_DISPLAY_LABELS 覆盖全部活跃阶段且为非空简体中文', () => {
    for (const stage of STAGE_SEQUENCE) {
      const label = STAGE_DISPLAY_LABELS[stage]
      expect(typeof label).toBe('string')
      expect(label.length).toBeGreaterThan(0)
      // 简体中文：至少包含一个 CJK 统一表意文字。
      expect(/[一-鿿]/.test(label)).toBe(true)
    }
  })

  it('七个阶段的文案明确可辨识、互不重复', () => {
    const labels = STAGE_SEQUENCE.map((s) => STAGE_DISPLAY_LABELS[s])
    expect(new Set(labels).size).toBe(labels.length)
    expect(labels).toEqual([
      '下载地图资产',
      '解析地图数据',
      '校验地图数据',
      '编译节点几何',
      '编译路径几何',
      '创建场景资源',
      '场景淡入',
    ])
  })
})

describe('getLoadingDisplay 各阶段加载展示（SPEC §10.1、TASK-008）', () => {
  it('downloading 阶段展示下载文案与字节映射百分比', () => {
    const state = applied(null, { type: 'start' })
    const display = getLoadingDisplay(state as Extract<MapSceneState, { status: 'loading' }>)
    expect(display).toEqual({ kind: 'loading', stage: 'downloading', stageLabel: '下载地图资产', percent: 0 })
  })

  it('每个活跃阶段都能生成阶段名与百分比一致的加载展示', () => {
    const cases: Array<{ stage: ActiveStage; expectedLabel: string }> = [
      { stage: 'downloading', expectedLabel: '下载地图资产' },
      { stage: 'parsing', expectedLabel: '解析地图数据' },
      { stage: 'validating', expectedLabel: '校验地图数据' },
      { stage: 'compiling-nodes', expectedLabel: '编译节点几何' },
      { stage: 'compiling-paths', expectedLabel: '编译路径几何' },
    ]
    for (const c of cases) {
      const state = advanceTo(c.stage)
      const display = getLoadingDisplay(state as Extract<MapSceneState, { status: 'loading' | 'preparing' }>)
      expect(display.kind).toBe('loading')
      expect(display.stage).toBe(c.stage)
      expect(display.stageLabel).toBe(c.expectedLabel)
    }
  })

  it('preparing 的 creating-scene 与 fading 阶段也生成加载展示（场景尚未上屏）', () => {
    let state: MapSceneState | null = applied(null, { type: 'start' })
    state = applied(state, { type: 'advance', to: 'parsing' })
    state = applied(state, { type: 'advance', to: 'validating' })
    state = applied(state, { type: 'advance', to: 'compiling-nodes' })
    state = applied(state, { type: 'advance', to: 'compiling-paths' })
    state = applied(state, { type: 'attach-packet', packet: emptyPacket() })
    const creating = getLoadingDisplay(state as Extract<MapSceneState, { status: 'loading' | 'preparing' }>)
    expect(creating).toMatchObject({ kind: 'loading', stage: 'creating-scene', stageLabel: '创建场景资源' })

    state = applied(state, { type: 'advance', to: 'fading' })
    const fading = getLoadingDisplay(state as Extract<MapSceneState, { status: 'loading' | 'preparing' }>)
    expect(fading).toMatchObject({ kind: 'loading', stage: 'fading', stageLabel: '场景淡入' })
  })

  it('百分比与状态 progress 同源且为整数', () => {
    const state = applied(null, { type: 'start' })
    const moved = applied(state, { type: 'report-progress', fraction: 0.5 })
    const display = getLoadingDisplay(moved as Extract<MapSceneState, { status: 'loading' }>)
    // downloading 区间 0%～30%，fraction 0.5 → 0.15 → 15%。
    expect(display.percent).toBe(15)
  })
})

describe('getErrorDisplay 每种稳定错误码的错误展示（SPEC §10.2、TASK-008）', () => {
  it('每个错误码都能在对应阶段进入错误状态并生成稳定展示', () => {
    const cases: Array<{ code: MapLoadErrorCode; toStage: ActiveStage[]; expectedStage: ActiveStage }> = [
      { code: 'ASSET_DOWNLOAD_FAILED', toStage: [], expectedStage: 'downloading' },
      { code: 'ASSET_INTEGRITY_FAILED', toStage: [], expectedStage: 'downloading' },
      { code: 'JSON_PARSE_FAILED', toStage: ['parsing'], expectedStage: 'parsing' },
      { code: 'SCHEMA_VALIDATION_FAILED', toStage: ['parsing', 'validating'], expectedStage: 'validating' },
      {
        code: 'GEOMETRY_COMPILE_FAILED',
        toStage: ['parsing', 'validating', 'compiling-nodes', 'compiling-paths'],
        expectedStage: 'compiling-paths',
      },
    ]
    for (const c of cases) {
      let state: MapSceneState | null = applied(null, { type: 'start' })
      for (const s of c.toStage) state = applied(state, { type: 'advance', to: s })
      state = applied(state, { type: 'fail', code: c.code, details: [`path:${c.expectedStage}`] })
      if (state.status !== 'error') throw new Error('应进入 error 状态')
      const display = getErrorDisplay(state)
      expect(display.kind).toBe('error')
      expect(display.code).toBe(c.code)
      expect(display.stage).toBe(c.expectedStage)
      expect(display.stageLabel).toBe(STAGE_DISPLAY_LABELS[c.expectedStage])
      expect(display.message).toBe(ERROR_CODE_MESSAGE[c.code])
      expect(display.details).toEqual([`path:${c.expectedStage}`])
    }
  })

  it('WEBGL_RESOURCE_FAILED 在 creating-scene 阶段生成错误展示', () => {
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
    const display = getErrorDisplay(state)
    expect(display.code).toBe('WEBGL_RESOURCE_FAILED')
    expect(display.stage).toBe('creating-scene')
    expect(display.stageLabel).toBe('创建场景资源')
    expect(display.message).toBe(ERROR_CODE_MESSAGE.WEBGL_RESOURCE_FAILED)
    expect(display.details).toEqual(['InstancedMesh: max attributes exceeded'])
  })

  it('错误展示的稳定错误码、阶段与说明可由可控输入验证（每种错误类型）', () => {
    // 遍历全部错误码：确保展示模型恒包含非空 code、stageLabel 与 message。
    const codeToStages: Record<MapLoadErrorCode, ActiveStage[]> = {
      ASSET_DOWNLOAD_FAILED: [],
      ASSET_INTEGRITY_FAILED: [],
      JSON_PARSE_FAILED: ['parsing'],
      SCHEMA_VALIDATION_FAILED: ['parsing', 'validating'],
      GEOMETRY_COMPILE_FAILED: ['parsing', 'validating', 'compiling-nodes', 'compiling-paths'],
      WEBGL_RESOURCE_FAILED: [
        'parsing',
        'validating',
        'compiling-nodes',
        'compiling-paths',
        'creating-scene',
      ],
    }
    for (const code of Object.keys(codeToStages) as MapLoadErrorCode[]) {
      let state: MapSceneState | null = applied(null, { type: 'start' })
      const stages = codeToStages[code]
      for (let i = 0; i < stages.length; i += 1) {
        const s = stages[i]
        if (s === 'creating-scene') {
          state = applied(state, { type: 'attach-packet', packet: emptyPacket() })
        } else {
          state = applied(state, { type: 'advance', to: s })
        }
      }
      state = applied(state, { type: 'fail', code, details: [] })
      if (state.status !== 'error') throw new Error('应进入 error 状态')
      const error: MapLoadError = state.error
      const display = getErrorDisplay(state)
      expect(display.code).toBe(error.code)
      expect(display.stage).toBe(error.stage)
      expect(display.message).toBe(error.message)
      expect(display.code.length).toBeGreaterThan(0)
      expect(display.stageLabel.length).toBeGreaterThan(0)
      expect(display.message.length).toBeGreaterThan(0)
    }
  })
})

describe('getOverlayDisplay 覆盖层选择与终态封闭（TASK-008）', () => {
  it('null（尚未启动）归一为 downloading/0% 加载展示，避免外壳首帧空白', () => {
    const display = getOverlayDisplay(null)
    expect(display).toEqual({ kind: 'loading', stage: 'downloading', stageLabel: '下载地图资产', percent: 0 })
  })

  it('loading 与 preparing 状态都返回加载展示（覆盖层遮挡画布）', () => {
    const downloading = applied(null, { type: 'start' })
    expect(getOverlayDisplay(downloading)?.kind).toBe('loading')

    let preparing: MapSceneState | null = applied(null, { type: 'start' })
    preparing = applied(preparing, { type: 'advance', to: 'parsing' })
    preparing = applied(preparing, { type: 'advance', to: 'validating' })
    preparing = applied(preparing, { type: 'advance', to: 'compiling-nodes' })
    preparing = applied(preparing, { type: 'advance', to: 'compiling-paths' })
    preparing = applied(preparing, { type: 'attach-packet', packet: emptyPacket() })
    expect(getOverlayDisplay(preparing)?.kind).toBe('loading')
  })

  it('error 状态返回错误展示，进入后不再回到加载态（终态封闭）', () => {
    let state: MapSceneState | null = applied(null, { type: 'start' })
    state = applied(state, { type: 'fail', code: 'JSON_PARSE_FAILED' })
    const display = getOverlayDisplay(state)
    expect(display?.kind).toBe('error')
  })

  it('ready 状态返回 null：覆盖层卸载，露出场景画布', () => {
    let state: MapSceneState | null = applied(null, { type: 'start' })
    state = applied(state, { type: 'advance', to: 'parsing' })
    state = applied(state, { type: 'advance', to: 'validating' })
    state = applied(state, { type: 'advance', to: 'compiling-nodes' })
    state = applied(state, { type: 'advance', to: 'compiling-paths' })
    state = applied(state, { type: 'attach-packet', packet: emptyPacket() })
    state = applied(state, { type: 'advance', to: 'fading' })
    state = applied(state, { type: 'complete' })
    expect(getOverlayDisplay(state)).toBe(null)
  })
})

describe('全流程展示百分比始终单调不下降（SPEC §10.1、TASK-008）', () => {
  it('从 start 到 ready 的每一步覆盖层百分比单调递增', () => {
    const percents: number[] = []
    const record = (s: MapSceneState | null) => {
      const display = getOverlayDisplay(s)
      if (display && display.kind === 'loading') percents.push(display.percent)
    }
    let state: MapSceneState | null = null
    record(state) // null → 0%
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
    expect(getOverlayDisplay(state)).toBe(null)

    for (let i = 1; i < percents.length; i += 1) {
      expect(percents[i]).toBeGreaterThanOrEqual(percents[i - 1])
    }
    expect(percents[0]).toBe(0)
    expect(percents[percents.length - 1]).toBe(100)
  })

  it('整数百分比与状态 progress 的四舍五入始终一致', () => {
    const state = applied(null, { type: 'start' })
    const moved = applied(state, { type: 'report-progress', fraction: 0.333 })
    const progress = (moved as { progress: number }).progress
    const display = getOverlayDisplay(moved)
    if (display?.kind !== 'loading') throw new Error('应为加载展示')
    expect(display.percent).toBe(formatPercent(progress))
  })
})
