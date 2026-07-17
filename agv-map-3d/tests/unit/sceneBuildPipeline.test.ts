/*
 * 场景构建 worker 管线自动化验证（TASK-013，SPEC 3.1 / 4.1 / 4.2 / 4.3 / 5 / 14.1 / 15.1～15.3）。
 *
 * 设计：
 *   - 依赖注入驱动：把 fetch / send / now 注入 runSceneBuild，在 node 环境完整验证
 *     消息顺序、请求关联、阶段名、缓冲区转移与失败原子性，不启动浏览器或 Web Worker。
 *   - 正常路径：真实样本与最小合成样本经管线产出 loading → preparing(parsing/validating/
 *     building) → success 消息，requestId 贯穿；成功 model 通过 TASK-012 全部计数与有限性断言。
 *   - 转移所有权：success 消息 transfer list 覆盖 8 个唯一 ArrayBuffer；用 structuredClone
 *     真实转移后，worker 侧 typed array 已分离（byteLength 归零），证明转移后不再访问。
 *   - 关键异常：非 2xx、网络失败、响应体不可读、非法 JSON、提取路径错误、实体非法、
 *     source bounds 退化、轨迹组异常 → 对应稳定错误码与 failureStage，不产生 success 或部分 model。
 *
 * 不启动浏览器：所有验证经依赖注入在 node 完成；不创建 Worker、不接触网络、不接触 WebGL。
 */
import { describe, test, expect, beforeAll } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { MessageChannel } from 'node:worker_threads'
import { runSceneBuild } from '../../src/workers/sceneBuildPipeline'
import type {
  SceneBuildDeps,
  SceneBuildFetchResponse,
} from '../../src/workers/sceneBuildPipeline'
import {
  SCENE_BUILD_PHASE,
  SCENE_BUILD_STAGE,
} from '../../src/workers/sceneBuildProtocol'
import type {
  SceneBuildFailure,
  SceneBuildFailureStage,
  SceneBuildMessage,
  SceneBuildPhase,
  SceneBuildProgress,
  SceneBuildSuccess,
} from '../../src/workers/sceneBuildProtocol'
import { MapErrorCode } from '../../src/domain/mapDataError'
import {
  collectTransferableBuffers,
  validateSceneModel,
} from '../../src/workers/buildSceneModel'
import { SAMPLE_RUNTIME_URL } from '../../src/workers/sampleSource'
import {
  SAMPLE_EDGE_COUNTS,
  SAMPLE_NODE_COUNTS,
  SAMPLE_TRACK_COUNTS,
} from '../fixture/sampleBaseline'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '..', '..')
const REAL_SAMPLE = resolve(root, 'data', 'sampleMap.json')

// ─── 测试基础设施（依赖注入 helpers）─────────────────────────────────────────

/*
 * 捕获 send 调用：记录全部消息及其 transfer list，供测试断言顺序、关联与转移。
 */
interface Captured {
  readonly messages: SceneBuildMessage[]
  readonly transfers: Array<readonly ArrayBuffer[] | undefined>
}

function capturingSink(captured: Captured): SceneBuildDeps['send'] {
  return (message, transfer) => {
    captured.messages.push(message)
    captured.transfers.push(transfer)
  }
}

/*
 * 单步递增时钟：每次调用 +1，使各阶段耗时为正且可预测，避免依赖真实时间。
 */
function makeStepClock(): () => number {
  let t = 0
  return () => (t += 1)
}

/*
 * 从固定文本构造模拟 fetch 响应；status 用于构造非 2xx 用例。
 */
function fetchFromText(
  text: string,
  status = 200,
): (url: string) => Promise<SceneBuildFetchResponse> {
  return () =>
    Promise.resolve({
      ok: status >= 200 && status < 300,
      status,
      text: () => Promise.resolve(text),
    })
}

/*
 * 从 JS 对象构造模拟 fetch 响应（自动 JSON.stringify）。
 */
function fetchFromObject(
  obj: unknown,
  status = 200,
): (url: string) => Promise<SceneBuildFetchResponse> {
  return fetchFromText(JSON.stringify(obj), status)
}

