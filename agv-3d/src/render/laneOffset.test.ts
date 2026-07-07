// ============================================================================
// laneOffset 单元测试（对应 docs/PLAN_agv-map-phase1.md §6.1 与 TASK_005 实现要点 4）
// ----------------------------------------------------------------------------
// 覆盖：
// 1. 配对索引：互为反向的两条边共享同一无向键；不相关边落不同键；
// 2. getPairKind：互反两条均 paired（即使 isBackEdge=false）；同向重复 /
//    三条以上 / 单条均 orphan；
// 3. offsetSign：paired→1、orphan→0，且与 isBackEdge 无关；
// 4. normalOf：(tz,-tx) 法线，切线 (1,0)→(0,-1)、(-1,0)→(0,1)，模长 1，
//    反向切线产生反向法线 → paired 双向边自然分居中心线两侧；
// 5. applyLaneOffset：sign=0 返回原位置；sign=1 沿右侧法线偏移 laneOffset/2，
//    双向 paired 车道关于中心线对称、间距恰为 laneOffset。
// ============================================================================

import { describe, expect, it } from 'vitest'
import type { Edge } from '../data/types.ts'
import {
  applyLaneOffset,
  buildPairIndex,
  getPairKind,
  normalOf,
  offsetSign,
} from './laneOffset.ts'

// ----------------------------------------------------------------------------
// 工具：构造最小合法 Edge，便于配对 / 偏移用例只写关心的节点 id 与反向标志
// 坐标字段填占位值：配对判定不依赖坐标，偏移由调用方在测试中显式传入。
// ----------------------------------------------------------------------------
function makeEdge(
  id: string,
  snodeId: string,
  enodeId: string,
  isBackEdge = false,
): Edge {
  return {
    id,
    name: id,
    mapId: 'test-map',
    edgeType: 'LINE',
    sx: 0,
    sy: 0,
    ex: 1,
    ey: 0,
    cx: null,
    cy: null,
    dx: null,
    dy: null,
    isBackEdge,
    snodeId,
    enodeId,
  }
}

// ----------------------------------------------------------------------------
// buildPairIndex：互反两条边共享同一无向键
// ----------------------------------------------------------------------------
describe('buildPairIndex · 配对索引', () => {
  it('互为反向的两条边落入同一 key（min-max 字典序归一化）', () => {
    const a = makeEdge('a', 'u', 'v')
    const b = makeEdge('b', 'v', 'u')
    const index = buildPairIndex([a, b])
    expect(index.size).toBe(1)
    // 字典序归一化：'u' < 'v' → key 为 'u-v'
    const key = [...index.keys()][0]
    expect(key).toBe('u-v')
    expect(index.get(key)).toHaveLength(2)
  })

  it('不相关的边落入不同 key', () => {
    const a = makeEdge('a', 'u', 'v')
    const c = makeEdge('c', 'p', 'q')
    const index = buildPairIndex([a, c])
    expect(index.size).toBe(2)
  })
})

// ----------------------------------------------------------------------------
// getPairKind + offsetSign：互反 paired / 同向重复 / 三条以上 / 单条 orphan
// ----------------------------------------------------------------------------
describe('getPairKind · 配对判定', () => {
  it('互反两条边均为 paired，且即使 isBackEdge=false 也都 sign=1', () => {
    const a = makeEdge('a', 'u', 'v')
    const b = makeEdge('b', 'v', 'u')
    const index = buildPairIndex([a, b])
    expect(getPairKind(a, index)).toBe('paired')
    expect(getPairKind(b, index)).toBe('paired')
    // 关键：isBackEdge=false 的两条 paired 边也都使用 sign=1
    expect(offsetSign(getPairKind(a, index))).toBe(1)
    expect(offsetSign(getPairKind(b, index))).toBe(1)
  })

  it('两条同向重复边均视为 orphan（非 paired），sign=0', () => {
    const a = makeEdge('a', 'u', 'v')
    const c = makeEdge('c', 'u', 'v')
    const index = buildPairIndex([a, c])
    expect(getPairKind(a, index)).toBe('orphan')
    expect(getPairKind(c, index)).toBe('orphan')
    expect(offsetSign(getPairKind(a, index))).toBe(0)
  })

  it('三条边（含反向）超过 2 条，全部 orphan', () => {
    const a = makeEdge('a', 'u', 'v')
    const b = makeEdge('b', 'v', 'u')
    const c = makeEdge('c', 'u', 'v')
    const index = buildPairIndex([a, b, c])
    expect(getPairKind(a, index)).toBe('orphan')
    expect(getPairKind(b, index)).toBe('orphan')
    expect(getPairKind(c, index)).toBe('orphan')
  })

  it('单条孤儿边（无反向配对）为 orphan，sign=0', () => {
    const a = makeEdge('a', 'u', 'v')
    const index = buildPairIndex([a])
    expect(getPairKind(a, index)).toBe('orphan')
    expect(offsetSign(getPairKind(a, index))).toBe(0)
  })

  it('配对判定只依赖节点 id，与 isBackEdge 颜色无关', () => {
    // 一条正向（isBackEdge=false）+ 一条反向（isBackEdge=true），仅靠节点 id 配对
    const a = makeEdge('a', 'u', 'v', false)
    const b = makeEdge('b', 'v', 'u', true)
    const index = buildPairIndex([a, b])
    expect(getPairKind(a, index)).toBe('paired')
    expect(getPairKind(b, index)).toBe('paired')
  })
})

