/*
 * Three 资源适配自动化验证（TASK-014，SPEC 3.3 / 4.3 / 5.2 / 7.3 / 7.4 / 8 / 9 / 10 / 13 / 15.3 / 16）。
 *
 * 设计：
 *   - 合成 SceneMap 经 buildSceneModel 得到自校验 SceneModel，再走 createMapResources，
 *     断言四类资源数量、属性长度、材质参数、深度、polygon offset、renderOrder、实例矩阵 / 实例色。
 *   - ribbon boundingBox / boundingSphere 与从 typed array 独立重算的纯数值结果逐项一致。
 *   - 幂等释放：连续创建 / 释放 20 次后重复释放同一集合，每个可释放资源恰好清理一次、不抛异常。
 *   - 异常路径：长度不一致、NaN / Infinity、缺失缓冲区、已转移（分离）缓冲区 → MAP_GEOMETRY_INVALID 整体拒绝。
 *   - 真实样本集成：先校验 SHA-256，走完整可信链到 createMapResources，交叉断言 1767 / 464 / 3043
 *     与材质 / renderOrder / ribbon bounds。
 *   - 跨层一致性：rendering 基准三角形顶点与 geometry 层导出值逐项相等，杜绝绕序漂移。
 *
 * 不启动浏览器：合成与真实样本测试只调纯函数 + Three 资源构造（node 环境无 WebGL 亦可）。
 */
import { describe, test, expect, beforeAll } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import * as THREE from 'three'
import { createMapResources } from '../../src/rendering/mapResources'
import type { MapResources } from '../../src/rendering/mapResources'
import { ResourceRegistry } from '../../src/rendering/resourceRegistry'
import {
  NODE_ARROW_VERTICES as RENDER_NODE_ARROW_VERTICES,
  EDGE_ARROW_VERTICES as RENDER_EDGE_ARROW_VERTICES,
} from '../../src/rendering/baseGeometry'
import { NODE_ARROW_VERTICES } from '../../src/geometry/nodeArrowData'
import { EDGE_ARROW_VERTICES } from '../../src/geometry/edgeArrowData'
import { buildSceneModel } from '../../src/workers/buildSceneModel'
import type { SceneModel } from '../../src/workers/buildSceneModel'
import {
  RENDER_ORDER,
  RIBBON_MATERIAL_PARAMS,
  NODE_MATERIAL_PARAMS,
  ARROW_MATERIAL_PARAMS,
  DEPTH_POLICY,
  LAYER_Y,
} from '../../src/config/mapVisualConfig'
import { isMapDataError, MapErrorCode } from '../../src/domain/mapDataError'
import type {
  MapTransform,
  SceneEdge,
  SceneLineEdge,
  SceneMap,
  SceneNode,
  SourceBounds2D,
} from '../../src/domain/sceneMap'
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
} from '../fixture/sampleBaseline'

// ─── 合成场景（SPEC 5.2 / 6.2）──────────────────────────────────────────────

/*
 * 合成节点：默认普通节点位于原点；作业节点带有限 angle 以触发节点箭头。
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
 * 合成 SceneMap：3 节点（1 普通 + 2 作业节点）+ 2 LINE 边，origin=(0,0)。
 * 产出 nodeCount=3、nodeArrowCount=2、edgeArrowCount=2、ribbon 顶点 > 0 的自校验模型。
 */
function buildSyntheticSceneMap(): SceneMap {
  const transform: MapTransform = {
    absoluteWorldOriginX: 0,
    absoluteWorldOriginZ: 0,
  }
  const sourceBounds: SourceBounds2D = { minX: 0, maxX: 8, minY: 0, maxY: 0 }
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
    metadata: { mapId: 'm1', mapName: '合成', version: 'V1' },
    transform,
    sourceBounds,
    nodes,
    edges,
  }
}

