/*
 * 节点本体实例数据自动化验证（TASK-008，SPEC 2.2 / 5.2 / 7.1 / 7.2 / 8.1 / 15.2 / 15.3 / 16）。
 *
 * 设计：
 *   - 合成 SceneNode 用于精确矩阵与颜色断言：列主序 T × R × S、平移位于 12/13/14、
 *     Y 不被半径缩放、四类半径与线性颜色、实例中心 Y 0.035。
 *   - 错误实现识别：本组断言以正确实现为基准，行主序、错误组合顺序、Y 被半径缩放、
 *     sRGB 直接除以 255、重复坐标转换等错误实现都会让对应断言失败。
 *   - 异常路径：未知节点类型 → MAP_ENTITY_INVALID；非有限位置 / 颜色 / 矩阵
 *     → MAP_GEOMETRY_INVALID；均整体拒绝，不输出部分数组。
 *   - 真实样本集成：先校验 SHA-256，再走完整可信链到 buildNodeInstanceData，
 *     断言 1767 节点、矩阵 1767×16、颜色 1767×3、全部有限、四色齐全；按完整 ID 查询
 *     固定普通节点与中文充电节点，交叉验证场景平移、半径缩放与线性颜色。
 *
 * 不启动浏览器：合成测试只调纯函数；真实样本在 node 环境直接读取，不接触 Three / React。
 */
import { describe, test, expect, beforeAll } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildNodeInstanceData } from '../../src/geometry/nodeInstanceData'
import type { NodeInstanceData } from '../../src/geometry/nodeInstanceData'
import { hexToLinearRGB, srgbByteToLinear } from '../../src/geometry/colorSpace'
import { isMapDataError, MapErrorCode } from '../../src/domain/mapDataError'
import type { SceneMap, SceneNode } from '../../src/domain/sceneMap'
import { parseSampleEnvelope } from '../../src/adapters/parseSampleEnvelope'
import { validateMapSemantics } from '../../src/adapters/validateMapSemantics'
import { normalizeSceneMap } from '../../src/adapters/normalizeSceneMap'
import {
  computeFileSha256,
  EXPECTED_SAMPLE_SHA256,
} from '../../scripts/sample-supply-chain.mjs'
import { FIXED_ENTITIES, SAMPLE_NODE_COUNTS } from '../fixture/sampleBaseline'

/*
 * 合成 SceneNode 构造工具：默认普通节点 angle = null，便于覆盖普通节点路径。
 * 字段缺省时回退到合法默认值；测试通过 overrides 注入所需类型 / 坐标 / angle。
 */
function sceneNode(overrides: Partial<SceneNode> & { id: string }): SceneNode {
  return {
    id: overrides.id,
    name: overrides.name ?? 'n',
    type: overrides.type ?? 'node',
    position: overrides.position ?? { x: 0, z: 0 },
    angle: overrides.angle ?? null,
  }
}

/*
 * 捕获预期抛出的异常；未抛出时失败，便于在断言里复用。
 */
function captureError(fn: () => unknown): unknown {
  try {
    fn()
  } catch (e) {
    return e
  }
  throw new Error('期望抛出异常，但未抛出')
}

/*
 * 取第 i 个节点的 16 元素矩阵（列主序）。
 */
function matrixOf(data: NodeInstanceData, i: number): number[] {
  const m = i * 16
  return Array.from(data.matrices.subarray(m, m + 16))
}

/*
 * 取第 i 个节点的线性颜色三元组。
 */
function colorOf(
  data: NodeInstanceData,
  i: number,
): readonly [number, number, number] {
  const c = i * 3
  return [data.colors[c], data.colors[c + 1], data.colors[c + 2]]
}

// ─── 合成：计数、长度与 typed array 契约（SPEC 5.2 / 8.1 / 15.3）──────────────

