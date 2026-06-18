/**
 * Task 13 · 大洲 / 大洋标签数据（M4 范围：仅大洲 + 大洋子集）。
 *
 * SPEC §6.5「大洲/标签系统」+ §12.4：labels.json = {id, zhName, kind, continent, lon, lat, priority}。
 *
 * 范围切割（与 Task 12 charset 同理）：
 *   七大洲 + 四大洋是「固定地理常识」——中文名（与 Task 12 charset.mjs 同源）、代表性锚点经纬度、
 *   优先级均确定，**无需 Natural Earth 数据源 / ISO_A3 join**（国家 join 留 Phase 2 M8 Task 25）。
 *   故本模块纯硬编码数据 + 纯函数，可脱离 DOM / Node fs 单测（被 pipeline 与 vitest 共用）。
 *
 * 锚点策略（SPEC §10 同理）：用人工代表性中心点，非几何质心——避免质心落海（如亚洲质心偏北极/
 *   中亚荒漠边缘、北美含格陵兰偏移）或落在大陆边缘。大洲锚点落陆地深处，大洋锚点落开阔海域中心。
 *
 * 优先级（SPEC §6.5「大洲 > 大洋 > 大国 > 小国」）：大洲=100、大洋=80，
 *   为 Phase 2 国家（大国~60 / 小国~30）留出数值空间。
 */

/**
 * @typedef {Object} LabelSeed
 * @property {string} id        英文 slug（稳定引用 / join key）
 * @property {string} zhName    中文名（与 charset.mjs CONTINENT_NAMES/OCEAN_NAMES 同源）
 * @property {number} lon       锚点经度 [-180,180]
 * @property {number} lat       锚点纬度 [-90,90]
 * @property {number} priority  显示优先级（越大越优先，碰撞剔除贪心放高优先级）
 */

/** 七大洲标签锚点（代表性陆地中心）。@type {LabelSeed[]} */
export const CONTINENT_LABELS = [
  { id: 'asia',          zhName: '亚洲',   lon:  95, lat:  45, priority: 100 }, // 中亚 / 蒙古高原
  { id: 'europe',        zhName: '欧洲',   lon:  15, lat:  52, priority: 100 }, // 中欧
  { id: 'africa',        zhName: '非洲',   lon:  20, lat:   5, priority: 100 }, // 刚果盆地
  { id: 'north-america', zhName: '北美洲', lon:-100, lat:  45, priority: 100 }, // 北美中部平原
  { id: 'south-america', zhName: '南美洲', lon: -60, lat: -15, priority: 100 }, // 南美中部
  { id: 'oceania',       zhName: '大洋洲', lon: 135, lat: -25, priority: 100 }, // 澳大利亚中部
  { id: 'antarctica',    zhName: '南极洲', lon:   0, lat: -82, priority: 100 }, // 南极内陆
]

/** 四大洋标签锚点（大洋中心开阔海域）。@type {LabelSeed[]} */
export const OCEAN_LABELS = [
  { id: 'pacific',  zhName: '太平洋', lon:-160, lat:   0, priority: 80 }, // 太平洋中部
  { id: 'atlantic', zhName: '大西洋', lon: -30, lat:   0, priority: 80 }, // 大西洋中部
  { id: 'indian',   zhName: '印度洋', lon:  80, lat: -20, priority: 80 }, // 印度洋南部
  { id: 'arctic',   zhName: '北冰洋', lon:   0, lat:  85, priority: 80 }, // 北冰洋中心
]