/*
 * 从 typed array 独立重算 ribbon 数值 bounds（SPEC 9.4 / 任务“ribbon bounds 与数值一致”）。
 * 几何层 ribbon 顶点 y 恒为 0，故 minY = maxY = 0；与 BufferGeometry.boundingBox 比对。
 */
function computeNumericRibbonBounds(positions: Float32Array): {
  readonly min: THREE.Vector3
  readonly max: THREE.Vector3
} {
  let minX = Infinity
  let minY = Infinity
  let minZ = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  let maxZ = -Infinity
  for (let i = 0; i < positions.length; i += 3) {
    const x = positions[i]
    const y = positions[i + 1]
    const z = positions[i + 2]
    if (x < minX) minX = x
    if (y < minY) minY = y
    if (z < minZ) minZ = z
    if (x > maxX) maxX = x
    if (y > maxY) maxY = y
    if (z > maxZ) maxZ = z
  }
  return {
    min: new THREE.Vector3(minX, minY, minZ),
    max: new THREE.Vector3(maxX, maxY, maxZ),
  }
}

/*
 * 从 typed array 独立重算 ribbon boundingSphere（center = box 中心，radius = 最远顶点到中心距离）。
 * Three computeBoundingSphere 采用同一算法；逐项比对验证球体与纯数值结果一致。
 */
function computeNumericRibbonSphere(positions: Float32Array): {
  readonly center: THREE.Vector3
  readonly radius: number
} {
  const box = computeNumericRibbonBounds(positions)
  const center = new THREE.Vector3(
    (box.min.x + box.max.x) / 2,
    (box.min.y + box.max.y) / 2,
    (box.min.z + box.max.z) / 2,
  )
  let radius = 0
  for (let i = 0; i < positions.length; i += 3) {
    const dx = positions[i] - center.x
    const dy = positions[i + 1] - center.y
    const dz = positions[i + 2] - center.z
    const d = Math.sqrt(dx * dx + dy * dy + dz * dz)
    if (d > radius) radius = d
  }
  return { center, radius }
}

/*
 * 收集一个资源集合中全部由 registry 登记的可释放 Three 对象（geometry / material / InstancedMesh）。
 * ribbon Mesh 本身不登记（无 dispose），故只取其 geometry / material。
 */
function collectRegisteredDisposables(r: MapResources): ReadonlyArray<{
  readonly obj: THREE.BufferGeometry | THREE.Material | THREE.InstancedMesh
  readonly label: string
}> {
  return [
    { obj: r.ribbon.geometry, label: 'ribbon.geometry' },
    { obj: r.ribbon.material as THREE.Material, label: 'ribbon.material' },
    { obj: r.nodes.geometry, label: 'nodes.geometry' },
    { obj: r.nodes.material as THREE.Material, label: 'nodes.material' },
    { obj: r.nodes, label: 'nodes' },
    { obj: r.nodeArrows.geometry, label: 'nodeArrows.geometry' },
    { obj: r.nodeArrows.material as THREE.Material, label: 'nodeArrows.material' },
    { obj: r.nodeArrows, label: 'nodeArrows' },
    { obj: r.edgeArrows.geometry, label: 'edgeArrows.geometry' },
    { obj: r.edgeArrows.material as THREE.Material, label: 'edgeArrows.material' },
    { obj: r.edgeArrows, label: 'edgeArrows' },
  ]
}

// ─── 资源登记器单元（SPEC 4.3 / 任务“幂等释放不变量”）─────────────────────────

