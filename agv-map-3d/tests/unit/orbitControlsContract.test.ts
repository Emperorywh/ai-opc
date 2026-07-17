/*
 * 只读轨道浏览契约自动化验证（TASK-019，SPEC §12.4 / §16 / 任务约束）。
 *
 * 设计（任务验证方式第 3、4 项，不启动浏览器）：
 *   - 固定参数：minDistance=0.50m、maxDistance=8×R、polar 15°~85°、dampingFactor=0.08、
 *     rotateSpeed=0.6、panSpeed=1.0、zoomSpeed=0.8；rotate / pan / zoom 全启用；screenSpacePanning=false。
 *   - maxDistance = 8 × R：R 合法时返回 8R；R 非有限 / 非正 → null。
 *   - applyOrbitContract：把契约字段完整写入任意 OrbitControlsLike 纯对象（与真实 OrbitControls 解耦）。
 *   - 相机始终位于地面上方：polar ∈ [15°, 85°] + target.y=0 → camera.y = distance × cos(polar) > 0。
 *   - 真实样本 R：maxDistance = 8 × R 与 R 同量级，且 > minDistance。
 *
 * 不启动浏览器：契约是纯数据 / 纯函数，applyOrbitContract 写入纯对象，不创建 Three / WebGL。
 */
import { describe, test, expect, beforeAll } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  ORBIT_MIN_DISTANCE_METERS,
  ORBIT_MAX_DISTANCE_RADIUS_MULTIPLE,
  ORBIT_MIN_POLAR_DEG,
  ORBIT_MAX_POLAR_DEG,
  ORBIT_DAMPING_FACTOR,
  ORBIT_ROTATE_SPEED,
  ORBIT_PAN_SPEED,
  ORBIT_ZOOM_SPEED,
  buildOrbitContract,
  applyOrbitContract,
  computeMaxDistance,
  orbitMinPolarAngle,
  orbitMaxPolarAngle,
} from '../../src/camera/orbitControlsContract'
import type { OrbitControlsLike } from '../../src/camera/orbitControlsContract'
import { computeCameraFit } from '../../src/camera/cameraFit'
import { buildSceneModel } from '../../src/workers/buildSceneModel'
import { parseSampleEnvelope } from '../../src/adapters/parseSampleEnvelope'
import { validateMapSemantics } from '../../src/adapters/validateMapSemantics'
import { normalizeSceneMap } from '../../src/adapters/normalizeSceneMap'
import type { NumericBox3 } from '../../src/domain/sceneMap'
import {
  computeFileSha256,
  EXPECTED_SAMPLE_SHA256,
} from '../../scripts/sample-supply-chain.mjs'

/*
 * 构造一个全字段可变的纯 OrbitControlsLike 对象，用于验证 applyOrbitContract 写入。
 */
function makeFakeControls(): OrbitControlsLike {
  return {
    enableDamping: false,
    dampingFactor: 0,
    enableRotate: false,
    enablePan: false,
    enableZoom: false,
    rotateSpeed: 0,
    panSpeed: 0,
    zoomSpeed: 0,
    minDistance: 0,
    maxDistance: 0,
    minPolarAngle: 0,
    maxPolarAngle: 0,
    screenSpacePanning: true,
  }
}

// ─── 真实样本集成（SPEC 15.1 / 12.4）──────────────────────────────────────────

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '..', '..')
const REAL_SAMPLE = resolve(root, 'data', 'sampleMap.json')

let realContentBounds: NumericBox3
let realFitRadius: number

beforeAll(async () => {
  const sha = await computeFileSha256(REAL_SAMPLE)
  if (sha !== EXPECTED_SAMPLE_SHA256) {
    throw new Error(`样本身份不符，停止回归验证：${sha}`)
  }
  const rawJson = JSON.parse(readFileSync(REAL_SAMPLE, 'utf8')) as unknown
  const rawMap = parseSampleEnvelope(rawJson)
  validateMapSemantics(rawMap)
  const sceneMap = normalizeSceneMap(rawMap)
  realContentBounds = buildSceneModel(sceneMap).contentBounds
  realFitRadius = computeCameraFit(realContentBounds, 16 / 9)!.radius
})

// ─── 固定参数（SPEC 12.4）─────────────────────────────────────────────────────

describe('SPEC §12.4 固定参数', () => {
  test('minDistance = 0.50m、maxDistance 倍数 = 8、polar 15°~85°、damping 0.08、速度契约', () => {
    expect(ORBIT_MIN_DISTANCE_METERS).toBe(0.5)
    expect(ORBIT_MAX_DISTANCE_RADIUS_MULTIPLE).toBe(8)
    expect(ORBIT_MIN_POLAR_DEG).toBe(15)
    expect(ORBIT_MAX_POLAR_DEG).toBe(85)
    expect(ORBIT_DAMPING_FACTOR).toBe(0.08)
    expect(ORBIT_ROTATE_SPEED).toBe(0.6)
    expect(ORBIT_PAN_SPEED).toBe(1.0)
    expect(ORBIT_ZOOM_SPEED).toBe(0.8)
  })

  test('polar 弧度 = deg2rad(15°) / deg2rad(85°)', () => {
    expect(orbitMinPolarAngle()).toBeCloseTo((15 * Math.PI) / 180, 10)
    expect(orbitMaxPolarAngle()).toBeCloseTo((85 * Math.PI) / 180, 10)
    // minPolar < maxPolar，范围合法。
    expect(orbitMinPolarAngle()).toBeLessThan(orbitMaxPolarAngle())
  })
})

// ─── buildOrbitContract 静态契约（SPEC 12.4）──────────────────────────────────

