/**
 * 省级悬停焦点配置不变量测试（TASK-018 验证方式 1）。
 *
 * 依赖方向：测试基线（vitest，Node 环境），import src/config/province-hover（悬停视觉参数唯一事实源）、
 * src/config/province-borders / place-labels（基线参数，用于断言焦点态相对基线的关系）。不依赖浏览器 /
 * React / Three.js——配置层是冻结数值常量，可在 Node 直接断言「焦点色比基线亮」「放大倍率 > 1」等不变量。
 */

import { describe, it, expect } from 'vitest'
import { PROVINCE_HOVER_CONFIG } from '../src/config/province-hover'
import { PROVINCE_BORDERS_CONFIG } from '../src/config/province-borders'
import { PLACE_LABELS_CONFIG } from '../src/config/place-labels'

describe('省级悬停焦点配置不变量（TASK-018 验证方式 1）', () => {
  it('焦点省界色比基线省界色更亮（加亮，逐通道 ≥ 基线）', () => {
    const { focusedBorderColorRgb, dimmedBorderColorRgb } = PROVINCE_HOVER_CONFIG
    const baseline = PROVINCE_BORDERS_CONFIG.colorRgb
    // 焦点色逐通道 ≥ 基线色（加亮）。
    expect(focusedBorderColorRgb.r).toBeGreaterThanOrEqual(baseline.r)
    expect(focusedBorderColorRgb.g).toBeGreaterThanOrEqual(baseline.g)
    expect(focusedBorderColorRgb.b).toBeGreaterThanOrEqual(baseline.b)
    // 压暗色逐通道 ≤ 基线色（弱化非焦点）。
    expect(dimmedBorderColorRgb.r).toBeLessThanOrEqual(baseline.r)
    expect(dimmedBorderColorRgb.g).toBeLessThanOrEqual(baseline.g)
    expect(dimmedBorderColorRgb.b).toBeLessThanOrEqual(baseline.b)
  })

  it('焦点省界线宽 > 基线线宽（加粗）', () => {
    expect(PROVINCE_HOVER_CONFIG.focusedBorderLineWidthPx).toBeGreaterThan(
      PROVINCE_BORDERS_CONFIG.lineWidthPx,
    )
  })

  it('焦点省名标签放大倍率 > 1、置顶透明度 = 1.0', () => {
    expect(PROVINCE_HOVER_CONFIG.focusedLabelScale).toBeGreaterThan(1)
    expect(PROVINCE_HOVER_CONFIG.focusedLabelOpacity).toBe(1.0)
  })

  it('焦点省名标签提亮色比基线省名色更亮（逐通道 ≥ 基线）', () => {
    const focused = PROVINCE_HOVER_CONFIG.focusedLabelColorRgb
    const baseline = PLACE_LABELS_CONFIG.provinceLabelColorRgb
    expect(focused.r).toBeGreaterThanOrEqual(baseline.r)
    expect(focused.g).toBeGreaterThanOrEqual(baseline.g)
    expect(focused.b).toBeGreaterThanOrEqual(baseline.b)
  })

  it('配置全部冻结（运行时不可被偷偷改）', () => {
    expect(Object.isFrozen(PROVINCE_HOVER_CONFIG)).toBe(true)
    expect(Object.isFrozen(PROVINCE_HOVER_CONFIG.focusedBorderColorRgb)).toBe(true)
    expect(Object.isFrozen(PROVINCE_HOVER_CONFIG.dimmedBorderColorRgb)).toBe(true)
    expect(Object.isFrozen(PROVINCE_HOVER_CONFIG.focusedLabelColorRgb)).toBe(true)
  })

  it('焦点态字号 = 基线字号 × 放大倍率（渲染层据此合成，配置层只提供倍率）', () => {
    const expected = PLACE_LABELS_CONFIG.provinceLabelFontSizeMeters * PROVINCE_HOVER_CONFIG.focusedLabelScale
    // 渲染层 fontSize = base × scale；此处只断言倍率有限、> 1，使合成结果确定。
    expect(Number.isFinite(expected)).toBe(true)
    expect(expected).toBeGreaterThan(PLACE_LABELS_CONFIG.provinceLabelFontSizeMeters)
  })
})
