/*
 * 动态 near / far 裁剪面自动化验证（TASK-017，SPEC 12.3 / 16）。
 *
 * 设计：
 *   - 真实样本 + 宽 / 窄视口：near / far 由相机空间深度与拟合半径推导，0 < near < far，
 *     near 下限 0.02m；地面通过 clipBounds 参与 far，但不参与 fit。
 *   - 合成合法正深度：near = max(0.02, minDepth × 0.8)，far = max(near+1, maxDepth×1.2, dist+2R)。
 *   - 相机空间存在非正深度（相机贴近 / 进入范围）：near 回落 0.02m（合法分支，非错误）。
 *   - 观察点前后深度：八角横跨相机前后时仍 0 < near < far。
 *   - 确定性：相同输入得到同一结果。
 *   - 异常路径：非有限输入 / bounds 反转 / 相机与目标重合 → null，禁止 NaN / Infinity。
 *
 * 不启动浏览器：相机空间深度为手写基（与 Three Matrix4.lookAt 同约定），不创建 Three / WebGL。
 */
import { describe, test, expect, beforeAll } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  computeClipPlanes,
  computeClipBounds,
  MIN_NEAR_METERS,
  NEAR_DEPTH_RATIO,
  FAR_DEPTH_RATIO,
  FAR_MIN_SLACK_METERS,
  FAR_TARGET_RADIUS_MULTIPLE,
} from '../../src/camera/clipPlanes'
import type { Vec3 } from '../../src/camera/cameraFit'
import { computeCameraFit } from '../../src/camera/cameraFit'
import { computeGroundBounds } from '../../src/camera/groundBounds'
import type { NumericBox3 } from '../../src/domain/sceneMap'
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
    minX: -1,
    minY: 0,
    minZ: -1,
    maxX: 1,
    maxY: 0.066,
    maxZ: 1,
    ...overrides,
  }
}

/*
 * 合成 Vec3。
 */
function vec(x: number, y: number, z: number): Vec3 {
  return { x, y, z }
}

// ─── 真实样本集成（SPEC 15.1 / 12.3）──────────────────────────────────────────

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '..', '..')
const REAL_SAMPLE = resolve(root, 'data', 'sampleMap.json')

let realContentBounds: NumericBox3

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
})

// ─── clipBounds 构造（SPEC 12.3 step 1）───────────────────────────────────────

describe('clipBounds = expanded content bounds ∪ Ground bounds（SPEC 12.3 step 1）', () => {
  test('真实样本：clipBounds 覆盖 expandedContent 与 Ground 的并集', () => {
    const fit = computeCameraFit(realContentBounds, 16 / 9)!
    const ground = computeGroundBounds(realContentBounds)!
    const clip = computeClipBounds(fit.expandedBounds, ground)!
    // 并集 = 各分量 min / max。
    expect(clip.minX).toBeCloseTo(
      Math.min(fit.expandedBounds.minX, ground.minX),
      6,
    )
    expect(clip.maxX).toBeCloseTo(
      Math.max(fit.expandedBounds.maxX, ground.maxX),
      6,
    )
    expect(clip.minZ).toBeCloseTo(
      Math.min(fit.expandedBounds.minZ, ground.minZ),
      6,
    )
    expect(clip.maxZ).toBeCloseTo(
      Math.max(fit.expandedBounds.maxZ, ground.maxZ),
      6,
    )
    // Ground padding（≈16.78m）> fit padding（0.5m），故 XZ 由 Ground 主导。
    expect(clip.minX).toBeCloseTo(ground.minX, 4)
  })

  test('Ground 通过 clipBounds 参与 far 推导，但不参与 fit（fit 不读 ground）', () => {
    // fit 与 clip 是独立函数；clip 通过传入的 groundBounds 间接纳入地面。
    const fit = computeCameraFit(realContentBounds, 16 / 9)!
    const ground = computeGroundBounds(realContentBounds)!
    const clip = computeClipPlanes(
      fit.expandedBounds,
      ground,
      fit.position,
      fit.target,
      fit.radius,
    )!
    expect(clip).not.toBeNull()
    expect(clip.far).toBeGreaterThan(0)
  })

  test('非有限 bounds → null', () => {
    const good = box({})
    expect(computeClipBounds(box({ minX: Number.NaN }), good)).toBeNull()
    expect(computeClipBounds(good, box({ maxX: Number.POSITIVE_INFINITY }))).toBeNull()
  })

  test('反转 bounds（min > max）→ null', () => {
    const good = box({})
    expect(computeClipBounds(box({ minZ: 5, maxZ: -5 }), good)).toBeNull()
  })
})

// ─── near / far 推导（SPEC 12.3 step 3~4）─────────────────────────────────────

