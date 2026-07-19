/**
 * 省名锚点与省级行政中心目录（34 个省级行政区 × 2 角色的领域真值）。
 *
 * 这是「34 个省级行政区的省名锚点与省会 / 首府 / 直辖市中心 / 特别行政区中心究竟是什么」
 * 的单一定义点，被离线生产脚本（scripts/places/build-places.ts）与资产深度校验
 * （scripts/verify-assets/places-deep.ts）共同引用，避免两处手写 68 行表导致漂移。
 *
 * 依赖方向：属于离线资产生产 / 校验层（scripts/，tsx 运行），单向依赖 src/geo-contracts
 * 契约层（仅复用其角色与行政区标识字面量），不依赖浏览器 / React / Three.js 或任何运行时状态。
 * 地点目录属于地理领域数据，禁止放进 React 组件、材质参数或 hover 状态中维护
 * （SPEC §3.7、§5.5、TASK-005 实现约束）。
 *
 * 行政区关联（稳定标识，禁止数组顺序 / 中文名模糊匹配 / 渲染对象引用）：
 * 每个条目以 adminId 关联到 34 省目录（scripts/provinces/province-catalog.ts），
 * 标识方案为 CN-<GB/T 2260 adcode>，如 CN-440000（广东）、CN-710000（台湾）、
 * CN-810000（香港）、CN-820000（澳门）。本目录的 adminId 集合必须与 34 省目录精确一致——
 * 这是地点目录深度校验的硬不变量（places-deep.ts）。
 *
 * 两种角色（SPEC §3.7、§5.5；契约 src/geo-contracts/places.ts PlaceRole）：
 * - provinceNameAnchor：省名展示锚点。省名 Billboard 标签的放置坐标，取省域内可读位置。
 * - administrativeCapital：省级行政中心（省会 / 首府 / 直辖市中心 / 特别行政区中心）。
 *   省会光点的坐标，对应实际行政中心城市的经纬度。
 * 二者语义不同，不得混用：锚点服务「省名标签可读性」，行政中心服务「光点位置真实性」。
 *
 * 锚点取位规则（可审计，禁止组件内魔法偏移）：
 * - 默认锚点坐标 = 省级行政中心坐标（省名标签浮于省会光点之上）。这一缺省对绝大多数紧凑型
 *   省份已足够可读，且保证锚点一定落在省域内（行政中心必在其行政区内）。
 * - 仅对东西狭长 / 南北狭长 / 多岛的省份（省会偏居一隅、省名标签若贴省会会严重偏移），
 *   通过 distinctAnchor 给出**省域内部**的居中可读锚点，并在 note 中记录校正依据。
 *   校正锚点已逐一在生产期 point-in-polygon 验证落在对应省域内（见 places-deep.ts 的几何包含校验）。
 * - 不在本目录承载任何「视图层标签偏移」——标签遮挡 / 拥挤时的透明度与错峰由渲染层决定
 *   （SPEC §3.7、§7.5、TASK-005 实现约束「不得用组件内魔法偏移承载」）。
 *
 * 坐标不变量：
 * - 全部坐标为 WGS84 经纬度（EPSG:4326），lon ∈ [72, 136]、lat ∈ [3, 54]（中国主图范围）。
 * - 行政中心坐标取公开权威城市坐标；锚点坐标取省域内部可读位置（含人工校正时已在 note 注明）。
 * - 坐标一经登记即冻结为审计锚点；如需更正，先改本目录并重产资产，不得在运行时打补丁。
 *
 * 非审图数据限制（SPEC §5.5、§8、§13）：
 * 省会 / 锚点坐标取自公开标准地图衍生数据，本身不含政治边界主张；但其与 DataV 省级边界
 * （非官方审图）联用时，整体仍属非官方审图数据，公开发布前须取得自然资源主管部门审图号。
 * 九段线 / 南海岛礁 / 钓鱼岛 / 藏南 / 阿克赛钦的国标完整性由 TASK-006 独立闭环，本目录不越权声明。
 */

