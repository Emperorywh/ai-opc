/**
 * 国家信息解析（SPEC §6.7 数据标注面板 / D19「仅名称+所属大洲」+ §10 国名质心落海修复，Task 24）。
 *
 * 非组件模块（纯常量 + 纯函数），与 labelLayout.ts / boundaryGeometry.ts 同构——承载常量与
 * 纯函数，组件模块（CountryCard.tsx）只导出组件（满足 react-refresh/only-export-components）。
 *
 * 解决两个数据缺口（M8 Task 24 范围）：
 *   1) 中文国名：boundaries.bin 仅存 ISO_A3 + 大洲（英文，见 boundaries-data.mjs CONTINENTS），
 *      无中文名。本模块提供 ISO_A3→中文国名表（覆盖当前合成 6 国；真实 NE ~200 国中文名留
 *      Task 25 标签数据 pipeline `4-labels-zh.mjs` ISO_A3 join 扩展，届时可并入 labels.json
 *      国家项，本解析函数签名保持不变）。
 *   2) 大洲中文名：boundaries 存英文大洲名（"Asia"/"North America"…），面板需中文。
 *
 * 质心落海修复（SPEC §10「国名质心落海」）：海外领土国家（USA 本土+阿拉斯加+夏威夷）顶点
 *   均值落入太平洋 → 提供人工锚点表覆盖（主体陆地质心）；其余单主体陆地国家用顶点均值
 *   （=多边形质心，落陆地）。
 */
import type { BoundaryCountry, BoundaryData } from '../../data/types'

/**
 * 大洲英文 → 中文（与 boundaries-data.mjs CONTINENTS 枚举逐一对应）。
 * 未知键回退原值（continentZh 守），避免面板空白。
 */
export const CONTINENT_ZH: Record<string, string> = {
  Africa: '非洲',
  Antarctica: '南极洲',
  Asia: '亚洲',
  Europe: '欧洲',
  'North America': '北美洲',
  Oceania: '大洋洲',
  'South America': '南美洲',
  'Seven seas': '公海',
}

/**
 * ISO_A3 → 中文国名（当前合成数据覆盖 6 国）。
 *
 * 真实 NE ~200 国中文名由 Task 25 标签数据 pipeline（`4-labels-zh.mjs` ISO_A3 join）产出，
 * 届时可迁移并入 labels.json 国家项；countryZhName 解析逻辑不变。
 */
export const COUNTRY_ZH_NAMES: Record<string, string> = {
  CHN: '中国',
  USA: '美国',
  FRA: '法国',
  BRA: '巴西',
  AUS: '澳大利亚',
  EGY: '埃及',
}

/**
 * 人工锚点（ISO_A3 → [lon,lat]）修复国名质心落海（SPEC §10）。
 *
 * 仅列「顶点均值落海」的海外领土国家，取主体陆地质心：
 *   · USA：本土矩形 (-125..-67, 25..49) 质心 (-96, 37)；不含阿拉斯加 (-170..-141) /
 *     夏威夷 (-160..-154)（二者把 12 顶点均值拖到 ~(-136,40) 太平洋）。
 *
 * 真实 NE 接入后，法国（法属圭亚那等海外省）、俄罗斯（弗兰格尔岛等）等若质心落海，
 * 在此补锚点（与 Task 25 真实数据同步）。当前合成数据仅 USA 需修复。
 */
export const COUNTRY_ANCHORS: Record<string, readonly [number, number]> = {
  USA: [-96, 37],
}

/** 大洲中文名（英文未知时回退原值，避免面板空白）。 */
export function continentZh(continent: string): string {
  return CONTINENT_ZH[continent] ?? continent
}

/** 中文国名（ISO_A3 未知时回退 ISO_A3，避免面板空白）。 */
export function countryZhName(isoA3: string): string {
  return COUNTRY_ZH_NAMES[isoA3] ?? isoA3
}

/** 面板展示的国家信息（D19：名称 + 所属大洲）。 */
export interface CountryInfo {
  isoA3: string
  zhName: string
  zhContinent: string
}

/**
 * 解析国家为面板信息（中文国名 + 中文大洲）。
 * 大洲取自 `continents[country.continentIndex]`（boundaries.bin 大洲名表，英文）→ continentZh。
 */
export function resolveCountryInfo(
  country: BoundaryCountry,
  continents: string[],
): CountryInfo {
  const continent = continents[country.continentIndex] ?? ''
  return {
    isoA3: country.isoA3,
    zhName: countryZhName(country.isoA3),
    zhContinent: continentZh(continent),
  }
}

/**
 * 国家质心锚点 [lon,lat]（SPEC §10 落海修复）。
 *
 *   · COUNTRY_ANCHORS 命中 → 人工锚点（主体陆地质心，修复海外领土落海）
 *   · 否则 → 该国全部顶点 (lon,lat) 均值（单主体陆地国家即多边形质心，落陆地）
 *
 * 顶点取自 `data.vertices[country.vertexOffset .. +vertexCount]`（lon,lat 交错，2 float/顶点），
 * 与 buildBoundaryPositions / buildPickColors 同源遍历范围。
 *
 * 纯函数（输入 data + country，输出 [lon,lat]）；可在 Node 单测（合成 boundaries）验证。
 */
export function countryAnchorLonLat(
  data: BoundaryData,
  country: BoundaryCountry,
): [number, number] {
  const anchor = COUNTRY_ANCHORS[country.isoA3]
  if (anchor) return [anchor[0], anchor[1]]
  const base = country.vertexOffset
  const n = country.vertexCount
  if (n <= 0) return [0, 0]
  let sumLon = 0
  let sumLat = 0
  for (let i = 0; i < n; i++) {
    sumLon += data.vertices[(base + i) * 2]
    sumLat += data.vertices[(base + i) * 2 + 1]
  }
  return [sumLon / n, sumLat / n]
}
