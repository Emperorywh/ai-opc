/**
 * 地形高程元数据契约。
 *
 * 依赖方向：契约层，依赖 codes.ts、errors.ts、geometry-primitives.ts、source.ts 的引用类型。
 * 不依赖 Three.js / React：GPU 顶点位移、CPU 高程查询都属于运行时渲染/访问层，
 * 它们单向消费本契约，本契约不得反向依赖它们。
 *
 * 冻结的不变量（SPEC §3.1、§3.3、§5.1、§7.1）：
 * - 栅格平面 CRS 固定为 EPSG:3857（Web 墨卡托）；地理范围以 EPSG:4326 经纬度四至表达。
 * - 高程编码区间线性映射到无符号整数，下限 < 上限；位深固定 16 位（禁止 8 位替代精度）。
 * - 超出区间采用 clamp-to-range：浅水负高程保留，低于下限的深海值截断到下限。
 * 这些不变量让 CPU 与 GPU 后续可以用同一编码、同一元数据解码回真实米制海拔。
 */

import {
  CHINA_MAIN_MAP_EXTENT,
  KNOWN_COORDINATE_REFERENCE_SYSTEMS,
  isRecognizedDataVersion,
} from './codes'
import { collectCrsErrors } from './geometry-primitives'
import { type ContractValidationOutcome, error, invalid, valid } from './errors'

/**
 * 高程编码描述。
 * SPEC §5.1：[-1500m, 9000m] 线性映射到 0..65535（16 位无符号整数）。
 */
export interface TerrainElevationEncoding {
  /** 编码区间下限（米）。保留浅水负高程，故通常为负值。 */
  readonly minValueMeters: number
  /** 编码区间上限（米）。 */
  readonly maxValueMeters: number
  /** 位深。SPEC 强制 16 位，校验器拒绝 8 位以防止精度丢失。 */
  readonly bitDepth: 8 | 16
  /** 编码方式：线性归一化到无符号整数区间。 */
  readonly encoding: 'linear-unsigned-integer'
  /** 超出区间的处理策略。SPEC：clamp-to-range。 */
  readonly outOfRangePolicy: 'clamp-to-range'
}

/** 栅格分辨率（像素）。宽高均须为正整数。 */
export interface TerrainRasterResolution {
  readonly widthPixels: number
  readonly heightPixels: number
}

/**
 * 栅格覆盖的地理范围（经纬度四至）。
 * 注意：crs 固定为 EPSG:4326——这里表达的是「栅格覆盖的经纬度区域」，
 * 与地形栅格自身的平面 CRS（EPSG:3857）是两个不同语义的字段，二者共存避免投影歧义。
 */
export interface TerrainGeographicExtent {
  readonly crs: 'EPSG:4326'
  readonly west: number
  readonly south: number
  readonly east: number
  readonly north: number
}

/** 来源引用：仅记录 sourceId，详情见来源注册表。 */
export interface DataSourceRef {
  readonly sourceId: string
}

/** 地形元数据契约主体。 */
export interface TerrainMetaContract {
  readonly kind: 'terrain-meta'
  readonly version: string
  /** 栅格平面坐标参考系，固定 EPSG:3857。 */
  readonly crs: 'EPSG:3857'
  readonly geographicExtent: TerrainGeographicExtent
  readonly resolution: TerrainRasterResolution
  readonly elevationEncoding: TerrainElevationEncoding
  readonly source: DataSourceRef
}

function isPositiveInteger(value: unknown): boolean {
  return typeof value === 'number' && Number.isInteger(value) && value > 0
}

/** 地形元数据校验器。 */
export function validateTerrainMeta(payload: unknown): ContractValidationOutcome {
  if (payload === null || typeof payload !== 'object') {
    return invalid([error('terrain-meta.not-object', '$', '地形元数据必须为对象。')])
  }
  const record = payload as Partial<TerrainMetaContract>
  const errors = []

  if (record.kind !== 'terrain-meta') {
    errors.push(error('terrain-meta.wrong-kind', '$.kind', '地形元数据的 kind 必须为 "terrain-meta"。'))
  }
  if (!isRecognizedDataVersion(record.version)) {
    errors.push(
      error(
        'terrain-meta.unknown-version',
        '$.version',
        `version 必须为已登记的静态资产版本，实际为 ${String(record.version)}。`,
      ),
    )
  }
  // CRS 缺失/错误：确定性失败的核心场景之一（TASK-001 验证方式 2）。
  errors.push(...collectCrsErrors(record.crs, '$.crs', KNOWN_COORDINATE_REFERENCE_SYSTEMS.EPSG_3857))

  errors.push(...collectGeographicExtentErrors(record.geographicExtent))
  errors.push(...collectResolutionErrors(record.resolution))
  errors.push(...collectElevationEncodingErrors(record.elevationEncoding))
  errors.push(...collectSourceRefErrors(record.source))

  return errors.length === 0 ? valid() : invalid(errors)
}