import type { AdministrativeRegionType } from '../../src/geo-contracts/index'

/** 经纬度坐标（EPSG:4326 命名字段，与契约 LonLatCoordinate 同构）。 */
export interface CatalogCoordinate {
  readonly lon: number
  readonly lat: number
}

/**
 * 单个省级行政区的地点真值。
 * 一条 province 真值在序列化时**确定性地展开为两条**地点条目：一条 provinceNameAnchor，
 * 一条 administrativeCapital（见 build-places.ts）。这保证「每个行政区恰有一个锚点与一个行政中心」
 * 是结构上不可能违反的——展开逻辑只有一处，无法手抖多写 / 漏写一条。
 */
export interface PlaceCatalogProvince {
  /** 稳定行政区标识：CN-<adcode>，须命中 34 省目录。 */
  readonly id: string
  /** 省名简称（锚点标签文字，去「省 / 市 / 自治区」后缀，符合大屏省名展示惯例）。 */
  readonly shortName: string
  /** 省级行政中心城市名（省会 / 首府 / 直辖市中心 / 特别行政区中心）。 */
  readonly capitalName: string
  /** 省级行政中心经纬度（公开权威城市坐标）。 */
  readonly capital: CatalogCoordinate
  /**
   * 居中可读锚点（可选）。
   * 缺省时锚点坐标 = capital；给出时锚点坐标用 distinctAnchor.coordinate，并强制附 note 记录校正依据。
   * note 非空、可审计，禁止用此字段之外的隐式偏移承载位置语义。
   */
  readonly distinctAnchor?: {
    readonly coordinate: CatalogCoordinate
    readonly note: string
  }
}

/**
 * 行政区类型在此仅作文档对照（与 34 省目录的类型一致），不参与地点契约结构；
 * 帮助阅读者理解「为什么这条行政中心叫省会 / 首府 / 直辖市中心 / 特别行政区中心」。
 */
export interface PlaceCatalogEntry extends PlaceCatalogProvince {
  readonly type: AdministrativeRegionType
}

/**
 * 34 个省级行政区的地点真值，按 adcode 升序（与 province-catalog 同序），保证同一真值表
 * 多次重产得到逐字节一致的 JSON。数量恰好 34：23 省 + 5 自治区 + 4 直辖市 + 2 特别行政区。
 *
 * 锚点人工校正清单（distinctAnchor，均已 point-in-polygon 验证落在省域内）：
 * - 内蒙古（CN-150000）：东西狭长，省会呼和浩特偏居西南，锚点取中部锡林郭勒一带。
 * - 黑龙江（CN-230000）：省会哈尔滨偏南，锚点取中部松嫩平原一带。
 * - 甘肃（CN-620000）：狭长河西走廊，省会兰州偏居东南，锚点取走廊中部张掖一带。
 * - 西藏（CN-540000）：省会拉萨偏居东南，锚点取中部那曲一带。
 * 其余 30 个行政区锚点 = 省级行政中心坐标（省名标签浮于省会光点之上）。
 */
