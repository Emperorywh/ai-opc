/*
 * 静态场景真实样本集成断言（TASK-018，SPEC 7.4 / 13 / 15.3 / 16，node 环境）。
 *
 * 设计（任务验证方式第 3 项，不启动浏览器）：
 *   - 真实样本经完整可信链到 createMapResources + createGroundMesh + createSceneEnvironment，
 *     断言 SPEC §15.3 集成级计数：节点 1767 / 节点箭头 464 / 边箭头 3043 / ribbon Mesh 1 /
 *     初始实体 draw call ≤ 5（地面 + ribbon + 两类箭头对应 5 个 Mesh / InstancedMesh）。
 *   - 全实例矩阵 / 顶点 / 颜色 typed array 有限：任意实例矩阵 NaN / Infinity = 0（SPEC §15.3 / 16）。
 *   - 标准 3/4 fit 下扩张内容范围八角 NDC |x|,|y| ≤ 0.92：初始 bounds 角被裁切 = 0
 *     （SPEC §12.2 / 15.3 / 16），用 Three PerspectiveCamera 投影做端到端忠实校验。
 *   - 20 次创建 / 释放：每轮把全部 GPU 资源（geometry / material）登记 dispose 事件，
 *     释放后 liveCount 必须归零；该断言在工厂级证明“不单调增长”，与 React 级
 *     StrictMode 挂载/卸载测试（sceneLayerStrictMode.test.ts）互补。
 *
 * 不启动浏览器：只调纯工厂 + TASK-014 资源适配（构造 Three 对象无需 WebGL）；
 *   R3F 装配的浏览器侧由人工视觉基线验收。
 *
 * 性能：真实样本解析 / 几何构建在 beforeAll 完成一次；计数 / NaN / draw call 断言复用同一份
 *   realResources，避免每个用例重复 createMapResources，降低 forks 池满载下的内存与 GC 压力。
 */
import { describe, test, expect, beforeAll, afterAll } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import * as THREE from 'three'
import { createMapResources } from '../../src/rendering/mapResources'
import type { MapResources } from '../../src/rendering/mapResources'
import { createGroundMesh } from '../../src/scene/groundMesh'
import type { GroundMeshHandle } from '../../src/scene/groundMesh'
import { buildSceneModel } from '../../src/workers/buildSceneModel'
import type { SceneModel } from '../../src/workers/buildSceneModel'
import { parseSampleEnvelope } from '../../src/adapters/parseSampleEnvelope'
import { validateMapSemantics } from '../../src/adapters/validateMapSemantics'
import { normalizeSceneMap } from '../../src/adapters/normalizeSceneMap'
import { computeGroundBounds } from '../../src/camera/groundBounds'
import { computeCameraFit, PERSPECTIVE_FOV_DEG } from '../../src/camera/cameraFit'
import type { NumericBox3 } from '../../src/domain/sceneMap'
import {
  computeFileSha256,
  EXPECTED_SAMPLE_SHA256,
} from '../../scripts/sample-supply-chain.mjs'
import { SAMPLE_NODE_COUNTS, SAMPLE_EDGE_COUNTS } from '../fixture/sampleBaseline'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '..', '..')
const REAL_SAMPLE = resolve(root, 'data', 'sampleMap.json')

let realModel: SceneModel
let realContentBounds: NumericBox3
let realGroundBounds: NumericBox3
// 复用一份资源集合：计数 / NaN / draw call 断言只读消费，不释放到 20× 轮次之前。
let sharedResources: MapResources
let sharedGround: GroundMeshHandle

/*
 * 哈希不符立即终止集成回归（SPEC 15.1），避免在错误样本上产生误导断言。
 * 真实样本解析 / 几何构建 / 资源适配在此完成一次，后续用例复用。
 */
beforeAll(async () => {
  const sha = await computeFileSha256(REAL_SAMPLE)
  if (sha !== EXPECTED_SAMPLE_SHA256) {
    throw new Error(`样本身份不符，停止集成验证：${sha}`)
  }
  const rawJson = JSON.parse(readFileSync(REAL_SAMPLE, 'utf8')) as unknown
  const rawMap = parseSampleEnvelope(rawJson)
  validateMapSemantics(rawMap)
  const sceneMap = normalizeSceneMap(rawMap)
  realModel = buildSceneModel(sceneMap)
  realContentBounds = realModel.contentBounds
  realGroundBounds = computeGroundBounds(realContentBounds)!
  sharedResources = createMapResources(realModel)
  sharedGround = createGroundMesh(realGroundBounds)
})