describe('ResourceRegistry · 登记与幂等释放', () => {
  test('按登记逆序释放每个资源恰好一次', () => {
    const registry = new ResourceRegistry()
    const calls: string[] = []
    const a = { dispose: () => calls.push('a') }
    const b = { dispose: () => calls.push('b') }
    const c = { dispose: () => calls.push('c') }
    registry.register(a)
    registry.register(b)
    registry.register(c)
    expect(registry.size).toBe(3)
    expect(registry.isDisposed).toBe(false)

    registry.dispose()
    // 逆序：c → b → a。
    expect(calls).toEqual(['c', 'b', 'a'])
    expect(registry.isDisposed).toBe(true)
    expect(registry.size).toBe(0)

    // 重复释放：空操作，不再触发任何 dispose。
    registry.dispose()
    expect(calls).toEqual(['c', 'b', 'a'])
    expect(registry.size).toBe(0)
  })

  test('已释放后登记的新资源被立即清理，不泄漏', () => {
    const registry = new ResourceRegistry()
    registry.dispose()
    let disposed = false
    registry.register({ dispose: () => (disposed = true) })
    expect(disposed).toBe(true)
    expect(registry.size).toBe(0)
  })
})

// ─── 合成模型正常路径（SPEC 7.3 / 7.4 / 8 / 10 / 15.3）──────────────────────────

