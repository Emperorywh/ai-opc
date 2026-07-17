/*
 * 场景模型汇总自动化验证（TASK-012，SPEC 4.1 / 5.2 / 6 / 7.1 / 8 / 9 / 10 / 11.2 / 12.1 / 14.2 / 15.3 / 16）。
 *
 * 设计：
 *   - 合成 SceneMap 用于精确断言：元数据 / 场景原点透传、五类数组长度与诊断交叉一致、
 *     contentBounds 逐项覆盖 ribbon / 节点圆柱 / 两类箭头的真实极值且排除标签。
 *   - 错误实现识别：补零 / 截断 / 只用节点坐标算 bounds / 纳入标签或 Ground / 重复派生坐标 /
 *     携带原始 DTO 等错误都会让对应断言失败。
 *   - 异常路径：篡改矩阵 / 颜色长度、ribbon 顶点计数、bounds 极值、诊断计数、注入 NaN / Infinity、
 *     重复缓冲区、缺失元数据 → MAP_GEOMETRY_INVALID，均整体拒绝，不返回可用模型。
 *   - 可转移缓冲区：枚举每个最终 typed array 的 ArrayBuffer 恰好一次，不包含描述符或不可转移对象。
 *   - 真实样本集成：先校验 SHA-256，再走完整可信链到 buildSceneModel，交叉断言元数据、场景原点、
 *     五类数组长度、4810 标签、979 配对轨迹、全部有限、颜色线性 [0,1]、contentBounds 逐项覆盖。
 *
 * 不启动浏览器：合成测试只调纯函数；真实样本在 node 环境直接读取，不接触 Three / React。
 */
import { describe, test, expect, beforeAll } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  buildSceneModel,
  validateSceneModel,
  collectTransferableBuffers,
} from '../../src/workers/buildSceneModel'
import type { SceneModel } from '../../src/workers/buildSceneModel'
import { NODE_ARROW_VERTICES } from '../../src/geometry/nodeArrowData'
import { EDGE_ARROW_VERTICES } from '../../src/geometry/edgeArrowData'
import { isMapDataError, MapErrorCode } from '../../src/domain/mapDataError'
import type {
  MapTransform,
  NumericBox3,
  SceneEdge,
  SceneLineEdge,
  SceneMap,
  SceneNode,
  SourceBounds2D,
} from '../../src/domain/sceneMap'
import { LABEL_ANCHOR_Y } from '../../src/labels/labelDescriptor'
import {
  parseSampleEnvelope,
} from '../../src/adapters/parseSampleEnvelope'
import {
  validateMapSemantics,
} from '../../src/adapters/validateMapSemantics'
import { normalizeSceneMap } from '../../src/adapters/normalizeSceneMap'
import {
  computeFileSha256,
  EXPECTED_SAMPLE_SHA256,
} from '../../scripts/sample-supply-chain.mjs'
import {
  SAMPLE_EDGE_COUNTS,
  SAMPLE_NODE_COUNTS,
  SAMPLE_TRACK_COUNTS,
} from '../fixture/sampleBaseline'

// ─── 合成场景构造（SPEC 5.2 / 6.2 / 7.1）─────────────────────────────────────

/*
 * SPEC 7.1：节点半径（米），按类型固定（与 nodeInstanceData / nodeLabel 同源 SPEC 7.1）。
 */
const NODE_RADIUS = { node: 0.1, work: 0.15, park: 0.15, charge: 0.15 } as const

/*
 * SPEC 7.1：节点实例中心 Y、底面 / 顶面 Y、节点箭头 Y、ribbon Y。
 * 用于独立重算 contentBounds 并与模型输出交叉比对。
 */
const NODE_INSTANCE_CENTER_Y = 0.035
const NODE_HALF_HEIGHT = 0.025
const NODE_ARROW_Y = 0.066
const RIBBON_Y = 0

/*
 * 合成节点构造工具：默认普通节点位于原点。
 */
function sceneNode(overrides: Partial<SceneNode> & { id: string }): SceneNode {
  return {
    name: overrides.id,
    type: 'node',
    position: { x: 0, z: 0 },
    angle: null,
    ...overrides,
  } as SceneNode
}

/*
 * 合成直线边构造工具：默认 (0,0)→(1,0) 的正向直线边。
 */
function lineEdge(overrides: Partial<SceneLineEdge> & { id: string }): SceneLineEdge {
  return {
    kind: 'line',
    name: '1',
    startNodeId: 'n1',
    endNodeId: 'n2',
    start: { x: 0, z: 0 },
    end: { x: 1, z: 0 },
    isBackEdge: false,
    ...overrides,
  } as SceneLineEdge
}

/*
 * 构造合成 SceneMap（已一次性转换到场景系；origin = (0,0) 使场景坐标 = 地图坐标）。
 *
 * 固定结构（pairedTrackCount = 0，两条 LINE 边几何不精确反序）：
 *   - N1 node (0,0)、N2 work (4,0) angle=0、N3 charge (8,0) angle=0。
 *   - E1 LINE (0,0)→(4,0)、E2 LINE (8,0)→(4,0)。
 *
 * 该结构下 contentBounds 可手工推导（见“逐项验证”测试组），用于精确断言。
 */
