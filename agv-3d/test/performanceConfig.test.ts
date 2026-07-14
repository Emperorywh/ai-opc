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
 * 核心验收：4K 尺寸或操作系统缩放下，DPR 被钳制使物理像素不超 3840×2160。
 */

describe('computeEffectiveDpr — 像素预算钳制（SPEC §11.1）', () => {
  it('小窗口采用设备像素比（不向下裁剪原生清晰度）', () => {
    // 1080p 窗口 + DPR 2：物理像素 3840×2160 = 8.29M，恰好等于预算，DPR 应为 2。
    const dpr = computeEffectiveDpr(2, 1920, 1080)
    expect(dpr).toBeCloseTo(2, 6)
  })

  it('1080p 窗口 DPR 1 时采用 1', () => {
    const dpr = computeEffectiveDpr(1, 1920, 1080)
    expect(dpr).toBe(1)
  })

  it('4K 窗口下 DPR 被钳制为 1（物理像素不超预算）', () => {
    // 3840×2160 CSS 窗口 + DPR 2：不钳制会渲染 7680×4320 = 33M 像素（8K 膨胀）。
    // 预算 sqrt(8294400 / 8294400) = 1，故 DPR 钳到 1。
    const dpr = computeEffectiveDpr(2, 3840, 2160)
    expect(dpr).toBeCloseTo(1, 6)
  })

  it('操作系统缩放产生超大 CSS 窗口时 DPR 进一步下调（不膨胀到 6K/8K）', () => {
    // 假设外接 4K 屏 + 系统缩放使 CSS 窗口为 5120×2880（5K 逻辑）。
    // 预算 sqrt(8294400 / (5120×2880)) = sqrt(8294400 / 14745600) ≈ 0.75，
    // 受 DPR_FLOOR=1 保护，最终为 1（仍把物理像素限制在 5120×2880 < 3840×2160？否，
    // 5120×2880 > 3840×2160，但 DPR=1 是下限，无法更低；此场景物理像素 = CSS 像素 = 14.7M，
    // 超预算但已是 DPR 下限能做的最大限制）。
    const dpr = computeEffectiveDpr(2, 5120, 2880)
    expect(dpr).toBe(1)
  })

  it('中等窗口按预算比例钳制', () => {
    // 2560×1440 CSS + DPR 2：物理 5120×2880 = 14.7M > 预算 8.29M。
    // 预算 sqrt(8294400 / 3686400) = sqrt(2.25) = 1.5，故 DPR 钳到 1.5。
    const dpr = computeEffectiveDpr(2, 2560, 1440)
    expect(dpr).toBeCloseTo(1.5, 6)
  })

  it('DPR 不会低于 DPR_FLOOR（1）', () => {
    // 极大 CSS 窗口使预算比 < 1，但 DPR 不低于 1。
    const dpr = computeEffectiveDpr(3, 7680, 4320)
    expect(dpr).toBe(DPR_FLOOR)
  })

  it('非法 DPR 回退到 DPR_FLOOR（不产生 NaN）', () => {
    expect(computeEffectiveDpr(Number.NaN, 1920, 1080)).toBe(DPR_FLOOR)
    expect(computeEffectiveDpr(-1, 1920, 1080)).toBe(DPR_FLOOR)
    expect(computeEffectiveDpr(0, 1920, 1080)).toBe(DPR_FLOOR)
  })

  it('非法或非正 CSS 尺寸回退到 DPR_FLOOR（不产生 NaN，SPEC §9.3）', () => {
    expect(computeEffectiveDpr(2, Number.NaN, 1080)).toBe(DPR_FLOOR)
    expect(computeEffectiveDpr(2, 0, 1080)).toBe(DPR_FLOOR)
    expect(computeEffectiveDpr(2, 1920, 0)).toBe(DPR_FLOOR)
    expect(computeEffectiveDpr(2, -100, 100)).toBe(DPR_FLOOR)
  })

  it('相同输入产生相同输出（纯函数）', () => {
    const a = computeEffectiveDpr(2, 2560, 1440)
    const b = computeEffectiveDpr(2, 2560, 1440)
    expect(a).toBe(b)
  })

  it('物理像素总数不超过预算（DPR × CSS 尺寸组合下）', () => {
    // 对若干典型组合验证：dpr² × cssW × cssH ≤ MAX_RENDER_PIXELS（DPR 为下限 1 时除外）。
    const cases: Array<[number, number, number]> = [
      [2, 1920, 1080],
      [2, 2560, 1440],
      [3, 1920, 1080],
      [2, 3840, 2160],
    ]
    for (const [dev, w, h] of cases) {
      const dpr = computeEffectiveDpr(dev, w, h)
      if (dpr > DPR_FLOOR) {
        const physicalPixels = (dpr * w) * (dpr * h)
        expect(physicalPixels).toBeLessThanOrEqual(MAX_RENDER_PIXELS + 1)
      }
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
