/**
 * 海拔色阶图例测试（TASK-014，SPEC §9 / §3.1）。
 *
 * 覆盖验收条件 1 与 4：
 * - 验收 1「色带与 §3.1 断点一致，标注 0/1000/2000/3500/5000/8848m 刻度，位置不遮挡主图核心区域」：
 *   配置层关键刻度精确等于 SPEC §9 六刻度；准备层逐刻度断言颜色 = sampleElevationColor(海拔)
 *   （断点海拔精确命中 §3.1 基线色）、位置 = normalizeElevationToRampU(海拔)；组件 / 样式源码扫描
 *   锁定左侧贴边纵向居中、指针穿透、半透明深色面板。
 * - 验收 4「图例配色与地表 ramp 同源（测试保证一致性）」：
 *   a. 数值闭环——准备层每个色条 stop / 刻度的颜色与「独立重算 sampleElevationColor（同海拔）」
 *      逐一精确相等；刻度颜色再与 buildElevationRampRgbData 的 256 纹素 ramp（GPU 同一份数据）
 *      在量化容差内一致——图例颜色 ≡ 采样器颜色 ≡ GPU ramp 颜色。
 *   b. 引用同一性——ELEVATION_LEGEND_CONFIG.domain 与 ELEVATION_COLOR_DOMAIN 是同一对象引用
 *      （toBe），不存在第二套色阶域。
 *   c. 源码扫描——图例配置 / 领域层 / 组件三处均不含 §3.1 断点基线色字面量（无第二套色阶），
 *      颜色只能来自唯一采样器。
 * - 组件是 DOM overlay：源码扫描锁定无 R3F / Three.js / useFrame / fetch 依赖；App 总装扫描锁定
 *   挂载在 </Canvas> 之外。
 *
 * 依赖方向：测试基线（vitest，Node 环境），import src/ 配置层与领域层纯函数 + 读源码文本扫描。
 * 运行时视觉验收（刻度可读性、与主图相对位置）另有有界无头验证覆盖。
 */

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  ELEVATION_COLOR_DOMAIN,
  ELEVATION_RAMP_WIDTH,
  buildElevationRampRgbData,
  normalizeElevationToRampU,
  sampleElevationColor,
  type RgbColor,
} from '../src/config/elevation-color-ramp'
import { ELEVATION_LEGEND_CONFIG } from '../src/config/elevation-legend'
import {
  buildElevationLegendBarGradientCss,
  prepareElevationLegend,
} from '../src/lib/elevation-legend'

const projectRoot = resolve(fileURLToPath(import.meta.url), '..', '..')

/** 读取 src 下某个源码文件文本（源码扫描用）。 */
function readSource(relativePath: string): string {
  return readFileSync(resolve(projectRoot, 'src', relativePath), 'utf-8')
}

/** 与领域层一致的 RgbColor → #rrggbb 独立重算（测试侧独立实现，交叉验证）。 */
function rgbToHex(color: RgbColor): string {
  const toHex2 = (channel: number): string =>
    Math.min(255, Math.max(0, Math.round(channel)))
      .toString(16)
      .padStart(2, '0')
  return `#${toHex2(color.r)}${toHex2(color.g)}${toHex2(color.b)}`
}

/** SPEC §3.1 分层设色断点基线色字面量（源码扫描「无第二套色阶」用）。 */
const BREAKPOINT_HEX_LITERALS = [
  '#06121c',
  '#1f4d3a',
  '#2f6b4a',
  '#5a7a3a',
  '#8a7a33',
  '#7a5a2e',
  '#5e4030',
  '#d8e4ea',
]

const { minValueMeters: MIN_H, maxValueMeters: MAX_H } = ELEVATION_COLOR_DOMAIN

describe('图例配置不变量（config/elevation-legend）', () => {
  it('关键刻度精确等于 SPEC §9 六刻度（0/1000/2000/3500/5000/8848m）且升序', () => {
    expect([...ELEVATION_LEGEND_CONFIG.keyTicks]).toEqual([0, 1000, 2000, 3500, 5000, 8848])
    const sorted = [...ELEVATION_LEGEND_CONFIG.keyTicks].sort((a, b) => a - b)
    expect([...ELEVATION_LEGEND_CONFIG.keyTicks]).toEqual(sorted)
  })

  it('关键刻度全部落在色阶域内（采样与归一化均给出有限确定结果）', () => {
    for (const tick of ELEVATION_LEGEND_CONFIG.keyTicks) {
      expect(tick).toBeGreaterThanOrEqual(MIN_H)
      expect(tick).toBeLessThanOrEqual(MAX_H)
    }
  })

  it('色阶域与 TASK-006 ramp 是同一对象引用（不存在第二套色阶域）', () => {
    expect(ELEVATION_LEGEND_CONFIG.domain).toBe(ELEVATION_COLOR_DOMAIN)
  })

  it('色条采样段数 / 几何尺寸为正且有限，界面文案非空，配置冻结', () => {
    expect(ELEVATION_LEGEND_CONFIG.barSampleCount).toBeGreaterThanOrEqual(32)
    expect(ELEVATION_LEGEND_CONFIG.barHeightPixels).toBeGreaterThan(0)
    expect(ELEVATION_LEGEND_CONFIG.barWidthPixels).toBeGreaterThan(0)
    expect(ELEVATION_LEGEND_CONFIG.caption.length).toBeGreaterThan(0)
    expect(ELEVATION_LEGEND_CONFIG.unitLabel).toBe('m')
    expect(ELEVATION_LEGEND_CONFIG.seaLevelLabel).toBe('海平面')
    expect(Object.isFrozen(ELEVATION_LEGEND_CONFIG)).toBe(true)
    expect(Object.isFrozen(ELEVATION_LEGEND_CONFIG.keyTicks)).toBe(true)
  })
})

