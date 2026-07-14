import type { Point2 } from '../domain/domainModel'
import { GeometryCompileError, type SampledPath } from './pathSampling'

/**
 * 地图坐标系与世界坐标系的确定基准（SPEC §6）。
 *
 * 坐标约定：
 * - 地图使用 XY 平面，Three.js 使用 XZ 地面。
 * - 映射 map(x, y) → world(x - centerX, height, -(y - centerY))（SPEC §6.1）。
 * - 1 world unit = 1 m，真实尺度保持，不做整体缩放。
 *
 * 地图中心由全部节点位置与全部路径采样点的联合 AABB 计算（SPEC §6.3），
 * 保证节点、扁带与场景共享同一空间基准。
 *
 * 不变量：仅累加 min/max，不缓存、不读取系统时间，对相同输入字节级稳定。
 * 上游校验已保证节点与边坐标均为有限数值，故中心结果恒为有限。
 */

/** 地图空间基准：以联合边界中心为原点的米制坐标系。 */
export interface MapSpace {
  /** 全部节点与路径采样点联合 AABB 的中心，地图 XY 平面，单位米。 */
  readonly center: Point2
}

/** 世界坐标，XZ 地面 + Y 高度（单位米）。 */
export interface WorldCoord {
  readonly x: number
  readonly y: number
  readonly z: number
}

/**
 * 由全部节点位置与全部路径采样点的联合 AABB 中心建立地图空间基准。
 *
 * 两组输入同时为空属于上游契约错误（V76 基线 1768 节点），此时抛出几何错误，
 * 不返回半成品中心；任一非空即按联合边界计算。
 */
export function computeMapSpace(
  nodePositions: Iterable<Point2>,
  sampledPaths: Iterable<SampledPath>,
): MapSpace {
  let minX = Number.POSITIVE_INFINITY
  let minY = Number.POSITIVE_INFINITY
  let maxX = Number.NEGATIVE_INFINITY
  let maxY = Number.NEGATIVE_INFINITY
  let hasAny = false

  for (const p of nodePositions) {
    hasAny = true
    if (p.x < minX) minX = p.x
    if (p.x > maxX) maxX = p.x
    if (p.y < minY) minY = p.y
    if (p.y > maxY) maxY = p.y
  }
  for (const sampled of sampledPaths) {
    for (const p of sampled.points) {
      hasAny = true
      if (p.x < minX) minX = p.x
      if (p.x > maxX) maxX = p.x
      if (p.y < minY) minY = p.y
      if (p.y > maxY) maxY = p.y
    }
  }

  if (!hasAny) {
    throw new GeometryCompileError(
      'EMPTY_COMPUTE_BOUNDS',
      '地图中心计算缺少任何节点或采样点',
    )
  }

  return {
    center: { x: (minX + maxX) / 2, y: (minY + maxY) / 2 },
  }
}

/**
 * 把地图 XY 坐标映射为世界坐标。height 表达离地高度，默认 0。
 * SPEC §6.1：world = (x - centerX, height, -(y - centerY))，1 单位 = 1 m。
 */
export function mapToWorld(point: Point2, space: MapSpace, height = 0): WorldCoord {
  return {
    x: point.x - space.center.x,
    y: height,
    z: -(point.y - space.center.y),
  }
}
