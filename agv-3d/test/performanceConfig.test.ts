import { describe, expect, it } from 'vitest'
import {
  computeEffectiveDpr,
  DPR_FLOOR,
  MAX_RENDER_HEIGHT_PX,
  MAX_RENDER_PIXELS,
  MAX_RENDER_WIDTH_PX,
} from '../src/features/agv-map/config/performanceConfig'

/**
 * 有效 DPR 与像素预算测试（SPEC §9.3、§11.1，TASK-011）。
 *
 * 公式：effectiveDpr = min(devicePixelRatio, sqrt(MAX_RENDER_PIXELS / (cssWidth × cssHeight)))。
 * 核心验收：4K 尺寸或操作系统缩放下，DPR 严格按公式钳制（可低于 1），使物理像素不超 3840×2160。
 * 正有限尺寸路径不施加会突破预算的下限；仅瞬态非法输入回退 DPR_FLOOR（TASK-011 异常路径）。
 */

describe('computeEffectiveDpr — 像素预算钳制（SPEC §11.1，TASK-011）', () => {
  it('小窗口采用设备像素比（不向下裁剪原生清晰度）', () => {
    // 1080p 窗口 + DPR 2：物理像素 3840×2160 = 8.29M，恰好等于预算，DPR 应为 2。
    const dpr = computeEffectiveDpr(2, 1920, 1080)
    expect(dpr).toBeCloseTo(2, 6)
  })

  it('1080p 窗口 DPR 1 时采用 1', () => {
    const dpr = computeEffectiveDpr(1, 1920, 1080)
    expect(dpr).toBe(1)
  })

  it('4K CSS 窗口下 DPR 钳制为 1（CSS 像素已等于预算）', () => {
    // 3840×2160 CSS 窗口 + DPR 2：预算 sqrt(8294400 / 8294400) = 1，DPR 钳到 1，
    // 物理 3840×2160 = 预算，不膨胀为 7680×4320（8K）。
    const dpr = computeEffectiveDpr(2, 3840, 2160)
    expect(dpr).toBeCloseTo(1, 6)
  })

  it('操作系统缩放产生超大 CSS 窗口时 DPR 低于 1（严格公式，物理像素不超预算）', () => {
    // 外接 4K 屏 + 系统缩放使 CSS 窗口为 5120×2880（5K 逻辑）。
    // 预算 sqrt(8294400 / 14745600) = 0.75；严格公式得 DPR=0.75（不再被下限 1 覆盖）。
    // 物理像素 = 0.75×5120 × 0.75×2880 = 3840×2160 = 预算，杜绝 5K/6K/8K 膨胀（TASK-011）。
    const dpr = computeEffectiveDpr(2, 5120, 2880)
    expect(dpr).toBeCloseTo(0.75, 6)
    const physicalPixels = (dpr * 5120) * (dpr * 2880)
    expect(physicalPixels).toBeLessThanOrEqual(MAX_RENDER_PIXELS + 1)
  })

  it('极大 CSS 窗口下 DPR 可低于 1（不施加突破预算的下限）', () => {
    // 7680×4320 CSS + DPR 3：预算 sqrt(8294400 / 33177600) = 0.5，DPR=0.5（< 1）。
    // 旧实现对正有限尺寸强加 DPR_FLOOR=1 会突破预算；TASK-011 禁止此类下限覆盖。
    const dpr = computeEffectiveDpr(3, 7680, 4320)
    expect(dpr).toBeCloseTo(0.5, 6)
    const physicalPixels = (dpr * 7680) * (dpr * 4320)
    expect(physicalPixels).toBeLessThanOrEqual(MAX_RENDER_PIXELS + 1)
  })

  it('中等窗口按预算比例钳制', () => {
    // 2560×1440 CSS + DPR 2：物理 5120×2880 = 14.7M > 预算 8.29M。
    // 预算 sqrt(8294400 / 3686400) = sqrt(2.25) = 1.5，故 DPR 钳到 1.5。
    const dpr = computeEffectiveDpr(2, 2560, 1440)
    expect(dpr).toBeCloseTo(1.5, 6)
  })

  it('正有限尺寸永不产生 NaN/Infinity（含极窄屏与超高 DPR）', () => {
    // 极窄竖屏 + 超高 DPR：仍为有限正数（TASK-011 异常路径）。
    const narrow = computeEffectiveDpr(4, 200, 1000)
    expect(Number.isFinite(narrow)).toBe(true)
    expect(narrow).toBeGreaterThan(0)
    // 超高 DPR（如某些移动端 DPR=5）：受预算钳制为有限正数。
    const huge = computeEffectiveDpr(5, 1920, 1080)
    expect(Number.isFinite(huge)).toBe(true)
    expect(huge).toBeGreaterThan(0)
  })

  it('瞬态非法 DPR 回退到 DPR_FLOOR（不产生 NaN，不参与预算计算）', () => {
    expect(computeEffectiveDpr(Number.NaN, 1920, 1080)).toBe(DPR_FLOOR)
    expect(computeEffectiveDpr(Number.POSITIVE_INFINITY, 1920, 1080)).toBe(DPR_FLOOR)
    expect(computeEffectiveDpr(-1, 1920, 1080)).toBe(DPR_FLOOR)
    expect(computeEffectiveDpr(0, 1920, 1080)).toBe(DPR_FLOOR)
  })

  it('瞬态零尺寸或非有限 CSS 尺寸回退到 DPR_FLOOR（SPEC §9.3，不触发新加载）', () => {
    // resize 中容器尚未量得的 0×0 瞬态：回退中性 DPR，不产生 NaN，下一帧正尺寸时重算。
    expect(computeEffectiveDpr(2, Number.NaN, 1080)).toBe(DPR_FLOOR)
    expect(computeEffectiveDpr(2, 1920, Number.NaN)).toBe(DPR_FLOOR)
    expect(computeEffectiveDpr(2, 0, 1080)).toBe(DPR_FLOOR)
    expect(computeEffectiveDpr(2, 1920, 0)).toBe(DPR_FLOOR)
    expect(computeEffectiveDpr(2, -100, 100)).toBe(DPR_FLOOR)
    expect(computeEffectiveDpr(2, 0, 0)).toBe(DPR_FLOOR)
  })

  it('相同输入产生相同输出（纯函数，resize 重算结果稳定）', () => {
    const a = computeEffectiveDpr(2, 2560, 1440)
    const b = computeEffectiveDpr(2, 2560, 1440)
    expect(a).toBe(b)
  })

  it('正有限尺寸的物理像素总数严格不超过预算（含 DPR<1 的超大窗口）', () => {
    // TASK-011 不变量：对任意正有限输入，dpr² × cssW × cssH ≤ MAX_RENDER_PIXELS。
    // 覆盖常见窗口、4K、超宽屏、超大 OS-缩放窗口、极窄屏、超高 DPR 等组合。
    const cases: Array<[number, number, number]> = [
      [1, 1920, 1080],
      [2, 1920, 1080],
      [2, 2560, 1440],
      [3, 1920, 1080],
      [2, 3840, 2160],
      [2, 5120, 2880],
      [3, 7680, 4320],
      [2, 3440, 1440],
      [4, 200, 1000],
      [5, 1920, 1080],
    ]
    for (const [dev, w, h] of cases) {
      const dpr = computeEffectiveDpr(dev, w, h)
      const physicalPixels = (dpr * w) * (dpr * h)
      expect(Number.isFinite(physicalPixels)).toBe(true)
      expect(physicalPixels).toBeLessThanOrEqual(MAX_RENDER_PIXELS + 1)
    }
  })
})

describe('像素预算常量（SPEC §11.1）', () => {
  it('主画布最大物理像素为 3840×2160', () => {
    expect(MAX_RENDER_WIDTH_PX).toBe(3840)
    expect(MAX_RENDER_HEIGHT_PX).toBe(2160)
    expect(MAX_RENDER_PIXELS).toBe(3840 * 2160)
  })
})