/*
 * 驱动一次完整管线：注入指定 fetch 实现，捕获全部消息，返回 Captured。
 * requestId 默认 1；URL 固定为唯一运行时 SAMPLE_RUNTIME_URL（SPEC 3.1）。
 */
async function runBuild(
  fetch: (url: string) => Promise<SceneBuildFetchResponse>,
  requestId = 1,
): Promise<Captured> {
  const captured: Captured = { messages: [], transfers: [] }
  const deps: SceneBuildDeps = {
    fetch,
    send: capturingSink(captured),
    now: makeStepClock(),
  }
  await runSceneBuild({ requestId }, SAMPLE_RUNTIME_URL, deps)
  return captured
}

/*
 * 断言恰好一条失败消息，匹配 code / failureStage（可选 phase），
 * 且消息序列不含 success（失败原子性，SPEC 16）。
 */
function expectFailure(
  captured: Captured,
  expected: {
    readonly code: MapErrorCode
    readonly failureStage: SceneBuildFailureStage
    readonly phase?: SceneBuildPhase
  },
): SceneBuildFailure {
  const failures = captured.messages.filter(
    (m): m is SceneBuildFailure => m.type === 'failure',
  )
  expect(failures, '应恰好一条失败消息').toHaveLength(1)
  const f = failures[0]
  expect(f.code).toBe(expected.code)
  expect(f.failureStage).toBe(expected.failureStage)
  if (expected.phase !== undefined) {
    expect(f.phase).toBe(expected.phase)
  }
  // 中文消息非空：失败消息必须面向 overlay 可读（SPEC 14.1 / 任务约束）。
  expect(typeof f.message === 'string' && f.message.length > 0).toBe(true)
  // 失败原子性：不产生 success 或部分 model。
  expect(
    captured.messages.some((m) => m.type === 'success'),
    '失败路径不得产生 success 消息',
  ).toBe(false)
  return f
}

// ─── 合成响应包构造（SPEC 5.1 字段形态）──────────────────────────────────────

/*
 * 合成节点：默认 work 节点位于原点（有 angle，会产生节点箭头）。
 */
interface SyntheticNode {
  readonly id: string
  readonly name: string
  readonly type: 'node' | 'work' | 'park' | 'charge'
  readonly mapId: string
  readonly x: number
  readonly y: number
  readonly angle: number | null
}

/*
 * 合成直线边：默认 (0,0)→(4,0)。
 */
interface SyntheticLineEdge {
  readonly id: string
  readonly name: string
  readonly mapId: string
  readonly snodeId: string
  readonly enodeId: string
  readonly sx: number
  readonly sy: number
  readonly ex: number
  readonly ey: number
  readonly isBackEdge: boolean
  readonly edgeType: 'LINE'
  readonly cx: null
  readonly cy: null
  readonly dx: null
  readonly dy: null
}

const SYNTH_MAP_ID = 'synth-map'

const defaultNodes: readonly SyntheticNode[] = [
  { id: 'n1', name: 'n1', type: 'work', mapId: SYNTH_MAP_ID, x: 0, y: 0, angle: 0 },
  { id: 'n2', name: 'n2', type: 'node', mapId: SYNTH_MAP_ID, x: 4, y: 0, angle: null },
]

const defaultEdges: readonly SyntheticLineEdge[] = [
  {
    id: 'e1',
    name: '1',
    mapId: SYNTH_MAP_ID,
    snodeId: 'n1',
    enodeId: 'n2',
    sx: 0,
    sy: 0,
    ex: 4,
    ey: 0,
    isBackEdge: false,
    edgeType: 'LINE',
    cx: null,
    cy: null,
    dx: null,
    dy: null,
  },
]

/*
 * 构造合法合成响应包对象；允许局部覆写 data / mapJson / nodes / edges，
 * 便于在其上构造各类异常用例（SPEC 5.1 / 5.3）。
 */
function validEnvelopeObject(overrides?: {
  readonly data?: unknown
  readonly mapJson?: unknown
  readonly nodes?: readonly SyntheticNode[]
  readonly edges?: readonly SyntheticLineEdge[]
}): unknown {
  const nodes = overrides?.nodes ?? defaultNodes
  const edges = overrides?.edges ?? defaultEdges
  const mapJson =
    overrides?.mapJson ?? { nodes, edges, zones: [], nodeEdgeGroups: [] }
  const data =
    overrides?.data ?? {
      mapId: SYNTH_MAP_ID,
      currentMapInfoVersion: {
        mapId: SYNTH_MAP_ID,
        mapName: '合成地图',
        mapVersion: 'V1',
        mapJson,
      },
    }
  return { code: 200, message: 'success', data }
}