describe('动态 near / far 推导（SPEC 12.3 step 3~4）', () => {
  test('真实样本宽屏：0 < near < far，near 下限 0.02m', () => {
    const fit = computeCameraFit(realContentBounds, 16 / 9)!
    const ground = computeGroundBounds(realContentBounds)!
    const clip = computeClipPlanes(
      fit.expandedBounds,
      ground,
      fit.position,
      fit.target,
      fit.radius,
    )!
    expect(clip.near).toBeGreaterThanOrEqual(MIN_NEAR_METERS)
    expect(clip.far).toBeGreaterThan(clip.near)
    // 真实样本相机远离内容，minDepth 大，near = minDepth × 0.8（远大于 0.02）。
    expect(clip.minDepth).toBeGreaterThan(0)
    expect(clip.near).toBeCloseTo(
      Math.max(MIN_NEAR_METERS, clip.minDepth * NEAR_DEPTH_RATIO),
      6,
    )
  })

  test('真实样本窄屏：仍 0 < near < far', () => {
    const fit = computeCameraFit(realContentBounds, 9 / 16)!
    const ground = computeGroundBounds(realContentBounds)!
    const clip = computeClipPlanes(
      fit.expandedBounds,
      ground,
      fit.position,
      fit.target,
      fit.radius,
    )!
    expect(clip.near).toBeGreaterThanOrEqual(MIN_NEAR_METERS)
    expect(clip.far).toBeGreaterThan(clip.near)
  })

  test('far = max(near+1, maxDepth×1.2, |position-target|+2R)', () => {
    const fit = computeCameraFit(realContentBounds, 16 / 9)!
    const ground = computeGroundBounds(realContentBounds)!
    const clip = computeClipPlanes(
      fit.expandedBounds,
      ground,
      fit.position,
      fit.target,
      fit.radius,
    )!
    const dist = Math.sqrt(
      (fit.position.x - fit.target.x) ** 2 +
        (fit.position.y - fit.target.y) ** 2 +
        (fit.position.z - fit.target.z) ** 2,
    )
    const expectedFar = Math.max(
      clip.near + FAR_MIN_SLACK_METERS,
      clip.maxDepth * FAR_DEPTH_RATIO,
      dist + FAR_TARGET_RADIUS_MULTIPLE * fit.radius,
    )
    expect(clip.far).toBeCloseTo(expectedFar, 4)
  })

  test('合成合法正深度：near = minDepth × 0.8（> 0.02）', () => {
    // 相机在 +Z 上方远处看向原点；clipBounds 八角全部在相机前方且深度较大。
    const expanded = box({ minX: -5, maxX: 5, minY: 0, maxY: 1, minZ: -5, maxZ: 5 })
    const ground = box({ minX: -10, maxX: 10, minY: 0, maxY: 0, minZ: -10, maxZ: 10 })
    const position = vec(0, 50, 100)
    const target = vec(0, 0, 0)
    const R = 50
    const clip = computeClipPlanes(expanded, ground, position, target, R)!
    expect(clip.minDepth).toBeGreaterThan(0)
    // 合法正深度分支：near = minDepth × 0.8，且因 minDepth 较大而 > 0.02 下限。
    expect(clip.near).toBeCloseTo(
      Math.max(MIN_NEAR_METERS, clip.minDepth * NEAR_DEPTH_RATIO),
      6,
    )
    expect(clip.near).toBeGreaterThan(MIN_NEAR_METERS)
    expect(clip.far).toBeGreaterThan(clip.near)
  })
})

// ─── 非正深度分支（SPEC 12.3 step 3 / 任务验证方式第 4 项）────────────────────