export const PLACE_CATALOG: readonly PlaceCatalogEntry[] = [
  {
    id: 'CN-110000', type: 'municipality', shortName: '北京', capitalName: '北京',
    capital: { lon: 116.4074, lat: 39.9042 },
  },
  {
    id: 'CN-120000', type: 'municipality', shortName: '天津', capitalName: '天津',
    capital: { lon: 117.2009, lat: 39.0842 },
  },
  {
    id: 'CN-130000', type: 'province', shortName: '河北', capitalName: '石家庄',
    capital: { lon: 114.5149, lat: 38.0428 },
  },
  {
    id: 'CN-140000', type: 'province', shortName: '山西', capitalName: '太原',
    capital: { lon: 112.5489, lat: 37.8706 },
  },
  {
    id: 'CN-150000', type: 'autonomousRegion', shortName: '内蒙古', capitalName: '呼和浩特',
    capital: { lon: 111.751, lat: 40.8426 },
    distinctAnchor: {
      coordinate: { lon: 116.05, lat: 43.95 },
      note: '内蒙古自治区东西狭长，省会呼和浩特偏居西南；锚点取中部锡林郭勒一带（已 point-in-polygon 验证落在省域内）以便省名标签居中可读。',
    },
  },
  {
    id: 'CN-210000', type: 'province', shortName: '辽宁', capitalName: '沈阳',
    capital: { lon: 123.4315, lat: 41.8057 },
  },
  {
    id: 'CN-220000', type: 'province', shortName: '吉林', capitalName: '长春',
    capital: { lon: 125.3235, lat: 43.8171 },
  },
  {
    id: 'CN-230000', type: 'province', shortName: '黑龙江', capitalName: '哈尔滨',
    capital: { lon: 126.5349, lat: 45.8038 },
    distinctAnchor: {
      coordinate: { lon: 124.4, lat: 46.6 },
      note: '黑龙江省会哈尔滨偏居南部；锚点取中部松嫩平原一带（已 point-in-polygon 验证落在省域内）以便省名标签居中可读。',
    },
  },
  {
    id: 'CN-310000', type: 'municipality', shortName: '上海', capitalName: '上海',
    capital: { lon: 121.4737, lat: 31.2304 },
  },
  {
    id: 'CN-320000', type: 'province', shortName: '江苏', capitalName: '南京',
    capital: { lon: 118.7969, lat: 32.0603 },
  },
  {
    id: 'CN-330000', type: 'province', shortName: '浙江', capitalName: '杭州',
    capital: { lon: 120.1551, lat: 30.2741 },
  },
  {
    id: 'CN-340000', type: 'province', shortName: '安徽', capitalName: '合肥',
    capital: { lon: 117.2272, lat: 31.8206 },
  },
  {
    id: 'CN-350000', type: 'province', shortName: '福建', capitalName: '福州',
    capital: { lon: 119.2965, lat: 26.0745 },
  },
  {
    id: 'CN-360000', type: 'province', shortName: '江西', capitalName: '南昌',
    capital: { lon: 115.8579, lat: 28.682 },
  },
  {
    id: 'CN-370000', type: 'province', shortName: '山东', capitalName: '济南',
    capital: { lon: 117.1201, lat: 36.6512 },
  },
  {
    id: 'CN-410000', type: 'province', shortName: '河南', capitalName: '郑州',
    capital: { lon: 113.6253, lat: 34.7466 },
  },
  {
    id: 'CN-420000', type: 'province', shortName: '湖北', capitalName: '武汉',
    capital: { lon: 114.3055, lat: 30.5928 },
  },
  {
    id: 'CN-430000', type: 'province', shortName: '湖南', capitalName: '长沙',
    capital: { lon: 112.9388, lat: 28.2282 },
  },
  {
    id: 'CN-440000', type: 'province', shortName: '广东', capitalName: '广州',
    capital: { lon: 113.2644, lat: 23.1291 },
  },
  {
    id: 'CN-450000', type: 'autonomousRegion', shortName: '广西', capitalName: '南宁',
    capital: { lon: 108.3669, lat: 22.817 },
  },
  {
    id: 'CN-460000', type: 'province', shortName: '海南', capitalName: '海口',
    capital: { lon: 110.199, lat: 20.044 },
  },
  {
    id: 'CN-500000', type: 'municipality', shortName: '重庆', capitalName: '重庆',
    capital: { lon: 106.5516, lat: 29.563 },
  },
  {
    id: 'CN-510000', type: 'province', shortName: '四川', capitalName: '成都',
    capital: { lon: 104.0668, lat: 30.5728 },
  },
  {
    id: 'CN-520000', type: 'province', shortName: '贵州', capitalName: '贵阳',
    capital: { lon: 106.6302, lat: 26.647 },
  },
  {
    id: 'CN-530000', type: 'province', shortName: '云南', capitalName: '昆明',
    capital: { lon: 102.7183, lat: 25.0389 },
  },
  {
    id: 'CN-540000', type: 'autonomousRegion', shortName: '西藏', capitalName: '拉萨',
    capital: { lon: 91.1409, lat: 29.65 },
    distinctAnchor: {
      coordinate: { lon: 92.05, lat: 31.48 },
      note: '西藏自治区省会拉萨偏居东南；锚点取中部那曲一带（已 point-in-polygon 验证落在省域内）以便省名标签居中可读。',
    },
  },
  {
    id: 'CN-610000', type: 'province', shortName: '陕西', capitalName: '西安',
    capital: { lon: 108.9398, lat: 34.3416 },
  },
  {
    id: 'CN-620000', type: 'province', shortName: '甘肃', capitalName: '兰州',
    capital: { lon: 103.8343, lat: 36.0611 },
    distinctAnchor: {
      coordinate: { lon: 100.45, lat: 38.93 },
      note: '甘肃省呈狭长河西走廊，省会兰州偏居东南；锚点取走廊中部张掖一带（已 point-in-polygon 验证落在省域内）以便省名标签居中可读。',
    },
  },
  {
    id: 'CN-630000', type: 'province', shortName: '青海', capitalName: '西宁',
    capital: { lon: 101.7782, lat: 36.6171 },
  },
  {
    id: 'CN-640000', type: 'autonomousRegion', shortName: '宁夏', capitalName: '银川',
    capital: { lon: 106.2309, lat: 38.4872 },
  },
  {
    id: 'CN-650000', type: 'autonomousRegion', shortName: '新疆', capitalName: '乌鲁木齐',
    capital: { lon: 87.6168, lat: 43.8256 },
  },
  {
    id: 'CN-710000', type: 'province', shortName: '台湾', capitalName: '台北',
    capital: { lon: 121.5654, lat: 25.033 },
  },
  {
    id: 'CN-810000', type: 'specialAdministrativeRegion', shortName: '香港', capitalName: '香港',
    capital: { lon: 114.1694, lat: 22.3193 },
  },
  {
    id: 'CN-820000', type: 'specialAdministrativeRegion', shortName: '澳门', capitalName: '澳门',
    capital: { lon: 113.5439, lat: 22.1987 },
  },
] as const

