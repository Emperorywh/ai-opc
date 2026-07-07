// ============================================================================
// 三次贝塞尔几何工具：弧长自适应 tessellate + 单位切线（SPEC §4.2，TASK_004）
// ----------------------------------------------------------------------------
// 设计要点：
// 1. 纯函数，不依赖 React / three，仅产出裸数值（地图坐标 + 单位切线），
//    便于 node 端单测与 CPU 端几何管线（geometry.ts）直接复用。
// 2. 三次贝塞尔位置 B(t) 与导数 B'(t) 用标准 Bernstein 多项式形式，
//    数值稳定，且端点严格命中 B(0)=P0、B(1)=P3。
// 3. 「弧长自适应」按任务约定取启发式而非精确等弧长：
//    先用若干参数点估算总弧长，结合「长度因子 + 曲率因子」决定总段数，
//    再封顶 maxSegments；关键是用段数封顶避免极端曲线爆炸。
//    采样点在参数 t 上均匀分布（t=i/segments）——总段数随长度/曲率自适应，
//    即可实现「短边少分段、大曲率多分段」的视觉效果。
// 4. 退化优先、永不抛异常：极短曲线仍返回 ≥2 点；端点零导数切线向相邻段回退。
//    控制点缺失不在本函数职责（loader 已把缺控制点的 BEZIER 降级为 LINE），
//    本函数假定 P0–P3 全部为有效数值。
// ============================================================================

import { constants } from '../config/constants.ts'

// ----------------------------------------------------------------------------
// 二维点 / 向量（地图坐标，米）
// 输入控制点 P0–P3 与内部向量运算统一使用该结构。
// ----------------------------------------------------------------------------
export interface Vec2 {
  x: number
  y: number
}

// ----------------------------------------------------------------------------
// 采样点：曲线上的位置（地图坐标）+ 沿 t 增大方向的单位切线
// 下游双车道法线偏移（laneOffset.ts）与方向箭头朝向（arrows.ts）复用切线。
// 切线方向约定：沿 t 增大（P0→P3），后续箭头朝向以此为准。
// ----------------------------------------------------------------------------
export interface SamplePoint {
  // 曲线上的位置（地图坐标，米）
  x: number
  y: number
  // 单位切线 x 分量（沿 P0→P3 方向）
  tx: number
  // 单位切线 y 分量（沿 P0→P3 方向）
  ty: number
}

// ----------------------------------------------------------------------------
// 内部启发式常量（非对外配置）
// ----------------------------------------------------------------------------
// 弧长估算的参数采样数：越大越准，64 点对三次贝塞尔已足够平滑
const ARC_LENGTH_SAMPLES = 64
// 每段目标弦长（米）：弧长越长则段数越多（「短边少分段」的长度因子）
const TARGET_SEGMENT_LENGTH = 0.25
// 零向量阈值：模长低于此值视为退化，触发相邻段切线回退
const EPSILON = 1e-9

// ----------------------------------------------------------------------------
// 规范化段数上限：非有限或小于 1 一律退化为 1，保证至少返回 2 点
// ----------------------------------------------------------------------------
function resolveMaxSegments(maxSegments: number): number {
  const cap = Math.trunc(maxSegments)
  if (!Number.isFinite(cap) || cap < 1) {
    return 1
  }
  return cap
}

