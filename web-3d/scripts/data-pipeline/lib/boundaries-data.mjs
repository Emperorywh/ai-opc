/**
 * Task 19 · 国家边界合成数据（M6 范围：代表性国家，免下载）。
 *
 * SPEC §6.3「国家边界系统」+ §12.2：`2-boundaries.mjs` 读 Natural Earth `ne_10m_admin_0_countries`
 * （MultiPolygon）→ 简化/三角化/打包二进制。但真实 NE Shapefile 需人工下载（~8MB，放
 * `scripts/data-pipeline/raw/ne/`，.gitignore 不进 git/构建）——与 Task 02b GEBCO 同模式：
 * agent 阶段用**合成代表性数据**保证 pipeline + 二进制格式 + 解码 round-trip **确定可测**，
 * 真实 NE 产物由人工运行 `pnpm gen:boundaries`（real 路径）重生成并提交。
 *
 * 范围切割（与 Task 02 合成 DEM / Task 13 标签数据同理）：
 *   本模块 = 固定代表性几何 + 纯函数（normalizeFeature → 统一结构），pipeline 与 vitest 共用。
 *   多边形用**粗略矩形/梯形近似**真实国家大致经纬范围（lon,lat 地理坐标），「可辨认」即可——
 *   目的是验证 pipeline 逻辑（简化 / earcut 三角化含 MultiPolygon+洞 / 打包紧凑 / 解码 round-trip /
 *   ISO_A3+continent 属性），**非地理精确**。真实轮廓由 NE 重生成。
 *
 * 统一结构（与 normalizeFeature 产出的真实路径同构）：
 *   CountryFeature = {
 *     isoA3: string,                 // ISO_A3 拾取/标签 join key
 *     continent: string,             // 所属大洲（CONTINENT 枚举之一）
 *     polygons: Array<{             // MultiPolygon：1..N 个多边形
 *       outer: Array<[lon,lat]>,     // 外环（闭合折线，首尾不必相同，normalize 补闭合）
 *       holes: Array<Array<[lon,lat]>>  // 内环（洞），0..M 个
 *     }>
 *   }
 *   顶点坐标均为地理 lon∈[-180,180] / lat∈[-90,90]。MVP 投影（equirect 线性）由前端
 *   `src/config/projection.ts` 的 `project()` 在加载时完成——pipeline **不投影**，二进制存 lon,lat
 *   （SPEC §12.2.4「Float32[lon,lat]」），与地形/标签同源对齐（R2）；proj4 重投影推迟到 M9 Robinson。
 *
 * 选取代表性国家（覆盖不同结构案例）：
 *   · CHN / FRA / BRA / AUS / EGY —— 单多边形外环（简单凸/非凸四边形）
 *   · USA —— MultiPolygon（本土 + 阿拉斯加 + 夏威夷），验证 earcut 逐多边形三角化 + 描边多环
 *   （earcut「洞」逻辑由 pack 模块的纯函数支持 + 单测构造含洞输入验证，本合成数据不绑定真实
 *    有洞国家以避免政治/地理歧义；真实 NE 数据的洞由 normalizeFeature 透传。）
 */

/** 大洲名枚举（写入二进制 CONTINENT_NAMES 表，供 country.continentIndex 引用）。 */
export const CONTINENTS = [
  'Africa',
  'Antarctica',
  'Asia',
  'Europe',
  'North America',
  'Oceania',
  'South America',
  'Seven seas',
]

/** 矩形外环构造器：CCW（earcut 约定外环逆时针），首尾不闭合（normalizeFeature 补）。 */
function rect(lonMin, latMin, lonMax, latMax) {
  return [
    [lonMin, latMin],
    [lonMax, latMin],
    [lonMax, latMax],
    [lonMin, latMax],
  ]
}

/**
 * 合成代表性国家（lon,lat 粗略近似真实范围）。
 * @type {CountryFeature[]}
 */
