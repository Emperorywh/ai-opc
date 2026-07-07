// ============================================================================
// bezier 单元测试（对应 docs/PLAN_agv-map-phase1.md §6.1 与 TASK_004 实现要点 4）
// ----------------------------------------------------------------------------
// 覆盖：
// 1. 直线型贝塞尔：采样点共线、切线恒等于直线方向；
// 2. 数值正确性：每个采样点精确落在三次贝塞尔曲线上（含 t=0.5 已知点），
//    切线方向与 B'(t) 归一化一致；
// 3. 段数封顶与端点命中：段数 ≤ maxSegments，首尾点严格命中 P0/P3；
// 4. 切线模长 ≈ 1；
// 5. 大曲率样本段数严格多于平直样本；
// 6. 退化：极短曲线（P0≈P3）不抛异常且 ≥2 点；maxSegments=1 恰好 2 点；
//    端点零导数切线向相邻段回退。
// ============================================================================

import { describe, expect, it } from 'vitest'
import { sampleCubicBezier, type Vec2 } from './bezier.ts'

// ----------------------------------------------------------------------------
// 测试内独立实现的三次贝塞尔位置 / 导数，用于交叉校验实现，
// 不复用被测代码内部函数，避免「用实现验证实现」。
// ----------------------------------------------------------------------------
function bezierAt(p0: Vec2, p1: Vec2, p2: Vec2, p3: Vec2, t: number): Vec2 {
  // 直接展开 Bernstein 基函数，写法与实现相互独立
  const mt = 1 - t
  const x =
    mt * mt * mt * p0.x +
    3 * mt * mt * t * p1.x +
    3 * mt * t * t * p2.x +
    t * t * t * p3.x
  const y =
    mt * mt * mt * p0.y +
    3 * mt * mt * t * p1.y +
    3 * mt * t * t * p2.y +
    t * t * t * p3.y
  return { x, y }
}

function bezierPrimeAt(p0: Vec2, p1: Vec2, p2: Vec2, p3: Vec2, t: number): Vec2 {
  // 导数 B'(t) = 3[(1-t)²(P1-P0) + 2(1-t)t(P2-P1) + t²(P3-P2)]
  const mt = 1 - t
  const x =
    3 *
    (mt * mt * (p1.x - p0.x) +
      2 * mt * t * (p2.x - p1.x) +
      t * t * (p3.x - p2.x))
  const y =
    3 *
    (mt * mt * (p1.y - p0.y) +
      2 * mt * t * (p2.y - p1.y) +
      t * t * (p3.y - p2.y))
  return { x, y }
}

// 工具：单位化（零向量返回 (0,0)，供上层判定跳过）
function normalize(v: Vec2): Vec2 {
  const len = Math.hypot(v.x, v.y)
  return len === 0 ? { x: 0, y: 0 } : { x: v.x / len, y: v.y / len }
}

// ----------------------------------------------------------------------------
// 直线型贝塞尔：控制点全部落在 P0–P3 直线上 → 曲线退化为直线段
// ----------------------------------------------------------------------------
describe('sampleCubicBezier · 直线型贝塞尔', () => {
  const p0 = { x: 0, y: 0 }
  const p1 = { x: 1, y: 0 }
  const p2 = { x: 2, y: 0 }
  const p3 = { x: 3, y: 0 }

  it('采样点全部共线（y 恒为 0）', () => {
    const samples = sampleCubicBezier(p0, p1, p2, p3, 64)
    expect(samples.length).toBeGreaterThanOrEqual(2)
    for (const s of samples) {
      expect(s.y).toBeCloseTo(0, 10)
    }
  })

  it('切线恒等于直线方向 (1,0)', () => {
    const samples = sampleCubicBezier(p0, p1, p2, p3, 64)
    for (const s of samples) {
      expect(s.tx).toBeCloseTo(1, 10)
      expect(s.ty).toBeCloseTo(0, 10)
    }
  })
})

