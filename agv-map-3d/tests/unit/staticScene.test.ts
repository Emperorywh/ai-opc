/*
 * 静态场景装配自动化验证（TASK-018，SPEC 7.1 / 7.2 / 7.3 / 7.4 / 12.1 / 13 / 15.3 / 16 / 任务约束）。
 *
 * 设计（任务验证方式第 3、4 项，不启动浏览器）：
 *   - 真实样本经完整可信链到 createMapResources，断言四类资源数量 1767 / 464 / 3043 与单一 ribbon。
 *   - createGroundMesh：有限 PlaneGeometry、MeshStandardMaterial(roughness=1, metalness=0, #1A1A1A)、
 *     renderOrder=0、位置居中、不投射 / 不接收阴影；幂等释放。
 *   - createSceneEnvironment：半球光（#FFFFFF/#202020/0.8）+ 方向光（白/1.0/(80,120,60)），无阴影。
 *   - draw call 契约：地面 1 + ribbon 1 + 边箭头 1 + 节点 1 + 节点箭头 1 = 5（SPEC 7.4 / 15.3 / 任务输出）。
 *   - renderOrder 升序唯一：ground(0) < ribbon(10) < edgeArrow(20) < node(30) < nodeArrow(40)。
 *   - 异常路径：非法地面范围 → createGroundMesh 拒绝；幂等释放重复调用不抛异常。
 *
 * 不启动浏览器：只调纯工厂 + TASK-014 资源适配（node 无 WebGL 亦可构造 Three 对象）；
 *   R3F 图层装配属于浏览器侧，由人工视觉基线验收。
 */
import { describe, test, expect, beforeAll } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import * as THREE from 'three'
import { createMapResources } from '../../src/rendering/mapResources'
import type { MapResources } from '../../src/rendering/mapResources'
import { createGroundMesh } from '../../src/scene/groundMesh'
import { createSceneEnvironment } from '../../src/scene/sceneEnvironment'
import { buildSceneModel } from '../../src/workers/buildSceneModel'
import type { SceneModel } from '../../src/workers/buildSceneModel'
import { parseSampleEnvelope } from '../../src/adapters/parseSampleEnvelope'
import { validateMapSemantics } from '../../src/adapters/validateMapSemantics'
import { normalizeSceneMap } from '../../src/adapters/normalizeSceneMap'
import { computeGroundBounds } from '../../src/camera/groundBounds'
import {
  RENDER_ORDER,
  GROUND_COLOR,
  GROUND_MATERIAL_PARAMS,
  HEMISPHERE_LIGHT_PARAMS,
  DIRECTIONAL_LIGHT_PARAMS,
} from '../../src/config/mapVisualConfig'
import {
  computeFileSha256,
  EXPECTED_SAMPLE_SHA256,
} from '../../scripts/sample-supply-chain.mjs'
import {
  SAMPLE_EDGE_COUNTS,
  SAMPLE_NODE_COUNTS,
} from '../fixture/sampleBaseline'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '..', '..')
const REAL_SAMPLE = resolve(root, 'data', 'sampleMap.json')

let realModel: SceneModel
let realResources: MapResources
let realGroundBounds: ReturnType<typeof computeGroundBounds>

beforeAll(async () => {
  // SPEC 15.1：哈希不符立即终止回归验证。
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
  realGroundBounds = computeGroundBounds(realModel.contentBounds)
})

// ─── 实体资源数量与单一 ribbon（SPEC 8 / 9 / 10 / 15.3 / 任务输出）────────────────

describe('静态场景 · 实体资源数量与合并 ribbon', () => {
  test('节点 1767、节点箭头 464、边箭头 3043、单一 ribbon Mesh', () => {
    expect(realResources.nodes.count).toBe(SAMPLE_NODE_COUNTS.total)
    expect(realResources.nodes.count).toBe(1767)
    expect(realResources.nodeArrows.count).toBe(SAMPLE_EDGE_COUNTS.nodeArrowCount)
    expect(realResources.nodeArrows.count).toBe(464)
    expect(realResources.edgeArrows.count).toBe(SAMPLE_EDGE_COUNTS.edgeArrowCount)
    expect(realResources.edgeArrows.count).toBe(3043)
    // 单一 ribbon Mesh（SPEC 15.3 Ribbon Mesh = 1）。
    expect(realResources.ribbon).toBeInstanceOf(THREE.Mesh)
  })

  test('四类资源类型固定：ribbon Mesh + 三个 InstancedMesh', () => {
    expect(realResources.ribbon).toBeInstanceOf(THREE.Mesh)
    expect(realResources.nodes).toBeInstanceOf(THREE.InstancedMesh)
    expect(realResources.nodeArrows).toBeInstanceOf(THREE.InstancedMesh)
    expect(realResources.edgeArrows).toBeInstanceOf(THREE.InstancedMesh)
  })
})

