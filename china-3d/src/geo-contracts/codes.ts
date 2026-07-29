/**
 * 静态地理资产契约的冻结不变量集合。
 *
 * 依赖方向（不可逆）：本模块是契约层最底层，只依赖 TypeScript 自身，
 * 不得 import React、Three.js、运行时渲染层或任何资产生产脚本。运行时数据访问层、
 * 资产校验入口与离线生产脚本都可以单向依赖本模块；反向依赖会破坏「契约先于实现」
 * 的分层，并在重构渲染层时引发隐式回归。
 *
 * 这里只冻结「输入输出与不变量」：哪些坐标参考系与数据版本被承认、行政区稳定标识
 * 必须长什么样、经纬度的合法区间、主图地理范围。具体校验库、测试框架、文件布局、
 * 类型名与实现模式均不在此冻结，留给后续 TASK 自行决定。
 */

/**
 * 坐标参考系白名单（领域不变量）。
 *
 * 为什么用闭合集合而非任意字符串：契约要求「坐标参考系必须显式表达」，任何未登记的
 * CRS 都必须在验证期被确定性地拒绝，而不是被静默接受后在运行时产生错误投影。新增 CRS
 * 必须先在此登记并补齐对应投影实现（统一投影层 src/lib/projection.ts），再产出引用该
 * CRS 的资产。
 */
export const KNOWN_COORDINATE_REFERENCE_SYSTEMS = {
  /**
   * WGS84 经纬度（EPSG:4326）。
   * 所有 GeoJSON 源几何与地点坐标的基准；契约层只冻结源坐标基准，
   * 不在此承担到世界坐标的投影。
   */
  EPSG_4326: 'EPSG:4326',
  /**
   * Web 墨卡托（EPSG:3857）。
   * 地形栅格平面坐标与运行时世界坐标的目标投影（SPEC §3.3、§5.1）。
   */
  EPSG_3857: 'EPSG:3857',
} as const

export type CoordinateReferenceSystem =
  (typeof KNOWN_COORDINATE_REFERENCE_SYSTEMS)[keyof typeof KNOWN_COORDINATE_REFERENCE_SYSTEMS]

/**
 * 全部已登记的坐标参考系字面量集合，供验证器做成员判定。
 * 以数组形式派生自上面的 as const 表，避免两处手写导致漂移。
 */
export const RECOGNIZED_COORDINATE_REFERENCE_SYSTEMS: readonly string[] = Object.values(
  KNOWN_COORDINATE_REFERENCE_SYSTEMS,
)

/**
 * 静态资产数据版本白名单。
 *
 * 为什么版本必须是已知集合：资产会随时间被重新生产（更换 DEM 源、修正边界等），版本字段
 * 让消费方明确知道自己读取的是哪一代资产。未知版本意味着资产来自未登记的生产流程，必须
 * 被拒绝，避免混用不兼容的代际数据。新版本必须先在此登记。
 */
export const KNOWN_DATA_VERSIONS = {
  /** 初始契约版本。 */
  V1_0_0: '1.0.0',
} as const

export type DataVersion =
  (typeof KNOWN_DATA_VERSIONS)[keyof typeof KNOWN_DATA_VERSIONS]

export const RECOGNIZED_DATA_VERSIONS: readonly string[] = Object.values(KNOWN_DATA_VERSIONS)

/**
 * 行政区稳定标识的格式约束。
 *
 * 为什么强制 `CN-` 前缀命名空间：契约要求行政区标识「显式、稳定、唯一」，禁止用数组顺序、
 * 中文名称模糊匹配或渲染对象引用承载关联。`CN-` 前缀给出显式命名空间，后段为大写字母或
 * 数字，避免大小写或 Unicode 归一化歧义。省级目录条目采用与 GB/T 2260 对齐的 6 位
 * adcode（如 CN-110000 北京市、CN-710000 台湾省），见 admin-directory.ts。
 */
export const ADMINISTRATIVE_ID_PATTERN = /^CN-[A-Z0-9]{2,8}$/

/**
 * 经度合法区间（度）。超出即视为非法坐标，验证器必须拒绝而非钳制。
 */
export const LONGITUDE_RANGE = { min: -180, max: 180 } as const
/**
 * 纬度合法区间（度）。超出即视为非法坐标，验证器必须拒绝而非钳制。
 */
export const LATITUDE_RANGE = { min: -90, max: 90 } as const

/**
 * 中国主图地理范围（SPEC §3.3）。
 *
 * 经度 72°E–136°E、纬度 3°N–54°N（南端覆盖到曾母暗沙 ≈3.58°N），含南海诸岛真实位置。
 * 统一投影层（src/lib/projection.ts）以它为「主图契约范围」做强校验；地形、边界、省会点、
 * 南海附图等全部地理数据都以它为准，不得另立范围常量。
 */
export const CHINA_MAIN_MAP_EXTENT = {
  west: 72,
  south: 3,
  east: 136,
  north: 54,
  crs: KNOWN_COORDINATE_REFERENCE_SYSTEMS.EPSG_4326,
} as const

/** 判定一个值是否为已登记的坐标参考系字面量。 */
export function isRecognizedCoordinateReferenceSystem(value: unknown): value is CoordinateReferenceSystem {
  return typeof value === 'string' && RECOGNIZED_COORDINATE_REFERENCE_SYSTEMS.includes(value)
}

/** 判定一个值是否为已登记的静态资产版本字面量。 */
export function isRecognizedDataVersion(value: unknown): value is DataVersion {
  return typeof value === 'string' && RECOGNIZED_DATA_VERSIONS.includes(value)
}

/** 判定经度是否落在合法区间内（含端点）。 */
export function isValidLongitude(value: unknown): boolean {
  return (
    typeof value === 'number' &&
    Number.isFinite(value) &&
    value >= LONGITUDE_RANGE.min &&
    value <= LONGITUDE_RANGE.max
  )
}

/** 判定纬度是否落在合法区间内（含端点）。 */
export function isValidLatitude(value: unknown): boolean {
  return (
    typeof value === 'number' &&
    Number.isFinite(value) &&
    value >= LATITUDE_RANGE.min &&
    value <= LATITUDE_RANGE.max
  )
}

/** 判定一个字符串是否符合行政区稳定标识格式。返回类型谓词以便校验器在分支中收窄。 */
export function isValidAdministrativeId(value: unknown): value is string {
  return typeof value === 'string' && ADMINISTRATIVE_ID_PATTERN.test(value)
}