describe('节点实例数据 · 计数与长度契约（SPEC 5.2 / 8.1）', () => {
  test('matrices 长度 = nodeCount × 16，colors 长度 = nodeCount × 3', () => {
    const nodes = [
      sceneNode({ id: 'a', type: 'node', position: { x: 0, z: 0 } }),
      sceneNode({ id: 'b', type: 'work', position: { x: 1, z: 1 } }),
      sceneNode({ id: 'c', type: 'park', position: { x: 2, z: 2 } }),
    ]
    const data = buildNodeInstanceData(nodes)
    expect(data.nodeCount).toBe(3)
    expect(data.matrices.length).toBe(3 * 16)
    expect(data.colors.length).toBe(3 * 3)
    expect(data.matrices).toBeInstanceOf(Float32Array)
    expect(data.colors).toBeInstanceOf(Float32Array)
  })

  test('空节点集合产出空 typed array 与 0 计数', () => {
    const data = buildNodeInstanceData([])
    expect(data.nodeCount).toBe(0)
    expect(data.matrices.length).toBe(0)
    expect(data.colors.length).toBe(0)
  })
})

// ─── 合成：矩阵列主序 T × R × S（SPEC 5.2 / 8.1）──────────────────────────────

describe('节点矩阵 · 列主序 T × R × S，节点本体 R = I（SPEC 5.2 / 8.1）', () => {
  test('普通节点：缩放在对角 0/5/10，平移在 12/13/14，Y 不被半径缩放', () => {
    // 位置 (5, 7)、type node → radius 0.10。
    const data = buildNodeInstanceData([
      sceneNode({ id: 'n1', type: 'node', position: { x: 5, z: 7 } }),
    ])
    const m = matrixOf(data, 0)
    // 列主序期望：
    //   列0 [r,0,0,0]  列1 [0,1,0,0]  列2 [0,0,r,0]  列3 [tx,ty,tz,1]
    expect(m[0]).toBeCloseTo(0.1, 6) // X 缩放 = radius
    expect(m[5]).toBe(1) // Y 缩放 = 1（不被半径缩放）
    expect(m[10]).toBeCloseTo(0.1, 6) // Z 缩放 = radius
    expect(m[12]).toBeCloseTo(5, 6) // 平移 X = sceneX
    expect(m[13]).toBeCloseTo(0.035, 6) // 平移 Y = 实例中心 Y
    expect(m[14]).toBeCloseTo(7, 6) // 平移 Z = sceneZ
    expect(m[15]).toBe(1) // 齐次 1
    // 其余分量恒为 0（无旋转、无非对角缩放）。
    expect(m[1]).toBe(0)
    expect(m[2]).toBe(0)
    expect(m[3]).toBe(0)
    expect(m[4]).toBe(0)
    expect(m[6]).toBe(0)
    expect(m[7]).toBe(0)
    expect(m[8]).toBe(0)
    expect(m[9]).toBe(0)
    expect(m[11]).toBe(0)
  })

  test('完整 16 元素矩阵等于列主序 T × S 数组（识别行主序错误实现）', () => {
    const data = buildNodeInstanceData([
      sceneNode({ id: 'n1', type: 'work', position: { x: -3, z: 4 } }),
    ])
    // type work → radius 0.15；位置 (-3, 4)。
    // 行主序实现会把平移放到索引 3/7/11，本断言会因此失败。
    const expected = [
      0.15, 0, 0, 0,
      0, 1, 0, 0,
      0, 0, 0.15, 0,
      -3, 0.035, 4, 1,
    ]
    const m = matrixOf(data, 0)
    for (let i = 0; i < 16; i++) {
      expect(m[i]).toBeCloseTo(expected[i], 6)
    }
  })

  test('Y 缩放恒为 1：work/park/charge 三类大半径节点 Y 仍不缩放', () => {
    const data = buildNodeInstanceData([
      sceneNode({ id: 'w', type: 'work', position: { x: 0, z: 0 } }),
      sceneNode({ id: 'p', type: 'park', position: { x: 0, z: 0 } }),
      sceneNode({ id: 'c', type: 'charge', position: { x: 0, z: 0 } }),
    ])
    // Y 被半径缩放的错误实现会让 m[5] = 0.15；这里三类都必须为 1。
    expect(matrixOf(data, 0)[5]).toBe(1)
    expect(matrixOf(data, 1)[5]).toBe(1)
    expect(matrixOf(data, 2)[5]).toBe(1)
    // X / Z 缩放为 0.15。
    expect(matrixOf(data, 0)[0]).toBeCloseTo(0.15, 6)
    expect(matrixOf(data, 0)[10]).toBeCloseTo(0.15, 6)
  })

  test('实例中心 Y 固定 0.035：四类节点平移 Y 一致', () => {
    const data = buildNodeInstanceData([
      sceneNode({ id: 'n', type: 'node', position: { x: 0, z: 0 } }),
      sceneNode({ id: 'w', type: 'work', position: { x: 0, z: 0 } }),
      sceneNode({ id: 'p', type: 'park', position: { x: 0, z: 0 } }),
      sceneNode({ id: 'c', type: 'charge', position: { x: 0, z: 0 } }),
    ])
    for (let i = 0; i < 4; i++) {
      expect(matrixOf(data, i)[13]).toBeCloseTo(0.035, 6)
    }
  })

  test('angle 不烘焙进节点本体矩阵：非普通节点带角度时旋转仍为单位', () => {
    // work 节点带 angle = π/2；节点本体矩阵不得包含该旋转（angle 留给箭头 TASK）。
    const data = buildNodeInstanceData([
      sceneNode({
        id: 'w',
        type: 'work',
        position: { x: 2, z: 3 },
        angle: Math.PI / 2,
      }),
    ])
    const m = matrixOf(data, 0)
    // 旋转恒为单位：无非对角分量，对角缩放仍为 radius/1/radius。
    expect(m[1]).toBe(0)
    expect(m[2]).toBe(0)
    expect(m[4]).toBe(0)
    expect(m[6]).toBe(0)
    expect(m[8]).toBe(0)
    expect(m[9]).toBe(0)
    expect(m[0]).toBeCloseTo(0.15, 6)
    expect(m[5]).toBe(1)
    expect(m[10]).toBeCloseTo(0.15, 6)
  })

  test('普通节点 angle = null：本体数据成功生成，无旋转、无箭头占位数据', () => {
    // 普通 node 的 angle = null 不得替换为零或烘焙旋转；输出仅含 count×16 / count×3。
    const data = buildNodeInstanceData([
      sceneNode({ id: 'n', type: 'node', position: { x: 1, z: 1 }, angle: null }),
    ])
    expect(data.nodeCount).toBe(1)
    expect(data.matrices.length).toBe(16)
    expect(data.colors.length).toBe(3)
    const m = matrixOf(data, 0)
    // 无旋转分量；angle = null 不影响本体矩阵。
    expect(m[1]).toBe(0)
    expect(m[2]).toBe(0)
    expect(m[4]).toBe(0)
    expect(m[6]).toBe(0)
    expect(m[8]).toBe(0)
    expect(m[9]).toBe(0)
  })

  test('坐标直接来自 SceneNode.position，不做第二次转换', () => {
    // 位置 (12.34, -56.78)；矩阵平移必须逐位等于输入场景坐标。
    // 重复转换（如再次 +81.82 或再次取负）会让本断言失败。
    const data = buildNodeInstanceData([
      sceneNode({
        id: 'n',
        type: 'node',
        position: { x: 12.34, z: -56.78 },
      }),
    ])
    const m = matrixOf(data, 0)
    expect(m[12]).toBeCloseTo(12.34, 5)
    expect(m[14]).toBeCloseTo(-56.78, 5)
  })
})