function collectGeographicExtentErrors(
  extent: unknown,
): readonly ReturnType<typeof error>[] {
  if (extent === null || typeof extent !== 'object') {
    return [error('terrain-meta.extent-not-object', '$.geographicExtent', 'geographicExtent 必须为对象。')]
  }
  const e = extent as Partial<TerrainGeographicExtent>
  const errors = []
  errors.push(...collectCrsErrors(e.crs, '$.geographicExtent.crs', 'EPSG:4326'))
  const bounds: Array<[unknown, string, number, number]> = [
    [e.west, '$.geographicExtent.west', -180, 180],
    [e.east, '$.geographicExtent.east', -180, 180],
    [e.south, '$.geographicExtent.south', -90, 90],
    [e.north, '$.geographicExtent.north', -90, 90],
  ]
  for (const [value, path, min, max] of bounds) {
    if (
      typeof value !== 'number' ||
      !Number.isFinite(value) ||
      value < min ||
      value > max
    ) {
      errors.push(
        error(
          'terrain-meta.extent-bound-out-of-range',
          path,
          `边界值必须为 ${min}..${max} 内的有限数值。`,
        ),
      )
    }
  }
  // 内部一致性：西 < 东、南 < 北，否则范围自相矛盾。
  if (
    typeof e.west === 'number' &&
    typeof e.east === 'number' &&
    Number.isFinite(e.west) &&
    Number.isFinite(e.east) &&
    e.west >= e.east
  ) {
    errors.push(
      error(
        'terrain-meta.extent-west-not-less-than-east',
        '$.geographicExtent',
        'west 必须小于 east，地理范围不得自相矛盾。',
      ),
    )
  }
  if (
    typeof e.south === 'number' &&
    typeof e.north === 'number' &&
    Number.isFinite(e.south) &&
    Number.isFinite(e.north) &&
    e.south >= e.north
  ) {
    errors.push(
      error(
        'terrain-meta.extent-south-not-less-than-north',
        '$.geographicExtent',
        'south 必须小于 north，地理范围不得自相矛盾。',
      ),
    )
  }
  // 仅作文档性提示：地形范围应覆盖中国主图；不强制相等以免过早冻结未生产完成的资产。
  void CHINA_MAIN_MAP_EXTENT
  return errors
}

function collectResolutionErrors(
  resolution: unknown,
): readonly ReturnType<typeof error>[] {
  if (resolution === null || typeof resolution !== 'object') {
    return [error('terrain-meta.resolution-not-object', '$.resolution', 'resolution 必须为对象。')]
  }
  const r = resolution as Partial<TerrainRasterResolution>
  const errors = []
  if (!isPositiveInteger(r.widthPixels)) {
    errors.push(error('terrain-meta.resolution-width-invalid', '$.resolution.widthPixels', 'widthPixels 必须为正整数。'))
  }
  if (!isPositiveInteger(r.heightPixels)) {
    errors.push(error('terrain-meta.resolution-height-invalid', '$.resolution.heightPixels', 'heightPixels 必须为正整数。'))
  }
  return errors
}

function collectElevationEncodingErrors(
  encoding: unknown,
): readonly ReturnType<typeof error>[] {
  if (encoding === null || typeof encoding !== 'object') {
    return [error('terrain-meta.encoding-not-object', '$.elevationEncoding', 'elevationEncoding 必须为对象。')]
  }
  const e = encoding as Partial<TerrainElevationEncoding>
  const errors = []
  if (e.encoding !== 'linear-unsigned-integer') {
    errors.push(
      error(
        'terrain-meta.encoding-unsupported',
        '$.elevationEncoding.encoding',
        'encoding 必须为 "linear-unsigned-integer"。',
      ),
    )
  }
  if (e.outOfRangePolicy !== 'clamp-to-range') {
    errors.push(
      error(
        'terrain-meta.out-of-range-policy-unsupported',
        '$.elevationEncoding.outOfRangePolicy',
        'outOfRangePolicy 必须为 "clamp-to-range"（浅水负高程保留、深海截断到下限）。',
      ),
    )
  }
  if (e.bitDepth !== 16) {
    errors.push(
      error(
        'terrain-meta.bit-depth-not-16',
        '$.elevationEncoding.bitDepth',
        'bitDepth 必须为 16；8 位会丢失高程精度，违反 SPEC §5.1。',
      ),
    )
  }
  if (
    typeof e.minValueMeters !== 'number' ||
    !Number.isFinite(e.minValueMeters)
  ) {
    errors.push(
      error(
        'terrain-meta.min-value-not-finite',
        '$.elevationEncoding.minValueMeters',
        'minValueMeters 必须为有限数值。',
      ),
    )
  }
  if (
    typeof e.maxValueMeters !== 'number' ||
    !Number.isFinite(e.maxValueMeters)
  ) {
    errors.push(
      error(
        'terrain-meta.max-value-not-finite',
        '$.elevationEncoding.maxValueMeters',
        'maxValueMeters 必须为有限数值。',
      ),
    )
  }
  // 高程区间自洽：下限必须严格小于上限。这是「错误高程范围」场景的确定性失败点。
  if (
    typeof e.minValueMeters === 'number' &&
    typeof e.maxValueMeters === 'number' &&
    Number.isFinite(e.minValueMeters) &&
    Number.isFinite(e.maxValueMeters) &&
    e.minValueMeters >= e.maxValueMeters
  ) {
    errors.push(
      error(
        'terrain-meta.elevation-range-inverted',
        '$.elevationEncoding',
        'minValueMeters 必须严格小于 maxValueMeters，编码区间不得倒置或退化。',
      ),
    )
  }
  return errors
}

function collectSourceRefErrors(
  source: unknown,
): readonly ReturnType<typeof error>[] {
  if (source === null || typeof source !== 'object') {
    return [error('terrain-meta.source-not-object', '$.source', 'source 必须为对象，包含 sourceId。')]
  }
  const s = source as Partial<DataSourceRef>
  if (typeof s.sourceId !== 'string' || s.sourceId.trim().length === 0) {
    return [error('terrain-meta.source-id-empty', '$.source.sourceId', 'sourceId 必须为非空字符串。')]
  }
  return []
}
