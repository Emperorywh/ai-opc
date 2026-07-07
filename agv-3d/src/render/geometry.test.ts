// ============================================================================
// geometry 单元测试（对应 docs/PLAN_agv-map-phase1.md §6.1 与 TASK_006 实现要点 5）
// ----------------------------------------------------------------------------
// 覆盖：
// 1. positions 为成对 segment 顶点编码（每段 6 float），顶点数正确
//    （直线各 2 顶点、贝塞尔 2(N−1) 顶点）；colors 与 positions 顶点一一对应；
// 2. 双向 paired 边（即使 isBackEdge 均为 false）落在中心线两侧；孤儿不偏移
//    （具体坐标断言）；
// 3. colors 按 isBackEdge 分色；
// 4. edgeSamplePaths 长度 = 边数，含 edgeId/edgeName/isBackEdge/length；
//    贝塞尔边 sample 数 > 2；
// 5. 零长度边被跳过（不出现在 positions / edgeSamplePaths）；
// 6. isFlipY=true 时场景 z 取反，且 paired 边仍对称分布于中心线两侧
//    （验证切线经 mapVectorToScene 映射后偏移方向正确）。
// ============================================================================

import { describe, expect, it } from 'vitest'
import type { Edge } from '../data/types.ts'
import { buildEdgeGeometry } from './geometry.ts'

// ----------------------------------------------------------------------------
// 测试用最小调色板（与 config/palette 的边色一致，仅取 edgeForward / edgeBack）
// ----------------------------------------------------------------------------
const PALETTE = { edgeForward: '#00e5a8', edgeBack: '#ff6b6b' }
const OPTS = {
  isFlipY: false,
  laneOffset: 0.15,
  bezierMaxSegments: 64,
  palette: PALETTE,
}

