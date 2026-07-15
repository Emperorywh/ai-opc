import { describe, expect, it } from 'vitest'
import { Color } from 'three'
import { PATH_BASE_COLOR, PATH_FLOW_HIGHLIGHT_COLOR } from '../src/features/agv-map/config/visualTheme'
import { hslToCss, hslToLinearColor } from '../src/features/agv-map/presentation/scene/colorConvert'

/**
 * 展示层颜色转换共享工具测试（SPEC §8.2、§8.5，TASK-009）。
 *
 * 验证节点材质与路径材质共用的 HSL→线性 Color 转换：
 * - hslToCss 格式与路径材质测试的字面期望一致（三位小数）。
 * - hslToLinearColor 等价于直接 Color.setStyle，保证色彩管线为 sRGB→线性（§8.5）。
 */

describe('hslToCss — CSS 字符串格式', () => {
  it('HSL 元组格式化为 hsl(h, s%, l%)，保留三位小数', () => {
    expect(hslToCss({ h: 210, s: 0.9, l: 0.6 })).toBe('hsl(210, 90.000%, 60.000%)')
    expect(hslToCss({ h: 48, s: 1.0, l: 0.6 })).toBe('hsl(48, 100.000%, 60.000%)')
  })

  it('与路径扁带/流光色字面期望一致（路径材质测试共享）', () => {
    expect(hslToCss(PATH_BASE_COLOR)).toBe('hsl(200, 85.000%, 55.000%)')
    expect(hslToCss(PATH_FLOW_HIGHLIGHT_COLOR)).toBe('hsl(185, 100.000%, 75.000%)')
  })
})

describe('hslToLinearColor — sRGB HSL 线性化（SPEC §8.5）', () => {
  it('等价于直接 Color.setStyle（按 sRGB 解析并转换到工作线性空间）', () => {
    const hsl = { h: 180, s: 0.9, l: 0.55 }
    const expected = new Color().setStyle('hsl(180, 90.000%, 55.000%)')
    const actual = hslToLinearColor(hsl)
    expect(actual.r).toBeCloseTo(expected.r, 6)
    expect(actual.g).toBeCloseTo(expected.g, 6)
    expect(actual.b).toBeCloseTo(expected.b, 6)
  })

  it('返回 THREE.Color 实例', () => {
    expect(hslToLinearColor({ h: 0, s: 0, l: 0 })).toBeInstanceOf(Color)
  })

  it('纯函数：相同输入产生相等分量', () => {
    const hsl = { h: 140, s: 0.8, l: 0.55 }
    const a = hslToLinearColor(hsl)
    const b = hslToLinearColor(hsl)
    expect(a.r).toBe(b.r)
    expect(a.g).toBe(b.g)
    expect(a.b).toBe(b.b)
  })
})