// ----------------------------------------------------------------------------
// 数值正确性：对称拱形 P0=(0,0) P1=(0,1) P2=(1,1) P3=(1,0)
// 手算 B(0.5) = 0.125·P0 + 0.375·P1 + 0.375·P2 + 0.125·P3 = (0.5, 0.75)
// ----------------------------------------------------------------------------
describe('sampleCubicBezier · 数值正确性', () => {
  const p0 = { x: 0, y: 0 }
  const p1 = { x: 0, y: 1 }
  const p2 = { x: 1, y: 1 }
  const p3 = { x: 1, y: 0 }

  it('每个采样点精确落在 B(t_i) 上（均匀参数 t=i/seg）', () => {
    const samples = sampleCubicBezier(p0, p1, p2, p3, 64)
    const seg = samples.length - 1
    expect(seg).toBeGreaterThanOrEqual(1)
    for (let i = 0; i < samples.length; i++) {
      const t = i / seg
      const expected = bezierAt(p0, p1, p2, p3, t)
      expect(samples[i].x).toBeCloseTo(expected.x, 9)
      expect(samples[i].y).toBeCloseTo(expected.y, 9)
    }
  })

  it('t=0.5 已知点 B(0.5) = (0.5, 0.75) 命中', () => {
    const samples = sampleCubicBezier(p0, p1, p2, p3, 64)
    const seg = samples.length - 1
    // 均匀采样下最接近 t=0.5 的索引
    const mid = Math.round(0.5 * seg)
    const tMid = mid / seg
    const expectedMid = bezierAt(p0, p1, p2, p3, tMid)
    expect(samples[mid].x).toBeCloseTo(expectedMid.x, 9)
    expect(samples[mid].y).toBeCloseTo(expectedMid.y, 9)
    // 独立手算值校验公式本身：t=0.5 应恰为 (0.5, 0.75)
    const half = bezierAt(p0, p1, p2, p3, 0.5)
    expect(half.x).toBeCloseTo(0.5, 10)
    expect(half.y).toBeCloseTo(0.75, 10)
  })

  it('切线方向与 B\'(t) 归一化一致', () => {
    const samples = sampleCubicBezier(p0, p1, p2, p3, 64)
    const seg = samples.length - 1
    for (let i = 0; i < samples.length; i++) {
      const t = i / seg
      const d = normalize(bezierPrimeAt(p0, p1, p2, p3, t))
      // 非退化点切线应与公式一致；退化回退由专门用例覆盖
      if (d.x !== 0 || d.y !== 0) {
        expect(samples[i].tx).toBeCloseTo(d.x, 9)
        expect(samples[i].ty).toBeCloseTo(d.y, 9)
      }
    }
  })
})

// ----------------------------------------------------------------------------
// 段数封顶与端点命中
// ----------------------------------------------------------------------------
describe('sampleCubicBezier · 段数封顶与端点命中', () => {
  const p0 = { x: 0, y: 0 }
  const p1 = { x: 0, y: 1 }
  const p2 = { x: 1, y: 1 }
  const p3 = { x: 1, y: 0 }

  it('段数 ≤ maxSegments（即点数 ≤ maxSegments+1）', () => {
    const samples = sampleCubicBezier(p0, p1, p2, p3, 8)
    expect(samples.length).toBeLessThanOrEqual(8 + 1)
  })

  it('封顶触发：极端弯曲曲线段数被钳到 maxSegments', () => {
    // 控制点远拉制造极端弯曲：大封顶下启发式会给很多段
    const a = { x: 0, y: 0 }
    const b = { x: 500, y: 0 }
    const c = { x: 0, y: 500 }
    const d = { x: 500, y: 500 }
    const uncapped = sampleCubicBezier(a, b, c, d, 1000)
    // 启发式确实想要超过 16 段
    expect(uncapped.length - 1).toBeGreaterThan(16)
    // 小封顶下被钳住，不超过 maxSegments+1
    const capped = sampleCubicBezier(a, b, c, d, 16)
    expect(capped.length).toBeLessThanOrEqual(16 + 1)
  })

  it('首点严格 = P0，末点严格 = P3', () => {
    const samples = sampleCubicBezier(p0, p1, p2, p3, 64)
    expect(samples[0].x).toBe(p0.x)
    expect(samples[0].y).toBe(p0.y)
    const last = samples[samples.length - 1]
    expect(last.x).toBe(p3.x)
    expect(last.y).toBe(p3.y)
  })
})

