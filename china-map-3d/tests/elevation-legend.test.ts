/**
 * 海拔色阶图例测试（TASK-021 验证方式 1）。
 *
 * 依赖方向：测试基线（vitest，Node 环境），import src/lib/elevation-legend（图例准备层）、
 * src/config/elevation-legend（图例呈现常量）、src/config/elevation-color-ramp（TASK-010 色阶唯一事实源）。
 * 不依赖浏览器 / React / Three.js——准备层是纯函数，可在 Node 内完整断言「图例颜色 / 位置与地表 shader
 * 引用同一事实源」「六个关键刻度完整且顺序正确」（TASK-021 验证方式 1）。
 *
 * 覆盖（TASK-021 验证方式 1、完成标准「图例与 shader 色阶单一事实源可由自动化证明」）：
 * - 关键刻度：0 / 1000 / 2000 / 3500 / 5000 / 8848m 六个齐全且升序。
 * - 色阶复用：每个刻度的颜色严格等于 sampleElevationColor(刻度海拔)（与地表片元着色器同一采样器）；
 *   每个刻度的位置严格等于 normalizeElevationToRampU(刻度海拔, minH, maxH)（与 shader 片元归一化同一公式）。
 *   ——形式证明图例与 shader 色阶单一事实源，不存在第二套色阶。
 * - 色条渐变：color stop 在色阶域均匀采样、颜色来自同一采样器、首末落域上下限、CSS 字符串非空且升序。
 * - 配置不变量：呈现常量有限、文案非空、配置冻结。
 */

import { describe, it, expect } from 'vitest'
import {
  prepareElevationLegend,
  buildElevationLegendBarGradientCss,
} from '../src/lib/elevation-legend'
import {
  ELEVATION_LEGEND_CONFIG,
  ELEVATION_LEGEND_KEY_TICKS,
} from '../src/config/elevation-legend'
import {
  ELEVATION_COLOR_DOMAIN,
  normalizeElevationToRampU,
  sampleElevationColor,
  type RgbColor,
} from '../src/config/elevation-color-ramp'

/** 把 RgbColor 转 #rrggbb（与生产 rgbColorToHex 同逻辑，测试本地副本用于断言）。 */
function rgbToHex(color: RgbColor): string {
  const toHex2 = (channel: number): string => {
    const clamped = Math.min(255, Math.max(0, Math.round(channel)))
    return clamped.toString(16).padStart(2, '0')
  }
  return `#${toHex2(color.r)}${toHex2(color.g)}${toHex2(color.b)}`
}

describe('关键刻度：0/1000/2000/3500/5000/8848m 六个齐全且升序（TASK-021 验证方式 1）', () => {
  it('配置声明恰好六个关键刻度，且为期望海拔', () => {
    expect(ELEVATION_LEGEND_KEY_TICKS).toStrictEqual([0, 1000, 2000, 3500, 5000, 8848])
  })

  it('准备产物含六个刻度，按海拔严格升序', () => {
    const { ticks } = prepareElevationLegend()
    expect(ticks.map((t) => t.elevationMeters)).toStrictEqual([0, 1000, 2000, 3500, 5000, 8848])
    for (let i = 1; i < ticks.length; i++) {
      expect(ticks[i].elevationMeters).toBeGreaterThan(ticks[i - 1].elevationMeters)
    }
  })

  it('每个刻度位置严格升序（色条由底向顶，低海拔在底）', () => {
    const { ticks } = prepareElevationLegend()
    for (let i = 1; i < ticks.length; i++) {
      expect(ticks[i].positionFraction).toBeGreaterThan(ticks[i - 1].positionFraction)
    }
  })
})

describe('色阶复用：图例颜色 / 位置与地表 shader 引用同一事实源（TASK-021 完成标准·自动化证明）', () => {
  it('每个刻度颜色严格等于 sampleElevationColor(海拔)（与地表片元着色器同一采样器）', () => {
    const { ticks } = prepareElevationLegend()
    for (const tick of ticks) {
      const expectedHex = rgbToHex(sampleElevationColor(tick.elevationMeters))
      expect(tick.colorHex, `${tick.elevationMeters}m 刻度颜色应来自色阶唯一采样器`).toBe(expectedHex)
    }
  })

  it('每个刻度位置严格等于 normalizeElevationToRampU(海拔, minH, maxH)（与 shader 片元归一化同一公式）', () => {
    const { minValueMeters: minH, maxValueMeters: maxH } = ELEVATION_COLOR_DOMAIN
    const { ticks } = prepareElevationLegend()
    for (const tick of ticks) {
      const expectedPos = normalizeElevationToRampU(tick.elevationMeters, minH, maxH)
      expect(tick.positionFraction, `${tick.elevationMeters}m 刻度位置应来自色阶域归一化`).toBe(expectedPos)
    }
  })

  it('图例域引用 elevation-color-ramp 的 ELEVATION_COLOR_DOMAIN（与 shader 经 resolveElevationColorConfig 复核的同一域）', () => {
    expect(ELEVATION_LEGEND_CONFIG.domain).toBe(ELEVATION_COLOR_DOMAIN)
  })

  it('刻度颜色不复制色阶断点字面量：1000m 刻度色 = 中山基线色、5000m 刻度色 = 雪线基线色', () => {
    const { ticks } = prepareElevationLegend()
    const at1000 = ticks.find((t) => t.elevationMeters === 1000)!
    const at5000 = ticks.find((t) => t.elevationMeters === 5000)!
    // 1000m 是色阶控制点 → 精确基线色 #8a7a33（中山）；5000m 是控制点 → 精确 #d8e4ea（雪线）。
    expect(at1000.colorHex).toBe(rgbToHex(sampleElevationColor(1000)))
    expect(at5000.colorHex).toBe(rgbToHex(sampleElevationColor(5000)))
    // 8848m 落在 5000–9000 雪白恒定段 → 与 5000m 同色（雪白）。
    const at8848 = ticks.find((t) => t.elevationMeters === 8848)!
    expect(at8848.colorHex).toBe(at5000.colorHex)
  })
})