// ─── 协议契约（SPEC 4.1 / 14.1 稳定字面量）───────────────────────────────────

describe('场景构建协议 · 稳定阶段名与唯一运行时 URL（SPEC 3.1 / 4.2 / 14.1）', () => {
  test('状态机阶段名稳定且与 SPEC 4.2 对齐', () => {
    expect(SCENE_BUILD_PHASE.LOADING).toBe('loading')
    expect(SCENE_BUILD_PHASE.PREPARING).toBe('preparing')
  })

  test('准备阶段子阶段名稳定且可供 UI 显示', () => {
    expect(SCENE_BUILD_STAGE.PARSING).toBe('parsing')
    expect(SCENE_BUILD_STAGE.VALIDATING).toBe('validating')
    expect(SCENE_BUILD_STAGE.BUILDING).toBe('building')
  })

  test('唯一运行时样本 URL 固定为 /generated/sampleMap.json（SPEC 3.1）', () => {
    expect(SAMPLE_RUNTIME_URL).toBe('/generated/sampleMap.json')
  })
})

// ─── 正常路径 · 最小合成样本（SPEC 4.1 / 4.2 / 5）─────────────────────────────

describe('正常路径 · 最小合成样本经管线构建（SPEC 4.1 / 4.2）', () => {
  let captured: Captured

  beforeAll(async () => {
    captured = await runBuild(fetchFromObject(validEnvelopeObject()), 7)
  })

  test('进度消息顺序：loading → preparing(parsing) → preparing(validating) → preparing(building)', () => {
    const progresses = captured.messages.filter(
      (m): m is SceneBuildProgress => m.type === 'progress',
    )
    expect(progresses).toHaveLength(4)
    expect(progresses[0]).toMatchObject({
      phase: SCENE_BUILD_PHASE.LOADING,
      stage: null,
    })
    expect(progresses[1]).toMatchObject({
      phase: SCENE_BUILD_PHASE.PREPARING,
      stage: SCENE_BUILD_STAGE.PARSING,
    })
    expect(progresses[2]).toMatchObject({
      phase: SCENE_BUILD_PHASE.PREPARING,
      stage: SCENE_BUILD_STAGE.VALIDATING,
    })
    expect(progresses[3]).toMatchObject({
      phase: SCENE_BUILD_PHASE.PREPARING,
      stage: SCENE_BUILD_STAGE.BUILDING,
    })
  })

  test('最终消息为 success，无 failure，所有消息携带 requestId = 7', () => {
    const last = captured.messages[captured.messages.length - 1]
    expect(last.type).toBe('success')
    expect(captured.messages.some((m) => m.type === 'failure')).toBe(false)
    for (const m of captured.messages) {
      expect(m.requestId).toBe(7)
    }
  })

  test('合成样本计数：2 节点、1 节点箭头、1 边箭头、3 标签候选', () => {
    const success = captured.messages.find(
      (m): m is SceneBuildSuccess => m.type === 'success',
    )!
    const d = success.model.diagnostics
    expect(d.nodeCount).toBe(2)
    expect(d.nodeArrowCount).toBe(1)
    expect(d.edgeArrowCount).toBe(1)
    expect(d.labelCandidateCount).toBe(3)
  })

  test('success 消息的 model 通过 TASK-012 自校验', () => {
    const success = captured.messages.find(
      (m): m is SceneBuildSuccess => m.type === 'success',
    )!
    expect(() => validateSceneModel(success.model)).not.toThrow()
  })

  test('成功消息附带 transfer list：覆盖 8 个唯一 ArrayBuffer', () => {
    const idx = captured.messages.findIndex((m) => m.type === 'success')
    const transfer = captured.transfers[idx]
    expect(transfer).toBeDefined()
    expect(transfer!.length).toBe(8)
    expect(new Set(transfer!).size).toBe(8)
    const success = captured.messages[idx] as SceneBuildSuccess
    const expected = collectTransferableBuffers(success.model)
    for (let i = 0; i < expected.length; i++) {
      expect(transfer![i]).toBe(expected[i])
    }
  })
})

