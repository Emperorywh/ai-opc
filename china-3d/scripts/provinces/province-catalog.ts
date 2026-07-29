/**
 * 省级行政区目录的离线层视图（34 省领域真值的 adcode 展开）。
 *
 * 依赖方向：属于离线资产生产/校验层（scripts/），单向依赖 src/geo-contracts 契约层。
 * 不依赖浏览器 / React / Three.js 或任何运行时状态。
 *
 * 与契约层的关系（单一事实源，禁止双轨）：
 * - 「中国 34 个省级行政区究竟有哪 34 个」的唯一事实源是契约层
 *   src/geo-contracts/admin-directory.ts 的 CHINA_ADMINISTRATIVE_DIRECTORY（id / name / type）。
 *   本模块**不再手写第二份 34 行表**，而是从该常量派生离线层需要的 adcode 视图：
 *   目录 id 采用 CN-<GB/T 2260 adcode> 方案（如 CN-440000 → adcode 440000），
 *   派生时逐项断言 id 确实携带 6 位数字 adcode，派生失败即抛错（契约漂移会被立刻发现，
 *   而不是静默产出错误对齐）。
 * - 被离线生产脚本（scripts/provinces/fetch-datav-provinces.ts，把 DataV 要素按 adcode
 *   对齐到目录）与资产深度校验（scripts/verify-assets/provinces-deep.ts）共同引用。
 *
 * 标识与对齐（SPEC §2「区划粒度」、§5.2）：
 * DataV.GeoAtlas 的 100000_full.json 以 6 位 adcode 标识省级要素；本视图提供
 * adcode ↔ 目录条目的确定性映射，使 DataV 要素能精确对齐到 34 省目录，
 * 非省级要素（如九段线 100000_JD）被显式忽略。
 *
 * 非审图数据限制（SPEC §5.2、§6、§8、§13）：
 * - 本目录只登记 DataV 基础 34 省，**不**在此声明九段线 / 南海岛礁 / 钓鱼岛 / 藏南 /
 *   阿克赛钦的国标完整性——那是政治边界补充资产（scripts/political）的红线。
 * - 港、澳、台三者的存在性在深度校验中另有**独立硬编码锚点**（REQUIRED_POLITICAL_IDS，
 *   不依赖本视图），防止目录被改动后三者随之消失而校验仍通过。
 * - 目录的规范名称取国家标准用语；其几何来自 DataV（非官方审图），发布前仍须取得审图号。
 */

import {
  CHINA_ADMINISTRATIVE_DIRECTORY,
  EXPECTED_PROVINCIAL_ADMINISTRATIVE_COUNT,
  type AdministrativeRegionType,
} from '../../src/geo-contracts/index'

/**
 * 单个省级行政区的目录真值（离线层视图）。
 * id 由 adcode 派生（CN-<adcode>），故 adcode 与 id 一一对应、可互相校验。
 */
export interface ProvinceCatalogEntry {
  /** 稳定行政区标识：CN-<adcode>。 */
  readonly id: string
  /** GB/T 2260 行政区划代码（6 位）。 */
  readonly adcode: number
  /** 规范名称（中文，国家标准用语）。 */
  readonly name: string
  /** 行政区类型（独立于 DataV 的扁平 level 字段）。 */
  readonly type: AdministrativeRegionType
}

/** 目录 id 的 adcode 段格式（CN- 后恰为 6 位数字）。 */
const ADCODE_SEGMENT_PATTERN = /^CN-(\d{6})$/

/**
 * 从契约层规范目录派生 adcode 视图。
 * 每个目录条目的 id 必须携带 6 位数字 adcode，否则抛错——派生是机械的，
 * 任何契约层 id 方案漂移都会在此处确定性暴露，而非静默产生错误对齐。
 */
function deriveProvinceCatalog(): readonly ProvinceCatalogEntry[] {
  return CHINA_ADMINISTRATIVE_DIRECTORY.map((entry) => {
    const match = ADCODE_SEGMENT_PATTERN.exec(entry.id)
    if (match === null) {
      throw new Error(
        `规范目录条目 id=${entry.id} 不携带 6 位数字 adcode，无法派生离线目录视图。`,
      )
    }
    return {
      id: entry.id,
      adcode: Number.parseInt(match[1], 10),
      name: entry.name,
      type: entry.type,
    }
  })
}

/**
 * 34 个省级行政区的完整目录视图，按 adcode 升序排列（契约层目录本身按 GB/T 2260 码序，
 * 派生保持该顺序）。数量与类型构成：23 省 + 5 自治区 + 4 直辖市 + 2 特别行政区 = 34。
 *
 * 为什么按 adcode 升序：给资产文件一个稳定、与字典序无关的确定性顺序，
 * 同一份数据源多次重产可得到逐字节一致的 JSON（便于 diff 与审计比对）。
 */
export const PROVINCE_CATALOG: readonly ProvinceCatalogEntry[] = deriveProvinceCatalog()

/**
 * 省级行政区的恰好数量（SPEC §2「区划粒度」）。
 * 直接引用契约层 EXPECTED_PROVINCIAL_ADMINISTRATIVE_COUNT（= 34），不另立数字字面量，
 * 使深度校验与测试可以「按名引用 34」而非「按目录长度推断」。
 */
export const EXPECTED_PROVINCE_COUNT = EXPECTED_PROVINCIAL_ADMINISTRATIVE_COUNT

/**
 * 政治红线独立锚点（SPEC §6 红线「港澳齐」「台湾省正常呈现」）。
 *
 * 这三个标识在深度校验中被独立断言存在，**不**通过遍历 PROVINCE_CATALOG 间接得出——
 * 即便有人误删目录中的台湾/港澳条目，这里的硬编码集合仍要求资产必须含三者，
 * 校验随之确定性失败。这是「政治边界完整性」红线在省级目录/几何层面的最小防御；
 * 九段线 / 南海岛礁 / 钓鱼岛 / 藏南 / 阿克赛钦的红线由政治边界补充资产独立闭环
 * （src/geo-contracts/political-catalog.ts）。
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
