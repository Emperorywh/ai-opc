/**
 * Task 28 · 河流合成数据 + 真实 NE 归一化（M10 范围：代表性河流，免下载）。
 *
 * SPEC §6.4「河流系统」+ §12.3：`3-rivers.mjs` 读 Natural Earth `ne_10m_rivers_lake_centerlines`
 * （LineString/MultiLineString）→ 简化 / 投影 / 按 heightmap 采样高度 / 带状几何 / 打包二进制。
 * 但真实 NE Shapefile/GeoJSON 需人工下载（放 `scripts/data-pipeline/raw/ne/`，.gitignore 不进
 * git/构建）——与 Task 02b GEBCO / Task 19 NE 国家边界同模式：agent 阶段用**合成代表性数据**
 * 保证 pipeline + 二进制格式 + 解码 round-trip **确定可测**，真实 NE 产物由人工运行
 * `pnpm gen:rivers`（real 路径）重生成并提交。
 *
 * 范围切割（与 boundaries-data.mjs / labels-data.mjs 同理）：
 *   本模块 = 固定代表性折线 + 纯函数（normalizeRivers → 统一结构），pipeline 与 vitest 共用。
 *   折线用**粗略经纬度折线近似**真实主要河流大致流向（lon,lat 地理坐标），「可辨认」即可——
 *   目的是验证 pipeline 逻辑（DP 简化 / Robinson 投影 / heightmap 采样贴地 / 带状几何 / 打包紧凑 /
 *   解码 round-trip / name+level 属性），**非地理精确**。真实流向由 NE 重生成。
 *
 * 统一结构（与 normalizeRivers 产出的真实路径同构）：
 *   RiverFeature = {
 *     name:   string,                  // 河流名（中文；真实 NE 取 properties.name）
 *     level:  1|2|3,                    // 流量级别（决定渲染粗细 / 亮度 / 带宽）
 *     vertices: Array<[lon,lat]>,       // 折线点（line strip，开放，lon∈[-180,180] lat∈[-90,90]）
 *   }
 *
 * 选取代表性河流（SPEC §6.4「长江、黄河、亚马逊、尼罗河、密西西比、多瑙」全覆盖）：
 *   · 长江 / 黄河（亚洲，跨地形落差大——验证贴地不穿山）
 *   · 亚马逊（南美，赤道低纬平原 + 安第斯源头）
 *   · 尼罗河（非洲，南北纵贯撒哈拉）
 *   · 密西西比（北美，南北纵贯）
 *   · 多瑙（欧洲，东西向）
 *   覆盖各纬度带 / 各大洲 / 跨山脉与平原，足以验证 pipeline 对齐与贴地契约。
 */

/** 流量级别（1=小 / 2=中 / 3=大；决定 pipeline 烘焙带宽与 Task 29 渲染粗细/亮度）。 */
export const RIVER_LEVELS = { SMALL: 1, MEDIUM: 2, LARGE: 3 }

/**
 * 合成代表性河流（lon,lat 粗略折线近似真实主要流向）。
 *
 * 顶点为粗略控制点（非真实河道密集采样）——合成数据"可辨认即可"，验证 pipeline 逻辑非地理精确。
 * 真实 NE `ne_10m_rivers_lake_centerlines` 每条河含数十至数百顶点，由 normalizeRivers 归一化后
 * 经 DP 简化（`--simplify`）压缩。
 *
 * @type {RiverFeature[]}
 */
