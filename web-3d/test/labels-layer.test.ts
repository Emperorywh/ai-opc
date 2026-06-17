// Task 14 · LabelLayer 渲染层单测
//
// 验收（ROADMAP Task 14）：标签中文正确显示、锚点对齐、build/lint 过。
// troika `Text` 实例化需浏览器（WebGL/字体 worker），Node 环境无法直接驱动组件 →
// 单测聚焦可脱离 DOM 的纯函数（同 Ocean/Terrain 惯例：纯函数 + 配置契约）：
//   - parseLabels：labels.json 运行时解析校验（非法输入抛错、合法解析为 Label[]）
//   - labelWorldPosition：锚点 x/z = project 同源；陆地贴地面、大洋贴海面 max；yOffset 应用
//   - LABEL_STYLE：视觉常量合理性（防回归）
//   - labelFontUrl：指向 Task 12 产出的 map-zh.woff2
import { describe, it, expect } from 'vitest'
import { parseLabels, sampleWorldY } from '../src/data/assets'
import { project } from '../src/config/projection'
import { LABEL_STYLE, labelFontUrl, labelWorldPosition } from '../src/three/labels/labelLayout'
import type { ElevationData, Label } from '../src/data/types'
import type { ElevationMeta } from '../src/config/projection'

/** 构造均匀高程（所有像素同 raw16 值）→ 任意 lon/lat 双线性采样返回该 h（值已知）。 */
function flatElevation(raw16: number, width = 4, height = 2): ElevationData {
  const data = new Uint16Array(width * height)
  data.fill(raw16)
  return { width, height, data }
}

const meta: ElevationMeta = {
  elevationMin: -4000,
  elevationMax: 4000,
  seaLevelMeters: 0,
  width: 4,
  height: 2,
}
// seaLevelWorldY = metersToWorldY(0) = 0

function labelAt(lon: number, lat: number): Label {
  return {
    id: 'x',
    zhName: '测试',
    kind: 'continent',
    continent: 'x',
    lon,
    lat,
    priority: 100,
  }
}

describe('parseLabels · labels.json 运行时解析', () => {
  const valid = [
    { id: 'asia', zhName: '亚洲', kind: 'continent', continent: 'asia', lon: 95, lat: 45, priority: 100 },
    { id: 'pacific', zhName: '太平洋', kind: 'ocean', continent: null, lon: -160, lat: 0, priority: 80 },
  ]

  it('合法数组解析为 Label[]', () => {
    const labels = parseLabels(valid)
    expect(labels).toHaveLength(2)
    expect(labels[0]).toMatchObject({
      id: 'asia',
      zhName: '亚洲',
      kind: 'continent',
      continent: 'asia',
      lon: 95,
      lat: 45,
      priority: 100,
    })
    // 大洋 continent=null 保留
    expect(labels[1]).toMatchObject({ id: 'pacific', kind: 'ocean', continent: null, priority: 80 })
  })

  it('非数组输入抛错', () => {
    expect(() => parseLabels({})).toThrow()
    expect(() => parseLabels('x')).toThrow()
    expect(() => parseLabels(null)).toThrow()
  })

  it('元素非对象抛错', () => {
    expect(() => parseLabels([1, 2])).toThrow()
    expect(() => parseLabels([null])).toThrow()
  })

  it('缺字段抛错', () => {
    expect(() => parseLabels([{ id: 'x' }])).toThrow()
    expect(() => parseLabels([{ id: 'x', zhName: 'X', kind: 'continent', continent: null }])).toThrow()
  })

  it('kind 非法值抛错', () => {
    expect(() =>
      parseLabels([
        { id: 'x', zhName: 'X', kind: 'region', continent: null, lon: 0, lat: 0, priority: 1 },
      ]),
    ).toThrow()
  })

  it('continent 非 string|null 抛错', () => {
    expect(() =>
      parseLabels([
        { id: 'x', zhName: 'X', kind: 'continent', continent: 123, lon: 0, lat: 0, priority: 1 },
      ]),
    ).toThrow()
  })

  it('经纬度/优先级非有限数抛错', () => {
    expect(() =>
      parseLabels([
        { id: 'x', zhName: 'X', kind: 'continent', continent: null, lon: NaN, lat: 0, priority: 1 },
      ]),
    ).toThrow()
    expect(() =>
      parseLabels([
        { id: 'x', zhName: 'X', kind: 'continent', continent: null, lon: 0, lat: 0, priority: Infinity },
      ]),
    ).toThrow()
  })

  it('真实 labels.json 结构（7 大洲 + 4 大洋）字段全覆盖', () => {
    // 复刻 Task 13 产出的一条大洲 + 一条大洋的最小完整对象
    const labels = parseLabels(valid)
    labels.forEach((l) => {
      expect(typeof l.id).toBe('string')
      expect(typeof l.zhName).toBe('string')
      expect(['continent', 'ocean', 'country', 'city']).toContain(l.kind)
      expect(l.continent === null || typeof l.continent === 'string').toBe(true)
      expect(typeof l.lon).toBe('number')
      expect(typeof l.lat).toBe('number')
      expect(typeof l.priority).toBe('number')
    })
  })
})

