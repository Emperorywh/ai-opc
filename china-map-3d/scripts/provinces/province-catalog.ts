/**
 * 省级行政区目录（34 个省级行政区的稳定领域真值）。
 *
 * 这是「中国 34 个省级行政区究竟有哪 34 个」的单一定义点，被离线生产脚本
 * （scripts/provinces/fetch-datav-provinces.ts）与资产深度校验
 * （scripts/verify-assets/provinces-deep.ts）共同引用，避免两处手写 34 行表导致漂移。
 *
 * 依赖方向：属于离线资产生产/校验层（scripts/），单向依赖 src/geo-contracts 契约层
 * （仅复用其行政区类型字面量），不依赖浏览器 / React / Three.js 或任何运行时状态。
 *
 * 标识方案（SPEC §2「区划粒度」、TASK-004 实现约束「稳定领域标识」）：
 * 采用 CN-<GB/T 2260 adcode>，例如 CN-440000（广东）、CN-460000（海南）、
 * CN-710000（台湾）、CN-810000（香港）、CN-820000（澳门）。adcode 是国家统计局
 * 行政区划代码（6 位数字），比拼音缩写更稳定、更可审计，且天然落在契约层
 * ADMINISTRATIVE_ID_PATTERN（^CN-[A-Z0-9]{2,8}$）内。行政区之间的关联一律走该 id，
 * 不得依赖数组顺序、中文名称模糊匹配或渲染对象引用。
 *
 * 行政区类型映射：DataV.GeoAtlas 的 100000_full.json 把所有省级要素一律标记为
 * level="province"，不区分省 / 自治区 / 直辖市 / 特别行政区。本目录按 adcode 显式给出
 * 四种行政区类型，作为「领域真值」独立于 DataV 的扁平 level 字段——类型是行政区本身的
 * 属性，不应由数据源的弱字段承载。
 *
 * 非审图数据限制（SPEC §5.2、§6、§8、§13；TASK-004 实现约束）：
 * - 本目录只登记 DataV 基础 34 省，**不**在此声明九段线 / 南海岛礁 / 钓鱼岛 / 藏南 /
 *   阿克赛钦的国标完整性——那是 TASK-006 的政治边界红线，本 TASK 不得越权声称已完成。
 * - 港、澳、台三者的存在性在深度校验中另有**独立硬编码锚点**（REQUIRED_POLITICAL_IDS，
 *   不依赖本目录），防止本目录被改动后三者随之消失而校验仍通过。
 * - 目录的规范名称取国家标准用语；其几何来自 DataV（非官方审图），发布前仍须取得审图号。
 */

import type { AdministrativeRegionType } from '../../src/geo-contracts/index'

/**
 * 单个省级行政区的目录真值。
 * id 由 adcode 派生（CN-<adcode>），故 adcode 与 id 一一对应、可互相校验。
 */
export interface ProvinceCatalogEntry {
  /** 稳定行政区标识：CN-<adcode>。 */
  readonly id: string
  /** GB/T 2260 行政区划代码（6 位）。 */
  readonly adcode: number
  /** 规范名称（中文，国家标准用语）。 */
  readonly name: string
  /** 行政区类型（独立于 DataV 的 level 字段）。 */
  readonly type: AdministrativeRegionType
}

/**
 * 34 个省级行政区的完整目录，按 adcode 升序排列。
 * 数量与类型构成：23 省 + 5 自治区 + 4 直辖市 + 2 特别行政区 = 34。
 *
 * 为什么按 adcode 升序：给资产文件一个稳定、与字典序无关的确定性顺序，
 * 同一份数据源多次重产可得到逐字节一致的 JSON（便于 diff 与审计比对）。
 */