describe('图例准备层（lib/elevation-legend）：色条与刻度派生', () => {
  it('色条 stop 数 = 段数 + 1，位置严格升序且首末落色阶域下限 / 上限', () => {
    const legend = prepareElevationLegend()
    expect(legend.barStops.length).toBe(ELEVATION_LEGEND_CONFIG.barSampleCount + 1)
    expect(legend.barStops[0].positionFraction).toBe(0)
    expect(legend.barStops[legend.barStops.length - 1].positionFraction).toBe(1)
    for (let i = 1; i < legend.barStops.length; i++) {
      expect(legend.barStops[i].positionFraction).toBeGreaterThan(
        legend.barStops[i - 1].positionFraction,
      )
    }
  })

  it('色条首末颜色 = 色阶域下限深海近黑 / 上限雪白（SPEC §3.1 端点）', () => {
    const legend = prepareElevationLegend()
    expect(legend.barStops[0].colorHex).toBe('#06121c')
    expect(legend.barStops[legend.barStops.length - 1].colorHex).toBe('#d8e4ea')
  })

  it('每个色条 stop 的颜色与「独立重算 sampleElevationColor（同海拔）」精确相等（同源数值闭环）', () => {
    const legend = prepareElevationLegend()
    for (const stop of legend.barStops) {
      const elevation = MIN_H + stop.positionFraction * (MAX_H - MIN_H)
      expect(stop.colorHex).toBe(rgbToHex(sampleElevationColor(elevation)))
    }
  })

  it('关键刻度为 SPEC §9 六刻度：海拔 / 文字齐全且升序', () => {
    const legend = prepareElevationLegend()
    expect(legend.ticks.map((tick) => tick.elevationMeters)).toEqual([
      0, 1000, 2000, 3500, 5000, 8848,
    ])
    expect(legend.ticks.map((tick) => tick.label)).toEqual([
      '0',
      '1000',
      '2000',
      '3500',
      '5000',
      '8848',
    ])
  })

  it('断点海拔的刻度颜色精确命中 SPEC §3.1 基线色（0/1000/2000/3500/5000m）', () => {
    const legend = prepareElevationLegend()
    const byElevation = new Map(legend.ticks.map((tick) => [tick.elevationMeters, tick.colorHex]))
    expect(byElevation.get(0)).toBe('#1f4d3a') // 平原
    expect(byElevation.get(1000)).toBe('#8a7a33') // 中山
    expect(byElevation.get(2000)).toBe('#7a5a2e') // 高山
    expect(byElevation.get(3500)).toBe('#5e4030') // 极高山
    expect(byElevation.get(5000)).toBe('#d8e4ea') // 雪线
    expect(byElevation.get(8848)).toBe('#d8e4ea') // 雪线以上（珠峰）
  })

  it('每个刻度的颜色 / 位置与同一采样器 / 归一化精确一致（与地表着色器同源）', () => {
    const legend = prepareElevationLegend()
    for (const tick of legend.ticks) {
      expect(tick.colorHex).toBe(rgbToHex(sampleElevationColor(tick.elevationMeters)))
      expect(tick.positionFraction).toBe(normalizeElevationToRampU(tick.elevationMeters, MIN_H, MAX_H))
    }
  })

  it('刻度颜色与 GPU 256 纹素 ramp（buildElevationRampRgbData）在量化容差内一致（图例≡地表）', () => {
    const legend = prepareElevationLegend()
    const ramp = buildElevationRampRgbData(ELEVATION_RAMP_WIDTH, MIN_H, MAX_H)
    for (const tick of legend.ticks) {
      const texelIndex = Math.min(
        ELEVATION_RAMP_WIDTH - 1,
        Math.floor(tick.positionFraction * ELEVATION_RAMP_WIDTH),
      )
      const rampColor = {
        r: ramp[texelIndex * 3],
        g: ramp[texelIndex * 3 + 1],
        b: ramp[texelIndex * 3 + 2],
      }
      const tickColor = sampleElevationColor(tick.elevationMeters)
      // 亚纹素量化（texel 中心与刻度海拔最多差 span/512≈20.5m）+ 字节取整，容差 ±3。
      expect(Math.abs(rampColor.r - tickColor.r)).toBeLessThanOrEqual(3)
      expect(Math.abs(rampColor.g - tickColor.g)).toBeLessThanOrEqual(3)
      expect(Math.abs(rampColor.b - tickColor.b)).toBeLessThanOrEqual(3)
    }
  })

  it('渐变 CSS：to top（低海拔在底）、65 个 stop、首 0.00% 末 100.00%、颜色来自采样器', () => {
    const legend = prepareElevationLegend()
    const css = buildElevationLegendBarGradientCss(legend.barStops)
    expect(css.startsWith('linear-gradient(to top, #06121c 0.00%, ')).toBe(true)
    expect(css.endsWith('#d8e4ea 100.00%)')).toBe(true)
    expect(css.match(/#[0-9a-f]{6} [0-9.]+%/g)?.length).toBe(legend.barStops.length)
  })

  it('空 stop 序列得到空渐变字符串（渲染层防御分支）', () => {
    expect(buildElevationLegendBarGradientCss([])).toBe('')
  })
})

describe('图例单一事实源与 DOM overlay 结构不变量（源码扫描）', () => {
  it('图例配置 / 领域层 / 组件均不含 §3.1 断点基线色字面量（无第二套色阶）', () => {
    for (const path of [
      'config/elevation-legend.ts',
      'lib/elevation-legend.ts',
      'components/ui/ElevationLegend.tsx',
    ]) {
      const source = readSource(path).toLowerCase()
      for (const hex of BREAKPOINT_HEX_LITERALS) {
        expect(source).not.toContain(hex)
      }
    }
  })

  it('领域层颜色 / 位置只从 TASK-006 色阶唯一事实源派生', () => {
    const source = readSource('lib/elevation-legend.ts')
    expect(source).toContain('sampleElevationColor')
    expect(source).toContain('normalizeElevationToRampU')
    expect(source).toContain("from '../config/elevation-color-ramp'")
    // 不取数、不依赖 React / DOM（纯函数）。
    expect(source).not.toContain('fetch(')
    expect(source).not.toContain('react')
  })

  it('组件是 DOM overlay：不进入 3D 渲染循环、不取数、不自行采样色阶', () => {
    const source = readSource('components/ui/ElevationLegend.tsx')
    expect(source).not.toContain('@react-three')
    expect(source).not.toContain("from 'three'")
    expect(source).not.toContain('useFrame')
    expect(source).not.toContain('fetch(')
    // 颜色只经领域准备层派生（组件不直接调采样器 / 归一化）。
    expect(source).not.toContain('sampleElevationColor(')
    expect(source).not.toContain('normalizeElevationToRampU(')
    expect(source).toContain('prepareElevationLegend')
    expect(source).toContain('buildElevationLegendBarGradientCss')
    expect(source).toContain("from '../../lib/elevation-legend'")
    expect(source).toContain("from '../../config/elevation-legend'")
  })

  it('App 总装接线：图例挂载在 </Canvas> 之外（DOM overlay）', () => {
    const source = readSource('App.tsx')
    const canvasClose = source.indexOf('</Canvas>')
    const legendMount = source.indexOf('<ElevationLegend')
    expect(canvasClose).toBeGreaterThan(-1)
    expect(legendMount).toBeGreaterThan(-1)
    expect(legendMount).toBeGreaterThan(canvasClose)
  })

  it('图例样式：左侧竖向贴边、纵向居中、半透明深色面板 + 发光描边、指针穿透（不遮挡主图核心）', () => {
    const css = readSource('index.css')
    const ruleStart = css.indexOf('.elevation-legend {')
    expect(ruleStart).toBeGreaterThan(-1)
    const rule = css.slice(ruleStart, css.indexOf('}', ruleStart))
    expect(rule).toContain('position: absolute')
    expect(rule).toContain('left: 24px')
    expect(rule).toContain('top: 50%')
    expect(rule).toContain('translateY(-50%)')
    expect(rule).toContain('rgba(14, 20, 36, 0.62)')
    expect(rule).toContain('rgba(159, 232, 216')
    expect(rule).toContain('pointer-events: none')
    // 贴边而非横贯：不设 right / width:100%（低调贴边面板，非底部栏 / 非全宽）。
    expect(rule).not.toContain('right:')
    expect(rule).not.toContain('width: 100%')
  })
})