// ─── 正常路径 · 真实样本（SPEC 4.1 / 4.2 / 15.1 / 15.3）──────────────────────

describe('正常路径 · 真实样本经管线构建（SPEC 4.1 / 4.2 / 15.1 / 15.3）', () => {
  let captured: Captured

  beforeAll(async () => {
    const sampleText = readFileSync(REAL_SAMPLE, 'utf8')
    captured = await runBuild(fetchFromText(sampleText), 42)
  })

  test('最终消息为 success，所有消息携带同一 requestId = 42', () => {
    const last = captured.messages[captured.messages.length - 1]
    expect(last.type).toBe('success')
    for (const m of captured.messages) {
      expect(m.requestId).toBe(42)
    }
  })

  test('成功 model 满足真实样本规模与 TASK-012 计数断言', () => {
    const success = captured.messages.find(
      (m): m is SceneBuildSuccess => m.type === 'success',
    )!
    const d = success.model.diagnostics
    expect(d.nodeCount).toBe(SAMPLE_NODE_COUNTS.total)
    expect(d.nodeCount).toBe(1767)
    expect(d.nodeArrowCount).toBe(SAMPLE_EDGE_COUNTS.nodeArrowCount)
    expect(d.edgeArrowCount).toBe(SAMPLE_EDGE_COUNTS.edgeArrowCount)
    expect(d.labelCandidateCount).toBe(SAMPLE_EDGE_COUNTS.labelCandidateTotal)
    expect(d.pairedTrackCount).toBe(SAMPLE_TRACK_COUNTS.pairedTrackCount)
    // 重新跑 TASK-012 整体自校验，证明 model 完整、计数与数组长度交叉一致。
    expect(() => validateSceneModel(success.model)).not.toThrow()
  })

  test('成功消息元数据来自样本响应包', () => {
    const success = captured.messages.find(
      (m): m is SceneBuildSuccess => m.type === 'success',
    )!
    expect(success.model.metadata.mapId).toBe('eca3f1d5803247148085688b971c54fb')
    expect(success.model.metadata.mapName).toBe('中环大地图')
    expect(success.model.metadata.version).toBe('V1784091415507')
  })

  test('成功消息 transfer list 覆盖 8 个唯一 ArrayBuffer，与 collectTransferableBuffers 一致', () => {
    const idx = captured.messages.findIndex((m) => m.type === 'success')
    const transfer = captured.transfers[idx]
    expect(transfer).toBeDefined()
    expect(transfer!.length).toBe(8)
    expect(new Set(transfer!).size).toBe(8)
    const success = captured.messages[idx] as SceneBuildSuccess
    const expected = collectTransferableBuffers(success.model)
    expect(transfer!.length).toBe(expected.length)
    for (let i = 0; i < expected.length; i++) {
      expect(transfer![i]).toBe(expected[i])
    }
  })

  test('timings 各阶段非负（诊断字段完整）', () => {
    const success = captured.messages.find(
      (m): m is SceneBuildSuccess => m.type === 'success',
    )!
    expect(success.timings.fetch).toBeGreaterThanOrEqual(0)
    expect(success.timings.parse).toBeGreaterThanOrEqual(0)
    expect(success.timings.validate).toBeGreaterThanOrEqual(0)
    expect(success.timings.build).toBeGreaterThanOrEqual(0)
  })
})

// ─── 转移所有权 · structuredClone 真实分离（SPEC 4.1 / 4.3 / 任务约束）─────────

