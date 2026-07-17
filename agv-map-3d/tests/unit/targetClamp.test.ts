/*
 * 观察目标地面约束自动化验证（TASK-019，SPEC §12.4 / §16 / 任务约束）。
 *
 * 设计（任务验证方式第 3、4 项，不启动浏览器）：
 *   - 范围内目标：不限制、零修正（offset 不变）。
 *   - 越过地面边界（X / Z / 双向）：确定性夹取，修正向量 = clamped - input。
 *   - offset 保持不变量：把修正同时加到 camera.position 与 target 后，camera-target offset 不变。
 *   - 边界恰好等于 min/max：不限制（闭区间）。
 *   - 异常路径：target 非有限、groundBounds 非有限 / 反转 → null，禁止 NaN / Infinity。
 *   - 真实样本 groundBounds：内容中心与四角越界点的夹取符合预期。
 *
 * 不启动浏览器：clampTargetToGround 是纯函数，不创建 Three / WebGL 对象。
 */
import { describe, test, expect, beforeAll } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { clampTargetToGround } from '../../src/camera/targetClamp'
import type { NumericBox3 } from '../../src/domain/sceneMap'
import { computeGroundBounds } from '../../src/camera/groundBounds'
import { buildSceneModel } from '../../src/workers/buildSceneModel'
import { parseSampleEnvelope } from '../../src/adapters/parseSampleEnvelope'
import { validateMapSemantics } from '../../src/adapters/validateMapSemantics'
import { normalizeSceneMap } from '../../src/adapters/normalizeSceneMap'
import {
  computeFileSha256,
  EXPECTED_SAMPLE_SHA256,
} from '../../scripts/sample-supply-chain.mjs'

/*
 * 合成 bounds 构造工具。
 */
function box(overrides: Partial<NumericBox3>): NumericBox3 {
  return {
    minX: -10,
    maxX: 10,
    minY: 0,
    maxY: 0,
    minZ: -5,
    maxZ: 5,
    ...overrides,
  }
}

// ─── 真实样本集成（SPEC 15.1 / 12.4）──────────────────────────────────────────

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '..', '..')
const REAL_SAMPLE = resolve(root, 'data', 'sampleMap.json')

let realGroundBounds: NumericBox3
let realContentCenterX: number
let realContentCenterZ: number

beforeAll(async () => {
  const sha = await computeFileSha256(REAL_SAMPLE)
  if (sha !== EXPECTED_SAMPLE_SHA256) {
    throw new Error(`样本身份不符，停止回归验证：${sha}`)
  }
  const rawJson = JSON.parse(readFileSync(REAL_SAMPLE, 'utf8')) as unknown
  const rawMap = parseSampleEnvelope(rawJson)
  validateMapSemantics(rawMap)
  const sceneMap = normalizeSceneMap(rawMap)
  const contentBounds = buildSceneModel(sceneMap).contentBounds
  realGroundBounds = computeGroundBounds(contentBounds)!
  realContentCenterX = (contentBounds.minX + contentBounds.maxX) / 2
  realContentCenterZ = (contentBounds.minZ + contentBounds.maxZ) / 2
})

// ─── 范围内目标：不限制（SPEC 12.4）────────────────────────────────────────────

describe('范围内目标 · 不限制、零修正（SPEC 12.4）', () => {
  test('目标在地面中心：clamped=false，修正为零', () => {
    const gb = box({})
    const r = clampTargetToGround(0, 0, gb)!
    expect(r.clamped).toBe(false)
    expect(r.correctionX).toBe(0)
    expect(r.correctionZ).toBe(0)
    expect(r.clampedX).toBe(0)
    expect(r.clampedZ).toBe(0)
  })

  test('目标恰好等于地面边界（闭区间）：不限制', () => {
    const gb = box({})
    // 四个边界值均属合法（闭区间 [min, max]）。
    for (const [x, z] of [
      [-10, -5],
      [10, 5],
      [-10, 5],
      [10, -5],
    ]) {
      const r = clampTargetToGround(x, z, gb)!
      expect(r.clamped).toBe(false)
      expect(r.clampedX).toBe(x)
      expect(r.clampedZ).toBe(z)
    }
  })

  test('真实样本内容中心在地面范围内：不限制', () => {
    const r = clampTargetToGround(
      realContentCenterX,
      realContentCenterZ,
      realGroundBounds,
    )!
    expect(r.clamped).toBe(false)
    expect(r.correctionX).toBe(0)
    expect(r.correctionZ).toBe(0)
  })
})

// ─── 越过地面边界：确定性夹取（SPEC 12.4 / 任务验证方式第 4 项）──────────────────