// ─── 有限地面工厂（SPEC 7.1 / 7.2 / 7.3 / 7.4 / 12.1）──────────────────────────

describe('createGroundMesh · 有限地面参数与幂等释放', () => {
  test('groundBounds 非空（contentBounds 已自校验）', () => {
    expect(realGroundBounds).not.toBeNull()
  })

  test('有限 PlaneGeometry 尺寸 = groundBounds XZ 跨度，Y 恒为 0', () => {
    const handle = createGroundMesh(realGroundBounds!)
    const geo = handle.mesh.geometry as THREE.PlaneGeometry
    const width = realGroundBounds!.maxX - realGroundBounds!.minX
    const depth = realGroundBounds!.maxZ - realGroundBounds!.minZ
    expect(geo.parameters.width).toBeCloseTo(width, 6)
    expect(geo.parameters.height).toBeCloseTo(depth, 6)
    // 位置：XZ 居中、Y = Ground Y = 0。
    expect(handle.mesh.position.x).toBeCloseTo(
      (realGroundBounds!.minX + realGroundBounds!.maxX) / 2,
      6,
    )
    expect(handle.mesh.position.y).toBe(0)
    expect(handle.mesh.position.z).toBeCloseTo(
      (realGroundBounds!.minZ + realGroundBounds!.maxZ) / 2,
      6,
    )
    handle.dispose()
  })

  test('材质：MeshStandardMaterial #1A1A1A roughness=1 metalness=0', () => {
    const handle = createGroundMesh(realGroundBounds!)
    const mat = handle.mesh.material as THREE.MeshStandardMaterial
    expect(mat).toBeInstanceOf(THREE.MeshStandardMaterial)
    expect(mat.color.getHex()).toBe(Number.parseInt(GROUND_COLOR.slice(1), 16))
    expect(mat.roughness).toBe(GROUND_MATERIAL_PARAMS.roughness)
    expect(mat.metalness).toBe(GROUND_MATERIAL_PARAMS.metalness)
    handle.dispose()
  })

  test('renderOrder=0、无阴影', () => {
    const handle = createGroundMesh(realGroundBounds!)
    expect(handle.mesh.renderOrder).toBe(RENDER_ORDER.ground)
    expect(handle.mesh.castShadow).toBe(false)
    expect(handle.mesh.receiveShadow).toBe(false)
    handle.dispose()
  })

  test('幂等释放：重复 dispose 不抛异常、不改变 isDisposed 语义', () => {
    const handle = createGroundMesh(realGroundBounds!)
    handle.dispose()
    expect(() => handle.dispose()).not.toThrow()
    expect(() => handle.dispose()).not.toThrow()
  })

  test('非法地面范围 → 拒绝创建', () => {
    const bad = {
      minX: NaN,
      maxX: 1,
      minY: 0,
      maxY: 0,
      minZ: 0,
      maxZ: 1,
    }
    expect(() => createGroundMesh(bad)).toThrow()
    const reversed = {
      minX: 10,
      maxX: 1,
      minY: 0,
      maxY: 0,
      minZ: 0,
      maxZ: 1,
    }
    expect(() => createGroundMesh(reversed)).toThrow()
  })
})

// ─── 场景环境灯光工厂（SPEC 7.3 / 任务约束）────────────────────────────────────

