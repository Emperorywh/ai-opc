import { describe, it, expect } from 'vitest'
import { palette, SATURATION_REDUCTION, desaturateHex } from '../src/config/palette'

describe('desaturateHex（SPEC §2.1：S 降 15–25%）', () => {
  it('默认降幅 = 0.2（取中值）', () => {
    expect(SATURATION_REDUCTION).toBe(0.2)
    expect(SATURATION_REDUCTION).toBeGreaterThanOrEqual(0.15)
    expect(SATURATION_REDUCTION).toBeLessThanOrEqual(0.25)
  })

  it('amount=0 → 原色精确往返（无 HSL 8-bit 舍入）', () => {
    for (const c of ['#7FC4C0', '#8FA98A', '#2E6E73', '#D9C39B', '#7E8B76']) {
      expect(desaturateHex(c, 0)).toBe(c)
    }
  })

  it('amount=1 → 完全去饱和为灰（R=G=B）', () => {
    for (const c of ['#7FC4C0', '#8FA98A', '#D9C39B']) {
      const gray = desaturateHex(c, 1).replace('#', '')
      const r = parseInt(gray.slice(0, 2), 16)
      const g = parseInt(gray.slice(2, 4), 16)
      const b = parseInt(gray.slice(4, 6), 16)
      expect(r).toBe(g)
      expect(g).toBe(b)
    }
  })

  it('降幅后饱和度严格下降（高饱和色 #FF0000 S=1 → 0.8）', () => {
    // #FF0000 纯红 S=1；降 0.2 → S=0.8。校验输出 hex 解出的 HSL S ≈ 0.8
    const out = desaturateHex('#FF0000', 0.2)
    const h = out.replace('#', '')
    const r = parseInt(h.slice(0, 2), 16) / 255
    const g = parseInt(h.slice(2, 4), 16) / 255
    const b = parseInt(h.slice(4, 6), 16) / 255
    const max = Math.max(r, g, b)
    const min = Math.min(r, g, b)
    const l = (max + min) / 2
    const s = l > 0.5 ? (max - min) / (2 - max - min) : (max - min) / (max + min)
    expect(s).toBeCloseTo(0.8, 1)
  })

  it('色相/明度不变（仅降 S）', () => {
    // HSL 中 H、L 在仅改 S 时不变；用 #7FC4C0 校验 L 往返
    const hex = '#7FC4C0'
    const lOf = (c: string) => {
      const h = c.replace('#', '')
      const r = parseInt(h.slice(0, 2), 16) / 255
      const g = parseInt(h.slice(2, 4), 16) / 255
      const b = parseInt(h.slice(4, 6), 16) / 255
      return (Math.max(r, g, b) + Math.min(r, g, b)) / 2
    }
    expect(lOf(desaturateHex(hex, 0.2))).toBeCloseTo(lOf(hex), 1)
  })

  it('输出仍为合法 #RRGGBB hex', () => {
    for (const c of ['#7FC4C0', '#8FA98A', '#2E6E73', '#E8EAEC']) {
      expect(desaturateHex(c, 0.2)).toMatch(/^#[0-9a-f]{6}$/)
    }
  })

  it('支持 #RGB 缩写', () => {
    expect(desaturateHex('#F00', 0)).toBe('#F00')
    expect(desaturateHex('#F00', 0.2)).toMatch(/^#[0-9a-f]{6}$/)
  })

  it('非法 hex 抛错', () => {
    expect(() => desaturateHex('nope', 0.2)).toThrow()
    expect(() => desaturateHex('#12', 0.2)).toThrow()
  })
})

describe('palette 雪线色（Task 08 新增，§2.2.1 雪线带）', () => {
  it('snow 为近白 #E8EAEC', () => {
    expect(palette.snow).toBe('#E8EAEC')
  })

  it('palette 既有色值未被 Task 08 改动（向后兼容，ocean Task 07 依赖）', () => {
    expect(palette.oceanShallow).toBe('#7FC4C0')
    expect(palette.oceanDeep).toBe('#2E6E73')
    expect(palette.grassland).toEqual(['#8FA98A', '#A9C0A0'])
    expect(palette.mountain).toEqual(['#7E8B76', '#9AA892'])
    expect(palette.desert).toEqual(['#D9C39B', '#C9B083'])
    expect(palette.border).toBe('#F3E9D2')
  })
})