function buildSyntheticSceneMap(): SceneMap {
  const transform: MapTransform = {
    absoluteWorldOriginX: 0,
    absoluteWorldOriginZ: 0,
  }
  const sourceBounds: SourceBounds2D = {
    minX: 0,
    maxX: 8,
    minY: 0,
    maxY: 0,
  }
  const nodes: SceneNode[] = [
    sceneNode({ id: 'n1', type: 'node', position: { x: 0, z: 0 } }),
    sceneNode({ id: 'n2', type: 'work', position: { x: 4, z: 0 }, angle: 0 }),
    sceneNode({ id: 'n3', type: 'charge', position: { x: 8, z: 0 }, angle: 0 }),
  ]
  const edges: SceneEdge[] = [
    lineEdge({
      id: 'e1',
      name: '1',
      startNodeId: 'n1',
      endNodeId: 'n2',
      start: { x: 0, z: 0 },
      end: { x: 4, z: 0 },
    }),
    lineEdge({
      id: 'e2',
      name: '2',
      startNodeId: 'n3',
      endNodeId: 'n2',
      start: { x: 8, z: 0 },
      end: { x: 4, z: 0 },
    }),
  ]
  return {
    metadata: { mapId: 'synthetic-map', mapName: '合成地图', version: 'V1' },
    transform,
    sourceBounds,
    nodes,
    edges,
  }
}

/*
 * 捕获被调函数抛出的错误；未抛出时主动失败，便于随后断言错误码。
 */
function captureError(fn: () => unknown): unknown {
  try {
    fn()
  } catch (e) {
    return e
  }
  throw new Error('期望抛出错误，但未抛出')
}

/*
 * 由实例矩阵（列主序 T × R × S）与局部顶点 (lx, ly, lz) 计算世界坐标。
 * 用于独立重算节点 / 边箭头真实几何范围，与模型 contentBounds 交叉比对。
 */
function transformByMatrix(
  matrices: Float32Array,
  instanceIndex: number,
  lx: number,
  ly: number,
  lz: number,
): { x: number; y: number; z: number } {
  const m = instanceIndex * 16
  return {
    x: matrices[m + 0] * lx + matrices[m + 4] * ly + matrices[m + 8] * lz + matrices[m + 12],
    y: matrices[m + 1] * lx + matrices[m + 5] * ly + matrices[m + 9] * lz + matrices[m + 13],
    z: matrices[m + 2] * lx + matrices[m + 6] * ly + matrices[m + 10] * lz + matrices[m + 14],
  }
}

/*
 * 由最终模型独立重算 contentBounds，逐项覆盖 ribbon / 节点圆柱 / 两类箭头（SPEC 12.1）。
 *
 * 不回读领域节点 / 领域边：ribbon 扫描 ribbonPositions；节点圆柱扫描 nodeMatrices；
 * 两类箭头分别用 NODE_ARROW_VERTICES / EDGE_ARROW_VERTICES 对实例矩阵逐顶点变换。
 * 排除标签锚点（Y = 0.250）与 Ground，保证与实现同口径。
 */
function computeExpectedContentBounds(model: SceneModel): NumericBox3 {
  let minX = Number.POSITIVE_INFINITY
  let minY = Number.POSITIVE_INFINITY
  let minZ = Number.POSITIVE_INFINITY
  let maxX = Number.NEGATIVE_INFINITY
  let maxY = Number.NEGATIVE_INFINITY
  let maxZ = Number.NEGATIVE_INFINITY
  const extend = (x: number, y: number, z: number): void => {
    if (x < minX) minX = x
    if (y < minY) minY = y
    if (z < minZ) minZ = z
    if (x > maxX) maxX = x
    if (y > maxY) maxY = y
    if (z > maxZ) maxZ = z
  }

  // ribbon 顶点（已含车道偏移与半宽，Y 恒为 ribbon Y）。
  for (let i = 0; i < model.ribbonPositions.length; i += 3) {
    extend(model.ribbonPositions[i], model.ribbonPositions[i + 1], model.ribbonPositions[i + 2])
  }

  // 节点圆柱：中心 (tx, 0.035, tz)，半径 rx/rz，半高 0.025。八个角点取极值。
  for (let i = 0; i < model.diagnostics.nodeCount; i++) {
    const m = i * 16
    const tx = model.nodeMatrices[m + 12]
    const tz = model.nodeMatrices[m + 14]
    const rx = model.nodeMatrices[m + 0]
    const rz = model.nodeMatrices[m + 10]
    const yMin = NODE_INSTANCE_CENTER_Y - NODE_HALF_HEIGHT
    const yMax = NODE_INSTANCE_CENTER_Y + NODE_HALF_HEIGHT
    extend(tx - rx, yMin, tz - rz)
    extend(tx + rx, yMax, tz + rz)
  }

  // 节点箭头：用基准三角形对每个实例矩阵逐顶点变换。
  for (let i = 0; i < model.diagnostics.nodeArrowCount; i++) {
    for (let v = 0; v < NODE_ARROW_VERTICES.length; v += 3) {
      const p = transformByMatrix(
        model.nodeArrowMatrices,
        i,
        NODE_ARROW_VERTICES[v],
        NODE_ARROW_VERTICES[v + 1],
        NODE_ARROW_VERTICES[v + 2],
      )
      extend(p.x, p.y, p.z)
    }
  }

  // 边箭头：用基准三角形对每个实例矩阵逐顶点变换。
  for (let i = 0; i < model.diagnostics.edgeArrowCount; i++) {
    for (let v = 0; v < EDGE_ARROW_VERTICES.length; v += 3) {
      const p = transformByMatrix(
        model.edgeArrowMatrices,
        i,
        EDGE_ARROW_VERTICES[v],
        EDGE_ARROW_VERTICES[v + 1],
        EDGE_ARROW_VERTICES[v + 2],
      )
      extend(p.x, p.y, p.z)
    }
  }

  return { minX, minY, minZ, maxX, maxY, maxZ }
}