describe('buildOrbitContract · 静态契约（SPEC 12.4）', () => {
  test('rotate / pan / zoom 全启用；damping 启用', () => {
    const c = buildOrbitContract()
    expect(c.enableRotate).toBe(true)
    expect(c.enablePan).toBe(true)
    expect(c.enableZoom).toBe(true)
    expect(c.enableDamping).toBe(true)
  })

  test('dampingFactor / 速度 / minDistance / polar 与 SPEC 常量一致', () => {
    const c = buildOrbitContract()
    expect(c.dampingFactor).toBe(ORBIT_DAMPING_FACTOR)
    expect(c.rotateSpeed).toBe(ORBIT_ROTATE_SPEED)
    expect(c.panSpeed).toBe(ORBIT_PAN_SPEED)
    expect(c.zoomSpeed).toBe(ORBIT_ZOOM_SPEED)
    expect(c.minDistance).toBe(ORBIT_MIN_DISTANCE_METERS)
    expect(c.minPolarAngle).toBe(orbitMinPolarAngle())
    expect(c.maxPolarAngle).toBe(orbitMaxPolarAngle())
  })

  test('maxDistance 占位为 +∞（由 computeMaxDistance(R) 在首次 fit 后覆盖）', () => {
    const c = buildOrbitContract()
    expect(c.maxDistance).toBe(Number.POSITIVE_INFINITY)
  })

  test('screenSpacePanning = false：pan 沿地面平面（地图浏览语义）', () => {
    expect(buildOrbitContract().screenSpacePanning).toBe(false)
  })
})

// ─── applyOrbitContract 写入纯对象（SPEC 12.4）────────────────────────────────

describe('applyOrbitContract · 写入 OrbitControlsLike（SPEC 12.4）', () => {
  test('把契约全部字段写入纯对象，逐字段相等', () => {
    const target = makeFakeControls()
    const contract = buildOrbitContract()
    applyOrbitContract(target, contract)
    // 全部字段被覆盖为契约值。
    expect(target.enableDamping).toBe(contract.enableDamping)
    expect(target.dampingFactor).toBe(contract.dampingFactor)
    expect(target.enableRotate).toBe(contract.enableRotate)
    expect(target.enablePan).toBe(contract.enablePan)
    expect(target.enableZoom).toBe(contract.enableZoom)
    expect(target.rotateSpeed).toBe(contract.rotateSpeed)
    expect(target.panSpeed).toBe(contract.panSpeed)
    expect(target.zoomSpeed).toBe(contract.zoomSpeed)
    expect(target.minDistance).toBe(contract.minDistance)
    expect(target.maxDistance).toBe(contract.maxDistance)
    expect(target.minPolarAngle).toBe(contract.minPolarAngle)
    expect(target.maxPolarAngle).toBe(contract.maxPolarAngle)
    expect(target.screenSpacePanning).toBe(contract.screenSpacePanning)
  })

  test('可重复调用：多次 apply 结果幂等', () => {
    const target = makeFakeControls()
    const contract = buildOrbitContract()
    applyOrbitContract(target, contract)
    const first = { ...target }
    applyOrbitContract(target, contract)
    expect(target).toEqual(first)
  })
})

// ─── computeMaxDistance（SPEC 12.4：maxDistance = 8 × R）──────────────────────

describe('computeMaxDistance · maxDistance = 8 × R（SPEC 12.4）', () => {
  test('R 合法：返回 8 × R', () => {
    expect(computeMaxDistance(1)).toBe(8)
    expect(computeMaxDistance(100)).toBe(800)
    expect(computeMaxDistance(12.5)).toBeCloseTo(100, 10)
  })

  test('真实样本 R：maxDistance = 8 × R > minDistance', () => {
    const maxD = computeMaxDistance(realFitRadius)!
    expect(maxD).toBeCloseTo(ORBIT_MAX_DISTANCE_RADIUS_MULTIPLE * realFitRadius, 10)
    expect(maxD).toBeGreaterThan(ORBIT_MIN_DISTANCE_METERS)
    // 真实样本 R 约 90m 量级，maxDistance 约 720m，允许用户拉远到 8R 浏览全局。
    expect(maxD).toBeGreaterThan(realFitRadius)
  })

  test('R 非有限 / 非正 → null（不产生 NaN / Infinity）', () => {
    expect(computeMaxDistance(0)).toBeNull()
    expect(computeMaxDistance(-5)).toBeNull()
    expect(computeMaxDistance(Number.NaN)).toBeNull()
    expect(computeMaxDistance(Number.POSITIVE_INFINITY)).toBeNull()
  })
})

// ─── 相机始终位于地面上方不变量（SPEC 12.4 / 任务约束）─────────────────────────

describe('相机始终位于地面上方（SPEC 12.4 / 任务约束）', () => {
  test('polar ∈ [15°, 85°] + target.y=0 → camera.y = distance × cos(polar) > 0', () => {
    // 对 polar 边界与中间值断言：camera.y 恒 > 0（相机位于 Ground Y=0 上方）。
    const minPolar = orbitMinPolarAngle()
    const maxPolar = orbitMaxPolarAngle()
    const polars = [minPolar, maxPolar, (minPolar + maxPolar) / 2]
    const distance = 100
    for (const polar of polars) {
      const cameraY = distance * Math.cos(polar)
      expect(cameraY).toBeGreaterThan(0)
    }
    // 最陡俯视角（85°）下 camera.y 仍 > 0：cos(85°) ≈ 0.087。
    expect(Math.cos(maxPolar)).toBeGreaterThan(0)
    expect(Math.cos(maxPolar)).toBeLessThan(1)
  })

  test('maxPolarAngle < 90°：相机永不会贴到或低于地面', () => {
    expect(orbitMaxPolarAngle()).toBeLessThan(Math.PI / 2)
  })
})