// ----------------------------------------------------------------------------
// 三次贝塞尔位置 B(t)（标准 Bernstein 形式）
// B(t) = (1-t)³·P0 + 3(1-t)²t·P1 + 3(1-t)t²·P2 + t³·P3，t∈[0,1]
// 端点严格命中：B(0)=P0、B(1)=P3（系数恰为 1/0，浮点亦精确）。
// ----------------------------------------------------------------------------
function bezierPoint(p0: Vec2, p1: Vec2, p2: Vec2, p3: Vec2, t: number): Vec2 {
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

// ----------------------------------------------------------------------------
// 三次贝塞尔导数 B'(t)（标准形式）
// B'(t) = 3·[(1-t)²(P1-P0) + 2(1-t)t(P2-P1) + t²(P3-P2)]
// 方向沿 t 增大（P0→P3）；归一化后即为单位切线。
// ----------------------------------------------------------------------------
function bezierDerivative(p0: Vec2, p1: Vec2, p2: Vec2, p3: Vec2, t: number): Vec2 {
  const mt = 1 - t
  const c0 = 3 * mt * mt
  const c1 = 6 * mt * t
  const c2 = 3 * t * t
  return {
    x: c0 * (p1.x - p0.x) + c1 * (p2.x - p1.x) + c2 * (p3.x - p2.x),
    y: c0 * (p1.y - p0.y) + c1 * (p2.y - p1.y) + c2 * (p3.y - p2.y),
  }
}

// 工具：两点欧氏距离
function distance(a: Vec2, b: Vec2): number {
  return Math.hypot(b.x - a.x, b.y - a.y)
}

// ----------------------------------------------------------------------------
// 工具：归一化为单位向量；零向量（模长 < EPSILON）原样返回 (0,0)
// 上层负责对零向量做相邻段回退，避免此处产生 NaN 污染下游。
// ----------------------------------------------------------------------------
function normalizeOrZero(v: Vec2): Vec2 {
  const len = Math.hypot(v.x, v.y)
  if (len < EPSILON) {
    return { x: 0, y: 0 }
  }
  return { x: v.x / len, y: v.y / len }
}

// ----------------------------------------------------------------------------
// 估算三次贝塞尔总弧长（参数均匀采样，累加相邻弦长）
// 仅用于段数启发式，无需精确等弧长；采样越密越接近真实弧长。
// ----------------------------------------------------------------------------
function estimateArcLength(p0: Vec2, p1: Vec2, p2: Vec2, p3: Vec2): number {
  let length = 0
  let prev = bezierPoint(p0, p1, p2, p3, 0)
  for (let i = 1; i <= ARC_LENGTH_SAMPLES; i++) {
    const t = i / ARC_LENGTH_SAMPLES
    const cur = bezierPoint(p0, p1, p2, p3, t)
    length += distance(prev, cur)
    prev = cur
  }
  return length
}

// ----------------------------------------------------------------------------
// 段数启发式：长度因子 + 曲率因子（「短边少分段、大曲率多分段」）
// - 长度因子：按目标弦长切分，弧长越长段数越多（极短弧长至少 1 段）；
// - 曲率因子：控制多边形长 / 弦长 ≥ 1，弯曲越大比值越大，放大段数；
//   端点重合（弦长≈0）时跳过曲率因子，仅按弧长决定段数，避免除零。
// 返回值尚未封顶，由调用方 clamp 到 [1, maxSegments]。
// ----------------------------------------------------------------------------
function decideSegmentCount(
  p0: Vec2,
  p1: Vec2,
  p2: Vec2,
  p3: Vec2,
  arcLength: number,
): number {
  // 长度因子：弧长越长段数越多，极短弧长兜底为 1 段
  let segments = Math.max(1, Math.ceil(arcLength / TARGET_SEGMENT_LENGTH))

  // 曲率因子：控制多边形长度相对弦长的放大倍数，衡量整体弯曲程度
  const polygonLength = distance(p0, p1) + distance(p1, p2) + distance(p2, p3)
  const chordLength = distance(p0, p3)
  if (chordLength > EPSILON) {
    const bend = polygonLength / chordLength
    segments = Math.ceil(segments * bend)
  }

  return segments
}

// ----------------------------------------------------------------------------
// 主入口：三次贝塞尔弧长自适应 tessellate
// 输入：四个控制点 P0–P3（假定均为有效数值）+ 段数上限 maxSegments。
// 输出：segments+1 个采样点（均匀参数 t=i/segments），含位置与单位切线。
// 保证：首点=P0、末点=P3；段数 ∈ [1, maxSegments]；退化不抛异常。
// maxSegments 默认取自全局 constants（与 SPEC §7 / geometry.ts 调用一致）。
// ----------------------------------------------------------------------------
export function sampleCubicBezier(
  p0: Vec2,
  p1: Vec2,
  p2: Vec2,
  p3: Vec2,
  maxSegments: number = constants.bezierMaxSegments,
): SamplePoint[] {
  const cap = resolveMaxSegments(maxSegments)

  // 1. 估算弧长 → 决定段数 → 封顶到 [1, cap]
  const arcLength = estimateArcLength(p0, p1, p2, p3)
  let segments = decideSegmentCount(p0, p1, p2, p3, arcLength)
  if (segments < 1) segments = 1
  if (segments > cap) segments = cap

  // 2. 均匀参数采样：t = i / segments，共 segments+1 个点（含 P0/P3）
  const samples: SamplePoint[] = []
  for (let i = 0; i <= segments; i++) {
    const t = i / segments
    const pos = bezierPoint(p0, p1, p2, p3, t)
    const dir = normalizeOrZero(bezierDerivative(p0, p1, p2, p3, t))
    samples.push({ x: pos.x, y: pos.y, tx: dir.x, ty: dir.y })
  }

  // 3. 切线回退：把零导数产生的 (0,0) 切线用相邻非零切线填补
  //    左→右传递：中间零切线继承左侧最近非零切线；
  //    右→左传递：补齐首端（含 t=0 端点退化）的零切线。
  //    两遍后仍为零（全曲线导数恒零的极端退化）→ 兜底为弦向单位向量。
  for (let i = 1; i < samples.length; i++) {
    if (Math.hypot(samples[i].tx, samples[i].ty) < EPSILON) {
      samples[i].tx = samples[i - 1].tx
      samples[i].ty = samples[i - 1].ty
    }
  }
  for (let i = samples.length - 2; i >= 0; i--) {
    if (Math.hypot(samples[i].tx, samples[i].ty) < EPSILON) {
      samples[i].tx = samples[i + 1].tx
      samples[i].ty = samples[i + 1].ty
    }
  }
  // 全零兜底：用 P0→P3 弦向单位向量；弦向也退化（端点重合）时退到 (1,0)
  const hasZeroTangent = samples.some(
    (s) => Math.hypot(s.tx, s.ty) < EPSILON,
  )
  if (hasZeroTangent) {
    const chordDir = normalizeOrZero({ x: p3.x - p0.x, y: p3.y - p0.y })
    const fallback =
      chordDir.x === 0 && chordDir.y === 0 ? { x: 1, y: 0 } : chordDir
    for (const s of samples) {
      if (Math.hypot(s.tx, s.ty) < EPSILON) {
        s.tx = fallback.x
        s.ty = fallback.y
      }
    }
  }

  return samples
}