// ----------------------------------------------------------------------------
// normalOf：顺时针 90° 法线 (tz,-tx)，模长 1，反向切线→反向法线
// ----------------------------------------------------------------------------
describe('normalOf · 顺时针法线', () => {
  it('切线 (1,0) → 法线 (0,-1)，模长 1', () => {
    const n = normalOf(1, 0)
    expect(n.nx).toBeCloseTo(0, 10)
    expect(n.nz).toBeCloseTo(-1, 10)
    expect(Math.hypot(n.nx, n.nz)).toBeCloseTo(1, 10)
  })

  it('反向切线 (-1,0) → 法线 (0,1)，与正向法线相反（自然分离）', () => {
    const pos = normalOf(1, 0)
    const neg = normalOf(-1, 0)
    expect(neg.nx).toBeCloseTo(0, 10)
    expect(neg.nz).toBeCloseTo(1, 10)
    // 正反法线互为相反 → paired 双向边自动分居中心线两侧
    expect(neg.nx).toBeCloseTo(-pos.nx, 10)
    expect(neg.nz).toBeCloseTo(-pos.nz, 10)
  })

  it('任意单位切线的法线模长恒为 1', () => {
    const dirs = [
      [1, 0],
      [0, 1],
      [-1, 0],
      [0, -1],
      [Math.SQRT1_2, Math.SQRT1_2],
    ]
    for (const [tx, tz] of dirs) {
      const n = normalOf(tx, tz)
      expect(Math.hypot(n.nx, n.nz)).toBeCloseTo(1, 10)
    }
  })
})

// ----------------------------------------------------------------------------
// applyLaneOffset：sign=0 原位置；sign=1 沿右侧法线偏移 laneOffset/2
// ----------------------------------------------------------------------------
describe('applyLaneOffset · 偏移应用', () => {
  it('sign=0 返回原位置（孤儿边画在中心线），且不修改入参', () => {
    const p = { x: 5, z: -3 }
    const out = applyLaneOffset(p, 1, 0, 0, 0.15)
    expect(out.x).toBe(5)
    expect(out.z).toBe(-3)
    // 纯函数：不修改入参 point
    expect(p.x).toBe(5)
    expect(p.z).toBe(-3)
  })

  it('sign=1 沿行驶方向右侧法线偏移 laneOffset/2', () => {
    // 切线 (1,0) → 法线 (0,-1)；laneOffset=2 → 偏移 1 → 落到 (0,-1)
    const out = applyLaneOffset({ x: 0, z: 0 }, 1, 0, 1, 2)
    expect(out.x).toBeCloseTo(0, 10)
    expect(out.z).toBeCloseTo(-1, 10)
  })

  it('paired 双向边自然分离：正向落 -d 侧，反向落 +d 侧，间距 = laneOffset', () => {
    // 共用 laneOffset=2（各偏 1）；正向切线 (1,0)→(0,-1)，反向切线 (-1,0)→(0,1)
    const fwd = applyLaneOffset({ x: 0, z: 0 }, 1, 0, 1, 2)
    const bwd = applyLaneOffset({ x: 0, z: 0 }, -1, 0, 1, 2)
    expect(fwd.z).toBeCloseTo(-1, 10)
    expect(bwd.z).toBeCloseTo(1, 10)
    // 两条偏移车道关于中心线（z=0）对称，间距恰为 laneOffset=2
    expect(bwd.z - fwd.z).toBeCloseTo(2, 10)
  })
})