// ─── 合成：四类半径（SPEC 7.1 / 8.1）──────────────────────────────────────────

describe('节点半径 · 按类型固定（SPEC 7.1 / 8.1）', () => {
  test('普通节点半径 0.10m；work/park/charge 半径 0.15m', () => {
    const data = buildNodeInstanceData([
      sceneNode({ id: 'n', type: 'node', position: { x: 0, z: 0 } }),
      sceneNode({ id: 'w', type: 'work', position: { x: 0, z: 0 } }),
      sceneNode({ id: 'p', type: 'park', position: { x: 0, z: 0 } }),
      sceneNode({ id: 'c', type: 'charge', position: { x: 0, z: 0 } }),
    ])
    expect(matrixOf(data, 0)[0]).toBeCloseTo(0.1, 6)
    expect(matrixOf(data, 1)[0]).toBeCloseTo(0.15, 6)
    expect(matrixOf(data, 2)[0]).toBeCloseTo(0.15, 6)
    expect(matrixOf(data, 3)[0]).toBeCloseTo(0.15, 6)
    // X / Z 缩放一致。
    for (let i = 0; i < 4; i++) {
      expect(matrixOf(data, i)[0]).toBeCloseTo(matrixOf(data, i)[10], 6)
    }
  })
})

// ─── 合成：线性颜色（SPEC 5.2 / 7.2 / 7.3）────────────────────────────────────