let syntheticModel: SceneModel

beforeAll(() => {
  syntheticModel = buildSceneModel(buildSyntheticSceneMap())
})

// ─── 合成场景模型 · 正常路径（SPEC 5.2 / 6.2 / 12.1）─────────────────────────

describe('合成场景模型 · 元数据与场景原点透传（SPEC 5.2 / 6.2）', () => {
  test('元数据来自 SceneMap，不被重算或丢弃', () => {
    expect(syntheticModel.metadata.mapId).toBe('synthetic-map')
    expect(syntheticModel.metadata.mapName).toBe('合成地图')
    expect(syntheticModel.metadata.version).toBe('V1')
  })

  test('场景原点来自 SceneMap.transform，不在汇总阶段二次转换', () => {
    expect(syntheticModel.transform.absoluteWorldOriginX).toBe(0)
    expect(syntheticModel.transform.absoluteWorldOriginZ).toBe(0)
  })
})

describe('合成场景模型 · 数组长度与诊断交叉一致（SPEC 5.2 / 8.2 / 10.2）', () => {
  test('nodeCount = 3，nodeMatrices 3×16，nodeColors 3×3', () => {
    const d = syntheticModel.diagnostics
    expect(d.nodeCount).toBe(3)
    expect(syntheticModel.nodeMatrices.length).toBe(3 * 16)
    expect(syntheticModel.nodeColors.length).toBe(3 * 3)
  })

  test('nodeArrowCount = 2（work + charge），矩阵 2×16，颜色 2×3', () => {
    const d = syntheticModel.diagnostics
    expect(d.nodeArrowCount).toBe(2)
    expect(syntheticModel.nodeArrowMatrices.length).toBe(2 * 16)
    expect(syntheticModel.nodeArrowColors.length).toBe(2 * 3)
  })

  test('edgeArrowCount = 2（每条边一个），矩阵 2×16，颜色 2×3', () => {
    const d = syntheticModel.diagnostics
    expect(d.edgeArrowCount).toBe(2)
    expect(syntheticModel.edgeArrowMatrices.length).toBe(2 * 16)
    expect(syntheticModel.edgeArrowColors.length).toBe(2 * 3)
  })

  test('ribbon position / color 长度 = ribbonVertexCount × 3', () => {
    const d = syntheticModel.diagnostics
    expect(syntheticModel.ribbonPositions.length).toBe(d.ribbonVertexCount * 3)
    expect(syntheticModel.ribbonColors.length).toBe(d.ribbonVertexCount * 3)
    // 两条 LINE（各 1 段 6 顶点，0 内部点）：2 × 6 = 12 非索引顶点。
    expect(d.ribbonVertexCount).toBe(12)
  })

  test('labelCandidateCount = nodeCount + edgeArrowCount = 5', () => {
    const d = syntheticModel.diagnostics
    expect(d.labelCandidateCount).toBe(5)
    expect(syntheticModel.labels.length).toBe(5)
    expect(d.labelCandidateCount).toBe(d.nodeCount + d.edgeArrowCount)
  })

  test('pairedTrackCount = 0（两条 LINE 边几何不精确反序）', () => {
    expect(syntheticModel.diagnostics.pairedTrackCount).toBe(0)
  })
})