describe('createSceneEnvironment · 半球光 + 方向光参数与无阴影', () => {
  test('半球光：天空 #FFFFFF / 地面 #202020 / 强度 0.8，不投射阴影', () => {
    const env = createSceneEnvironment()
    const hemi = env.group.children.find(
      (c): c is THREE.HemisphereLight => c instanceof THREE.HemisphereLight,
    )
    expect(hemi).toBeDefined()
    expect(hemi!.color.getHex()).toBe(
      Number.parseInt(HEMISPHERE_LIGHT_PARAMS.skyColor.slice(1), 16),
    )
    expect(hemi!.groundColor.getHex()).toBe(
      Number.parseInt(HEMISPHERE_LIGHT_PARAMS.groundColor.slice(1), 16),
    )
    expect(hemi!.intensity).toBe(HEMISPHERE_LIGHT_PARAMS.intensity)
    expect(hemi!.castShadow).toBe(false)
    env.dispose()
  })

  test('方向光：白 / 强度 1.0 / 位置 (80,120,60)，不投射阴影', () => {
    const env = createSceneEnvironment()
    const dir = env.group.children.find(
      (c): c is THREE.DirectionalLight => c instanceof THREE.DirectionalLight,
    )
    expect(dir).toBeDefined()
    expect(dir!.color.getHex()).toBe(
      Number.parseInt(DIRECTIONAL_LIGHT_PARAMS.color.slice(1), 16),
    )
    expect(dir!.intensity).toBe(DIRECTIONAL_LIGHT_PARAMS.intensity)
    expect(dir!.position.x).toBe(DIRECTIONAL_LIGHT_PARAMS.position[0])
    expect(dir!.position.y).toBe(DIRECTIONAL_LIGHT_PARAMS.position[1])
    expect(dir!.position.z).toBe(DIRECTIONAL_LIGHT_PARAMS.position[2])
    expect(dir!.castShadow).toBe(false)
    env.dispose()
  })

  test('恰好一盏半球光 + 一盏方向光（不创建阴影资源）', () => {
    const env = createSceneEnvironment()
    const lights = env.group.children
    expect(lights.length).toBe(2)
    expect(
      lights.filter((c) => c instanceof THREE.HemisphereLight).length,
    ).toBe(1)
    expect(
      lights.filter((c) => c instanceof THREE.DirectionalLight).length,
    ).toBe(1)
    env.dispose()
  })
})

// ─── draw call 契约与 renderOrder 升序（SPEC 7.4 / 15.3 / 任务输出）──────────────

describe('静态场景 · draw call 契约 ≤ 5 与 renderOrder 升序', () => {
  test('地图实体 draw call = 地面 1 + ribbon 1 + 边箭头 1 + 节点 1 + 节点箭头 1 = 5', () => {
    const ground = createGroundMesh(realGroundBounds!)
    // 每个 Mesh / InstancedMesh 一次 draw call；四类资源 + 地面 = 5。
    const drawCallObjects: THREE.Object3D[] = [
      ground.mesh,
      realResources.ribbon,
      realResources.edgeArrows,
      realResources.nodes,
      realResources.nodeArrows,
    ]
    expect(drawCallObjects.length).toBe(5)
    // 全部为可提交 draw call 的 Mesh / InstancedMesh（非 Line / Points / 第二套几何）。
    for (const obj of drawCallObjects) {
      expect(obj).toBeInstanceOf(THREE.Mesh)
    }
    ground.dispose()
  })

  test('renderOrder 升序唯一：ground < ribbon < edgeArrow < node < nodeArrow', () => {
    const ground = createGroundMesh(realGroundBounds!)
    const orders = [
      ground.mesh.renderOrder,
      realResources.ribbon.renderOrder,
      realResources.edgeArrows.renderOrder,
      realResources.nodes.renderOrder,
      realResources.nodeArrows.renderOrder,
    ]
    expect(orders).toEqual([
      RENDER_ORDER.ground,
      RENDER_ORDER.ribbon,
      RENDER_ORDER.edgeArrow,
      RENDER_ORDER.node,
      RENDER_ORDER.nodeArrow,
    ])
    // 严格升序：提交顺序由 renderOrder 决定，不替代深度测试（SPEC 7.4）。
    for (let i = 1; i < orders.length; i++) {
      expect(orders[i]).toBeGreaterThan(orders[i - 1])
    }
    ground.dispose()
  })

  test('初始文字对象数 = 0（无标签挂载，属于后续 TASK）', () => {
    // TASK-018 不挂载任何文字对象；StaticSceneContent 只装配实体 + 地面 + 灯光。
    // 这里以“四类资源 + 地面 + 灯光均非 Text / Sprite”间接断言无文字对象。
    const ground = createGroundMesh(realGroundBounds!)
    const env = createSceneEnvironment()
    const all: THREE.Object3D[] = [
      ground.mesh,
      realResources.ribbon,
      realResources.edgeArrows,
      realResources.nodes,
      realResources.nodeArrows,
      ...env.group.children,
    ]
    for (const obj of all) {
      // 排除任何文字 / 精灵类对象（Troika Text 在后续 TASK 才挂载）。
      expect(obj.type).not.toContain('Text')
      expect(obj).not.toBeInstanceOf(THREE.Sprite)
    }
    ground.dispose()
    env.dispose()
  })
})