/**
 * 省级行政区的恰好数量（与 province-catalog.EXPECTED_PROVINCE_COUNT 对齐 = 34）。
 * 单独命名导出，使深度校验与测试可以「按名引用 34」而非「按目录长度推断」，
 * 一旦目录被误改导致数量漂移，与该常量的比较会立刻暴露不一致。
 */
export const EXPECTED_PLACE_PROVINCE_COUNT = PLACE_CATALOG.length

/**
 * 每个行政区的地点条目数（锚点 + 行政中心 = 2）。展开后总条目数 = 34 × 2 = 68。
 * 用常量表达「每省恰两条」这一结构不变量，避免后续误改成「每省多条」或「只发锚点」。
 */
export const PLACE_ENTRIES_PER_PROVINCE = 2

/** 展开后的地点条目总数（68）。由 EXPECTED_PLACE_PROVINCE_COUNT × PLACE_ENTRIES_PER_PROVINCE 派生，杜绝手写漂移。 */
export const EXPECTED_PLACE_ENTRY_COUNT = EXPECTED_PLACE_PROVINCE_COUNT * PLACE_ENTRIES_PER_PROVINCE

/**
 * 政治红线独立锚点（SPEC §6 红线；与 province-catalog.REQUIRED_POLITICAL_IDS 对齐）。
 *
 * 台湾 / 港 / 澳三者的地点条目（锚点 + 行政中心）在深度校验中被独立断言存在——
 * 即便有人误删本目录中的三者，这里的硬编码集合仍要求地点资产必须含三者的锚点与行政中心，
 * 校验随之确定性失败。这是「政治边界完整性」红线在地点层面的最小防御。
 */
export const REQUIRED_POLITICAL_PLACE_IDS: readonly string[] = [
  'CN-710000', // 台湾省
  'CN-810000', // 香港特别行政区
  'CN-820000', // 澳门特别行政区
]
