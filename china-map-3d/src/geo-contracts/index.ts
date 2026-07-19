/**
 * 静态地理资产契约层公共出口。
 *
 * 依赖方向（强约束）：
 * - 本层只依赖 TypeScript 自身，禁止 import React、Three.js 或任何渲染层。
 * - 运行时数据访问层、资产校验入口（CLI）、离线资产生产脚本、测试夹具都从此处导入，
 *   反向依赖会破坏分层并造成隐式耦合。
 *
 * 对外只暴露「契约类型 + 校验入口 + 冻结不变量」。具体契约的内部实现细节
 * （各校验器如何拼装错误列表等）不属于公共稳定面，但出于高内聚仍从这里再导出，
 * 便于后续 TASK 直接复用单契约校验器而非总是走分发入口。
 */

// 冻结不变量与基础判定
export {
  CHINA_MAIN_MAP_EXTENT,
  KNOWN_COORDINATE_REFERENCE_SYSTEMS,
  KNOWN_DATA_VERSIONS,
  ADMINISTRATIVE_ID_PATTERN,
  LATITUDE_RANGE,
  LONGITUDE_RANGE,
  RECOGNIZED_COORDINATE_REFERENCE_SYSTEMS,
  RECOGNIZED_DATA_VERSIONS,
  isRecognizedCoordinateReferenceSystem,
  isRecognizedDataVersion,
  isValidAdministrativeId,
  isValidLatitude,
  isValidLongitude,
  type CoordinateReferenceSystem,
  type DataVersion,
} from './codes'

// 验证结果语义
export {
  error,
  invalid,
  valid,
  type ContractValidationError,
  type ContractValidationOutcome,
} from './errors'

// 几何原语（跨契约共享）
export {
  collectAdministrativeGeometryErrors,
  collectCoordinateErrors,
  collectCrsErrors,
  collectRingErrors,
  type AdministrativeGeometry,
  type LonLatCoordinate,
  type LonLatRing,
  type MultiPolygonGeometry,
  type PolygonGeometry,
} from './geometry-primitives'

// 数据来源声明
export {
  validateDataSourceRegistry,
  RECOGNIZED_SOURCE_KINDS,
  type DataSourceDeclaration,
  type DataSourceKind,
  type DataSourceRegistryContract,
} from './source'

// 地形元数据
export {
  decodeUint16ToElevation,
  encodeElevationToUint16,
  validateTerrainMeta,
  type DataSourceRef,
  type TerrainElevationEncoding,
  type TerrainGeographicExtent,
  type TerrainMetaContract,
  type TerrainRasterResolution,
} from './terrain'

// 行政区目录
export {
  validateAdministrativeDirectory,
  RECOGNIZED_REGION_TYPES,
  type AdministrativeDirectoryContract,
  type AdministrativeDirectoryEntry,
  type AdministrativeRegionType,
} from './admin-directory'

// 行政区几何
export {
  validateAdministrativeGeometry,
  type AdministrativeGeometryContract,
  type AdministrativeGeometryFeature,
} from './geometry'

// 地点目录
export {
  validatePlaceDirectory,
  RECOGNIZED_PLACE_ROLES,
  type PlaceDirectoryContract,
  type PlaceDirectoryEntry,
  type PlaceRole,
} from './places'

// 政治边界补充数据
export {
  validatePoliticalBoundary,
  type DisputedBoundaryCorrectionFeature,
  type IslandOrReefPointFeature,
  type NineDashLineSegmentFeature,
  type PoliticalBoundaryContract,
  type PoliticalBoundaryFeature,
} from './political'

// 统一验证入口
export {
  validateContractByKind,
  validateContractBundle,
  readContractKind,
  type ContractBundle,
  type ContractKind,
} from './validate'
