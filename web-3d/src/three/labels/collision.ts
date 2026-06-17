/**
 * 标签碰撞剔除 + LOD 联动（SPEC §6.5「优先级视口碰撞剔除 + LOD 缩放联动」/ §8 性能节流）。
 *
 * 纯常量 + 纯函数（可脱离 three / troika / DOM 单测），与 labelLayout.ts / oceanMaterial.ts /
 * cameraState.ts 同构：非组件模块承载算法，组件 / hook（useLabelCollision）只做 R3F 胶水。
 *
 * Task 15 落地 §6.5.1–5：
 *  1. AABB 贪心剔除（按 priority 排序，与已放置 AABB 相交 → 隐藏）
 *  2. LOD 缩放联动（cameraZoom → 密度）+ qualityTier `labelDensity` 取更严格者
 *  3. 屏幕投影辅助（NDC→像素、角点→AABB、外扩 padding）
 *
 * 范围切割：collision.ts = 算法纯函数（全单测）；useLabelCollision.ts = R3F useFrame 胶水
 * （troika bounds 投影 + 设 text.visible）。M4 仅 11 条标签地理分散、几无重叠，碰撞在 MVP
 * 阶段主要验证算法正确性，为 Phase 2 数百标签铺路（SPEC §6.5.5「排序列表足够」）。
 */
import type { Label } from '../../data/types'
import type { LabelDensity } from '../../config/quality'

/** 屏幕空间轴对齐包围盒（像素单位）。 */
export type AABB = { minX: number; minY: number; maxX: number; maxY: number }

/** 参与碰撞的标签（id + 优先级 + 屏幕 AABB）。 */
export type PlacedLabel = { id: string; priority: number; bounds: AABB }

/**
 * 两个屏幕 AABB 是否相交（SPEC §6.5.3「相交则隐藏」）。
 * 严格相交（仅共享边 / 共享角不算）—— 避免紧贴的相邻标签被判重叠，与视觉「不重叠」语义一致。
 */
export function aabbIntersect(a: AABB, b: AABB): boolean {
  return a.minX < b.maxX && a.maxX > b.minX && a.minY < b.maxY && a.maxY > b.minY
}

/**
 * 优先级贪心碰撞剔除（SPEC §6.5.2–3）。
 *
 * 按 priority 降序排序后逐个放入；与任一已放置 AABB 相交则剔除（不显示）。
 * priority 高的先放入、占位，低优先级的若与之相交则让位 → 重要标签优先可见。
 *
 * 返回「应显示」的 id 集合。同级 priority 按传入序稳定（Array.sort 稳定）。
 * O(n²) 对数百标签可承受（SPEC §6.5.5）；Phase 3 上千标签可换 Quadtree/RTree。
 */
export function greedyCollision(labels: PlacedLabel[]): Set<string> {
  const sorted = [...labels].sort((a, b) => b.priority - a.priority)
  const placed: AABB[] = []
  const visible = new Set<string>()
  for (const label of sorted) {
    const collide = placed.some((p) => aabbIntersect(label.bounds, p))
    if (!collide) {
      placed.push(label.bounds)
      visible.add(label.id)
    }
  }
  return visible
}

/** 由一组屏幕角点构造 AABB（取最小 / 最大 x/y）。 */
export function aabbFromCorners(corners: ReadonlyArray<readonly [number, number]>): AABB {
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const [x, y] of corners) {
    if (x < minX) minX = x
    if (x > maxX) maxX = x
    if (y < minY) minY = y
    if (y > maxY) maxY = y
  }
  return { minX, minY, maxX, maxY }
}

/**
 * NDC[-1,1] → 屏幕像素坐标（Y 翻转：屏幕原点左上，NDC 原点中心、Y 向上）。
 * 供 useLabelCollision 把投影后的文字角点统一到屏幕空间比较。
 */
export function ndcToScreen(ndcX: number, ndcY: number, width: number, height: number): [number, number] {
  return [(ndcX * 0.5 + 0.5) * width, (-ndcY * 0.5 + 0.5) * height]
}

/** 标签 AABB 外扩 padding（像素），避免文字紧贴判重叠（美学留 Review）。 */
export function padAabb(aabb: AABB, padding: number): AABB {
  return {
    minX: aabb.minX - padding,
    minY: aabb.minY - padding,
    maxX: aabb.maxX + padding,
    maxY: aabb.maxY + padding,
  }
}

/** 标签碰撞 AABB 外扩 padding（像素，SPEC §6.5 默认紧凑放置，留少量间距）。 */
export const LABEL_PADDING_PX = 4

// ---------------------------------------------------------------------------
// LOD 联动（SPEC §6.5.4「低 zoom 仅大洲/大洋…」+ §8 quality tier `labelDensity`）
// ---------------------------------------------------------------------------

/**
 * 标签密度可见度（越大越宽松 = 显示越多）：
 *  - all(2)：全部标签（含未来国家 / 城市）
 *  - major(1)：大洲 + 大洋（+ 未来大国）
 *  - continent(0)：仅大洲（SPEC §8 低档「仅大洲标签」）
 */
const DENSITY_VISIBILITY: Record<LabelDensity, number> = { all: 2, major: 1, continent: 0 }

/**
 * 各 kind 标签的「最低显示密度」（越小越易显示）。落地 SPEC §6.5.1「大洲 > 大洋 > 大国 > 小国」梯度：
 *  - continent：最低密度 continent 也可见（最优先）
 *  - ocean：需 major 及以上
 *  - country：需 major 及以上（Phase 2 大国先于小国；细分小国可在此加密）
 *  - city：需 all（最细粒度）
 */
const KIND_MIN_VISIBILITY: Record<Label['kind'], number> = {
  continent: 0,
  ocean: 1,
  country: 1,
  city: 2,
}

/** 标签在给定密度下是否该显示（密度可见度 ≥ 标签最低需求 → 显示）。 */
export function densityVisible(kind: Label['kind'], density: LabelDensity): boolean {
  return DENSITY_VISIBILITY[density] >= KIND_MIN_VISIBILITY[kind]
}

/** 取两个密度的更严格者（可见度更小者）—— cameraZoom LOD 与 qualityTier `labelDensity` 协同。 */
export function stricterDensity(a: LabelDensity, b: LabelDensity): LabelDensity {
  return DENSITY_VISIBILITY[a] <= DENSITY_VISIBILITY[b] ? a : b
}

/**
 * cameraZoom LOD 阈值（zoom∈[0,1]，0=最远 1=最近）。
 * 远 → 严格密度（仅大洲），近 → 宽松（全部）。SPEC §6.5.4「低 zoom 仅大洲/大洋…」。
 * 阈值属美学 / 手感，默认值留人工 Review。
 */
export const LOD_ZOOM_THRESHOLDS = {
  /** zoom 低于此值 → continent（仅大洲）。 */
  continent: 0.33,
  /** zoom∈[continent, major) → major；≥ major → all。 */
  major: 0.66,
} as const

/** 相机缩放 → 标签密度档（SPEC §6.5.4 LOD 缩放联动）。 */
export function zoomToDensity(zoom: number): LabelDensity {
  if (zoom < LOD_ZOOM_THRESHOLDS.continent) return 'continent'
  if (zoom < LOD_ZOOM_THRESHOLDS.major) return 'major'
  return 'all'
}