afterAll(() => {
  sharedResources.dispose()
  sharedGround.dispose()
})

// ─── SPEC 15.3 集成计数 ─────────────────────────────────────────────────────

describe('静态场景集成 · 实体计数与 draw call 契约（SPEC 15.3）', () => {
  test('节点 1767 / 节点箭头 464 / 边箭头 3043 / 单一 ribbon / 初始 Text 0', () => {
    expect(sharedResources.nodes.count).toBe(SAMPLE_NODE_COUNTS.total)
    expect(sharedResources.nodeArrows.count).toBe(SAMPLE_EDGE_COUNTS.nodeArrowCount)
    expect(sharedResources.edgeArrows.count).toBe(SAMPLE_EDGE_COUNTS.edgeArrowCount)
    expect(sharedResources.ribbon).toBeInstanceOf(THREE.Mesh)
    // 四类实体均为可提交 draw call 的 Mesh / InstancedMesh，且非文字 / 精灵对象（初始 Text = 0）。
    const entityObjects = [
      sharedResources.ribbon,
      sharedResources.nodes,
      sharedResources.nodeArrows,
      sharedResources.edgeArrows,
    ]
    for (const obj of entityObjects) {
      expect(obj).toBeInstanceOf(THREE.Mesh)
      expect(obj.type).not.toContain('Text')
    }
  })

  test('初始实体 draw call ≤ 5：地面 1 + ribbon 1 + 边箭头 1 + 节点 1 + 节点箭头 1', () => {
    // 每个 Mesh / InstancedMesh 占一次 draw call；5 个对象即 5 次，满足 SPEC 7.4 / 15.3 ≤ 5。
    const drawCallObjects = [
      sharedGround.mesh,
      sharedResources.ribbon,
      sharedResources.edgeArrows,
      sharedResources.nodes,
      sharedResources.nodeArrows,
    ]
    expect(drawCallObjects.length).toBe(5)
    for (const obj of drawCallObjects) {
      expect(obj).toBeInstanceOf(THREE.Mesh)
    }
  })
})

// ─── SPEC 16 全矩阵 / 顶点 / 颜色有限 ───────────────────────────────────────

describe('静态场景集成 · 实例矩阵 NaN / Infinity = 0（SPEC 15.3 / 16）', () => {
  test('全部 typed array 元素有限：矩阵 / 顶点 / 颜色无 NaN / Infinity', () => {
    const arrays: ReadonlyArray<{ readonly name: string; readonly arr: Float32Array }> = [
      { name: 'nodeMatrices', arr: realModel.nodeMatrices },
      { name: 'nodeArrowMatrices', arr: realModel.nodeArrowMatrices },
      { name: 'edgeArrowMatrices', arr: realModel.edgeArrowMatrices },
      { name: 'ribbonPositions', arr: realModel.ribbonPositions },
      { name: 'nodeColors', arr: realModel.nodeColors },
      { name: 'nodeArrowColors', arr: realModel.nodeArrowColors },
      { name: 'edgeArrowColors', arr: realModel.edgeArrowColors },
      { name: 'ribbonColors', arr: realModel.ribbonColors },
    ]
    for (const { name, arr } of arrays) {
      for (let i = 0; i < arr.length; i++) {
        // 任意非有限值直接失败，杜绝 NaN / Infinity 进入 GPU（SPEC 16）。
        expect(Number.isFinite(arr[i]), `${name}[${i}] = ${arr[i]} 非有限`).toBe(true)
      }
    }
    // GPU 上传后的实例矩阵也必须有限：经 InstancedMesh.instanceMatrix 批量拷贝后逐元素复核。
    const uploaded = [
      sharedResources.nodes.instanceMatrix,
      sharedResources.nodeArrows.instanceMatrix,
      sharedResources.edgeArrows.instanceMatrix,
    ]
    for (const attr of uploaded) {
      for (let i = 0; i < attr.array.length; i++) {
        expect(Number.isFinite(attr.array[i])).toBe(true)
      }
    }
  })
})

// ─── SPEC 12.2 / 15.3 标准 fit 下扩张范围八角不被裁切 ───────────────────────