describe('createMapResources · 合成模型资源数量与参数', () => {
  let model: SceneModel
  let resources: MapResources

  beforeAll(() => {
    model = buildSceneModel(buildSyntheticSceneMap())
    resources = createMapResources(model)
  })

  test('恰好产出四类资源且实例计数与诊断一致', () => {
    expect(resources.ribbon).toBeInstanceOf(THREE.Mesh)
    expect(resources.nodes).toBeInstanceOf(THREE.InstancedMesh)
    expect(resources.nodeArrows).toBeInstanceOf(THREE.InstancedMesh)
    expect(resources.edgeArrows).toBeInstanceOf(THREE.InstancedMesh)
    expect(resources.nodes.count).toBe(model.diagnostics.nodeCount)
    expect(resources.nodes.count).toBe(3)
    expect(resources.nodeArrows.count).toBe(model.diagnostics.nodeArrowCount)
    expect(resources.nodeArrows.count).toBe(2)
    expect(resources.edgeArrows.count).toBe(model.diagnostics.edgeArrowCount)
    expect(resources.edgeArrows.count).toBe(2)
  })

  test('ribbon 非索引 BufferGeometry 属性长度与诊断一致', () => {
    const g = resources.ribbon.geometry
    const v = model.diagnostics.ribbonVertexCount
    expect(g.getAttribute('position').count).toBe(v)
    expect(g.getAttribute('color').count).toBe(v)
    expect(g.index).toBeNull()
  })

  test('实例矩阵与实例色直接消费模型 typed array（无二次变换）', () => {
    // instanceMatrix 是 InstancedMesh 内部分配的 Float32Array，经 .set() 批量拷贝模型矩阵。
    expect(arrayEqual(resources.nodes.instanceMatrix.array, model.nodeMatrices)).toBe(true)
    expect(arrayEqual(resources.nodeArrows.instanceMatrix.array, model.nodeArrowMatrices)).toBe(true)
    expect(arrayEqual(resources.edgeArrows.instanceMatrix.array, model.edgeArrowMatrices)).toBe(true)
    // instanceColor 以零拷贝方式引用模型颜色 typed array（同一 buffer）。
    expect(resources.nodes.instanceColor!.array).toBe(model.nodeColors)
    expect(resources.nodeArrows.instanceColor!.array).toBe(model.nodeArrowColors)
    expect(resources.edgeArrows.instanceColor!.array).toBe(model.edgeArrowColors)
  })

  test('ribbon 材质：vertexColors + toneMapped=false + polygonOffset（config）', () => {
    const m = resources.ribbon.material as THREE.MeshBasicMaterial
    expect(m.vertexColors).toBe(true)
    expect(m.toneMapped).toBe(RIBBON_MATERIAL_PARAMS.toneMapped)
    expect(m.polygonOffset).toBe(RIBBON_MATERIAL_PARAMS.polygonOffset)
    expect(m.polygonOffsetFactor).toBe(RIBBON_MATERIAL_PARAMS.polygonOffsetFactor)
    expect(m.polygonOffsetUnits).toBe(RIBBON_MATERIAL_PARAMS.polygonOffsetUnits)
  })

  test('节点材质：白色基色 MeshStandardMaterial × instanceColor，roughness/metalness 来自 config', () => {
    const m = resources.nodes.material as THREE.MeshStandardMaterial
    expect(m.color.getHex()).toBe(0xffffff)
    expect(m.roughness).toBe(NODE_MATERIAL_PARAMS.roughness)
    expect(m.metalness).toBe(NODE_MATERIAL_PARAMS.metalness)
  })

  test('两类箭头材质：白色基色 MeshBasicMaterial × instanceColor，toneMapped=false', () => {
    const na = resources.nodeArrows.material as THREE.MeshBasicMaterial
    const ea = resources.edgeArrows.material as THREE.MeshBasicMaterial
    expect(na.color.getHex()).toBe(0xffffff)
    expect(ea.color.getHex()).toBe(0xffffff)
    expect(na.toneMapped).toBe(ARROW_MATERIAL_PARAMS.toneMapped)
    expect(ea.toneMapped).toBe(ARROW_MATERIAL_PARAMS.toneMapped)
  })

  test('深度策略：所有实体 depthTest=true；节点箭头 depthWrite=false，其余默认 true', () => {
    expect((resources.ribbon.material as THREE.Material).depthTest).toBe(true)
    expect((resources.nodes.material as THREE.Material).depthTest).toBe(true)
    expect((resources.nodeArrows.material as THREE.Material).depthTest).toBe(true)
    expect((resources.edgeArrows.material as THREE.Material).depthTest).toBe(true)
    expect((resources.nodeArrows.material as THREE.Material).depthWrite).toBe(
      DEPTH_POLICY.nodeArrowDepthWrite,
    )
    expect((resources.nodeArrows.material as THREE.Material).depthWrite).toBe(false)
    expect((resources.nodes.material as THREE.Material).depthWrite).toBe(true)
    expect((resources.edgeArrows.material as THREE.Material).depthWrite).toBe(true)
  })

  test('renderOrder 来自 config：ribbon 10 / edgeArrow 20 / node 30 / nodeArrow 40', () => {
    expect(resources.ribbon.renderOrder).toBe(RENDER_ORDER.ribbon)
    expect(resources.edgeArrows.renderOrder).toBe(RENDER_ORDER.edgeArrow)
    expect(resources.nodes.renderOrder).toBe(RENDER_ORDER.node)
    expect(resources.nodeArrows.renderOrder).toBe(RENDER_ORDER.nodeArrow)
  })

  test('ribbon Mesh 平移到 Ribbon Y（config LAYER_Y.ribbon）', () => {
    expect(resources.ribbon.position.y).toBe(LAYER_Y.ribbon)
  })

  test('节点共享 CylinderGeometry(1,1,0.05,24)；两类箭头共享各自单位三角形', () => {
    const ng = resources.nodes.geometry as THREE.CylinderGeometry
    expect(ng.parameters.radiusTop).toBe(1)
    expect(ng.parameters.radiusBottom).toBe(1)
    expect(ng.parameters.height).toBe(0.05)
    expect(ng.parameters.radialSegments).toBe(24)
    // 三角形几何：3 顶点、非索引。
    expect(resources.nodeArrows.geometry.getAttribute('position').count).toBe(3)
    expect(resources.nodeArrows.geometry.index).toBeNull()
    expect(resources.edgeArrows.geometry.getAttribute('position').count).toBe(3)
    expect(resources.edgeArrows.geometry.index).toBeNull()
  })
})