describe('节点颜色 · 四类线性 sRGB（SPEC 5.2 / 7.2 / 7.3）', () => {
  test('四类颜色等于 SPEC hex 经 transfer function 的线性值', () => {
    const data = buildNodeInstanceData([
      sceneNode({ id: 'n', type: 'node', position: { x: 0, z: 0 } }),
      sceneNode({ id: 'w', type: 'work', position: { x: 0, z: 0 } }),
      sceneNode({ id: 'p', type: 'park', position: { x: 0, z: 0 } }),
      sceneNode({ id: 'c', type: 'charge', position: { x: 0, z: 0 } }),
    ])
    const expected = {
      node: hexToLinearRGB('#78909C'),
      work: hexToLinearRGB('#2196F3'),
      park: hexToLinearRGB('#F44336'),
      charge: hexToLinearRGB('#8BC34A'),
    }
    const nodeColor = colorOf(data, 0)
    const workColor = colorOf(data, 1)
    const parkColor = colorOf(data, 2)
    const chargeColor = colorOf(data, 3)
    for (let k = 0; k < 3; k++) {
      expect(nodeColor[k]).toBeCloseTo(expected.node[k], 6)
      expect(workColor[k]).toBeCloseTo(expected.work[k], 6)
      expect(parkColor[k]).toBeCloseTo(expected.park[k], 6)
      expect(chargeColor[k]).toBeCloseTo(expected.charge[k], 6)
    }
  })

  test('颜色不是 8-bit sRGB 直接除以 255（识别错误色彩空间）', () => {
    // #78909C：R=120 → 120/255 ≈ 0.4706；线性值 ≈ 0.1842，明显小于 0.4706。
    const data = buildNodeInstanceData([
      sceneNode({ id: 'n', type: 'node', position: { x: 0, z: 0 } }),
    ])
    const linearR = colorOf(data, 0)[0]
    expect(linearR).toBeCloseTo(srgbByteToLinear(120), 6)
    expect(linearR).not.toBeCloseTo(120 / 255, 3)
    expect(linearR).toBeLessThan(120 / 255)
  })

  test('全部颜色分量位于线性 [0,1] 区间且有限', () => {
    const data = buildNodeInstanceData([
      sceneNode({ id: 'n', type: 'node', position: { x: 0, z: 0 } }),
      sceneNode({ id: 'w', type: 'work', position: { x: 0, z: 0 } }),
      sceneNode({ id: 'p', type: 'park', position: { x: 0, z: 0 } }),
      sceneNode({ id: 'c', type: 'charge', position: { x: 0, z: 0 } }),
    ])
    for (let i = 0; i < data.colors.length; i++) {
      expect(data.colors[i]).toBeGreaterThanOrEqual(0)
      expect(data.colors[i]).toBeLessThanOrEqual(1)
      expect(Number.isFinite(data.colors[i])).toBe(true)
    }
  })

  test('全部矩阵元素为有限数', () => {
    const data = buildNodeInstanceData([
      sceneNode({ id: 'n', type: 'node', position: { x: 1, z: 2 } }),
      sceneNode({ id: 'w', type: 'work', position: { x: -1, z: -2 } }),
    ])
    for (let i = 0; i < data.matrices.length; i++) {
      expect(Number.isFinite(data.matrices[i])).toBe(true)
    }
  })
})