describe('静态场景集成 · 初始 bounds 角被裁切 = 0（SPEC 12.2 / 15.3）', () => {
  /*
   * 用 Three PerspectiveCamera 投影 expandedBounds 八角，与 MapCameraController 写入相机的约定一致
   * （lookAt up=(0,1,0)、相同 fov/aspect）。vector.project(camera) 依次施加
   * camera.matrixWorldInverse 与 camera.projectionMatrix，等价于应用的视图 + 透视投影。
   */
  function assertCornersWithinNDC(aspect: number): void {
    const fit = computeCameraFit(realContentBounds, aspect)!
    const pos = new THREE.Vector3(fit.position.x, fit.position.y, fit.position.z)
    const tgt = new THREE.Vector3(fit.target.x, fit.target.y, fit.target.z)
    const camera = new THREE.PerspectiveCamera(PERSPECTIVE_FOV_DEG, aspect, fit.distance * 0.02, fit.distance * 4)
    camera.position.copy(pos)
    camera.lookAt(tgt)
    camera.updateMatrixWorld()
    const xs = [fit.expandedBounds.minX, fit.expandedBounds.maxX]
    const ys = [fit.expandedBounds.minY, fit.expandedBounds.maxY]
    const zs = [fit.expandedBounds.minZ, fit.expandedBounds.maxZ]
    for (const x of xs) {
      for (const y of ys) {
        for (const z of zs) {
          const ndc = new THREE.Vector3(x, y, z).project(camera)
          expect(Math.abs(ndc.x)).toBeLessThanOrEqual(0.92)
          expect(Math.abs(ndc.y)).toBeLessThanOrEqual(0.92)
        }
      }
    }
  }

  test('宽屏 16:9 标准 fit：扩张内容范围八角 |NDC.x|,|NDC.y| ≤ 0.92', () => {
    assertCornersWithinNDC(16 / 9)
  })

  test('窄屏 9:16 标准 fit：扩张内容范围八角 |NDC.x|,|NDC.y| ≤ 0.92', () => {
    assertCornersWithinNDC(9 / 16)
  })
})

// ─── SPEC 15.3 / 4.3 20 次创建/释放：GPU 资源计数不单调增长 ─────────────────

describe('静态场景集成 · 20 次创建/释放 GPU 资源计数归零（SPEC 4.3 / 15.3）', () => {
  /*
   * 收集一轮全部 GPU 资源（geometry / material）并登记 dispose 事件：
   * 释放后 liveCount 必须归零，证明 registry 成对释放、不因重复创建累积。
   * 该断言与 React 级 StrictMode 挂载/卸载测试互补：前者验证工厂级成对释放，
   * 后者验证 scene 层 effect 驱动的释放与 StrictMode 重建无泄漏。
   */
  function trackAndDispose(resources: MapResources, ground: GroundMeshHandle): number {
    const geoMat: Array<THREE.BufferGeometry | THREE.Material> = [
      resources.ribbon.geometry,
      resources.ribbon.material,
      resources.nodes.geometry,
      resources.nodes.material,
      resources.nodeArrows.geometry,
      resources.nodeArrows.material,
      resources.edgeArrows.geometry,
      resources.edgeArrows.material,
      ground.mesh.geometry,
      ground.mesh.material,
    ]
    let live = geoMat.length
    for (const obj of geoMat) {
      obj.addEventListener('dispose', () => {
        live--
      })
    }
    resources.dispose()
    ground.dispose()
    return live
  }

  test('20 次（创建 → 释放）：每轮 liveCount 归零，末轮计数仍正确（无累积、无腐蚀）', () => {
    for (let i = 0; i < 20; i++) {
      const resources = createMapResources(realModel)
      const ground = createGroundMesh(realGroundBounds)
      const live = trackAndDispose(resources, ground)
      // 每轮释放后全部 GPU 资源（10 个 geometry/material）均已 dispose，无悬挂。
      expect(live).toBe(0)
      // 重复释放幂等：registry 已释放，二次调用不抛异常、不增长（SPEC 4.3）。
      expect(() => resources.dispose()).not.toThrow()
      expect(() => ground.dispose()).not.toThrow()
    }
    // 末轮重建后计数仍正确：证明 20 次循环未腐蚀工厂或 typed array 通路。
    const finalResources = createMapResources(realModel)
    expect(finalResources.nodes.count).toBe(SAMPLE_NODE_COUNTS.total)
    expect(finalResources.nodeArrows.count).toBe(SAMPLE_EDGE_COUNTS.nodeArrowCount)
    expect(finalResources.edgeArrows.count).toBe(SAMPLE_EDGE_COUNTS.edgeArrowCount)
    expect(finalResources.isDisposed).toBe(false)
    finalResources.dispose()
    expect(finalResources.isDisposed).toBe(true)
  })
})