describe('createMapResources · ribbon bounds 与纯数值结果一致', () => {
  test('boundingBox / boundingSphere 由 ribbonPositions 独立重算逐项一致', () => {
    const model = buildSceneModel(buildSyntheticSceneMap())
    const resources = createMapResources(model)
    const g = resources.ribbon.geometry
    expect(g.boundingBox).not.toBeNull()
    expect(g.boundingSphere).not.toBeNull()
    const expected = computeNumericRibbonBounds(model.ribbonPositions)
    expect(g.boundingBox!.min.x).toBeCloseTo(expected.min.x, 5)
    expect(g.boundingBox!.min.y).toBeCloseTo(expected.min.y, 5)
    expect(g.boundingBox!.min.z).toBeCloseTo(expected.min.z, 5)
    expect(g.boundingBox!.max.x).toBeCloseTo(expected.max.x, 5)
    expect(g.boundingBox!.max.y).toBeCloseTo(expected.max.y, 5)
    expect(g.boundingBox!.max.z).toBeCloseTo(expected.max.z, 5)
    // boundingSphere：center = box 中心，radius = 最远顶点到中心距离，独立重算后逐项一致。
    const expectedSphere = computeNumericRibbonSphere(model.ribbonPositions)
    expect(g.boundingSphere!.center.x).toBeCloseTo(expectedSphere.center.x, 5)
    expect(g.boundingSphere!.center.y).toBeCloseTo(expectedSphere.center.y, 5)
    expect(g.boundingSphere!.center.z).toBeCloseTo(expectedSphere.center.z, 5)
    expect(g.boundingSphere!.radius).toBeCloseTo(expectedSphere.radius, 5)
    expect(Number.isFinite(g.boundingSphere!.radius)).toBe(true)
    expect(g.boundingSphere!.radius).toBeGreaterThan(0)
  })
})

// ─── 幂等释放（SPEC 4.3 / 任务验收）──────────────────────────────────────────

describe('createMapResources · 创建 / 释放幂等性', () => {
  test('连续创建并释放 20 次，再对同一集合重复释放：恰好一次清理、不抛异常', () => {
    const model = buildSceneModel(buildSyntheticSceneMap())
    // 20 轮创建 + 释放，验证可重复创建、无累积失败。
    for (let i = 0; i < 20; i++) {
      const r = createMapResources(model)
      expect(r.isDisposed).toBe(false)
      r.dispose()
      expect(r.isDisposed).toBe(true)
    }

    // 最后一轮：对同一集合重复释放，统计每个登记资源恰好清理一次。
    const r = createMapResources(model)
    const counts = new Map<string, number>()
    for (const { obj, label } of collectRegisteredDisposables(r)) {
      counts.set(label, 0)
      obj.addEventListener('dispose', () => counts.set(label, counts.get(label)! + 1))
    }
    r.dispose()
    r.dispose() // 重复释放
    r.dispose()
    for (const [, c] of counts) {
      expect(c, '每个登记资源在重复释放下应恰好清理一次').toBe(1)
    }
    expect(r.isDisposed).toBe(true)
  })
})

// ─── 异常路径（SPEC 16 / 任务异常路径）────────────────────────────────────────

