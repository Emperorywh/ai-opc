import type { Point2 } from '../../src/features/agv-map/domain/domainModel'

/**
 * 测试用三次贝塞尔曲线几何工具（SPEC §7.3）。
 *
 * 这些函数仅用于测试校验：独立于被测实现，用朴素的三次贝塞尔公式与点到线段距离
 * 度量采样折线对真实曲线的逼近误差。不进入 src，避免污染生产依赖。
 *
 * 不变量：
 * - 纯函数，不依赖被测代码，作为采样结果的独立校验标尺。
 * - 输入相同则输出逐点一致，便于断言。
 */

/**
 * 在参数 t 处计算三次贝塞尔曲线上的点。
 * 独立实现，用于校验采样点是否落在真实曲线上（de Casteljau 切分点恒在曲线上）。
 */
export function cubicAt(p0: Point2, p1: Point2, p2: Point2, p3: Point2, t: number): Point2 {
  const mt = 1 - t
  const a = mt * mt * mt
  const b = 3 * mt * mt * t
  const c = 3 * mt * t * t
  const d = t * t * t
  return {
    x: a * p0.x + b * p1.x + c * p2.x + d * p3.x,
    y: a * p0.y + b * p1.y + c * p2.y + d * p3.y,
  }
}

/**
 * 沿参数 t∈[0,1] 等间距密集采样真实曲线，用于近似校验折线对曲线的逼近误差。
 * n 越大越接近真实最大偏差；默认 4000 点足以覆盖 V76 全部贝塞尔的平坦度量。
 */
export function denseCurve(p0: Point2, p1: Point2, p2: Point2, p3: Point2, n = 4000): Point2[] {
  const out: Point2[] = []
  for (let i = 0; i <= n; i += 1) {
    out.push(cubicAt(p0, p1, p2, p3, i / n))
  }
  return out
}

/** 点到线段 a-b 的最近距离。线段退化为点时回退到点到端点的欧氏距离。 */
export function distPointToSegment(p: Point2, a: Point2, b: Point2): number {
  const abx = b.x - a.x
  const aby = b.y - a.y
  const apx = p.x - a.x
  const apy = p.y - a.y
  const lenSq = abx * abx + aby * aby
  if (lenSq === 0) return Math.hypot(apx, apy)
  const t = Math.min(1, Math.max(0, (apx * abx + apy * aby) / lenSq))
  return Math.hypot(p.x - (a.x + abx * t), p.y - (a.y + aby * t))
}

/** 点到折线的最近距离，取所有相邻段的最小值。空折线返回正无穷。 */
export function distToPolyline(p: Point2, polyline: readonly Point2[]): number {
  let min = Number.POSITIVE_INFINITY
  for (let i = 1; i < polyline.length; i += 1) {
    const d = distPointToSegment(p, polyline[i - 1], polyline[i])
    if (d < min) min = d
  }
  return min
}