export const PROVINCE_CATALOG: readonly ProvinceCatalogEntry[] = [
  { id: 'CN-110000', adcode: 110000, name: '北京市', type: 'municipality' },
  { id: 'CN-120000', adcode: 120000, name: '天津市', type: 'municipality' },
  { id: 'CN-130000', adcode: 130000, name: '河北省', type: 'province' },
  { id: 'CN-140000', adcode: 140000, name: '山西省', type: 'province' },
  { id: 'CN-150000', adcode: 150000, name: '内蒙古自治区', type: 'autonomousRegion' },
  { id: 'CN-210000', adcode: 210000, name: '辽宁省', type: 'province' },
  { id: 'CN-220000', adcode: 220000, name: '吉林省', type: 'province' },
  { id: 'CN-230000', adcode: 230000, name: '黑龙江省', type: 'province' },
  { id: 'CN-310000', adcode: 310000, name: '上海市', type: 'municipality' },
  { id: 'CN-320000', adcode: 320000, name: '江苏省', type: 'province' },
  { id: 'CN-330000', adcode: 330000, name: '浙江省', type: 'province' },
  { id: 'CN-340000', adcode: 340000, name: '安徽省', type: 'province' },
  { id: 'CN-350000', adcode: 350000, name: '福建省', type: 'province' },
  { id: 'CN-360000', adcode: 360000, name: '江西省', type: 'province' },
  { id: 'CN-370000', adcode: 370000, name: '山东省', type: 'province' },
  { id: 'CN-410000', adcode: 410000, name: '河南省', type: 'province' },
  { id: 'CN-420000', adcode: 420000, name: '湖北省', type: 'province' },
  { id: 'CN-430000', adcode: 430000, name: '湖南省', type: 'province' },
  { id: 'CN-440000', adcode: 440000, name: '广东省', type: 'province' },
  { id: 'CN-450000', adcode: 450000, name: '广西壮族自治区', type: 'autonomousRegion' },
  { id: 'CN-460000', adcode: 460000, name: '海南省', type: 'province' },
  { id: 'CN-500000', adcode: 500000, name: '重庆市', type: 'municipality' },
  { id: 'CN-510000', adcode: 510000, name: '四川省', type: 'province' },
  { id: 'CN-520000', adcode: 520000, name: '贵州省', type: 'province' },
  { id: 'CN-530000', adcode: 530000, name: '云南省', type: 'province' },
  { id: 'CN-540000', adcode: 540000, name: '西藏自治区', type: 'autonomousRegion' },
  { id: 'CN-610000', adcode: 610000, name: '陕西省', type: 'province' },
  { id: 'CN-620000', adcode: 620000, name: '甘肃省', type: 'province' },
  { id: 'CN-630000', adcode: 630000, name: '青海省', type: 'province' },
  { id: 'CN-640000', adcode: 640000, name: '宁夏回族自治区', type: 'autonomousRegion' },
  { id: 'CN-650000', adcode: 650000, name: '新疆维吾尔自治区', type: 'autonomousRegion' },
  { id: 'CN-710000', adcode: 710000, name: '台湾省', type: 'province' },
  { id: 'CN-810000', adcode: 810000, name: '香港特别行政区', type: 'specialAdministrativeRegion' },
  { id: 'CN-820000', adcode: 820000, name: '澳门特别行政区', type: 'specialAdministrativeRegion' },
] as const

/**
 * 省级行政区的恰好数量（SPEC §2「区划粒度」、TASK-004 验证方式 1）。
 * 单独命名导出，使深度校验与测试可以「按名引用 34」而非「按目录长度推断」，
 * 一旦目录被误改导致数量漂移，与该常量的比较会立刻暴露不一致。
 */
export const EXPECTED_PROVINCE_COUNT = 34

/**
 * 政治红线独立锚点（SPEC §6 红线、TASK-004 验证方式 1「港、澳、台均存在」）。
 *
 * 这三个标识在深度校验中被独立断言存在，**不**通过遍历 PROVINCE_CATALOG 间接得出——
 * 即便有人误删目录中的台湾/港澳条目，这里的硬编码集合仍要求资产必须含三者，
 * 校验随之确定性失败。这是「政治边界完整性」红线在本 TASK 范围内的最小防御；
 * 九段线 / 南海岛礁 / 钓鱼岛 / 藏南 / 阿克赛钦的完整国标画法仍由 TASK-006 独立闭环。
 */
export const REQUIRED_POLITICAL_IDS: readonly string[] = [
  'CN-710000', // 台湾省
  'CN-810000', // 香港特别行政区
  'CN-820000', // 澳门特别行政区
]

/** 按 adcode 建立查找表，供生产脚本把 DataV 要素对齐到目录真值。 */
const CATALOG_BY_ADCODE: ReadonlyMap<number, ProvinceCatalogEntry> = new Map(
  PROVINCE_CATALOG.map((entry) => [entry.adcode, entry]),
)

/** 按 adcode 取目录条目；不在 34 省目录内的 adcode 返回 undefined（如九段线要素）。 */
export function findCatalogEntryByAdcode(adcode: number): ProvinceCatalogEntry | undefined {
  return CATALOG_BY_ADCODE.get(adcode)
}

/** 目录全部 adcode 集合，供校验快速成员判定。 */
export const CATALOG_ADCODES: readonly number[] = PROVINCE_CATALOG.map((entry) => entry.adcode)
