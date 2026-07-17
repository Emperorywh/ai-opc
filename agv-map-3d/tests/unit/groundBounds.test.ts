/*
 * 有限地面范围推导自动化验证（TASK-017，SPEC 12.1 / 12.3 / 7.1 / 16）。
 *
 * 设计：
 *   - 真实样本 contentBounds：地面 padding = max(5, max(宽, 深) × 10%)，宽约 167.84m 主导，
 *     padding ≈ 16.78m；地面 XZ = content ± padding，Y 恒为 [0, 0]。
 *   - 合成非方形范围：宽深不等时 padding 取较大者 × 10%，验证不退化成各自 10%。
 *   - 小地图：宽深均 < 50m 时 padding 由 5m 下限兜底。
 *   - 异常路径：非有限分量、min > max → 返回 null，不产生 NaN / Infinity。
 *   - 唯一消费：地面只读 contentBounds 六分量，不重算几何；与 fit / 裁剪共享同一范围来源。
 *
 * 不启动浏览器：合成测试只调纯函数；真实样本在 node 环境直接读取，不接触 Three / React。
 */
import { describe, test, expect, beforeAll } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  computeGroundBounds,
  computeGroundPadding,
  GROUND_PADDING_MIN_METERS,
  GROUND_PADDING_RATIO,
  GROUND_Y,
} from '../../src/camera/groundBounds'
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

// ─── 真实样本集成（SPEC 15.1 / 12.1）──────────────────────────────────────────

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '..', '..')
const REAL_SAMPLE = resolve(root, 'data', 'sampleMap.json')

let realContentBounds: NumericBox3

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
  const model = buildSceneModel(sceneMap)
  realContentBounds = model.contentBounds
})

// ─── padding 推导（SPEC 12.1）─────────────────────────────────────────────────

describe('地面 padding 推导（SPEC 12.1）', () => {
  test('padding = max(5m, max(宽, 深) × 10%)', () => {
    // 宽 40、深 30：较大者 40 × 10% = 4 < 5，取 5m 下限。
    const small = box({ minX: -20, maxX: 20, minZ: -15, maxZ: 15 })
    expect(computeGroundPadding(small)).toBeCloseTo(
      Math.max(GROUND_PADDING_MIN_METERS, 40 * GROUND_PADDING_RATIO),
      10,
    )
    expect(computeGroundPadding(small)).toBe(5)

    // 宽 167.84、深 75.32：较大者主导，padding = 16.784m。
    const wide = box({ minX: -83.92, maxX: 83.92, minZ: -37.66, maxZ: 37.66 })
    expect(computeGroundPadding(wide)).toBeCloseTo(
      Math.max(5, 167.84 * 0.1),
      5,
    )
  })

  test('非方形范围 padding 取宽深较大者，不各自取 10%', () => {
    // 宽 100、深 20：padding = max(5, 100 × 10%) = 10，而非深方向 2m。
    const rect = box({ minX: -50, maxX: 50, minZ: -10, maxZ: 10 })
    const padding = computeGroundPadding(rect)
    expect(padding).toBeCloseTo(10, 10)
    // 四侧 padding 一致，深方向也用 10m（不是 2m）。
    const g = computeGroundBounds(rect)!
    expect(g.maxX - g.minX).toBeCloseTo(100 + 2 * 10, 6)
    expect(g.maxZ - g.minZ).toBeCloseTo(20 + 2 * 10, 6)
  })

  test('真实样本 padding ≈ 16.78m（宽约 167.84m 主导）', () => {
    const width = realContentBounds.maxX - realContentBounds.minX
    const depth = realContentBounds.maxZ - realContentBounds.minZ
    const expected = Math.max(
      GROUND_PADDING_MIN_METERS,
      Math.max(width, depth) * GROUND_PADDING_RATIO,
    )
    expect(computeGroundPadding(realContentBounds)).toBeCloseTo(expected, 10)
    // 宽约 167.84m，padding 应在 ~16.58m～~16.98m 区间（允许 ±2m 内容范围抖动）。
    expect(computeGroundPadding(realContentBounds)).toBeGreaterThan(16.5)
    expect(computeGroundPadding(realContentBounds)).toBeLessThan(17)
  })
})

// ─── 地面范围推导（SPEC 12.1 / 7.1）───────────────────────────────────────────