describe('createMapResources · 非法模型整体拒绝', () => {
  function baseModel(): SceneModel {
    return buildSceneModel(buildSyntheticSceneMap())
  }

  test('nodeMatrices 长度与诊断不一致 → MAP_GEOMETRY_INVALID', () => {
    const m = baseModel()
    const tampered: SceneModel = {
      ...m,
      nodeMatrices: m.nodeMatrices.slice(0, 16), // 只保留 1 个实例的矩阵，但 nodeCount=3
    }
    expect(() => createMapResources(tampered)).toThrow()
    try {
      createMapResources(tampered)
    } catch (e) {
      expect(isMapDataError(e)).toBe(true)
      expect((e as { code: string }).code).toBe(MapErrorCode.MAP_GEOMETRY_INVALID)
    }
  })

  test('ribbonPositions 含 NaN → 整体拒绝', () => {
    const m = baseModel()
    const bad = new Float32Array(m.ribbonPositions)
    bad[0] = NaN
    const tampered: SceneModel = { ...m, ribbonPositions: bad }
    expect(() => createMapResources(tampered)).toThrow()
  })

  test('nodeMatrices 含 Infinity → 整体拒绝', () => {
    const m = baseModel()
    const bad = new Float32Array(m.nodeMatrices)
    bad[4] = Infinity
    const tampered: SceneModel = { ...m, nodeMatrices: bad }
    expect(() => createMapResources(tampered)).toThrow()
  })

  test('颜色超线性 sRGB [0,1] → 整体拒绝', () => {
    const m = baseModel()
    const bad = new Float32Array(m.nodeColors)
    bad[0] = 1.5
    const tampered: SceneModel = { ...m, nodeColors: bad }
    expect(() => createMapResources(tampered)).toThrow()
  })

  test('缺失缓冲区（非 Float32Array）→ 整体拒绝', () => {
    const m = baseModel()
    const tampered = { ...m, nodeMatrices: undefined } as unknown as SceneModel
    expect(() => createMapResources(tampered)).toThrow()
  })

  test('已转移（分离）缓冲区长度归零 → 整体拒绝', () => {
    const m = baseModel()
    // 通过 MessageChannel 转移 ArrayBuffer，使原 typed array 长度归零（模拟 worker postMessage 后主线程误用）。
    const { port1, port2 } = new MessageChannel()
    port2.onmessage = () => {
      /* 接收后自动 GC，无需处理 */
    }
    port1.postMessage(m.edgeArrowMatrices.buffer, [m.edgeArrowMatrices.buffer])
    // 转移后 edgeArrowMatrices.length === 0，但 edgeArrowCount 仍为 2 → 长度不一致。
    expect(m.edgeArrowMatrices.length).toBe(0)
    expect(() => createMapResources(m)).toThrow()
  })
})

// ─── 跨层一致性（SPEC 8.2 / 10.1）────────────────────────────────────────────

describe('rendering 基准三角形与 geometry 层一致', () => {
  test('节点箭头顶点逐项相等', () => {
    expect(RENDER_NODE_ARROW_VERTICES).toEqual([...NODE_ARROW_VERTICES])
  })
  test('边箭头顶点逐项相等', () => {
    expect(RENDER_EDGE_ARROW_VERTICES).toEqual([...EDGE_ARROW_VERTICES])
  })
})

// ─── 真实样本集成（SPEC 15.1 / 15.3 / 16）─────────────────────────────────────

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '..', '..')
const REAL_SAMPLE = resolve(root, 'data', 'sampleMap.json')

let realModel: SceneModel
let realResources: MapResources

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
  realResources = createMapResources(realModel)
})

describe('真实样本 · 资源数量与诊断交叉一致（SPEC 2.2 / 15.3）', () => {
  test('节点 1767、节点箭头 464、边箭头 3043、ribbon 1 个 Mesh', () => {
    expect(realResources.nodes.count).toBe(SAMPLE_NODE_COUNTS.total)
    expect(realResources.nodes.count).toBe(1767)
    expect(realResources.nodeArrows.count).toBe(SAMPLE_EDGE_COUNTS.nodeArrowCount)
    expect(realResources.nodeArrows.count).toBe(464)
    expect(realResources.edgeArrows.count).toBe(SAMPLE_EDGE_COUNTS.edgeArrowCount)
    expect(realResources.edgeArrows.count).toBe(3043)
    expect(realResources.ribbon).toBeInstanceOf(THREE.Mesh)
  })

  test('实例矩阵 / 实例色直接消费模型 typed array（无二次变换）', () => {
    expect(arrayEqual(realResources.nodes.instanceMatrix.array, realModel.nodeMatrices)).toBe(true)
    expect(arrayEqual(realResources.nodeArrows.instanceMatrix.array, realModel.nodeArrowMatrices)).toBe(true)
    expect(arrayEqual(realResources.edgeArrows.instanceMatrix.array, realModel.edgeArrowMatrices)).toBe(true)
    expect(realResources.nodes.instanceColor!.array).toBe(realModel.nodeColors)
    expect(realResources.edgeArrows.instanceColor!.array).toBe(realModel.edgeArrowColors)
  })

  test('全部实例矩阵为有限数（无 NaN / Infinity）', () => {
    for (const arr of [
      realResources.nodes.instanceMatrix.array,
      realResources.nodeArrows.instanceMatrix.array,
      realResources.edgeArrows.instanceMatrix.array,
    ] as readonly Float32Array[]) {
      for (let i = 0; i < arr.length; i++) {
        expect(Number.isFinite(arr[i])).toBe(true)
      }
    }
  })
})