export const SYNTHETIC_COUNTRIES = [
  {
    isoA3: 'CHN',
    continent: 'Asia',
    polygons: [{ outer: rect(73, 18, 135, 53), holes: [] }], // 中国本土
  },
  {
    isoA3: 'USA',
    continent: 'North America',
    polygons: [
      { outer: rect(-125, 25, -67, 49), holes: [] }, // 本土
      { outer: rect(-170, 54, -141, 71), holes: [] }, // 阿拉斯加
      { outer: rect(-160, 19, -154, 22), holes: [] }, // 夏威夷
    ],
  },
  {
    isoA3: 'FRA',
    continent: 'Europe',
    polygons: [{ outer: rect(-5, 42, 8, 51), holes: [] }], // 法国本土
  },
  {
    isoA3: 'BRA',
    continent: 'South America',
    polygons: [{ outer: rect(-74, -33, -34, 5), holes: [] }], // 巴西
  },
  {
    isoA3: 'AUS',
    continent: 'Oceania',
    polygons: [{ outer: rect(113, -39, 154, -12), holes: [] }], // 澳大利亚
  },
  {
    isoA3: 'EGY',
    continent: 'Africa',
    polygons: [{ outer: rect(25, 22, 35, 32), holes: [] }], // 埃及
  },
]

/**
 * 争议边界折线（粗略占位）。真实争议边界由 NE `ne_10m_admin_0_boundary_lines_disputed_areas`
 * 重生成；本合成数据仅验证 disputed.bin 格式（Task 21 DisputedLines 渲染）。
 * 每条 = 闭合/开放折线顶点序列（line strip）。lon,lat 地理坐标。
 * @type {Array<{ id:string, vertices:Array<[lon,lat]> }>}
 */
export const SYNTHETIC_DISPUTED = [
  { id: 'kashmir', vertices: [[74, 36], [78, 36], [78, 33], [74, 33]] }, // 克什米尔（粗略）
  { id: 'crimea', vertices: [[33, 46], [36, 46], [36, 44], [33, 44]] }, // 克里米亚（粗略）
  { id: 'western-sahara', vertices: [[-13, 28], [-8, 28], [-8, 21], [-13, 21]] }, // 西撒哈拉（粗略）
]

/**
 * GeoJSON Feature → 统一 CountryFeature 结构（real 路径用，与合成数据同构）。
 *
 * NE `ne_10m_admin_0_countries` 每条 Feature：geometry.type ∈ {Polygon, MultiPolygon}，
 * coordinates 按 GeoJSON 约定（Polygon=[outer, ...holes]，MultiPolygon=[poly, ...]）；
 * properties.ISO_A3 / properties.CONTINENT 提供属性。Polygon 外环按 GeoJSON CW（顺时针）约定，
 * earcut 要求 CCW——本函数不翻转（earcut 对环方向容错，仅影响填充法线朝向；Task 20 材质
 * DoubleSide / 描边层不受影响）。洞（holes）透传供 earcut 扣除。
 *
 * @param {{ geometry?:any, properties?:Record<string,unknown> }} feature
 * @returns {CountryFeature | null} 非法/缺属性返回 null（pipeline 跳过）
 */
export function normalizeFeature(feature) {
  const props = feature?.properties ?? {}
  const geom = feature?.geometry
  const isoA3 = typeof props.ISO_A3 === 'string' ? props.ISO_A3 : null
  const continent = typeof props.CONTINENT === 'string' ? props.CONTINENT : null
  if (!isoA3 || !continent || !geom) return null

  /** @param {number[][]} ring GeoJSON 线性环 → [lon,lat][] */
  const toRing = (ring) =>
    ring
      .filter((c) => Array.isArray(c) && c.length >= 2 && c.every((v) => Number.isFinite(v)))
      .map((c) => [c[0], c[1]])

  /** @param {number[][][]} poly GeoJSON Polygon [outer, ...holes] */
  const toPolygon = (poly) => {
    const rings = poly.map(toRing).filter((r) => r.length >= 3)
    if (rings.length === 0) return null
    return { outer: rings[0], holes: rings.slice(1) }
  }

  let polygons
  if (geom.type === 'Polygon') {
    const p = toPolygon(/** @type {number[][][]} */ (geom.coordinates))
    polygons = p ? [p] : []
  } else if (geom.type === 'MultiPolygon') {
    polygons = /** @type {number[][][][]} */ (geom.coordinates)
      .map(toPolygon)
      .filter((p) => p !== null)
  } else {
    return null
  }
  if (polygons.length === 0) return null
  return { isoA3, continent, polygons }
}

/**
 * GeoJSON FeatureCollection → CountryFeature[]（real 路径用）。
 * @param {unknown} input
 * @returns {CountryFeature[]}
 */
export function normalizeCountries(input) {
  if (!input || typeof input !== 'object') return []
  const features = /** @type {{ features?: unknown[] }} */ (input).features
  if (!Array.isArray(features)) return []
  const out = []
  for (const f of features) {
    const c = normalizeFeature(/** @type {any} */ (f))
    if (c) out.push(c)
  }
  return out
}
