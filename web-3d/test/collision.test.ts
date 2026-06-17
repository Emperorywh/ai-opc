// Task 15 · 标签碰撞剔除 + LOD 联动 单测
//
// 验收（ROADMAP Task 15）：标签不重叠（AABB 断言）、缩放联动显隐。
// collision.ts 全是脱离 three/troika/DOM 的纯函数（同 Ocean/Terrain/labelLayout 惯例），
// 故本文件覆盖其全部纯函数；R3F 投影胶水（useLabelCollision）留 dev Review。
import { describe, it, expect } from 'vitest'
import {
  aabbIntersect,
  greedyCollision,
  aabbFromCorners,
  ndcToScreen,
  padAabb,
  densityVisible,
  stricterDensity,
  zoomToDensity,
  LABEL_PADDING_PX,
  LOD_ZOOM_THRESHOLDS,
  type AABB,
} from '../src/three/labels/collision'

describe('aabbIntersect · 屏幕 AABB 相交判定', () => {
  const a: AABB = { minX: 0, minY: 0, maxX: 10, maxY: 10 }
  it('完全不相交', () => {
    expect(aabbIntersect(a, { minX: 20, minY: 20, maxX: 30, maxY: 30 })).toBe(false)
  })
  it('部分重叠', () => {
    expect(aabbIntersect(a, { minX: 5, minY: 5, maxX: 15, maxY: 15 })).toBe(true)
  })
  it('包含（内部）', () => {
    expect(aabbIntersect(a, { minX: 2, minY: 2, maxX: 8, maxY: 8 })).toBe(true)
  })
  it('被包含（外部更大）', () => {
    expect(aabbIntersect(a, { minX: -5, minY: -5, maxX: 15, maxY: 15 })).toBe(true)
  })
  it('仅共享边不算相交（严格）', () => {
    expect(aabbIntersect(a, { minX: 10, minY: 0, maxX: 20, maxY: 10 })).toBe(false)
  })
  it('仅共享角不算相交（严格）', () => {
    expect(aabbIntersect(a, { minX: 10, minY: 10, maxX: 20, maxY: 20 })).toBe(false)
  })
  it('对称性 a↔b', () => {
    const b: AABB = { minX: 5, minY: 5, maxX: 15, maxY: 15 }
    expect(aabbIntersect(a, b)).toBe(aabbIntersect(b, a))
  })
})

describe('greedyCollision · 优先级贪心剔除', () => {
  it('无重叠全部保留', () => {
    const visible = greedyCollision([
      { id: 'a', priority: 100, bounds: { minX: 0, minY: 0, maxX: 10, maxY: 10 } },
      { id: 'b', priority: 80, bounds: { minX: 100, minY: 100, maxX: 110, maxY: 110 } },
    ])
    expect(visible.size).toBe(2)
    expect(visible.has('a')).toBe(true)
    expect(visible.has('b')).toBe(true)
  })
  it('完全重叠只留最高优先级', () => {
    const visible = greedyCollision([
      { id: 'low', priority: 50, bounds: { minX: 0, minY: 0, maxX: 10, maxY: 10 } },
      { id: 'high', priority: 100, bounds: { minX: 0, minY: 0, maxX: 10, maxY: 10 } },
      { id: 'mid', priority: 80, bounds: { minX: 0, minY: 0, maxX: 10, maxY: 10 } },
    ])
    expect(visible.size).toBe(1)
    expect(visible.has('high')).toBe(true)
  })
  it('高优先保留、与高优先重叠的低优先让位、独立标签保留', () => {
    const visible = greedyCollision([
      { id: 'high', priority: 100, bounds: { minX: 0, minY: 0, maxX: 10, maxY: 10 } },
      { id: 'low', priority: 50, bounds: { minX: 5, minY: 5, maxX: 15, maxY: 15 } }, // 与 high 重叠
      { id: 'free', priority: 30, bounds: { minX: 50, minY: 50, maxX: 60, maxY: 60 } }, // 独立
    ])
    expect(visible.has('high')).toBe(true)
    expect(visible.has('low')).toBe(false) // 被 high 剔除
    expect(visible.has('free')).toBe(true)
  })
  it('priority 降序放置：同级重叠时先入（priority 高）保留', () => {
    const visible = greedyCollision([
      { id: 'p70', priority: 70, bounds: { minX: 0, minY: 0, maxX: 10, maxY: 10 } },
      { id: 'p60', priority: 60, bounds: { minX: 0, minY: 0, maxX: 10, maxY: 10 } },
    ])
    expect(visible.has('p70')).toBe(true)
    expect(visible.has('p60')).toBe(false)
  })
  it('空输入返回空集', () => {
    expect(greedyCollision([]).size).toBe(0)
  })
  it('同级 priority 按传入序稳定（先入保留）', () => {
    const visible = greedyCollision([
      { id: 'first', priority: 100, bounds: { minX: 0, minY: 0, maxX: 10, maxY: 10 } },
      { id: 'second', priority: 100, bounds: { minX: 0, minY: 0, maxX: 10, maxY: 10 } },
    ])
    expect(visible.has('first')).toBe(true)
    expect(visible.has('second')).toBe(false)
  })
  it('不修改入参数组（纯函数）', () => {
    const labels = [
      { id: 'low', priority: 50, bounds: { minX: 0, minY: 0, maxX: 10, maxY: 10 } },
      { id: 'high', priority: 100, bounds: { minX: 0, minY: 0, maxX: 10, maxY: 10 } },
    ]
    const snapshot = labels.map((l) => ({ ...l }))
    greedyCollision(labels)
    expect(labels).toEqual(snapshot)
  })
})