describe('越过地面边界 · 确定性夹取与修正向量（SPEC 12.4）', () => {
  test('X 超出 maxX：夹取到 maxX，修正为负', () => {
    const gb = box({})
    const r = clampTargetToGround(25, 0, gb)!
    expect(r.clamped).toBe(true)
    expect(r.clampedX).toBe(10)
    expect(r.clampedZ).toBe(0)
    expect(r.correctionX).toBe(-15)
    expect(r.correctionZ).toBe(0)
  })

  test('X 低于 minX：夹取到 minX，修正为正', () => {
    const gb = box({})
    const r = clampTargetToGround(-30, 0, gb)!
    expect(r.clamped).toBe(true)
    expect(r.clampedX).toBe(-10)
    expect(r.correctionX).toBe(20)
  })

  test('Z 超出 maxZ / 低于 minZ：夹取到边界', () => {
    const gb = box({})
    const over = clampTargetToGround(0, 50, gb)!
    expect(over.clampedZ).toBe(5)
    expect(over.correctionZ).toBe(-45)
    const under = clampTargetToGround(0, -50, gb)!
    expect(under.clampedZ).toBe(-5)
    expect(under.correctionZ).toBe(45)
  })

  test('X / Z 同时越界：双向同时夹取', () => {
    const gb = box({})
    const r = clampTargetToGround(100, -100, gb)!
    expect(r.clamped).toBe(true)
    expect(r.clampedX).toBe(10)
    expect(r.clampedZ).toBe(-5)
    expect(r.correctionX).toBe(-90)
    expect(r.correctionZ).toBe(95)
  })

  test('真实样本：内容中心 + 大偏移被夹回地面边界', () => {
    // 沿 +X 方向远超地面：夹取到 groundMaxX。
    const r = clampTargetToGround(
      realContentCenterX + 1000,
      realContentCenterZ,
      realGroundBounds,
    )!
    expect(r.clamped).toBe(true)
    expect(r.clampedX).toBeCloseTo(realGroundBounds.maxX, 6)
    // 沿 -Z 方向远超地面：夹取到 groundMinZ。
    const r2 = clampTargetToGround(
      realContentCenterX,
      realContentCenterZ - 1000,
      realGroundBounds,
    )!
    expect(r2.clampedZ).toBeCloseTo(realGroundBounds.minZ, 6)
  })
})

// ─── offset 保持不变量（SPEC 12.4 / 任务“保持 camera-target offset 不变”）──────

describe('offset 保持不变量（SPEC 12.4）', () => {
  test('修正向量同时加到 camera.position 与 target 后，camera-target offset 不变', () => {
    // 模拟 OrbitControls pan 把 target 拖出地面：相机随同 pan 移动相同 delta（offset 暂不变）。
    const gb = box({})
    const camBefore = { x: 0, y: 50, z: 100 }
    const tgtBefore = { x: 0, y: 0, z: 0 }
    // pan 把 target 与 camera 同时 +X 方向移 50（offset 不变）。
    const panDX = 50
    const tgtAfterPan = { x: tgtBefore.x + panDX, y: 0, z: 0 }
    const camAfterPan = { x: camBefore.x + panDX, y: camBefore.y, z: camBefore.z }
    // offset before = camera - target。
    const offBefore = {
      x: camBefore.x - tgtBefore.x,
      y: camBefore.y - tgtBefore.y,
      z: camBefore.z - tgtBefore.z,
    }
    // clamp target（target.x = 50 > maxX = 10）。
    const clamp = clampTargetToGround(tgtAfterPan.x, tgtAfterPan.z, gb)!
    expect(clamp.clamped).toBe(true)
    // 控制器把修正同时加到 camera 与 target。
    const tgtFinal = {
      x: tgtAfterPan.x + clamp.correctionX,
      y: 0,
      z: tgtAfterPan.z + clamp.correctionZ,
    }
    const camFinal = {
      x: camAfterPan.x + clamp.correctionX,
      y: camAfterPan.y,
      z: camAfterPan.z + clamp.correctionZ,
    }
    const offAfter = {
      x: camFinal.x - tgtFinal.x,
      y: camFinal.y - tgtFinal.y,
      z: camFinal.z - tgtFinal.z,
    }
    // offset 保持不变：clamp 只平移了 target 与 camera，未改变相对关系。
    expect(offAfter.x).toBeCloseTo(offBefore.x, 10)
    expect(offAfter.y).toBeCloseTo(offBefore.y, 10)
    expect(offAfter.z).toBeCloseTo(offBefore.z, 10)
    // target 最终落在地面内、Y=0。
    expect(tgtFinal.x).toBe(10)
    expect(tgtFinal.y).toBe(0)
  })

  test('范围内目标的零修正：offset 自然不变', () => {
    const gb = box({})
    const clamp = clampTargetToGround(0, 0, gb)!
    expect(clamp.correctionX).toBe(0)
    expect(clamp.correctionZ).toBe(0)
    // 零修正加到 camera / target：offset 完全不变。
  })
})

// ─── 异常路径（SPEC 16 / 任务约束 / 任务验证方式第 4 项）─────────────────────────

describe('异常路径 · 无效输入返回 null（SPEC 16 / 任务约束）', () => {
  test('target 非有限（NaN / Infinity）→ null', () => {
    const gb = box({})
    expect(clampTargetToGround(Number.NaN, 0, gb)).toBeNull()
    expect(clampTargetToGround(0, Number.NaN, gb)).toBeNull()
    expect(clampTargetToGround(Number.POSITIVE_INFINITY, 0, gb)).toBeNull()
    expect(clampTargetToGround(0, Number.NEGATIVE_INFINITY, gb)).toBeNull()
  })

  test('groundBounds 非有限分量 → null', () => {
    expect(clampTargetToGround(0, 0, box({ minX: Number.NaN }))).toBeNull()
    expect(clampTargetToGround(0, 0, box({ maxZ: Number.POSITIVE_INFINITY }))).toBeNull()
  })

  test('groundBounds 反转（min > max）→ null', () => {
    expect(clampTargetToGround(0, 0, box({ minX: 10, maxX: -10 }))).toBeNull()
    expect(clampTargetToGround(0, 0, box({ minZ: 5, maxZ: -5 }))).toBeNull()
  })
})
