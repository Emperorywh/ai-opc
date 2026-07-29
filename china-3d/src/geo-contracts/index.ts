/**
 * 静态地理资产契约层公共出口。
 *
 * 依赖方向（强约束）：
 * - 本层只依赖 TypeScript 自身，禁止 import React、Three.js 或任何渲染层。
 * - 统一投影层（src/lib/projection.ts）、运行时数据访问层、离线资产生产脚本、测试
 *   都从此处导入，反向依赖会破坏分层并造成隐式耦合。
 *
 * 对外只暴露「契约类型 + 校验入口 + 冻结不变量 + 规范目录/编码常量」。
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

// 地形元数据 + 16 位高程编码/解码唯一源
export {
  CHINA_TERRAIN_ELEVATION_ENCODING,
  UINT16_MAX_CODE,
  decodeUint16ToElevation,
  encodeElevationToUint16,
  validateTerrainMeta,
  type DataSourceRef,
  type TerrainElevationEncoding,
  type TerrainGeographicExtent,
  type TerrainMetaContract,
  type TerrainRasterResolution,
} from './terrain'

// 省级行政区目录（含规范 34 目录常量）
export {
  CHINA_ADMINISTRATIVE_DIRECTORY,
  EXPECTED_PROVINCIAL_ADMINISTRATIVE_COUNT,
  validateAdministrativeDirectory,
  RECOGNIZED_REGION_TYPES,
  type AdministrativeDirectoryContract,
  type AdministrativeDirectoryEntry,
  type AdministrativeRegionType,
} from './admin-directory'

// 地点目录（省名锚点 + 省级行政中心）
export {
  validatePlaceDirectory,
  RECOGNIZED_PLACE_ROLES,
  type PlaceDirectoryContract,
  type PlaceDirectoryEntry,
  type PlaceRole,
} from './places'

// 政治边界补充数据（九段线 / 岛礁点 / 争议区修正）
export {
  validatePoliticalBoundary,
  type DisputedBoundaryCorrectionFeature,
  type IslandOrReefPointFeature,
  type NineDashLineSegmentFeature,
  type PoliticalBoundaryContract,
  type PoliticalBoundaryFeature,
} from './political'