describe('真实样本 · 材质、深度与 renderOrder 符合 SPEC（SPEC 7.3 / 7.4）', () => {
  test('ribbon：vertexColors + toneMapped=false + polygonOffset(-1,-1)', () => {
    const m = realResources.ribbon.material as THREE.MeshBasicMaterial
    expect(m.vertexColors).toBe(true)
    expect(m.toneMapped).toBe(false)
    expect(m.polygonOffset).toBe(true)
    expect(m.polygonOffsetFactor).toBe(-1)
    expect(m.polygonOffsetUnits).toBe(-1)
  })
  test('节点：白色 MeshStandardMaterial roughness=0.8 metalness=0', () => {
    const m = realResources.nodes.material as THREE.MeshStandardMaterial
    expect(m.color.getHex()).toBe(0xffffff)
    expect(m.roughness).toBe(0.8)
    expect(m.metalness).toBe(0)
  })
  test('节点箭头 depthWrite=false，其余 depthWrite=true，全部 depthTest=true', () => {
    expect((realResources.nodeArrows.material as THREE.Material).depthWrite).toBe(false)
    expect((realResources.nodes.material as THREE.Material).depthWrite).toBe(true)
    expect((realResources.edgeArrows.material as THREE.Material).depthWrite).toBe(true)
    expect((realResources.ribbon.material as THREE.Material).depthTest).toBe(true)
  })
  test('renderOrder：ribbon 10 / edgeArrow 20 / node 30 / nodeArrow 40', () => {
    expect(realResources.ribbon.renderOrder).toBe(10)
    expect(realResources.edgeArrows.renderOrder).toBe(20)
    expect(realResources.nodes.renderOrder).toBe(30)
    expect(realResources.nodeArrows.renderOrder).toBe(40)
  })
})

describe('真实样本 · ribbon bounds 与纯数值结果一致（SPEC 9.4 / 任务约束）', () => {
  test('boundingBox 与从 ribbonPositions 独立重算逐项一致', () => {
    const g = realResources.ribbon.geometry
    const expected = computeNumericRibbonBounds(realModel.ribbonPositions)
    expect(g.boundingBox!.min.x).toBeCloseTo(expected.min.x, 3)
    expect(g.boundingBox!.min.z).toBeCloseTo(expected.min.z, 3)
    expect(g.boundingBox!.max.x).toBeCloseTo(expected.max.x, 3)
    expect(g.boundingBox!.max.z).toBeCloseTo(expected.max.z, 3)
    // ribbon 几何 y 恒为 0（层高由 Mesh 平移承担）。
    expect(g.boundingBox!.min.y).toBe(0)
    expect(g.boundingBox!.max.y).toBe(0)
    expect(Number.isFinite(g.boundingSphere!.radius)).toBe(true)
  })
})

// ─── 工具（typed array 深比较）────────────────────────────────────────────────

/*
 * 逐元素比较两个 Float32Array 是否完全相等（无容差）。
 * 用于断言“实例矩阵直接拷贝模型 typed array”的逐位一致性。
 */
function arrayEqual(a: ArrayLike<number>, b: ArrayLike<number>): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false
  }
  return true
}