export const SYNTHETIC_RIVERS = [
  {
    name: '长江',
    level: RIVER_LEVELS.LARGE,
    // 青藏源头 → 重庆 → 武汉 → 南京 → 上海入海（跨中国地势三级阶梯，验证贴地）
    vertices: [
      [91, 33],
      [100, 30],
      [106, 30],
      [111, 30],
      [114, 30],
      [117, 31],
      [118, 32],
      [122, 31],
    ],
  },
  {
    name: '黄河',
    level: RIVER_LEVELS.MEDIUM,
    // 青藏源头 → 兰州 → 河套北上 → 内蒙古 → 晋陕南下 → 东流入海（"几"字粗略）
    vertices: [
      [96, 35],
      [101, 36],
      [103, 36],
      [106, 39],
      [110, 41],
      [111, 38],
      [110, 35],
      [113, 35],
      [116, 36],
      [119, 37],
    ],
  },
  {
    name: '亚马逊河',
    level: RIVER_LEVELS.LARGE,
    // 安第斯源头 → 马瑙斯 → 入海（赤道低纬，世界流量第一）
    vertices: [
      [-77, -10],
      [-74, -8],
      [-70, -6],
      [-65, -5],
      [-60, -3],
      [-55, -2],
      [-50, -1],
      [-49, 0],
    ],
  },
  {
    name: '尼罗河',
    level: RIVER_LEVELS.LARGE,
    // 维多利亚湖源头 → 喀土穆 → 苏丹 → 阿斯旺 → 开罗 → 入海（南北纵贯撒哈拉）
    vertices: [
      [33, 0],
      [32, 5],
      [32, 12],
      [32, 15],
      [32, 19],
      [33, 24],
      [31, 27],
      [31, 30],
      [31, 32],
    ],
  },
  {
    name: '密西西比河',
    level: RIVER_LEVELS.LARGE,
    // 明尼苏达源头 → 圣路易斯 → 孟菲斯 → 入海墨西哥湾（南北纵贯北美）
    vertices: [
      [-94, 47],
      [-93, 45],
      [-92, 41],
      [-90, 39],
      [-90, 35],
      [-90, 32],
      [-90, 29],
    ],
  },
  {
    name: '多瑙河',
    level: RIVER_LEVELS.MEDIUM,
    // 德国黑森林源头 → 维也纳 → 布达佩斯 → 贝尔格莱德 → 入海黑海（东西向，欧洲第二长河）
    vertices: [
      [8, 48],
      [10, 48],
      [13, 48],
      [16, 48],
      [19, 47],
      [21, 44],
      [25, 44],
      [29, 45],
    ],
  },
]

/**
 * NE scalerank（1=最显著 .. 10=最细）→ 流量级别映射。真实 NE 河流无 level 属性，按 scalerank 推断。
 * @param {number} scalerank
 * @returns {1|2|3}
 */
export function scalerankToLevel(scalerank) {
  if (!Number.isFinite(scalerank)) return RIVER_LEVELS.MEDIUM
  if (scalerank <= 3) return RIVER_LEVELS.LARGE
  if (scalerank <= 6) return RIVER_LEVELS.MEDIUM
  return RIVER_LEVELS.SMALL
}

/**
 * GeoJSON Feature → RiverFeature[]（real 路径用，与合成数据同构）。
 *
 * NE `ne_10m_rivers_lake_centerlines` 每条 Feature：geometry.type ∈ {LineString, MultiLineString}；
 * properties.name 提供河名，properties.scalerank 提供级别推断依据。MultiLineString 每条子折线作为
 * 一条独立 RiverFeature（同名）——真实数据中同一条河可能由不连续多段组成，分别成带更稳妥。
 *
 * @param {{ geometry?:any, properties?:Record<string,unknown> }} feature
 * @returns {RiverFeature[]} 非法/顶点不足返回空数组（pipeline 跳过）
 */
export function normalizeRiverFeature(feature) {
  const props = feature?.properties ?? {}
  const geom = feature?.geometry
  const name = typeof props.name === 'string' && props.name ? props.name : 'unknown'
  const level = scalerankToLevel(Number(props.scalerank))
  if (!geom) return []
  /** @param {number[][]} coords */
  const toVerts = (coords) =>
    coords
      .filter((c) => Array.isArray(c) && c.length >= 2 && c.every((v) => Number.isFinite(v)))
      .map((c) => [c[0], c[1]])
  /** @param {number[][]} line */
  const toFeature = (line) => {
    const v = toVerts(line)
    return v.length >= 2 ? { name, level, vertices: v } : null
  }
  if (geom.type === 'LineString') {
    const f = toFeature(/** @type {number[][]} */ (geom.coordinates))
    return f ? [f] : []
  }
  if (geom.type === 'MultiLineString') {
    return /** @type {number[][][]} */ (geom.coordinates)
      .map(toFeature)
      .filter((f) => f !== null)
  }
  return []
}

/**
 * GeoJSON FeatureCollection → RiverFeature[]（real 路径用）。
 * @param {unknown} input
 * @returns {RiverFeature[]}
 */
export function normalizeRivers(input) {
  if (!input || typeof input !== 'object') return []
  const features = /** @type {{ features?: unknown[] }} */ (input).features
  if (!Array.isArray(features)) return []
  const out = []
  for (const f of features) {
    out.push(...normalizeRiverFeature(/** @type {any} */ (f)))
  }
  return out
}

/**
 * @typedef {Object} RiverFeature
 * @property {string} name
 * @property {1|2|3} level
 * @property {Array<[number, number]>} vertices
 */