// ─── 异常路径 · 整体拒绝（SPEC 5.3 / 14.1 / 16）──────────────────────────────

describe('节点实例异常路径 · 整体拒绝（SPEC 14.1 / 16）', () => {
  test('未知节点类型 → MAP_ENTITY_INVALID，不输出部分数组', () => {
    // 绕过类型边界注入样本不存在的旧类型 warehouse。
    const bad = {
      id: 'x',
      name: 'x',
      type: 'warehouse',
      position: { x: 0, z: 0 },
      angle: null,
    } as unknown as SceneNode
    const err = captureError(() => buildNodeInstanceData([bad])) as Error
    expect(isMapDataError(err)).toBe(true)
    if (isMapDataError(err)) {
      expect(err.code).toBe(MapErrorCode.MAP_ENTITY_INVALID)
      expect(err.entityId).toBe('x')
    }
  })

  test('非有限 X 坐标 → MAP_GEOMETRY_INVALID', () => {
    const err = captureError(() =>
      buildNodeInstanceData([
        sceneNode({
          id: 'n',
          type: 'node',
          position: { x: Number.NaN, z: 0 },
        }),
      ]),
    ) as Error
    expect(isMapDataError(err)).toBe(true)
    if (isMapDataError(err)) {
      expect(err.code).toBe(MapErrorCode.MAP_GEOMETRY_INVALID)
    }
  })

  test('非有限 Z 坐标（Infinity）→ MAP_GEOMETRY_INVALID', () => {
    const err = captureError(() =>
      buildNodeInstanceData([
        sceneNode({
          id: 'n',
          type: 'node',
          position: { x: 0, z: Number.POSITIVE_INFINITY },
        }),
      ]),
    ) as Error
    expect(isMapDataError(err)).toBe(true)
    if (isMapDataError(err)) {
      expect(err.code).toBe(MapErrorCode.MAP_GEOMETRY_INVALID)
    }
  })

  test('多节点中第 i 个非有限 → 整体失败，不输出部分数组', () => {
    const err = captureError(() =>
      buildNodeInstanceData([
        sceneNode({ id: 'a', type: 'node', position: { x: 0, z: 0 } }),
        sceneNode({ id: 'b', type: 'work', position: { x: 1, z: 1 } }),
        sceneNode({
          id: 'c',
          type: 'park',
          position: { x: Number.NaN, z: 1 },
        }),
      ]),
    ) as Error
    expect(isMapDataError(err)).toBe(true)
    if (isMapDataError(err)) {
      expect(err.code).toBe(MapErrorCode.MAP_GEOMETRY_INVALID)
      expect(err.entityId).toBe('c')
    }
  })
})

// ─── 真实样本集成（SPEC 15.1 / 15.3 / 16）──────────────────────────────────────

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '..', '..')
const REAL_SAMPLE = resolve(root, 'data', 'sampleMap.json')

let sceneMap!: SceneMap
let nodeData!: NodeInstanceData
let nodeIndex!: Map<string, number>