// ----------------------------------------------------------------------------
// 切线模长
// ----------------------------------------------------------------------------
describe('sampleCubicBezier · 切线模长', () => {
  it('非退化曲线上所有切线模长 ≈ 1', () => {
    const samples = sampleCubicBezier(
      { x: 0, y: 0 },
      { x: 0, y: 1 },
      { x: 1, y: 1 },
      { x: 1, y: 0 },
      64,
    )
    for (const s of samples) {
      expect(Math.hypot(s.tx, s.ty)).toBeCloseTo(1, 9)
    }
  })
})

// ----------------------------------------------------------------------------
// 自适应段数：大曲率样本段数严格多于平直样本
// ----------------------------------------------------------------------------
describe('sampleCubicBezier · 自适应段数', () => {
  it('大曲率样本段数严格多于平直样本（同端点）', () => {
    // 同 P0/P3，仅控制点不同：平直直线 vs 拱形曲线，差异完全来自曲率
    const flat = sampleCubicBezier(
      { x: 0, y: 0 },
      { x: 1, y: 0 },
      { x: 2, y: 0 },
      { x: 3, y: 0 },
      64,
    )
    const curvy = sampleCubicBezier(
      { x: 0, y: 0 },
      { x: 0, y: 2 },
      { x: 3, y: 2 },
      { x: 3, y: 0 },
      64,
    )
    expect(curvy.length).toBeGreaterThan(flat.length)
  })
})

// ----------------------------------------------------------------------------
// 退化处理：极短曲线 / maxSegments=1 / 端点零导数回退
// ----------------------------------------------------------------------------
describe('sampleCubicBezier · 退化处理', () => {
  it('极短曲线（P0≈P3）不抛异常且返回 ≥2 点，切线合法', () => {
    // 端点几乎重合（相差 ~1e-12），整体尺度极小
    const samples = sampleCubicBezier(
      { x: 0, y: 0 },
      { x: 1e-12, y: 2e-12 },
      { x: 3e-12, y: 1e-12 },
      { x: 1e-12, y: 1e-12 },
      64,
    )
    expect(samples.length).toBeGreaterThanOrEqual(2)
    // 切线仍为合法有限单位向量（无 NaN / Infinity）
    for (const s of samples) {
      expect(Number.isFinite(s.tx)).toBe(true)
      expect(Number.isFinite(s.ty)).toBe(true)
      expect(Math.hypot(s.tx, s.ty)).toBeCloseTo(1, 9)
    }
  })

  it('maxSegments=1 时返回恰好 2 点（首尾）', () => {
    const samples = sampleCubicBezier(
      { x: 0, y: 0 },
      { x: 0, y: 1 },
      { x: 1, y: 1 },
      { x: 1, y: 0 },
      1,
    )
    expect(samples).toHaveLength(2)
    expect(samples[0].x).toBe(0)
    expect(samples[0].y).toBe(0)
    expect(samples[1].x).toBe(1)
    expect(samples[1].y).toBe(0)
  })

  it('端点零导数（P0=P1）切线向相邻段回退，模长仍为 1', () => {
    // B'(0)=3(P1-P0)=0：首点切线应回退为相邻段（index1）的方向
    const p0 = { x: 0, y: 0 }
    const p1 = { x: 0, y: 0 }
    const p2 = { x: 1, y: 1 }
    const p3 = { x: 2, y: 0 }
    const samples = sampleCubicBezier(p0, p1, p2, p3, 64)
    expect(samples.length).toBeGreaterThanOrEqual(2)
    // 首点切线非零且为单位向量
    const head = samples[0]
    expect(Math.hypot(head.tx, head.ty)).toBeCloseTo(1, 9)
    // 回退来源为相邻段（index1），二者方向一致
    const next = samples[1]
    expect(head.tx).toBeCloseTo(next.tx, 9)
    expect(head.ty).toBeCloseTo(next.ty, 9)
  })
})