describe('转移所有权 · success 转移后 worker 侧缓冲区分离（SPEC 4.1 / 4.3）', () => {
  test('真实转移后，model 全部 typed array 的 byteLength 归零，转移后管线不再访问', async () => {
    const sampleText = readFileSync(REAL_SAMPLE, 'utf8')
    const received: SceneBuildMessage[] = []
    let transferred: readonly ArrayBuffer[] | undefined
    const deps: SceneBuildDeps = {
      fetch: fetchFromText(sampleText),
      send: (message, transfer) => {
        received.push(message)
        if (message.type === 'success') {
          transferred = transfer
          // 真实转移：MessageChannel.postMessage 的 transfer list 会分离源端 ArrayBuffer
          // （Node 下与浏览器 worker postMessage 同源语义），模拟 worker → 主线程转移后
          // worker 侧缓冲区被分离、不可再访问（SPEC 4.3）。
          const { port1, port2 } = new MessageChannel()
          port1.postMessage(message, transfer ? [...transfer] : [])
          port1.close()
          port2.close()
        }
      },
      now: makeStepClock(),
    }
    await runSceneBuild({ requestId: 99 }, SAMPLE_RUNTIME_URL, deps)

    const success = received.find(
      (m): m is SceneBuildSuccess => m.type === 'success',
    )!
    expect(success).toBeDefined()

    // 转移后：所有 typed array 底层 buffer 已分离 → byteLength 归零。
    const arrays: readonly Float32Array[] = [
      success.model.nodeMatrices,
      success.model.nodeColors,
      success.model.nodeArrowMatrices,
      success.model.nodeArrowColors,
      success.model.edgeArrowMatrices,
      success.model.edgeArrowColors,
      success.model.ribbonPositions,
      success.model.ribbonColors,
    ]
    for (const arr of arrays) {
      expect(arr.byteLength).toBe(0)
      expect(arr.length).toBe(0)
    }
    // transfer list 覆盖且仅覆盖这些 buffer，无遗漏、无重复。
    expect(transferred).toBeDefined()
    expect(transferred!.length).toBe(8)
    expect(new Set(transferred!).size).toBe(8)
  })

  test('progress / failure 消息不附带 transfer list', async () => {
    const captured = await runBuild(
      fetchFromObject(validEnvelopeObject({ data: { unexpected: true } })),
    )
    // data 形态错误 → validate 失败；progress 与 failure 均不应附带 transfer。
    for (const t of captured.transfers) {
      expect(t).toBeUndefined()
    }
  })
})

// ─── 异常路径 · fetch 阶段（SPEC 14.1 SAMPLE_FETCH_FAILED）────────────────────

describe('异常路径 · fetch 阶段（SPEC 14.1 SAMPLE_FETCH_FAILED）', () => {
  test('非 2xx 响应 → SAMPLE_FETCH_FAILED, phase=loading, failureStage=fetch', async () => {
    const captured = await runBuild(fetchFromObject(validEnvelopeObject(), 500))
    const f = expectFailure(captured, {
      code: MapErrorCode.SAMPLE_FETCH_FAILED,
      failureStage: 'fetch',
      phase: SCENE_BUILD_PHASE.LOADING,
    })
    // 非 2xx 在读取响应体前终止，不进入解析。
    expect(f.context).toMatchObject({ status: 500 })
    expect(captured.messages.some((m) => m.type === 'progress' && m.stage !== null)).toBe(false)
  })

  test('网络失败（fetch reject）→ SAMPLE_FETCH_FAILED', async () => {
    const captured = await runBuild(async () => {
      throw new Error('network unreachable')
    })
    expectFailure(captured, {
      code: MapErrorCode.SAMPLE_FETCH_FAILED,
      failureStage: 'fetch',
      phase: SCENE_BUILD_PHASE.LOADING,
    })
  })

  test('响应体不可读 → SAMPLE_FETCH_FAILED', async () => {
    const captured = await runBuild(() =>
      Promise.resolve({
        ok: true,
        status: 200,
        text: () => Promise.reject(new Error('read interrupted')),
      }),
    )
    expectFailure(captured, {
      code: MapErrorCode.SAMPLE_FETCH_FAILED,
      failureStage: 'fetch',
      phase: SCENE_BUILD_PHASE.LOADING,
    })
  })
})

// ─── 异常路径 · parse 阶段（SPEC 14.1 SAMPLE_JSON_INVALID）────────────────────