beforeAll(async () => {
  // SPEC 15.1：哈希不符必须立即终止回归验证。
  const sha = await computeFileSha256(REAL_SAMPLE)
  if (sha !== EXPECTED_SAMPLE_SHA256) {
    throw new Error(`样本身份不符，停止回归验证：${sha}`)
  }
  const rawJson = JSON.parse(readFileSync(REAL_SAMPLE, 'utf8')) as unknown
  const rawMap = parseSampleEnvelope(rawJson)
  validateMapSemantics(rawMap)
  sceneMap = normalizeSceneMap(rawMap)
  nodeData = buildNodeInstanceData(sceneMap.nodes)
  nodeIndex = new Map(
    sceneMap.nodes.map((node, i) => [node.id, i]),
  )
})

describe('真实样本节点实例 · 规模与有限性（SPEC 2.2 / 5.2 / 15.3）', () => {
  test('1767 节点，矩阵 1767×16，颜色 1767×3', () => {
    expect(nodeData.nodeCount).toBe(SAMPLE_NODE_COUNTS.total)
    expect(nodeData.nodeCount).toBe(1767)
    expect(nodeData.matrices.length).toBe(1767 * 16)
    expect(nodeData.colors.length).toBe(1767 * 3)
  })

  test('全部矩阵与颜色元素为有限数', () => {
    for (let i = 0; i < nodeData.matrices.length; i++) {
      expect(Number.isFinite(nodeData.matrices[i])).toBe(true)
    }
    for (let i = 0; i < nodeData.colors.length; i++) {
      expect(Number.isFinite(nodeData.colors[i])).toBe(true)
    }
  })

  test('全部颜色位于线性 [0,1]，且只出现四类节点色', () => {
    const expected = new Set(
      [
        hexToLinearRGB('#78909C'),
        hexToLinearRGB('#2196F3'),
        hexToLinearRGB('#F44336'),
        hexToLinearRGB('#8BC34A'),
      ].map((c) => `${c[0].toFixed(6)},${c[1].toFixed(6)},${c[2].toFixed(6)}`),
    )
    const seen = new Set<string>()
    for (let i = 0; i < nodeData.nodeCount; i++) {
      const col = colorOf(nodeData, i)
      for (let k = 0; k < 3; k++) {
        expect(col[k]).toBeGreaterThanOrEqual(0)
        expect(col[k]).toBeLessThanOrEqual(1)
      }
      seen.add(`${col[0].toFixed(6)},${col[1].toFixed(6)},${col[2].toFixed(6)}`)
    }
    // 四类颜色全部出现（样本含全部四类节点）。
    expect(seen.size).toBe(4)
    for (const key of expected) {
      expect(seen.has(key)).toBe(true)
    }
  })

  test('每个实例矩阵平移 Y 恒为 0.035、缩放 Y 恒为 1', () => {
    for (let i = 0; i < nodeData.nodeCount; i++) {
      expect(nodeData.matrices[i * 16 + 13]).toBeCloseTo(0.035, 6)
      expect(nodeData.matrices[i * 16 + 5]).toBe(1)
    }
  })

  test('矩阵平移 X/Z 逐位等于 SceneNode 场景坐标（无重复转换）', () => {
    for (let i = 0; i < nodeData.nodeCount; i++) {
      const node = sceneMap.nodes[i]
      expect(nodeData.matrices[i * 16 + 12]).toBeCloseTo(node.position.x, 5)
      expect(nodeData.matrices[i * 16 + 14]).toBeCloseTo(node.position.z, 5)
    }
  })

  test('矩阵无非对角旋转分量（angle 不烘焙进本体）', () => {
    // 全部 1767 节点本体矩阵的旋转分量恒为 0。
    for (let i = 0; i < nodeData.nodeCount; i++) {
      const m = i * 16
      expect(nodeData.matrices[m + 1]).toBe(0)
      expect(nodeData.matrices[m + 2]).toBe(0)
      expect(nodeData.matrices[m + 4]).toBe(0)
      expect(nodeData.matrices[m + 6]).toBe(0)
      expect(nodeData.matrices[m + 8]).toBe(0)
      expect(nodeData.matrices[m + 9]).toBe(0)
      expect(nodeData.matrices[m + 3]).toBe(0)
      expect(nodeData.matrices[m + 7]).toBe(0)
      expect(nodeData.matrices[m + 11]).toBe(0)
      expect(nodeData.matrices[m + 15]).toBe(1)
    }
  })
})