// ----------------------------------------------------------------------------
// 工具：构造最小合法直线 Edge
// 坐标 / 节点 id / 反向标志由调用方按用例显式给出。
// ----------------------------------------------------------------------------
function makeLineEdge(
  id: string,
  snodeId: string,
  enodeId: string,
  sx: number,
  sy: number,
  ex: number,
  ey: number,
  isBackEdge = false,
): Edge {
  return {
    id,
    name: id,
    mapId: 'test-map',
    edgeType: 'LINE',
    sx,
    sy,
    ex,
    ey,
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
// 工具：构造最小合法贝塞尔 Edge（P1=(cx,cy)、P2=(dx,dy)）
// ----------------------------------------------------------------------------
function makeBezierEdge(
  id: string,
  snodeId: string,
  enodeId: string,
  sx: number,
  sy: number,
  ex: number,
  ey: number,
  cx: number,
  cy: number,
  dx: number,
  dy: number,
  isBackEdge = false,
): Edge {
  return {
    id,
    name: id,
    mapId: 'test-map',
    edgeType: 'BEZIER',
    sx,
    sy,
    ex,
    ey,
    cx,
    cy,
    dx,
    dy,
    isBackEdge,
    snodeId,
    enodeId,
  }
}

// ----------------------------------------------------------------------------
// positions 编码与顶点计数
// ----------------------------------------------------------------------------
describe('buildEdgeGeometry · 成对 segment 编码', () => {
  it('positions 为成对 segment 顶点（每段 6 float），顶点数正确', () => {
    // 2 条配对直线（u↔v）+ 1 条孤儿直线 + 1 条贝塞尔（孤儿，反向）
    const a = makeLineEdge('a', 'u', 'v', 0, 0, 10, 0, false)
    const b = makeLineEdge('b', 'v', 'u', 10, 0, 0, 0, false)
    const c = makeLineEdge('c', 'p', 'q', 0, 10, 10, 10, false)
    const d = makeBezierEdge('d', 'x', 'y', 0, 20, 10, 20, 2, 25, 8, 25, true)
    const { positions, colors, edgeSamplePaths } = buildEdgeGeometry(
      [a, b, c, d],
      OPTS,
    )

    // 成对 segment 编码：positions.length 必为 6 的倍数
    expect(positions.length % 6).toBe(0)
    // 总段数 = Σ(每边采样点数 − 1)；每段贡献 6 float
    const totalSegments = edgeSamplePaths.reduce(
      (sum, p) => sum + (p.points.length - 1),
      0,
    )
    expect(positions.length).toBe(6 * totalSegments)
    // colors 与 positions 顶点一一对应（每顶点 3 float）
    expect(colors.length).toBe(positions.length)
    // 贝塞尔边采样数 > 2（直线为 2 点）
    const bezierPath = edgeSamplePaths.find((p) => p.edgeId === 'd')
    expect(bezierPath).toBeDefined()
    expect(bezierPath!.points.length).toBeGreaterThan(2)
  })
})

// ----------------------------------------------------------------------------
// 双车道偏移：paired 落中心线两侧、孤儿不偏移
// ----------------------------------------------------------------------------
describe('buildEdgeGeometry · 双车道偏移方向', () => {
  it('双向 paired 边（即使 isBackEdge=false）落在中心线两侧；孤儿不偏移', () => {
    const a = makeLineEdge('a', 'u', 'v', 0, 0, 10, 0, false) // u→v: (0,0)→(10,0)
    const b = makeLineEdge('b', 'v', 'u', 10, 0, 0, 0, false) // v→u: (10,0)→(0,0)
    const c = makeLineEdge('c', 'p', 'q', 0, 10, 10, 10, false) // 孤儿: (0,10)→(10,10)
    const { positions } = buildEdgeGeometry([a, b, c], OPTS)

    // a（u→v）切线 (1,0) → 法线 (0,-1)，paired 偏移 z = -laneOffset/2 = -0.075
    expect(positions[2]).toBeCloseTo(-0.075, 6) // a 首顶点 z
    // b（v→u）切线 (-1,0) → 法线 (0,1)，paired 偏移 z = +0.075
    expect(positions[8]).toBeCloseTo(0.075, 6) // b 首顶点 z
    // 两条 paired 关于中心线 z=0 对称
    expect(positions[2] + positions[8]).toBeCloseTo(0, 6)
    // 孤儿 c 不偏移：z 恰为地图 y=10（无 laneOffset 位移）
    expect(positions[14]).toBeCloseTo(10, 6) // c 首顶点 z
  })
})

// ----------------------------------------------------------------------------
// 颜色：按 isBackEdge 分色，与 positions 顶点一一对应
// ----------------------------------------------------------------------------
describe('buildEdgeGeometry · 颜色分色', () => {
  it('colors 按 isBackEdge 分色（forward/back 各自 rgb）', () => {
    const a = makeLineEdge('a', 'u', 'v', 0, 0, 10, 0, false) // forward
    const b = makeLineEdge('b', 'v', 'u', 10, 0, 0, 0, false) // forward
    const c = makeLineEdge('c', 'p', 'q', 0, 10, 10, 10, false) // forward
    const d = makeBezierEdge('d', 'x', 'y', 0, 20, 10, 20, 2, 25, 8, 25, true) // back
    const { colors } = buildEdgeGeometry([a, b, c, d], OPTS)

    // a 为 forward（#00e5a8 → r=0x00=0, g=0xe5=229），首顶点在 colors[0..2]
    expect(colors[0]).toBeCloseTo(0, 6)
    expect(colors[1]).toBeCloseTo(229 / 255, 6)
    // d 为 back（#ff6b6b → r=0xff=255, g=0x6b=107），
    // d 是第 4 条边，前面 a/b/c 各 1 段 = 2 顶点，d 首顶点 = 第 6 个顶点 → colors[18..20]
    expect(colors[18]).toBeCloseTo(1, 6)
    expect(colors[19]).toBeCloseTo(107 / 255, 6)
  })
})

// ----------------------------------------------------------------------------
// edgeSamplePaths 元数据
// ----------------------------------------------------------------------------
describe('buildEdgeGeometry · edgeSamplePaths', () => {
  it('长度 = 边数，含 edgeId/edgeName/isBackEdge/length', () => {
    const a = makeLineEdge('a', 'u', 'v', 0, 0, 10, 0, false)
    const b = makeLineEdge('b', 'v', 'u', 10, 0, 0, 0, false)
    const c = makeLineEdge('c', 'p', 'q', 0, 10, 10, 10, true)
    const { edgeSamplePaths } = buildEdgeGeometry([a, b, c], OPTS)

    // 无退化边被跳过，路径数 = 边数
    expect(edgeSamplePaths).toHaveLength(3)
    for (const p of edgeSamplePaths) {
      expect(typeof p.edgeId).toBe('string')
      expect(typeof p.edgeName).toBe('string')
      expect(typeof p.isBackEdge).toBe('boolean')
      expect(typeof p.length).toBe('number')
    }
    // 直线 paired 边弧长 = 10（偏移不改变直线长度）
    const pathA = edgeSamplePaths.find((p) => p.edgeId === 'a')
    expect(pathA!.length).toBeCloseTo(10, 6)
    // 直线边采样点恰为 2 个（首末），y 固定为 yEdge(0)
    expect(pathA!.points).toHaveLength(2)
    expect(pathA!.points[0].y).toBe(0)
  })
})

// ----------------------------------------------------------------------------
// 退化：零长度边被跳过
// ----------------------------------------------------------------------------
describe('buildEdgeGeometry · 退化跳过', () => {
  it('零长度边被跳过（不出现在 positions / edgeSamplePaths）', () => {
    const good = makeLineEdge('g', 'u', 'v', 0, 0, 5, 0)
    const zero = makeLineEdge('z', 'p', 'q', 3, 3, 3, 3) // 零长度
    const { positions, edgeSamplePaths } = buildEdgeGeometry([good, zero], OPTS)

    // 仅 good 贡献 1 段 = 6 float；零长度边完全不参与
    expect(positions.length).toBe(6)
    expect(edgeSamplePaths).toHaveLength(1)
    expect(edgeSamplePaths[0].edgeId).toBe('g')
  })

  it('自环边（snodeId==enodeId）被跳过', () => {
    const good = makeLineEdge('g', 'u', 'v', 0, 0, 5, 0)
    const loop = makeLineEdge('l', 'k', 'k', 0, 0, 5, 0) // 自环
    const { positions, edgeSamplePaths } = buildEdgeGeometry([good, loop], OPTS)

    expect(positions.length).toBe(6)
    expect(edgeSamplePaths).toHaveLength(1)
    expect(edgeSamplePaths[0].edgeId).toBe('g')
  })
})

// ----------------------------------------------------------------------------
// isFlipY：场景 z 取反，paired 仍对称
// ----------------------------------------------------------------------------
describe('buildEdgeGeometry · isFlipY', () => {
  it('isFlipY=true 时场景 z 取反，且 paired 边仍对称分布于中心线两侧', () => {
    // 竖向 paired 边：切线含 y 分量，验证 mapVectorToScene 翻转后偏移方向仍正确
    const a = makeLineEdge('a', 'u', 'v', 0, 0, 0, 10, false) // u→v: (0,0)→(0,10)
    const b = makeLineEdge('b', 'v', 'u', 0, 10, 0, 0, false) // v→u: (0,10)→(0,0)

    const noFlip = buildEdgeGeometry([a, b], OPTS)
    const flip = buildEdgeGeometry([a, b], { ...OPTS, isFlipY: true })

    // z 取反：a 末端 z 不翻转 = 10、翻转 = -10
    expect(noFlip.positions[5]).toBeCloseTo(10, 6)
    expect(flip.positions[5]).toBeCloseTo(-10, 6)
    // 偏移方向随切线翻转而反转：
    //   不翻转：a 切线 (0,1) → 场景 (0,1) → 法线 (1,0)，x = +0.075
    //   翻转  ：a 切线 (0,1) → 场景 (0,-1) → 法线 (-1,0)，x = -0.075
    expect(noFlip.positions[0]).toBeCloseTo(0.075, 6)
    expect(flip.positions[0]).toBeCloseTo(-0.075, 6)
    // paired 仍对称：a 与 b 首顶点 x 互为相反数（中点落在中心线 x=0）
    expect(noFlip.positions[0] + noFlip.positions[6]).toBeCloseTo(0, 6)
    expect(flip.positions[0] + flip.positions[6]).toBeCloseTo(0, 6)
  })
})