describe('合成场景模型 · contentBounds 逐项覆盖真实几何（SPEC 12.1 / 16）', () => {
  test('contentBounds 与独立重算结果在六个分量上一致', () => {
    const expected = computeExpectedContentBounds(syntheticModel)
    const actual = syntheticModel.contentBounds
    // 在 Float32 精度内逐项一致；独立重算用 number 精度，模型 bounds 来自子系统 Float32 累计。
    expect(actual.minX).toBeCloseTo(expected.minX, 5)
    expect(actual.minY).toBeCloseTo(expected.minY, 5)
    expect(actual.minZ).toBeCloseTo(expected.minZ, 5)
    expect(actual.maxX).toBeCloseTo(expected.maxX, 5)
    expect(actual.maxY).toBeCloseTo(expected.maxY, 5)
    expect(actual.maxZ).toBeCloseTo(expected.maxZ, 5)
  })

  test('contentBounds 覆盖节点圆柱极值（N1 左缘 minX、N3 右缘 maxX）', () => {
    // N1 (node) 在 x=0，半径 0.10 → 左缘 -0.10；N3 (charge) 在 x=8，半径 0.15 → 右缘 8.15。
    expect(syntheticModel.contentBounds.minX).toBeCloseTo(0 - NODE_RADIUS.node, 5)
    expect(syntheticModel.contentBounds.maxX).toBeCloseTo(8 + NODE_RADIUS.charge, 5)
  })

  test('contentBounds 覆盖 ribbon 与节点圆柱的 Y 范围（ribbon Y=0 到节点箭头 Y=0.066）', () => {
    expect(syntheticModel.contentBounds.minY).toBeCloseTo(RIBBON_Y, 6)
    expect(syntheticModel.contentBounds.maxY).toBeCloseTo(NODE_ARROW_Y, 6)
  })

  test('contentBounds 覆盖边箭头 Z 极值（±0.55 × 0.30）', () => {
    expect(syntheticModel.contentBounds.minZ).toBeCloseTo(-0.55 * 0.30, 5)
    expect(syntheticModel.contentBounds.maxZ).toBeCloseTo(0.55 * 0.30, 5)
  })

  test('contentBounds 满足 min ≤ max', () => {
    const b = syntheticModel.contentBounds
    expect(b.minX).toBeLessThanOrEqual(b.maxX)
    expect(b.minY).toBeLessThanOrEqual(b.maxY)
    expect(b.minZ).toBeLessThanOrEqual(b.maxZ)
  })

  test('contentBounds 排除标签锚点（maxY < Label Anchor Y = 0.250）', () => {
    // 标签锚点 Y = 0.250 是最高实体；contentBounds.maxY = 0.066（节点箭头），证明标签不进入 bounds。
    expect(syntheticModel.contentBounds.maxY).toBeLessThan(LABEL_ANCHOR_Y)
  })
})

describe('合成场景模型 · 标签描述符透传（SPEC 5.2 / 11.2）', () => {
  test('标签顺序固定为节点标签 + 边标签，文本保持原样', () => {
    const texts = syntheticModel.labels.map((l) => l.text)
    expect(texts).toEqual(['n1', 'n2', 'n3', '1', '2'])
  })

  test('全部标签锚点 / 偏移为有限数', () => {
    for (const label of syntheticModel.labels) {
      expect(Number.isFinite(label.anchorX)).toBe(true)
      expect(Number.isFinite(label.anchorY)).toBe(true)
      expect(Number.isFinite(label.anchorZ)).toBe(true)
      expect(Number.isFinite(label.localOffsetX)).toBe(true)
      expect(Number.isFinite(label.localOffsetY)).toBe(true)
    }
  })

  test('标签锚点 Y 恒为 Label Anchor Y（0.250），不进入 contentBounds', () => {
    for (const label of syntheticModel.labels) {
      expect(label.anchorY).toBeCloseTo(LABEL_ANCHOR_Y, 6)
    }
  })
})

// ─── 合成场景模型 · 可转移缓冲区（SPEC 4.1 / 任务约束）────────────────────────

describe('合成场景模型 · 可转移缓冲区契约（SPEC 4.1）', () => {
  test('枚举 8 个 ArrayBuffer，每个最终 typed array 的缓冲区恰好出现一次', () => {
    const buffers = collectTransferableBuffers(syntheticModel)
    expect(buffers.length).toBe(8)
    // 去重后数量不变：每个缓冲区唯一。
    const unique = new Set(buffers)
    expect(unique.size).toBe(8)
  })

  test('每个缓冲区等于对应 typed array 的底层 buffer', () => {
    const buffers = collectTransferableBuffers(syntheticModel)
    const expected: readonly Float32Array[] = [
      syntheticModel.nodeMatrices,
      syntheticModel.nodeColors,
      syntheticModel.nodeArrowMatrices,
      syntheticModel.nodeArrowColors,
      syntheticModel.edgeArrowMatrices,
      syntheticModel.edgeArrowColors,
      syntheticModel.ribbonPositions,
      syntheticModel.ribbonColors,
    ]
    for (let i = 0; i < expected.length; i++) {
      expect(buffers[i]).toBe(expected[i].buffer)
    }
  })

  test('枚举结果不包含标签描述符或其它不可转移对象（元素类型为 ArrayBuffer）', () => {
    const buffers = collectTransferableBuffers(syntheticModel)
    for (const buf of buffers) {
      expect(buf).toBeInstanceOf(ArrayBuffer)
    }
  })
})