describe('相机空间存在非正深度（SPEC 12.3 step 3 / 任务验证方式第 4 项）', () => {
  test('相机位于范围内（部分角在相机后方）→ near 回落 0.02m', () => {
    // 相机放在 box 内部；部分八角在相机后方（depth ≤ 0）。
    const expanded = box({ minX: -10, maxX: 10, minY: 0, maxY: 1, minZ: -10, maxZ: 10 })
    const ground = box({ minX: -15, maxX: 15, minY: 0, maxY: 0, minZ: -15, maxZ: 15 })
    const position = vec(0, 0.5, 0) // 位于范围内
    const target = vec(5, 0, 5) // 朝第一象限看
    const R = 5
    const clip = computeClipPlanes(expanded, ground, position, target, R)!
    expect(clip.minDepth).toBeLessThanOrEqual(0)
    expect(clip.near).toBe(MIN_NEAR_METERS)
    expect(clip.far).toBeGreaterThan(clip.near)
  })

  test('观察点前后深度横跨：仍 0 < near < far', () => {
    // 相机贴近范围前缘，部分角在前部分在后。
    const expanded = box({ minX: -5, maxX: 5, minY: 0, maxY: 1, minZ: -5, maxZ: 5 })
    const ground = box({ minX: -10, maxX: 10, minY: 0, maxY: 0, minZ: -10, maxZ: 10 })
    const position = vec(0, 1, 5) // 贴近 maxZ 面
    const target = vec(0, 0, -5) // 穿过范围看向 -Z
    const R = 8
    const clip = computeClipPlanes(expanded, ground, position, target, R)!
    expect(clip.near).toBeGreaterThanOrEqual(MIN_NEAR_METERS)
    expect(clip.far).toBeGreaterThan(clip.near)
  })

  test('near 在所有合法分支下限为 0.02m', () => {
    // 多种姿态：远距离、近距离、范围内部；near 恒 ≥ 0.02m。
    const expanded = box({ minX: -5, maxX: 5, minY: 0, maxY: 1, minZ: -5, maxZ: 5 })
    const ground = box({ minX: -10, maxX: 10, minY: 0, maxY: 0, minZ: -10, maxZ: 10 })
    const cases: ReadonlyArray<{ pos: Vec3; tgt: Vec3; R: number }> = [
      { pos: vec(0, 50, 100), tgt: vec(0, 0, 0), R: 50 },
      { pos: vec(0, 1, 5), tgt: vec(0, 0, -5), R: 8 },
      { pos: vec(0, 0.5, 0), tgt: vec(5, 0, 5), R: 5 },
    ]
    for (const c of cases) {
      const clip = computeClipPlanes(expanded, ground, c.pos, c.tgt, c.R)!
      expect(clip.near).toBeGreaterThanOrEqual(MIN_NEAR_METERS)
      expect(clip.far).toBeGreaterThan(clip.near)
    }
  })
})

// ─── 确定性（SPEC 12.3 / 任务约束）────────────────────────────────────────────

describe('确定性（SPEC 12.3 / 任务约束）', () => {
  test('相同输入得到同一 near / far', () => {
    const fit = computeCameraFit(realContentBounds, 16 / 9)!
    const ground = computeGroundBounds(realContentBounds)!
    const a = computeClipPlanes(
      fit.expandedBounds,
      ground,
      fit.position,
      fit.target,
      fit.radius,
    )!
    const b = computeClipPlanes(
      fit.expandedBounds,
      ground,
      fit.position,
      fit.target,
      fit.radius,
    )!
    expect(b.near).toBe(a.near)
    expect(b.far).toBe(a.far)
  })
})

// ─── 异常路径（SPEC 16 / 任务约束 / 任务验证方式第 4 项）───────────────────────

describe('异常路径 · 无效输入返回 null（SPEC 16 / 任务约束）', () => {
  const expanded = box({ minX: -5, maxX: 5, minY: 0, maxY: 1, minZ: -5, maxZ: 5 })
  const ground = box({ minX: -10, maxX: 10, minY: 0, maxY: 0, minZ: -10, maxZ: 10 })

  test('非有限 expandedContentBounds → null', () => {
    expect(
      computeClipPlanes(
        box({ minX: Number.NaN }),
        ground,
        vec(0, 50, 100),
        vec(0, 0, 0),
        50,
      ),
    ).toBeNull()
  })

  test('非有限 groundBounds → null', () => {
    expect(
      computeClipPlanes(
        expanded,
        box({ maxZ: Number.POSITIVE_INFINITY }),
        vec(0, 50, 100),
        vec(0, 0, 0),
        50,
      ),
    ).toBeNull()
  })

  test('非有限 position / target / fitRadius → null', () => {
    expect(
      computeClipPlanes(expanded, ground, vec(Number.NaN, 50, 100), vec(0, 0, 0), 50),
    ).toBeNull()
    expect(
      computeClipPlanes(expanded, ground, vec(0, 50, 100), vec(0, Number.POSITIVE_INFINITY, 0), 50),
    ).toBeNull()
    expect(
      computeClipPlanes(expanded, ground, vec(0, 50, 100), vec(0, 0, 0), Number.NaN),
    ).toBeNull()
  })

  test('反转 bounds（min > max）→ null', () => {
    expect(
      computeClipPlanes(
        box({ minX: 10, maxX: -10 }),
        ground,
        vec(0, 50, 100),
        vec(0, 0, 0),
        50,
      ),
    ).toBeNull()
  })

  test('相机与目标重合（基未定义）→ null', () => {
    expect(
      computeClipPlanes(expanded, ground, vec(0, 0, 0), vec(0, 0, 0), 50),
    ).toBeNull()
  })
})