describe('labelWorldPosition · 锚点对齐（R2 project + R3 高度表同源）', () => {
  it('x/z 与 project 严格同源', () => {
    const elevation = flatElevation(0)
    for (const [lon, lat] of [
      [95, 45],
      [-100, 45],
      [0, -82],
      [-160, 0],
    ] as const) {
      const lbl = labelAt(lon, lat)
      const [x, , z] = labelWorldPosition(lbl, elevation, meta, 0)
      const [px, pz] = project(lon, lat)
      expect(x).toBeCloseTo(px, 10)
      expect(z).toBeCloseTo(pz, 10)
    }
  })

  it('陆地锚点贴地面（地面 > 海面，取地面）', () => {
    // h=0.75 → meters = -4000 + 0.75*8000 = 2000 → worldY = 0.05（> 海面 0）
    const elevation = flatElevation(49152)
    const lbl = labelAt(30, 30)
    const [, y] = labelWorldPosition(lbl, elevation, meta, 0)
    const groundY = sampleWorldY(elevation, meta, 30, 30)
    expect(y).toBeCloseTo(groundY, 10) // max(0.05, 0) = 0.05
    expect(y).toBeGreaterThan(0)
  })

  it('大洋锚点贴海平面（海底 < 海面，取海面）', () => {
    // h=0 → meters = -4000 → worldY = -0.1（海底），海面 = 0
    const elevation = flatElevation(0)
    const lbl = labelAt(0, 0)
    const [, y] = labelWorldPosition(lbl, elevation, meta, 0)
    expect(y).toBeCloseTo(0, 10) // max(-0.1, 0) = 0
    const groundY = sampleWorldY(elevation, meta, 0, 0)
    expect(groundY).toBeLessThan(0) // 确认海底为负，验证 max 真的把负值抬到海面
  })

  it('heightOffset 应用到锚点 Y（陆地与大洋均叠加）', () => {
    const land = flatElevation(49152) // 地面 0.05
    const lbl = labelAt(0, 0)
    const [, y0] = labelWorldPosition(lbl, land, meta, 0)
    const [, yOff] = labelWorldPosition(lbl, land, meta, 0.05)
    expect(yOff - y0).toBeCloseTo(0.05, 10)

    const sea = flatElevation(0) // 海底 -0.1 → 锚点海面 0
    const [, ys0] = labelWorldPosition(lbl, sea, meta, 0)
    const [, ysOff] = labelWorldPosition(lbl, sea, meta, 0.05)
    expect(ys0).toBeCloseTo(0, 10)
    expect(ysOff).toBeCloseTo(0.05, 10)
  })

  it('海平面非 0 时锚点贴合（seaLevelWorldY 同源）', () => {
    const metaSea: ElevationMeta = { ...meta, seaLevelMeters: 1000 }
    // 海面 = metersToWorldY(1000) = 0.025；海底（h=0）= -0.1 → 取海面 0.025
    const elevation = flatElevation(0)
    const lbl = labelAt(0, 0)
    const [, y] = labelWorldPosition(lbl, elevation, metaSea, 0)
    expect(y).toBeCloseTo(0.025, 10)
  })
})

describe('LABEL_STYLE · 视觉常量合理性', () => {
  it('字号/描边/偏移非负', () => {
    expect(LABEL_STYLE.fontSize).toBeGreaterThan(0)
    expect(LABEL_STYLE.outlineWidth).toBeGreaterThanOrEqual(0)
    expect(LABEL_STYLE.heightOffset).toBeGreaterThanOrEqual(0)
    expect(LABEL_STYLE.outlineOpacity).toBeGreaterThanOrEqual(0)
    expect(LABEL_STYLE.outlineOpacity).toBeLessThanOrEqual(1)
  })

  it('颜色为合法 hex', () => {
    expect(LABEL_STYLE.color).toMatch(/^#[0-9a-f]{6}$/i)
    expect(LABEL_STYLE.outlineColor).toMatch(/^#[0-9a-f]{6}$/i)
  })

  it('锚点居中', () => {
    expect(LABEL_STYLE.anchorX).toBe('center')
    expect(LABEL_STYLE.anchorY).toBe('middle')
  })
})

describe('labelFontUrl · 指向 Task 12 子集字体', () => {
  it('URL 含 fonts/map-zh.woff2', () => {
    expect(labelFontUrl()).toContain('fonts/map-zh.woff2')
  })
})