// ─── 合成场景模型 · 异常路径（整体拒绝，SPEC 14.1 / 16 / 任务约束）────────────

describe('合成场景模型 · 异常路径 · 整体拒绝（SPEC 14.1 / 16）', () => {
  test('篡改 nodeMatrices 长度 → MAP_GEOMETRY_INVALID', () => {
    const tampered: SceneModel = {
      ...syntheticModel,
      nodeMatrices: new Float32Array(syntheticModel.diagnostics.nodeCount * 16 - 1),
    }
    const err = captureError(() => validateSceneModel(tampered)) as Error
    expect(isMapDataError(err)).toBe(true)
    if (isMapDataError(err)) {
      expect(err.code).toBe(MapErrorCode.MAP_GEOMETRY_INVALID)
    }
  })

  test('篡改 nodeColors 长度 → MAP_GEOMETRY_INVALID', () => {
    const tampered: SceneModel = {
      ...syntheticModel,
      nodeColors: new Float32Array(syntheticModel.diagnostics.nodeCount * 3 + 1),
    }
    const err = captureError(() => validateSceneModel(tampered)) as Error
    expect(isMapDataError(err)).toBe(true)
    if (isMapDataError(err)) {
      expect(err.code).toBe(MapErrorCode.MAP_GEOMETRY_INVALID)
    }
  })

  test('篡改 ribbonVertexCount 诊断（与 ribbonPositions 不一致）→ MAP_GEOMETRY_INVALID', () => {
    const tampered: SceneModel = {
      ...syntheticModel,
      diagnostics: {
        ...syntheticModel.diagnostics,
        ribbonVertexCount: syntheticModel.diagnostics.ribbonVertexCount + 10,
      },
    }
    const err = captureError(() => validateSceneModel(tampered)) as Error
    expect(isMapDataError(err)).toBe(true)
    if (isMapDataError(err)) {
      expect(err.code).toBe(MapErrorCode.MAP_GEOMETRY_INVALID)
    }
  })

  test('篡改 edgeArrowCount 诊断（与矩阵长度不一致）→ MAP_GEOMETRY_INVALID', () => {
    const tampered: SceneModel = {
      ...syntheticModel,
      diagnostics: {
        ...syntheticModel.diagnostics,
        edgeArrowCount: syntheticModel.diagnostics.edgeArrowCount + 1,
      },
    }
    const err = captureError(() => validateSceneModel(tampered)) as Error
    expect(isMapDataError(err)).toBe(true)
    if (isMapDataError(err)) {
      expect(err.code).toBe(MapErrorCode.MAP_GEOMETRY_INVALID)
    }
  })

  test('篡改 nodeCount 诊断（破坏 labelCandidateCount = nodeCount + edgeArrowCount）→ 拒绝', () => {
    const tampered: SceneModel = {
      ...syntheticModel,
      diagnostics: {
        ...syntheticModel.diagnostics,
        nodeCount: syntheticModel.diagnostics.nodeCount + 5,
      },
    }
    expect(() => validateSceneModel(tampered)).toThrow()
  })

  test('篡改 contentBounds 极值（minX = NaN）→ MAP_GEOMETRY_INVALID', () => {
    const tampered: SceneModel = {
      ...syntheticModel,
      contentBounds: { ...syntheticModel.contentBounds, minX: Number.NaN },
    }
    const err = captureError(() => validateSceneModel(tampered)) as Error
    expect(isMapDataError(err)).toBe(true)
    if (isMapDataError(err)) {
      expect(err.code).toBe(MapErrorCode.MAP_GEOMETRY_INVALID)
    }
  })

  test('篡改 contentBounds 顺序（minX > maxX）→ MAP_GEOMETRY_INVALID', () => {
    const tampered: SceneModel = {
      ...syntheticModel,
      contentBounds: { ...syntheticModel.contentBounds, minX: 100, maxX: 1 },
    }
    const err = captureError(() => validateSceneModel(tampered)) as Error
    expect(isMapDataError(err)).toBe(true)
    if (isMapDataError(err)) {
      expect(err.code).toBe(MapErrorCode.MAP_GEOMETRY_INVALID)
    }
  })

  test('注入 NaN 到 nodeMatrices → MAP_GEOMETRY_INVALID', () => {
    const bad = new Float32Array(syntheticModel.nodeMatrices)
    bad[0] = Number.NaN
    const tampered: SceneModel = { ...syntheticModel, nodeMatrices: bad }
    const err = captureError(() => validateSceneModel(tampered)) as Error
    expect(isMapDataError(err)).toBe(true)
    if (isMapDataError(err)) {
      expect(err.code).toBe(MapErrorCode.MAP_GEOMETRY_INVALID)
    }
  })

  test('注入 Infinity 到 ribbonColors → MAP_GEOMETRY_INVALID', () => {
    const bad = new Float32Array(syntheticModel.ribbonColors)
    bad[0] = Number.POSITIVE_INFINITY
    const tampered: SceneModel = { ...syntheticModel, ribbonColors: bad }
    const err = captureError(() => validateSceneModel(tampered)) as Error
    expect(isMapDataError(err)).toBe(true)
    if (isMapDataError(err)) {
      expect(err.code).toBe(MapErrorCode.MAP_GEOMETRY_INVALID)
    }
  })

  test('注入超范围颜色（> 1）到 edgeArrowColors → MAP_GEOMETRY_INVALID', () => {
    const bad = new Float32Array(syntheticModel.edgeArrowColors)
    bad[0] = 5
    const tampered: SceneModel = { ...syntheticModel, edgeArrowColors: bad }
    const err = captureError(() => validateSceneModel(tampered)) as Error
    expect(isMapDataError(err)).toBe(true)
    if (isMapDataError(err)) {
      expect(err.code).toBe(MapErrorCode.MAP_GEOMETRY_INVALID)
    }
  })

  test('缺失元数据（mapId 为空）→ MAP_GEOMETRY_INVALID', () => {
    const tampered: SceneModel = {
      ...syntheticModel,
      metadata: { ...syntheticModel.metadata, mapId: '' },
    }
    const err = captureError(() => validateSceneModel(tampered)) as Error
    expect(isMapDataError(err)).toBe(true)
    if (isMapDataError(err)) {
      expect(err.code).toBe(MapErrorCode.MAP_GEOMETRY_INVALID)
    }
  })

  test('场景原点非有限 → MAP_GEOMETRY_INVALID', () => {
    const tampered: SceneModel = {
      ...syntheticModel,
      transform: {
        absoluteWorldOriginX: Number.POSITIVE_INFINITY,
        absoluteWorldOriginZ: 0,
      },
    }
    const err = captureError(() => validateSceneModel(tampered)) as Error
    expect(isMapDataError(err)).toBe(true)
    if (isMapDataError(err)) {
      expect(err.code).toBe(MapErrorCode.MAP_GEOMETRY_INVALID)
    }
  })

  test('重复 ArrayBuffer（两个 typed array 共享同一 buffer）→ collectTransferableBuffers 拒绝', () => {
    // 构造两个共享同一 buffer 的 typed array（subarray 共享底层 buffer）。
    const shared = new Float32Array(1024)
    const fakeModel: SceneModel = {
      ...syntheticModel,
      nodeMatrices: shared.subarray(0, syntheticModel.nodeMatrices.length),
      nodeColors: shared.subarray(
        syntheticModel.nodeMatrices.length,
        syntheticModel.nodeMatrices.length + syntheticModel.nodeColors.length,
      ),
    }
    const err = captureError(() => collectTransferableBuffers(fakeModel)) as Error
    expect(isMapDataError(err)).toBe(true)
    if (isMapDataError(err)) {
      expect(err.code).toBe(MapErrorCode.MAP_GEOMETRY_INVALID)
    }
  })

  test('nodeArrowCount > nodeCount → MAP_GEOMETRY_INVALID', () => {
    const tampered: SceneModel = {
      ...syntheticModel,
      diagnostics: {
        ...syntheticModel.diagnostics,
        nodeCount: 1,
        nodeArrowCount: 2,
      },
    }
    expect(() => validateSceneModel(tampered)).toThrow()
  })

  test('labels 长度与 labelCandidateCount 不一致 → 拒绝', () => {
    const tampered: SceneModel = {
      ...syntheticModel,
      labels: syntheticModel.labels.slice(0, 1),
    }
    expect(() => validateSceneModel(tampered)).toThrow()
  })
})