describe('真实样本节点实例 · 固定回归实体（SPEC 2.6 / 6.2 / 7.1 / 7.2）', () => {
  test('普通节点 d0f03a8c...：场景平移 (81.98, 33.83)、半径 0.10、#78909C 线性', () => {
    const id = FIXED_ENTITIES.normalNode.id
    const idx = nodeIndex.get(id)
    expect(idx).toBeDefined()
    const node = sceneMap.nodes[idx!]
    // SPEC 6.2 固定场景点：(81.98, 33.83)。
    expect(node.position.x).toBeCloseTo(81.98, 2)
    expect(node.position.z).toBeCloseTo(33.83, 2)

    const m = matrixOf(nodeData, idx!)
    // 平移位于索引 12 / 13 / 14（列主序）；行主序实现会落在 3 / 7 / 11。
    expect(m[12]).toBeCloseTo(81.98, 2)
    expect(m[13]).toBeCloseTo(0.035, 6)
    expect(m[14]).toBeCloseTo(33.83, 2)
    // 普通节点半径 0.10；Y 不缩放。
    expect(m[0]).toBeCloseTo(0.1, 6)
    expect(m[5]).toBe(1)
    expect(m[10]).toBeCloseTo(0.1, 6)

    const expected = hexToLinearRGB('#78909C')
    const col = colorOf(nodeData, idx!)
    for (let k = 0; k < 3; k++) {
      expect(col[k]).toBeCloseTo(expected[k], 6)
    }
  })

  test('中文充电节点 178744a4...：场景平移 (-57.53, -1.06)、半径 0.15、#8BC34A 线性', () => {
    const id = FIXED_ENTITIES.chineseChargeNode.id
    const idx = nodeIndex.get(id)
    expect(idx).toBeDefined()
    const node = sceneMap.nodes[idx!]
    // SPEC 6.2 固定场景点：(-57.53, -1.06)。
    expect(node.position.x).toBeCloseTo(-57.53, 2)
    expect(node.position.z).toBeCloseTo(-1.06, 2)

    const m = matrixOf(nodeData, idx!)
    expect(m[12]).toBeCloseTo(-57.53, 2)
    expect(m[13]).toBeCloseTo(0.035, 6)
    expect(m[14]).toBeCloseTo(-1.06, 2)
    // 充电节点半径 0.15；Y 不缩放。
    expect(m[0]).toBeCloseTo(0.15, 6)
    expect(m[5]).toBe(1)
    expect(m[10]).toBeCloseTo(0.15, 6)

    const expected = hexToLinearRGB('#8BC34A')
    const col = colorOf(nodeData, idx!)
    for (let k = 0; k < 3; k++) {
      expect(col[k]).toBeCloseTo(expected[k], 6)
    }
  })

  test('四类节点按类型分布的半径缩放与颜色与样本计数一致', () => {
    // 按矩阵 X 缩放归类半径，验证四类节点数量与 SAMPLE_NODE_COUNTS 一致。
    const byRadius = new Map<number, number>()
    for (let i = 0; i < nodeData.nodeCount; i++) {
      const r = Number(nodeData.matrices[i * 16].toFixed(6))
      byRadius.set(r, (byRadius.get(r) ?? 0) + 1)
    }
    // 0.10 → 普通节点 1303；0.15 → work+park+charge = 389+64+11 = 464。
    expect(byRadius.get(0.1)).toBe(SAMPLE_NODE_COUNTS.node)
    expect(byRadius.get(0.15)).toBe(
      SAMPLE_NODE_COUNTS.work +
        SAMPLE_NODE_COUNTS.park +
        SAMPLE_NODE_COUNTS.charge,
    )
  })
})