describe('aabbFromCorners · 角点构造 AABB', () => {
  it('四角点取极值', () => {
    const aabb = aabbFromCorners([
      [10, 20],
      [30, 5],
      [15, 40],
      [25, 15],
    ])
    expect(aabb).toEqual({ minX: 10, minY: 5, maxX: 30, maxY: 40 })
  })
  it('单点退化为点 AABB', () => {
    expect(aabbFromCorners([[5, 5]])).toEqual({ minX: 5, minY: 5, maxX: 5, maxY: 5 })
  })
})

describe('ndcToScreen · NDC[-1,1]→像素（Y 翻转）', () => {
  it('中心 → 画布中心', () => {
    expect(ndcToScreen(0, 0, 1920, 1080)).toEqual([960, 540])
  })
  it('左下 NDC(-1,-1) → 左下像素(0,1080)', () => {
    expect(ndcToScreen(-1, -1, 1920, 1080)).toEqual([0, 1080])
  })
  it('右上 NDC(1,1) → 右上像素(1920,0)', () => {
    expect(ndcToScreen(1, 1, 1920, 1080)).toEqual([1920, 0])
  })
  it('Y 翻转：NDC 顶（y=1）→ 屏幕顶（y=0）', () => {
    expect(ndcToScreen(0, 1, 100, 100)[1]).toBe(0)
    expect(ndcToScreen(0, -1, 100, 100)[1]).toBe(100)
  })
})

describe('padAabb · 外扩 padding', () => {
  it('四周外扩', () => {
    const aabb: AABB = { minX: 10, minY: 10, maxX: 20, maxY: 20 }
    expect(padAabb(aabb, 5)).toEqual({ minX: 5, minY: 5, maxX: 25, maxY: 25 })
  })
  it('padding=0 不变', () => {
    const aabb: AABB = { minX: 1, minY: 2, maxX: 3, maxY: 4 }
    expect(padAabb(aabb, 0)).toEqual(aabb)
  })
  it('LABEL_PADDING_PX 为正', () => {
    expect(LABEL_PADDING_PX).toBeGreaterThan(0)
  })
})

describe('densityVisible · LOD 密度过滤（SPEC §6.5.1 大洲>大洋>大国>小国）', () => {
  it('continent 标签在所有密度均可见（最优先）', () => {
    expect(densityVisible('continent', 'all')).toBe(true)
    expect(densityVisible('continent', 'major')).toBe(true)
    expect(densityVisible('continent', 'continent')).toBe(true)
  })
  it('ocean 标签在 major/all 可见，continent 不可见', () => {
    expect(densityVisible('ocean', 'all')).toBe(true)
    expect(densityVisible('ocean', 'major')).toBe(true)
    expect(densityVisible('ocean', 'continent')).toBe(false)
  })
  it('country 标签同 ocean（Phase 2 大国 major 起）', () => {
    expect(densityVisible('country', 'all')).toBe(true)
    expect(densityVisible('country', 'major')).toBe(true)
    expect(densityVisible('country', 'continent')).toBe(false)
  })
  it('city 标签仅 all 可见（最细粒度）', () => {
    expect(densityVisible('city', 'all')).toBe(true)
    expect(densityVisible('city', 'major')).toBe(false)
    expect(densityVisible('city', 'continent')).toBe(false)
  })
})

describe('stricterDensity · 取更严格密度（zoom LOD × qualityTier 协同）', () => {
  it('all + major → major', () => {
    expect(stricterDensity('all', 'major')).toBe('major')
    expect(stricterDensity('major', 'all')).toBe('major')
  })
  it('continent 最严格（与任意组合都赢）', () => {
    expect(stricterDensity('continent', 'all')).toBe('continent')
    expect(stricterDensity('continent', 'major')).toBe('continent')
  })
  it('相同密度不变', () => {
    expect(stricterDensity('all', 'all')).toBe('all')
    expect(stricterDensity('continent', 'continent')).toBe('continent')
  })
})

describe('zoomToDensity · 缩放→密度（SPEC §6.5.4 LOD 缩放联动）', () => {
  it('zoom < continent 阈值 → continent', () => {
    expect(zoomToDensity(0)).toBe('continent')
    expect(zoomToDensity(LOD_ZOOM_THRESHOLDS.continent - 0.01)).toBe('continent')
  })
  it('zoom∈[continent,major) → major', () => {
    expect(zoomToDensity(LOD_ZOOM_THRESHOLDS.continent)).toBe('major')
    expect(zoomToDensity(0.5)).toBe('major')
    expect(zoomToDensity(LOD_ZOOM_THRESHOLDS.major - 0.01)).toBe('major')
  })
  it('zoom ≥ major → all', () => {
    expect(zoomToDensity(LOD_ZOOM_THRESHOLDS.major)).toBe('all')
    expect(zoomToDensity(1)).toBe('all')
  })
  it('单调：最远→continent，最近→all', () => {
    expect(zoomToDensity(0)).toBe('continent')
    expect(zoomToDensity(1)).toBe('all')
  })
})