// ─── 真实样本集成（SPEC 15.1 / 15.3 / 16）──────────────────────────────────────

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '..', '..')
const REAL_SAMPLE = resolve(root, 'data', 'sampleMap.json')

let realModel: SceneModel

beforeAll(async () => {
  // SPEC 15.1：哈希不符必须立即终止回归验证。
  const sha = await computeFileSha256(REAL_SAMPLE)
  if (sha !== EXPECTED_SAMPLE_SHA256) {
    throw new Error(`样本身份不符，停止回归验证：${sha}`)
  }
  const rawJson = JSON.parse(readFileSync(REAL_SAMPLE, 'utf8')) as unknown
  const rawMap = parseSampleEnvelope(rawJson)
  validateMapSemantics(rawMap)
  const sceneMap = normalizeSceneMap(rawMap)
  realModel = buildSceneModel(sceneMap)
})

describe('真实样本场景模型 · 元数据与场景原点（SPEC 2.1 / 5.2 / 6.2）', () => {
  test('元数据来自样本响应包，完整且非空', () => {
    expect(realModel.metadata.mapId).toBe('eca3f1d5803247148085688b971c54fb')
    expect(realModel.metadata.mapName).toBe('中环大地图')
    expect(realModel.metadata.version).toBe('V1784091415507')
  })

  test('场景原点 ≈ (-81.82, -12.54)，由 source bounds 中心派生', () => {
    // SPEC 6.2：absoluteWorldOriginX = source bounds 中心 mapX；absoluteWorldOriginZ = -(bounds 中心 mapY)。
    expect(realModel.transform.absoluteWorldOriginX).toBeCloseTo(-81.82, 2)
    expect(realModel.transform.absoluteWorldOriginZ).toBeCloseTo(-12.54, 2)
  })
})

