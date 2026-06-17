/**
 * 数据来源 / 许可信息（SPEC §12 数据来源规划 + §6.7 署名，M5 Task 18）。
 *
 * 纯数据 + 纯函数，可脱离 DOM/React 单测（照 loading.ts / atmosphereMaterial /
 * labelLayout 同构「非组件模块承载逻辑、组件只导出组件满足 react-refresh」）。
 *
 * 署名原则（合规）：仅列出**当前打包/分发的资产**及其许可，未接入的数据源不进署名行
 * （Phase 2/3 接入 Natural Earth 国家边界 / 河流等后再追加）。MVP 实际数据源
 * （SPEC §12.1 / PROGRESS Task 02b）：地形 = GEBCO 2026（免费公开数据，建议署名）；
 * 字体 = Noto Sans SC（思源黑体，OFL 1.1，PROGRESS Task 12）。
 *
 * ROADMAP Task 18 行的「NE/Copernicus/REMA」为数据源家族模板名；实际 MVP 依 SPEC §12.1
 * 以 GEBCO 为准（NE 国家边界 / 河流留 Phase 2/3，Copernicus / REMA 留 Phase 4 更高精度 DEM）。
 */

/** 数据/资产用途分类（许可弹窗分组用）。 */
export type SourceCategory = 'terrain' | 'font'

/** 单个数据来源 / 资产。 */
export interface DataSource {
  /** 稳定 id（去重 / 单测）。 */
  id: string
  /** 展示名（含版本 / 项目名）。 */
  name: string
  /** 在本项目中的用途（中文）。 */
  role: string
  /** 用途分类。 */
  category: SourceCategory
  /** 许可类型标签（中文）。 */
  license: string
  /** 许可 / 来源官网 URL（http/https）。 */
  url: string
  /** 是否当前 MVP 打包使用；false = 规划中（Phase 2+），不进常驻署名行。 */
  active: boolean
}

/** 分类中文标签（亦决定弹窗展示顺序：地形 → 字体）。 */
export const CATEGORY_LABELS: Record<SourceCategory, string> = {
  terrain: '地形数据',
  font: '字体',
}

/** 分类展示顺序（与 CATEGORY_LABELS 同源）。 */
export const CATEGORY_ORDER: readonly SourceCategory[] = ['terrain', 'font']

/**
 * 数据来源全集（MVP 实际打包 + 未来规划）。
 *
 * 仅 `active:true` 者进常驻署名行 / 许可弹窗主列表；`active:false`（规划中）保留以备
 * Phase 2/3 接入后翻 true（数据结构就绪，不破坏既有测试）。
 */
export const DATA_SOURCES: readonly DataSource[] = [
  {
    id: 'gebco',
    name: 'GEBCO 2026 Grid',
    role: '全球地形高程与海底测深（heightmap + bathymetry，喂海洋深浅渐变）',
    category: 'terrain',
    license: '免费公开数据（建议署名）',
    url: 'https://www.gebco.net/',
    active: true,
  },
  {
    id: 'noto-sans-sc',
    name: 'Noto Sans SC（思源黑体）',
    role: '中文标签字体（map-zh.woff2 子集化产物，PROGRESS Task 12）',
    category: 'font',
    license: 'SIL Open Font License 1.1',
    url: 'https://fonts.google.com/noto/specimen/Noto+Sans+SC',
    active: true,
  },
]

/** OFL 字体许可附加说明（子集化产物仍受 OFL 约束，需保留许可声明）。 */
export const FONT_LICENSE_NOTE =
  '字体经子集化处理，仍遵循 SIL Open Font License 1.1（可自由使用、修改与再分发，需保留许可声明）。'

/**
 * 校验单条来源字段完整：id/name/role/license 非空，且 url 为 http(s)。
 * 供 DATA_SOURCES 自检 + 单测断言。
 */
export function isValidSource(s: DataSource): boolean {
  return (
    typeof s.id === 'string' &&
    s.id.trim().length > 0 &&
    typeof s.name === 'string' &&
    s.name.trim().length > 0 &&
    typeof s.role === 'string' &&
    s.role.trim().length > 0 &&
    typeof s.license === 'string' &&
    s.license.trim().length > 0 &&
    typeof s.url === 'string' &&
    /^https?:\/\//i.test(s.url)
  )
}

/** 当前 MVP 打包使用的数据来源（按 DATA_SOURCES 原序）。 */
export function activeSources(sources: readonly DataSource[] = DATA_SOURCES): DataSource[] {
  return sources.filter((s) => s.active)
}

/**
 * 常驻署名行文案（来源名以「·」连接）。
 * 例：`GEBCO 2026 Grid · Noto Sans SC（思源黑体）`。
 */
export function formatAttributionLine(sources: readonly DataSource[] = activeSources()): string {
  return sources.map((s) => s.name).join(' · ')
}

/**
 * 按分类分组（保持 CATEGORY_ORDER 顺序、组内保持来源原序；跳过空分类）。
 * 许可弹窗按地形 → 字体分组展示。
 */
export function groupSourcesByCategory(
  sources: readonly DataSource[] = activeSources(),
): Array<[SourceCategory, DataSource[]]> {
  const buckets = new Map<SourceCategory, DataSource[]>()
  for (const s of sources) {
    const arr = buckets.get(s.category)
    if (arr) arr.push(s)
    else buckets.set(s.category, [s])
  }
  const result: Array<[SourceCategory, DataSource[]]> = []
  for (const cat of CATEGORY_ORDER) {
    const arr = buckets.get(cat)
    if (arr && arr.length > 0) result.push([cat, arr])
  }
  return result
}
