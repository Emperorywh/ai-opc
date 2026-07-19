/**
 * 经纬度坐标与几何原语类型 + 结构性校验助手。
 *
 * 依赖方向：契约层内部共享原语，只依赖 codes.ts 与 errors.ts，不得引入渲染层。
 * 行政区几何、地点目录与政治边界补充数据都复用这里的坐标与几何表达，
 * 使「源坐标基准统一为 EPSG:4326」这一不变量在一处定义、处处一致。
 *
 * 关键决策：坐标用命名字段 { lon, lat } 而非 [lon, lat] 数组。
 * 契约约束「不得用数组位置承载领域语义」——GeoJSON 的位置语义虽是业界惯例，
 * 但本契约要求经纬度语义显式可达，故采用命名字段消除 0/1 位置歧义。
 * 几何的 CRS 在容器层级声明一次（GeoJSON 惯例），避免在每个坐标上重复。
 */

import {
  isValidLatitude,
  isValidLongitude,
  type CoordinateReferenceSystem,
} from './codes'
import { type ContractValidationError, error } from './errors'

/**
 * WGS84 经纬度坐标。
 * lon/lat 显式命名；CRS 由所在几何容器统一声明，故此处不再重复携带。
 */
export interface LonLatCoordinate {
  readonly lon: number
  readonly lat: number
}

/**
 * 一个闭合环（外环或内环/洞）。
 * 本契约不强制首尾点重合（环闭合可在加载期统一处理），但要求至少 3 个不共线意义的
 * 顶点，否则不足以表达一个面。是否进一步要求首尾重合由消费该几何的下游 TASK 决定。
 */
export type LonLatRing = readonly LonLatCoordinate[]

/** 多边形：rings[0] 为外环，其余为内环（洞）。 */
export interface PolygonGeometry {
  readonly type: 'Polygon'
  readonly rings: readonly LonLatRing[]
}

/**
 * 多多边形：用于岛屿、飞地等多块的省级行政区（如海南、黑龙江、广东等）。
 * 每个多边形独立拥有自己的环列表，语义与 Polygon 一致。
 */
export interface MultiPolygonGeometry {
  readonly type: 'MultiPolygon'
  readonly polygons: readonly { readonly rings: readonly LonLatRing[] }[]
}

/** 行政区几何的判别联合。 */
export type AdministrativeGeometry = PolygonGeometry | MultiPolygonGeometry

/** 单个经纬度坐标的合法性校验，返回错误列表（可能为空）。 */
export function collectCoordinateErrors(
  coordinate: unknown,
  path: string,
): readonly ContractValidationError[] {
  if (coordinate === null || typeof coordinate !== 'object') {
    return [error('coordinate.not-object', path, '坐标必须为对象，包含 lon 与 lat 数值字段。')]
  }
  const record = coordinate as { lon?: unknown; lat?: unknown }
  const errors: ContractValidationError[] = []
  if (!isValidLongitude(record.lon)) {
    errors.push(
      error(
        'coordinate.longitude-out-of-range',
        `${path}.lon`,
        '经度必须为 -180..180 内的有限数值。',
      ),
    )
  }
  if (!isValidLatitude(record.lat)) {
    errors.push(
      error(
        'coordinate.latitude-out-of-range',
        `${path}.lat`,
        '纬度必须为 -90..90 内的有限数值。',
      ),
    )
  }
  return errors
}

/** 单个环的结构性校验：至少 3 个合法坐标。 */
export function collectRingErrors(
  ring: unknown,
  path: string,
): readonly ContractValidationError[] {
  if (!Array.isArray(ring)) {
    return [error('ring.not-array', path, '几何环必须为数组。')]
  }
  if (ring.length < 3) {
    return [
      error('ring.too-few-points', path, '几何环至少需要 3 个坐标，否则不足以表达一个面。'),
    ]
  }
  const errors: ContractValidationError[] = []
  ring.forEach((coordinate, index) => {
    errors.push(...collectCoordinateErrors(coordinate, `${path}[${index}]`))
  })
  return errors
}

/**
 * 行政区几何的结构性校验。
 * 不做语义级拓扑检查（自相交、面积等），那些需要专门几何库且属于下游 TASK 的职责；
 * 本契约只保证坐标合法、结构闭合到「环/多边形/多多边形」层级。
 */
export function collectAdministrativeGeometryErrors(
  geometry: unknown,
  path: string,
): readonly ContractValidationError[] {
  if (geometry === null || typeof geometry !== 'object') {
    return [error('geometry.not-object', path, '几何必须为对象。')]
  }
  const record = geometry as { type?: unknown; rings?: unknown; polygons?: unknown }
  if (record.type === 'Polygon') {
    if (!Array.isArray(record.rings) || record.rings.length === 0) {
      return [error('polygon.missing-rings', `${path}.rings`, 'Polygon 至少需要 1 个外环。')]
    }
    const errors: ContractValidationError[] = []
    record.rings.forEach((ring, index) => {
      errors.push(...collectRingErrors(ring, `${path}.rings[${index}]`))
    })
    return errors
  }
  if (record.type === 'MultiPolygon') {
    if (!Array.isArray(record.polygons) || record.polygons.length === 0) {
      return [
        error('multi-polygon.missing-polygons', `${path}.polygons`, 'MultiPolygon 至少需要 1 个多边形。'),
      ]
    }
    const errors: ContractValidationError[] = []
    record.polygons.forEach((polygon, index) => {
      const polygonPath = `${path}.polygons[${index}]`
      if (polygon === null || typeof polygon !== 'object') {
        errors.push(error('multi-polygon.polygon-not-object', polygonPath, '多多边形的成员必须为对象。'))
        return
      }
      const polygonRecord = polygon as { rings?: unknown }
      if (!Array.isArray(polygonRecord.rings) || polygonRecord.rings.length === 0) {
        errors.push(
          error('polygon.missing-rings', `${polygonPath}.rings`, 'Polygon 至少需要 1 个外环。'),
        )
        return
      }
      polygonRecord.rings.forEach((ring, ringIndex) => {
        errors.push(...collectRingErrors(ring, `${polygonPath}.rings[${ringIndex}]`))
      })
    })
    return errors
  }
  return [error('geometry.unknown-type', `${path}.type`, '几何 type 必须为 "Polygon" 或 "MultiPolygon"。')]
}

/**
 * 校验一个 CRS 字段是否为已知 CRS，并可选地要求其等于某个期望值。
 * 期望值用于表达「源几何固定为 EPSG:4326」「地形栅格固定为 EPSG:3857」这类硬不变量。
 */
export function collectCrsErrors(
  crs: unknown,
  path: string,
  expected: CoordinateReferenceSystem,
): readonly ContractValidationError[] {
  if (typeof crs !== 'string') {
    return [error('crs.missing', path, `坐标参考系必须显式给出，且应为 ${expected}。`)]
  }
  if (crs !== expected) {
    return [
      error(
        'crs.unexpected',
        path,
        `该字段的坐标参考系必须为 ${expected}，实际为 ${crs}。`,
      ),
    ]
  }
  return []
}