describe('真实样本场景模型 · 规模与诊断交叉一致（SPEC 2.2 / 5.2 / 15.3）', () => {
  test('节点 1767、节点箭头 464、边箭头 3043、标签 4810、配对轨迹 979', () => {
    const d = realModel.diagnostics
    expect(d.nodeCount).toBe(SAMPLE_NODE_COUNTS.total)
    expect(d.nodeCount).toBe(1767)
    expect(d.nodeArrowCount).toBe(SAMPLE_EDGE_COUNTS.nodeArrowCount)
    expect(d.nodeArrowCount).toBe(464)
    expect(d.edgeArrowCount).toBe(SAMPLE_EDGE_COUNTS.edgeArrowCount)
    expect(d.edgeArrowCount).toBe(3043)
    expect(d.labelCandidateCount).toBe(SAMPLE_EDGE_COUNTS.labelCandidateTotal)
    expect(d.labelCandidateCount).toBe(4810)
    expect(d.pairedTrackCount).toBe(SAMPLE_TRACK_COUNTS.pairedTrackCount)
    expect(d.pairedTrackCount).toBe(979)
  })

  test('五类数组长度与诊断计数严格一致', () => {
    const d = realModel.diagnostics
    expect(realModel.nodeMatrices.length).toBe(d.nodeCount * 16)
    expect(realModel.nodeColors.length).toBe(d.nodeCount * 3)
    expect(realModel.nodeArrowMatrices.length).toBe(d.nodeArrowCount * 16)
    expect(realModel.nodeArrowColors.length).toBe(d.nodeArrowCount * 3)
    expect(realModel.edgeArrowMatrices.length).toBe(d.edgeArrowCount * 16)
    expect(realModel.edgeArrowColors.length).toBe(d.edgeArrowCount * 3)
    expect(realModel.ribbonPositions.length).toBe(d.ribbonVertexCount * 3)
    expect(realModel.ribbonColors.length).toBe(d.ribbonVertexCount * 3)
    expect(realModel.labels.length).toBe(d.labelCandidateCount)
  })

  test('ribbonVertexCount = 48669（2934 LINE × 6 + 109 BEZIER × 285）', () => {
    expect(realModel.diagnostics.ribbonVertexCount).toBe(48669)
  })

  test('labelCandidateCount = nodeCount + edgeArrowCount（边数认知一致）', () => {
    const d = realModel.diagnostics
    expect(d.labelCandidateCount).toBe(d.nodeCount + d.edgeArrowCount)
  })
})

describe('真实样本场景模型 · 有限性与颜色范围（SPEC 5.2 / 7.3 / 16）', () => {
  test('全部矩阵元素为有限数（无 NaN / Infinity）', () => {
    const matrices: readonly Float32Array[] = [
      realModel.nodeMatrices,
      realModel.nodeArrowMatrices,
      realModel.edgeArrowMatrices,
    ]
    // 扫描收集首个违规，避免逐元素 expect 造成性能瓶颈。
    let violation: { arr: string; index: number; value: number } | null = null
    for (const arr of matrices) {
      for (let i = 0; i < arr.length; i++) {
        if (!Number.isFinite(arr[i])) {
          violation = { arr: arr.constructor.name, index: i, value: arr[i] }
          break
        }
      }
      if (violation) break
    }
    expect(violation).toBe(null)
  })

  test('ribbonPositions 全部为有限数', () => {
    let violation: { index: number; value: number } | null = null
    for (let i = 0; i < realModel.ribbonPositions.length; i++) {
      if (!Number.isFinite(realModel.ribbonPositions[i])) {
        violation = { index: i, value: realModel.ribbonPositions[i] }
        break
      }
    }
    expect(violation).toBe(null)
  })

  test('全部颜色为有限数且位于线性 sRGB [0, 1]', () => {
    const colors: ReadonlyArray<readonly [Float32Array, string]> = [
      [realModel.nodeColors, 'nodeColors'],
      [realModel.nodeArrowColors, 'nodeArrowColors'],
      [realModel.edgeArrowColors, 'edgeArrowColors'],
      [realModel.ribbonColors, 'ribbonColors'],
    ]
    // 扫描收集首个违规（非有限或超范围），避免逐元素多次 expect 造成性能瓶颈。
    let violation: { arr: string; index: number; value: number } | null = null
    for (const [arr, name] of colors) {
      for (let i = 0; i < arr.length; i++) {
        const v = arr[i]
        if (!Number.isFinite(v) || v < -1e-6 || v > 1 + 1e-6) {
          violation = { arr: name, index: i, value: v }
          break
        }
      }
      if (violation) break
    }
    expect(violation).toBe(null)
  })

  test('全部标签锚点 / 偏移为有限数', () => {
    let violation: { labelId: string; field: string; value: number } | null = null
    for (const label of realModel.labels) {
      const fields: ReadonlyArray<readonly [string, number]> = [
        ['anchorX', label.anchorX],
        ['anchorY', label.anchorY],
        ['anchorZ', label.anchorZ],
        ['localOffsetX', label.localOffsetX],
        ['localOffsetY', label.localOffsetY],
      ]
      for (const [field, value] of fields) {
        if (!Number.isFinite(value)) {
          violation = { labelId: label.id, field, value }
          break
        }
      }
      if (violation) break
    }
    expect(violation).toBe(null)
  })
})

