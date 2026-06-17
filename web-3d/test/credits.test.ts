import { describe, it, expect } from 'vitest'
import {
  DATA_SOURCES,
  CATEGORY_LABELS,
  CATEGORY_ORDER,
  FONT_LICENSE_NOTE,
  activeSources,
  formatAttributionLine,
  groupSourcesByCategory,
  isValidSource,
  type DataSource,
} from '../src/ui/credits'

describe('DATA_SOURCES 数据完整性', () => {
  it('每条来源字段完整（id/name/role/license 非空 + url 为 http(s)）', () => {
    expect(DATA_SOURCES.length).toBeGreaterThan(0)
    for (const s of DATA_SOURCES) {
      expect(isValidSource(s)).toBe(true)
    }
  })

  it('id 唯一', () => {
    const ids = DATA_SOURCES.map((s) => s.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('url 唯一', () => {
    const urls = DATA_SOURCES.map((s) => s.url)
    expect(new Set(urls).size).toBe(urls.length)
  })

  it('category 全部取自合法枚举', () => {
    const valid = Object.keys(CATEGORY_LABELS)
    for (const s of DATA_SOURCES) {
      expect(valid).toContain(s.category)
    }
  })

  it('MVP 至少含地形与字体两类 active 来源', () => {
    const cats = new Set(activeSources().map((s) => s.category))
    expect(cats.has('terrain')).toBe(true)
    expect(cats.has('font')).toBe(true)
  })

  it('MVP 地形来源为 GEBCO（SPEC §12.1 实际数据源，PROGRESS Task 02b 打包）', () => {
    const terrain = DATA_SOURCES.filter((s) => s.category === 'terrain' && s.active)
    expect(terrain.length).toBeGreaterThan(0)
    expect(terrain.some((s) => /gebco/i.test(s.name))).toBe(true)
  })

  it('MVP 字体来源为 Noto Sans SC 且 OFL 许可（PROGRESS Task 12）', () => {
    const fonts = DATA_SOURCES.filter((s) => s.category === 'font' && s.active)
    expect(fonts.length).toBeGreaterThan(0)
    expect(fonts.some((s) => /noto.*sans.*sc|思源/i.test(s.name))).toBe(true)
    expect(fonts.every((s) => /open font license|OFL/i.test(s.license))).toBe(true)
  })

  it('OFL 字体附加说明非空（子集化仍受 OFL 约束）', () => {
    expect(FONT_LICENSE_NOTE.trim().length).toBeGreaterThan(0)
  })

  it('MVP 不误列未接入的 NE/Copernicus/REMA 为 active（合规：仅署名实际打包资产）', () => {
    for (const s of activeSources()) {
      expect(/natural earth/i.test(s.name)).toBe(false)
      expect(/copernicus/i.test(s.name)).toBe(false)
      expect(/\brema\b/i.test(s.name)).toBe(false)
    }
  })
})

describe('activeSources', () => {
  it('仅返回 active:true 来源', () => {
    for (const s of activeSources()) expect(s.active).toBe(true)
  })

  it('过滤 inactive（规划中来源不进 active 列表）', () => {
    const mixed: DataSource[] = [
      { id: 'a', name: 'A', role: 'r', category: 'terrain', license: 'l', url: 'https://a', active: true },
      { id: 'b', name: 'B', role: 'r', category: 'font', license: 'l', url: 'https://b', active: false },
    ]
    expect(activeSources(mixed).map((s) => s.id)).toEqual(['a'])
  })
})

describe('formatAttributionLine', () => {
  it('以「·」连接 active 来源名（默认参 = 全部 active）', () => {
    const line = formatAttributionLine()
    const names = activeSources().map((s) => s.name)
    expect(line).toBe(names.join(' · '))
    for (const n of names) expect(line).toContain(n)
  })

  it('接收自定义来源列表', () => {
    const custom: DataSource[] = [
      { id: 'a', name: 'Aaa', role: 'r', category: 'terrain', license: 'l', url: 'https://a', active: true },
      { id: 'b', name: 'Bbb', role: 'r', category: 'font', license: 'l', url: 'http://b', active: true },
    ]
    expect(formatAttributionLine(custom)).toBe('Aaa · Bbb')
  })

  it('空列表 → 空串', () => {
    expect(formatAttributionLine([])).toBe('')
  })
})

describe('groupSourcesByCategory', () => {
  it('按分类分组，每组非空，分类键合法', () => {
    const groups = groupSourcesByCategory()
    expect(groups.length).toBeGreaterThan(0)
    for (const [cat, items] of groups) {
      expect(CATEGORY_LABELS[cat]).toBeTruthy()
      expect(items.length).toBeGreaterThan(0)
    }
  })

  it('分组顺序遵循 CATEGORY_ORDER（地形 → 字体）', () => {
    const cats = groupSourcesByCategory().map(([cat]) => cat)
    expect(cats).toEqual(CATEGORY_ORDER.filter((c) => cats.includes(c)))
    // 地形在字体之前（两者皆存在时）
    const ti = cats.indexOf('terrain')
    const fi = cats.indexOf('font')
    if (ti >= 0 && fi >= 0) expect(ti).toBeLessThan(fi)
  })

  it('组内保持来源原序', () => {
    const custom: DataSource[] = [
      { id: 't1', name: 'T1', role: 'r', category: 'terrain', license: 'l', url: 'https://t1', active: true },
      { id: 'f1', name: 'F1', role: 'r', category: 'font', license: 'l', url: 'https://f1', active: true },
      { id: 't2', name: 'T2', role: 'r', category: 'terrain', license: 'l', url: 'https://t2', active: true },
    ]
    const groups = groupSourcesByCategory(custom)
    const terrain = groups.find(([c]) => c === 'terrain')?.[1].map((s) => s.id)
    expect(terrain).toEqual(['t1', 't2'])
  })

  it('每个来源恰好归入一个分类组（无丢失无重复）', () => {
    const groups = groupSourcesByCategory()
    const all = groups.flatMap(([, items]) => items)
    expect(all.length).toBe(activeSources().length)
  })

  it('跳过空分类', () => {
    const onlyTerrain: DataSource[] = [
      { id: 't', name: 'T', role: 'r', category: 'terrain', license: 'l', url: 'https://t', active: true },
    ]
    const cats = groupSourcesByCategory(onlyTerrain).map(([c]) => c)
    expect(cats).toEqual(['terrain'])
  })
})

describe('isValidSource', () => {
  const valid: DataSource = {
    id: 'x',
    name: 'X',
    role: 'r',
    category: 'terrain',
    license: 'l',
    url: 'https://x.com',
    active: true,
  }

  it('合法来源通过', () => {
    expect(isValidSource(valid)).toBe(true)
  })

  it('http url 同样通过', () => {
    expect(isValidSource({ ...valid, url: 'http://x.com' })).toBe(true)
  })

  it('空白 id 拒绝', () => {
    expect(isValidSource({ ...valid, id: '   ' })).toBe(false)
  })

  it('空 name 拒绝', () => {
    expect(isValidSource({ ...valid, name: '' })).toBe(false)
  })

  it('空 role 拒绝', () => {
    expect(isValidSource({ ...valid, role: '' })).toBe(false)
  })

  it('空 license 拒绝', () => {
    expect(isValidSource({ ...valid, license: '' })).toBe(false)
  })

  it('非 http(s) url 拒绝（ftp）', () => {
    expect(isValidSource({ ...valid, url: 'ftp://x.com' })).toBe(false)
  })

  it('空 url 拒绝', () => {
    expect(isValidSource({ ...valid, url: '' })).toBe(false)
  })
})