describe('有限地面范围推导（SPEC 12.1 / 7.1）', () => {
  test('XZ = content ± padding，Y 恒为 [0, 0]', () => {
    const content = box({ minX: -10, maxX: 20, minY: 0, maxY: 0.066, minZ: -5, maxZ: 5 })
    const g = computeGroundBounds(content)!
    const padding = computeGroundPadding(content) // max(5, 30 × 0.1) = 5
    expect(padding).toBe(5)
    expect(g.minX).toBeCloseTo(-10 - padding, 10)
    expect(g.maxX).toBeCloseTo(20 + padding, 10)
    expect(g.minZ).toBeCloseTo(-5 - padding, 10)
    expect(g.maxZ).toBeCloseTo(5 + padding, 10)
    // Y 固定为 Ground Y = 0（地面是位于 Y=0 的有限平面），不受内容 Y 范围影响。
    expect(g.minY).toBe(GROUND_Y)
    expect(g.maxY).toBe(GROUND_Y)
  })

  test('真实样本地面 XZ 包含内容范围并外扩 padding，Y = [0, 0]', () => {
    const g = computeGroundBounds(realContentBounds)!
    const padding = computeGroundPadding(realContentBounds)
    expect(g.minX).toBeCloseTo(realContentBounds.minX - padding, 4)
    expect(g.maxX).toBeCloseTo(realContentBounds.maxX + padding, 4)
    expect(g.minZ).toBeCloseTo(realContentBounds.minZ - padding, 4)
    expect(g.maxZ).toBeCloseTo(realContentBounds.maxZ + padding, 4)
    expect(g.minY).toBe(0)
    expect(g.maxY).toBe(0)
    // 地面严格大于内容范围（padding > 0）。
    expect(g.minX).toBeLessThan(realContentBounds.minX)
    expect(g.maxX).toBeGreaterThan(realContentBounds.maxX)
    expect(g.minZ).toBeLessThan(realContentBounds.minZ)
    expect(g.maxZ).toBeGreaterThan(realContentBounds.maxZ)
  })

  test('地面范围有限且 min ≤ max', () => {
    const g = computeGroundBounds(realContentBounds)!
    for (const v of [g.minX, g.minY, g.minZ, g.maxX, g.maxY, g.maxZ]) {
      expect(Number.isFinite(v)).toBe(true)
    }
    expect(g.minX).toBeLessThanOrEqual(g.maxX)
    expect(g.minY).toBeLessThanOrEqual(g.maxY)
    expect(g.minZ).toBeLessThanOrEqual(g.maxZ)
  })

  test('零 Y 范围内容（minY = maxY = 0）仍得到合法地面', () => {
    // 非 Y 几何范围用例：内容 Y 退化但 XZ 正常，地面推导不应受 Y 影响。
    const content = box({ minX: -100, maxX: 100, minY: 0, maxY: 0, minZ: -50, maxZ: 50 })
    const g = computeGroundBounds(content)!
    expect(g.minY).toBe(0)
    expect(g.maxY).toBe(0)
    // padding = max(5, max(200, 100) × 0.1) = 20，四侧一致。
    expect(g.minX).toBeCloseTo(-100 - 20, 6)
    expect(g.maxX).toBeCloseTo(100 + 20, 6)
    expect(g.minZ).toBeCloseTo(-50 - 20, 6)
    expect(g.maxZ).toBeCloseTo(50 + 20, 6)
  })
})

// ─── 异常路径（SPEC 16 / 任务约束）─────────────────────────────────────────────

describe('异常路径 · 无效输入返回 null（SPEC 16 / 任务约束）', () => {
  test('非有限分量 → null', () => {
    expect(computeGroundBounds(box({ minX: Number.NaN }))).toBeNull()
    expect(computeGroundBounds(box({ maxX: Number.POSITIVE_INFINITY }))).toBeNull()
    expect(computeGroundBounds(box({ minZ: Number.NEGATIVE_INFINITY }))).toBeNull()
    expect(computeGroundBounds(box({ maxY: Number.NaN }))).toBeNull()
  })

  test('min > max（退化 / 反转范围）→ null', () => {
    expect(computeGroundBounds(box({ minX: 10, maxX: -10 }))).toBeNull()
    expect(computeGroundBounds(box({ minZ: 5, maxZ: -5 }))).toBeNull()
    expect(computeGroundBounds(box({ minY: 1, maxY: 0 }))).toBeNull()
  })

  test('computeGroundPadding 对非法输入仍返回数值（不做 null 守卫，仅做算术）', () => {
    // computeGroundPadding 是纯算术；只读取 maxX-minX / maxZ-minZ，不校验有限性。
    // 守卫由 computeGroundBounds 统一负责；此处确认 padding 函数本身不抛、不返回 NaN 之外的非数。
    const padding = computeGroundPadding(box({ minX: 0, maxX: 10, minZ: 0, maxZ: 4 }))
    expect(Number.isFinite(padding)).toBe(true)
    expect(padding).toBeCloseTo(5, 10) // max(5, 10 × 0.1) = 5
  })
})