describe('真实样本场景模型 · contentBounds 逐项覆盖真实几何（SPEC 12.1 / 16）', () => {
  test('contentBounds 与独立重算结果在六个分量上一致', () => {
    const expected = computeExpectedContentBounds(realModel)
    const actual = realModel.contentBounds
    // 独立重算用 number 精度，模型 bounds 来自子系统 Float32 累计；Float32 精度内逐项一致。
    expect(actual.minX).toBeCloseTo(expected.minX, 4)
    expect(actual.minY).toBeCloseTo(expected.minY, 4)
    expect(actual.minZ).toBeCloseTo(expected.minZ, 4)
    expect(actual.maxX).toBeCloseTo(expected.maxX, 4)
    expect(actual.maxY).toBeCloseTo(expected.maxY, 4)
    expect(actual.maxZ).toBeCloseTo(expected.maxZ, 4)
  })

  test('contentBounds 满足有限性与 min ≤ max', () => {
    const b = realModel.contentBounds
    expect(Number.isFinite(b.minX)).toBe(true)
    expect(Number.isFinite(b.minY)).toBe(true)
    expect(Number.isFinite(b.minZ)).toBe(true)
    expect(Number.isFinite(b.maxX)).toBe(true)
    expect(Number.isFinite(b.maxY)).toBe(true)
    expect(Number.isFinite(b.maxZ)).toBe(true)
    expect(b.minX).toBeLessThanOrEqual(b.maxX)
    expect(b.minY).toBeLessThanOrEqual(b.maxY)
    expect(b.minZ).toBeLessThanOrEqual(b.maxZ)
  })

  test('contentBounds 覆盖样本基准范围（宽 ≈ 167.84m，深 ≈ 75.32m）', () => {
    const b = realModel.contentBounds
    const width = b.maxX - b.minX
    const depth = b.maxZ - b.minZ
    // SPEC 6.2：转换后节点基准范围约 sceneX ∈ [-83.92, 83.92]、sceneZ ∈ [-37.66, 37.66]。
    // contentBounds 含节点半径 / ribbon 半宽 / 箭头，略宽于节点基准，允许 ±2m 容差。
    expect(width).toBeGreaterThan(167.84 - 2)
    expect(width).toBeLessThan(167.84 + 2)
    expect(depth).toBeGreaterThan(75.32 - 2)
    expect(depth).toBeLessThan(75.32 + 2)
  })

  test('contentBounds.minY 接近 ribbon Y（0），maxY 接近节点箭头 Y（0.066）', () => {
    // ribbon Y = 0 是最低实体层；节点箭头 Y = 0.066 是最高实体层（不含标签）。
    expect(realModel.contentBounds.minY).toBeGreaterThanOrEqual(0)
    expect(realModel.contentBounds.minY).toBeLessThan(0.02)
    expect(realModel.contentBounds.maxY).toBeCloseTo(NODE_ARROW_Y, 5)
  })

  test('contentBounds 排除标签锚点（maxY < Label Anchor Y = 0.250）', () => {
    // 标签锚点 Y = 0.250 是最高实体；contentBounds.maxY ≈ 0.066，证明标签不进入 bounds。
    expect(realModel.contentBounds.maxY).toBeLessThan(LABEL_ANCHOR_Y)
  })
})

describe('真实样本场景模型 · 可转移缓冲区契约（SPEC 4.1）', () => {
  test('枚举 8 个唯一 ArrayBuffer，对应全部最终 typed array', () => {
    const buffers = collectTransferableBuffers(realModel)
    expect(buffers.length).toBe(8)
    expect(new Set(buffers).size).toBe(8)
    const expected: readonly Float32Array[] = [
      realModel.nodeMatrices,
      realModel.nodeColors,
      realModel.nodeArrowMatrices,
      realModel.nodeArrowColors,
      realModel.edgeArrowMatrices,
      realModel.edgeArrowColors,
      realModel.ribbonPositions,
      realModel.ribbonColors,
    ]
    for (let i = 0; i < expected.length; i++) {
      expect(buffers[i]).toBe(expected[i].buffer)
      expect(buffers[i]).toBeInstanceOf(ArrayBuffer)
    }
  })
})