describe('异常路径 · parse 阶段（SPEC 14.1 SAMPLE_JSON_INVALID）', () => {
  test('非法 JSON → SAMPLE_JSON_INVALID, phase=preparing, failureStage=parse', async () => {
    const captured = await runBuild(fetchFromText('{ 不是合法 JSON'))
    const f = expectFailure(captured, {
      code: MapErrorCode.SAMPLE_JSON_INVALID,
      failureStage: 'parse',
      phase: SCENE_BUILD_PHASE.PREPARING,
    })
    expect(f.jsonPath).toBe('$')
    expect(f.entityId).toBeNull()
  })
})

// ─── 异常路径 · validate 阶段（SPEC 14.1 / 5.3，透传 TASK-003～TASK-005 稳定错误码）──

describe('异常路径 · validate 阶段（SPEC 14.1 / 5.3）', () => {
  test('提取路径错误（mapJson 缺失）→ MAP_ENVELOPE_INVALID, 保留 jsonPath', async () => {
    // 删除 mapJson，使 currentMapInfoVersion 不含合法提取路径。
    const obj = validEnvelopeObject({
      data: {
        mapId: SYNTH_MAP_ID,
        currentMapInfoVersion: { mapId: SYNTH_MAP_ID, mapName: '合成', mapVersion: 'V1' },
      },
    })
    const captured = await runBuild(fetchFromObject(obj))
    const f = expectFailure(captured, {
      code: MapErrorCode.MAP_ENVELOPE_INVALID,
      failureStage: 'validate',
    })
    // 保留 TASK-003 的稳定 JSON path，便于 overlay 与诊断定位。
    expect(f.jsonPath).toContain('mapJson')
  })

  test('实体非法（未知节点类型）→ MAP_ENTITY_INVALID, 保留 entityId', async () => {
    // warehouse 是样本不存在的旧类型，必须以 MAP_ENTITY_INVALID 拒绝（SPEC 2.2 / 5.3 第 6 项）。
    const badNodes: readonly SyntheticNode[] = [
      ...defaultNodes,
      {
        id: 'bad',
        name: 'bad',
        type: 'work',
        mapId: SYNTH_MAP_ID,
        x: 8,
        y: 0,
        angle: 0,
      },
    ]
    // 在序列化前注入非法 type（绕过 SyntheticNode 的字面量收窄），模拟未知类型实体。
    const obj = validEnvelopeObject({ nodes: badNodes }) as {
      data: { currentMapInfoVersion: { mapJson: { nodes: unknown[] } } }
    }
    obj.data.currentMapInfoVersion.mapJson.nodes[2] = {
      ...badNodes[2],
      type: 'warehouse',
    }
    const captured = await runBuild(fetchFromObject(obj))
    const f = expectFailure(captured, {
      code: MapErrorCode.MAP_ENTITY_INVALID,
      failureStage: 'validate',
    })
    expect(f.entityId).toBe('bad')
    expect(f.jsonPath).toContain('type')
  })

  test('空节点空边（source bounds 退化）→ MAP_GEOMETRY_INVALID, failureStage=validate', async () => {
    // 空集合通过字段与语义校验，但在 normalizeSceneMap 计算 source bounds 时退化。
    const obj = validEnvelopeObject({ nodes: [], edges: [] })
    const captured = await runBuild(fetchFromObject(obj))
    expectFailure(captured, {
      code: MapErrorCode.MAP_GEOMETRY_INVALID,
      failureStage: 'validate',
    })
  })

  test('悬空引用（边引用不存在的节点）→ MAP_ENTITY_INVALID, 保留 entityId 与 jsonPath', async () => {
    const obj = validEnvelopeObject({
      edges: [
        {
          ...defaultEdges[0],
          id: 'e1',
          snodeId: 'missing-node',
        },
      ],
    })
    const captured = await runBuild(fetchFromObject(obj))
    const f = expectFailure(captured, {
      code: MapErrorCode.MAP_ENTITY_INVALID,
      failureStage: 'validate',
    })
    expect(f.entityId).toBe('e1')
    expect(f.jsonPath).toContain('snodeId')
  })
})

// ─── 异常路径 · build 阶段（SPEC 14.1 MAP_GEOMETRY_INVALID，透传 TASK-012）────