describe('色条渐变：color stop 在色阶域均匀采样、颜色来自同一采样器', () => {
  it('color stop 数 = 采样段数 + 1，首末分别落色阶域下限 / 上限', () => {
    const { barStops } = prepareElevationLegend()
    expect(barStops.length).toBe(ELEVATION_LEGEND_CONFIG.barSampleCount + 1)
    expect(barStops[0].positionFraction).toBeCloseTo(0, 10)
    expect(barStops[barStops.length - 1].positionFraction).toBeCloseTo(1, 10)
  })

  it('color stop 按位置升序、颜色 = sampleElevationColor(对应海拔)', () => {
    const { minValueMeters: minH, maxValueMeters: maxH } = ELEVATION_COLOR_DOMAIN
    const { barStops } = prepareElevationLegend()
    const segmentCount = ELEVATION_LEGEND_CONFIG.barSampleCount
    for (let i = 0; i < barStops.length; i++) {
      if (i > 0) {
        expect(barStops[i].positionFraction).toBeGreaterThanOrEqual(barStops[i - 1].positionFraction)
      }
      const elevation = minH + ((maxH - minH) * i) / segmentCount
      expect(barStops[i].colorHex).toBe(rgbToHex(sampleElevationColor(elevation)))
    }
  })

  it('首 stop = 深海近黑、末 stop = 雪白（与色阶域端点一致）', () => {
    const { barStops } = prepareElevationLegend()
    expect(barStops[0].colorHex).toBe(rgbToHex(sampleElevationColor(ELEVATION_COLOR_DOMAIN.minValueMeters)))
    expect(barStops[barStops.length - 1].colorHex).toBe(
      rgbToHex(sampleElevationColor(ELEVATION_COLOR_DOMAIN.maxValueMeters)),
    )
  })

  it('CSS linear-gradient 字符串非空、to top、含全部 stop', () => {
    const { barStops } = prepareElevationLegend()
    const css = buildElevationLegendBarGradientCss(barStops)
    expect(css.startsWith('linear-gradient(to top,')).toBe(true)
    // stop 数 = colorHex 出现次数（每个 stop 一个颜色项）。
    expect(css.split(',').length).toBe(barStops.length + 1) // +1 因 "linear-gradient(to top" 被首个逗号分出
  })
})

describe('配置不变量：呈现常量有限、文案非空、配置冻结', () => {
  it('色条尺寸 / 字号为正有限值', () => {
    expect(ELEVATION_LEGEND_CONFIG.barHeightPixels).toBeGreaterThan(0)
    expect(ELEVATION_LEGEND_CONFIG.barWidthPixels).toBeGreaterThan(0)
    expect(ELEVATION_LEGEND_CONFIG.barStrokeWidthPx).toBeGreaterThan(0)
    expect(ELEVATION_LEGEND_CONFIG.tickLabelFontSizePx).toBeGreaterThan(0)
    expect(ELEVATION_LEGEND_CONFIG.captionFontSizePx).toBeGreaterThan(0)
    expect(ELEVATION_LEGEND_CONFIG.barSampleCount).toBeGreaterThan(0)
  })

  it('文案非空（标题 / 单位 / 海平面注释）', () => {
    expect(ELEVATION_LEGEND_CONFIG.caption.length).toBeGreaterThan(0)
    expect(ELEVATION_LEGEND_CONFIG.unitLabel.length).toBeGreaterThan(0)
    expect(ELEVATION_LEGEND_CONFIG.seaLevelLabel.length).toBeGreaterThan(0)
  })

  it('配置与关键刻度数组冻结（消费者无法就地改刻度 / 样式）', () => {
    expect(Object.isFrozen(ELEVATION_LEGEND_CONFIG)).toBe(true)
    expect(Object.isFrozen(ELEVATION_LEGEND_KEY_TICKS)).toBe(true)
  })
})