/**
 * 国家标签锚点（M8 Task 25：代表性大国）。
 *
 * SPEC §6.5「国家名（Phase 2）」+ §12.4「ISO_A3 join 中文名表」。MVP 合成数据覆盖 6 国，
 * 与 M6 合成边界 `boundaries-data.mjs` 的 SYNTHETIC_COUNTRIES 同步（ISO_A3 一致）；
 * 真实 NE ~200 国由 pipeline ISO_A3 join CC0 中文 ISO-3166 名表重生成（与本表同结构）。
 *
 * 锚点策略（SPEC §10 + 与前端 src/three/labels/countryInfo.ts 同源，确保「标签文字」与
 *   「Task 24 数据卡片」定位严格一致——均落在 countryAnchorLonLat 同一点）：
 *   · USA：主体陆地质心 [-96,37]（本土+阿拉斯加+夏威夷顶点均值落太平洋，§10 修复；
 *     与 countryInfo.ts COUNTRY_ANCHORS.USA 同值）。
 *   · 其余：合成矩形中心 = countryAnchorLonLat 顶点均值（单主体陆地，落陆地）。
 *
 * 优先级（SPEC §6.5「大洲 > 大洋 > 大国 > 小国」）：大国=60；未来小国细分~30。
 * kind='country' 经 LabelLayer 渲染、collision 碰撞、LOD 密度（需 major 及以上显示）。
 * @type {LabelSeed[]}
 */
export const COUNTRY_LABELS = [
  { id: 'chn', zhName: '中国',     lon:  104, lat: 35.5, priority: 60 }, // 中国本土中心
  { id: 'usa', zhName: '美国',     lon:  -96, lat:   37, priority: 60 }, // §10 主体陆地（覆盖落海均值）
  { id: 'fra', zhName: '法国',     lon:  1.5, lat: 46.5, priority: 60 }, // 法国本土中心
  { id: 'bra', zhName: '巴西',     lon:  -54, lat:  -14, priority: 60 }, // 巴西中心
  { id: 'aus', zhName: '澳大利亚', lon: 133.5, lat: -25.5, priority: 60 }, // 澳大利亚中心
  { id: 'egy', zhName: '埃及',     lon:   30, lat:   27, priority: 60 }, // 埃及中心
]

/**
 * 国家 id → 所属大洲 slug（与 continent label id 同源：asia/europe/africa/...）。
 * 供 country 标签 `continent` 字段（大洋=null；大洲=自身；国家=所属大洲 slug）。
 */
const COUNTRY_CONTINENT = {
  chn: 'asia',
  usa: 'north-america',
  fra: 'europe',
  bra: 'south-america',
  aus: 'oceania',
  egy: 'africa',
}

/**
 * 生成完整 labels 数组（M4：七大洲 + 四大洋；M8 Task 25：+ 6 代表性大国 = 17 条）。
 *
 * 字段顺序 {id, zhName, kind, continent, lon, lat, priority} 对齐 SPEC §6.5 / types.ts Label。
 * - kind：continent / ocean / country（由分组注入，源数据按 kind 分数组，DRY）
 * - continent：大洲标签 = 自身 id；大洋标签 = null（大洋不属任何大洲，§6.5 continent 字段对大洋为空）；
 *   国家标签 = 所属大洲 slug（COUNTRY_CONTINENT）
 *
 * @returns {{id:string,zhName:string,kind:'continent'|'ocean'|'country',continent:string|null,lon:number,lat:number,priority:number}[]}
 */
export function buildLabels() {
  const continents = CONTINENT_LABELS.map((l) => ({
    id: l.id,
    zhName: l.zhName,
    kind: 'continent',
    continent: l.id,
    lon: l.lon,
    lat: l.lat,
    priority: l.priority,
  }))
  const oceans = OCEAN_LABELS.map((l) => ({
    id: l.id,
    zhName: l.zhName,
    kind: 'ocean',
    continent: null,
    lon: l.lon,
    lat: l.lat,
    priority: l.priority,
  }))
  const countries = COUNTRY_LABELS.map((l) => ({
    id: l.id,
    zhName: l.zhName,
    kind: 'country',
    continent: COUNTRY_CONTINENT[l.id] ?? null,
    lon: l.lon,
    lat: l.lat,
    priority: l.priority,
  }))
  return [...continents, ...oceans, ...countries]
}