describe('异常路径 · build 阶段（SPEC 14.1 / 9.2 轨迹组异常）', () => {
  test('三重相同轨迹 → MAP_GEOMETRY_INVALID, failureStage=build', async () => {
    // 三条端点完全相同的 LINE 边构成同向重复 / 三重轨迹，trackGrouping 整体拒绝。
    const triplicateEdges: readonly SyntheticLineEdge[] = [
      { ...defaultEdges[0], id: 'e1', name: '1' },
      { ...defaultEdges[0], id: 'e2', name: '2' },
      { ...defaultEdges[0], id: 'e3', name: '3' },
    ]
    const obj = validEnvelopeObject({ edges: triplicateEdges })
    const captured = await runBuild(fetchFromObject(obj))
    expectFailure(captured, {
      code: MapErrorCode.MAP_GEOMETRY_INVALID,
      failureStage: 'build',
    })
  })
})

// ─── 失败原子性 · 不返回部分场景（SPEC 16 / 任务约束）──────────────────────────

describe('失败原子性 · 不输出部分 SceneModel（SPEC 16 / 任务约束）', () => {
  test('fetch 失败：只产生 loading 进度与失败消息，无 preparing 进度、无 success', async () => {
    const captured = await runBuild(async () => {
      throw new Error('offline')
    })
    const phases = captured.messages
      .filter((m): m is SceneBuildProgress => m.type === 'progress')
      .map((p) => p.phase)
    // loading 已报告，但 fetch 失败后不再进入 preparing。
    expect(phases).toEqual([SCENE_BUILD_PHASE.LOADING])
    expect(captured.messages.some((m) => m.type === 'success')).toBe(false)
  })

  test('build 失败：已报告全部 preparing 子阶段，但只产出 failure，无 success', async () => {
    const triplicateEdges: readonly SyntheticLineEdge[] = [
      { ...defaultEdges[0], id: 'e1', name: '1' },
      { ...defaultEdges[0], id: 'e2', name: '2' },
      { ...defaultEdges[0], id: 'e3', name: '3' },
    ]
    const captured = await runBuild(
      fetchFromObject(validEnvelopeObject({ edges: triplicateEdges })),
    )
    const stages = captured.messages
      .filter((m): m is SceneBuildProgress => m.type === 'progress')
      .map((p) => p.stage)
    // build 阶段失败前已报告 parsing / validating / building 三个子阶段。
    expect(stages).toEqual([
      null,
      SCENE_BUILD_STAGE.PARSING,
      SCENE_BUILD_STAGE.VALIDATING,
      SCENE_BUILD_STAGE.BUILDING,
    ])
    expect(captured.messages.some((m) => m.type === 'success')).toBe(false)
  })
})

// ─── 失败消息可克隆性（任务约束：不得抛出不可克隆对象）────────────────────────

describe('失败消息可克隆性（任务约束）', () => {
  test('各类失败消息都能被 structuredClone 序列化', async () => {
    const cases: ReadonlyArray<{
      name: string
      fetch: (url: string) => Promise<SceneBuildFetchResponse>
      code: MapErrorCode
    }> = [
      {
        name: 'fetch',
        fetch: async () => {
          throw new Error('net')
        },
        code: MapErrorCode.SAMPLE_FETCH_FAILED,
      },
      {
        name: 'parse',
        fetch: fetchFromText('not json'),
        code: MapErrorCode.SAMPLE_JSON_INVALID,
      },
      {
        name: 'validate',
        fetch: fetchFromObject(validEnvelopeObject({ data: { broken: true } })),
        code: MapErrorCode.MAP_ENVELOPE_INVALID,
      },
      {
        name: 'build',
        fetch: fetchFromObject(
          validEnvelopeObject({
            edges: [
              { ...defaultEdges[0], id: 'e1', name: '1' },
              { ...defaultEdges[0], id: 'e2', name: '2' },
              { ...defaultEdges[0], id: 'e3', name: '3' },
            ],
          }),
        ),
        code: MapErrorCode.MAP_GEOMETRY_INVALID,
      },
    ]
    for (const c of cases) {
      const captured = await runBuild(c.fetch)
      const f = captured.messages.find(
        (m): m is SceneBuildFailure => m.type === 'failure',
      )!
      // 失败消息必须可结构化克隆，不得携带不可克隆对象（任务约束）。
      expect(() => structuredClone(f)).not.toThrow()
      expect(f.code).toBe(c.code)
    }
  })
})
