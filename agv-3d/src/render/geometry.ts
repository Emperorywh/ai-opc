// ============================================================================
// 统一边折线 buffer 构建：合并直线 + 贝塞尔为单一 LineSegments2 几何
// （SPEC §4.6，TASK_006）
// ----------------------------------------------------------------------------
// 设计要点：
// 1. 纯函数，不依赖 React / three，仅产出裸数值数组（positions / colors），
//    供 EdgesLayer 的 LineSegmentsGeometry.setPositions / setColors 直接消费；
//    edgeSamplePaths 供 ArrowsLayer（TASK_009）/ LabelsLayer（TASK_012）复用，
//    避免重复 tessellate。全部图边合并为 1 次 draw call（SPEC §4.6）。
// 2. 遍历全部边，直线（2 点）与贝塞尔（tessellate 多点）统一合并进单个折线
//    点序列，每段叠加双车道法线偏移（laneOffset.ts）。
// 3. 采用 LineSegments2 成对 segment 编码（每段 2 顶点 = 6 float），
//    天然表达「单 draw call 内多条断开折线」，不使用 NaN 分隔。
// 4. 坐标映射统一调用 render/coordinates.ts：
//    位置点经 mapPointToScene（地图 (x,y) → 场景 (x,z)，高度 y=yEdge）；
//    切线向量经 mapVectorToScene（受 isFlipY 影响）。
//    先映射位置与切线，再在场景 xz 平面做法线偏移（法线由场景切线算）。
//    ⚠️ 贝塞尔 sampleCubicBezier 返回的 tx/ty 是地图坐标切线，
//       必须先 mapVectorToScene 再 applyLaneOffset，
//       否则 isFlipY=true 时偏移方向反转。
// 5. isBackEdge 只决定颜色（不参与偏移方向）；偏移方向完全由配对与行驶切线决定。
// ============================================================================

import type { Edge } from '../data/types.ts'
import { constants } from '../config/constants.ts'
import { mapPointToScene, mapVectorToScene } from './coordinates.ts'
import { sampleCubicBezier } from './bezier.ts'
import {
  applyLaneOffset,
  buildPairIndex,
  getPairKind,
  offsetSign,
} from './laneOffset.ts'

// y 分层：路径贴片层高度（SPEC §3），所有边折线顶点的 y 固定为此值
const Y_EDGE = constants.yEdge

// ----------------------------------------------------------------------------
// 边渲染所需的最小调色板结构（结构化类型，便于测试解耦）
// TASK_008 传入完整 palette（含 edgeForward / edgeBack 字段即结构兼容）。
// ----------------------------------------------------------------------------
export interface EdgePalette {
  edgeForward: string
  edgeBack: string
}

// ----------------------------------------------------------------------------
// buildEdgeGeometry 入参选项
// ----------------------------------------------------------------------------
export interface BuildEdgeGeometryOptions {
  // 是否翻转 Y（作用于场景 z），统一经 coordinates.ts 应用
  isFlipY: boolean
  // 双车道法线偏移量（米）：成对边各偏 laneOffset/2
  laneOffset: number
  // 贝塞尔 tessellate 段数上限
  bezierMaxSegments: number
  // 调色板（取 edgeForward / edgeBack 按 isBackEdge 分色）
  palette: EdgePalette
}

// ----------------------------------------------------------------------------
// 边采样路径的单个点：偏移后的场景位置 + 场景坐标单位切线
// 供方向箭头（TASK_009）定位与朝向、路径标签（TASK_012）取中点复用。
// y 固定为 yEdge（路径层）；tx/tz 为场景坐标单位切线（与偏移无关，平移不变）。
// ----------------------------------------------------------------------------
export interface EdgeSamplePathPoint {
  x: number
  y: number
  z: number
  tx: number
  tz: number
}

// ----------------------------------------------------------------------------
// 边采样路径：单条边偏移后的折线元数据
// length 为偏移后折线在场景 xz 平面的弧长，供箭头数量与路径标签中点复用。
// ----------------------------------------------------------------------------
export interface EdgeSamplePath {
  edgeId: string
  edgeName: string
  isBackEdge: boolean
  points: EdgeSamplePathPoint[]
  length: number
}

// ----------------------------------------------------------------------------
// buildEdgeGeometry 产物：统一 LineSegments2 折线 buffer + 边采样路径
// positions / colors 为成对 segment 顶点（每 6 float 一段：x0,y0,z0,x1,y1,z1），
// 可直接喂 LineSegmentsGeometry.setPositions / setColors。
// ----------------------------------------------------------------------------
export interface EdgeGeometry {
  positions: number[]
  colors: number[]
  edgeSamplePaths: EdgeSamplePath[]
}

// ----------------------------------------------------------------------------
// 场景坐标下的采样点（内部中间结构）：位置 + 场景单位切线（均尚未做车道偏移）
// 坐标映射已在生成本结构时完成，下游只需叠加 laneOffset 即可。
// ----------------------------------------------------------------------------
interface SceneSample {
  x: number
  z: number
  tx: number
  tz: number
}

// ----------------------------------------------------------------------------
// 工具：解析 #RRGGBB hex 颜色为 [r,g,b] 归一化浮点（[0,1]）
// 供 LineSegmentsGeometry.setColors 直接使用（每顶点 3 float）。
// ----------------------------------------------------------------------------
function hexToRgbFloats(hex: string): [number, number, number] {
  // 去掉前缀 #，按两位一切分解析 R/G/B 通道
  const h = hex.replace('#', '')
  const r = Number.parseInt(h.slice(0, 2), 16) / 255
  const g = Number.parseInt(h.slice(2, 4), 16) / 255
  const b = Number.parseInt(h.slice(4, 6), 16) / 255
  return [r, g, b]
}

// ----------------------------------------------------------------------------
// 工具：把单条边的端点（地图坐标）采样为「场景坐标采样点」序列
// - LINE：2 端点，切线 = 端点方向归一化（两端共享同一切线）；
// - BEZIER：sampleCubicBezier 产出 N 个采样点（含地图坐标切线）。
// 位置经 mapPointToScene、切线经 mapVectorToScene 完成坐标映射
// （先映射再偏移，见文件头要点 4）。
// 返回 null 表示该边应被跳过（零长度）。
// ----------------------------------------------------------------------------
function sampleEdge(
  edge: Edge,
  isFlipY: boolean,
  bezierMaxSegments: number,
): SceneSample[] | null {
  // 零长度边（起点==终点）跳过（loader 已剔除，此处防御性，SPEC §9）
  if (edge.sx === edge.ex && edge.sy === edge.ey) {
    return null
  }

  if (edge.edgeType === 'BEZIER') {
    // loader 已保证 BEZIER 控制点非空（缺失会在 loader 降级为 LINE）；
    // 此处 ?? 兜底仅作防御，避免 null 喂入 sampleCubicBezier。
    const p1x = edge.cx ?? edge.sx
    const p1y = edge.cy ?? edge.sy
    const p2x = edge.dx ?? edge.ex
    const p2y = edge.dy ?? edge.ey
    // 三次贝塞尔 tessellate：返回地图坐标位置 + 地图坐标单位切线
    const samples = sampleCubicBezier(
      { x: edge.sx, y: edge.sy },
      { x: p1x, y: p1y },
      { x: p2x, y: p2y },
      { x: edge.ex, y: edge.ey },
      bezierMaxSegments,
    )
    // 位置 mapPointToScene、切线 mapVectorToScene（要点 4：先映射再偏移）
    return samples.map((s) => {
      const p = mapPointToScene({ x: s.x, y: s.y }, { isFlipY })
      const t = mapVectorToScene({ x: s.tx, y: s.ty }, { isFlipY })
      return { x: p.x, z: p.z, tx: t.x, tz: t.z }
    })
  }

  // 直线：2 端点 + 端点方向归一化切线（地图坐标），两端共享同一切线
  const dir = { x: edge.ex - edge.sx, y: edge.ey - edge.sy }
  const sp0 = mapPointToScene({ x: edge.sx, y: edge.sy }, { isFlipY })
  const sp1 = mapPointToScene({ x: edge.ex, y: edge.ey }, { isFlipY })
  const st = mapVectorToScene(dir, { isFlipY })
  return [
    { x: sp0.x, z: sp0.z, tx: st.x, tz: st.z },
    { x: sp1.x, z: sp1.z, tx: st.x, tz: st.z },
  ]
}

// ----------------------------------------------------------------------------
// 主入口：构建统一边折线 buffer（SPEC §4.6 构建 1–4）
// ----------------------------------------------------------------------------
export function buildEdgeGeometry(
  edges: Edge[],
  opts: BuildEdgeGeometryOptions,
): EdgeGeometry {
  const { isFlipY, laneOffset, bezierMaxSegments, palette } = opts

  // 1. 预建配对索引一次（成对双向边判定，laneOffset.ts）
  const pairIndex = buildPairIndex(edges)

  // 预解析颜色为 rgb 浮点（按 isBackEdge 二分色，SPEC §4.3）
  const colorForward = hexToRgbFloats(palette.edgeForward)
  const colorBack = hexToRgbFloats(palette.edgeBack)

  const positions: number[] = []
  const colors: number[] = []
  const edgeSamplePaths: EdgeSamplePath[] = []

  for (const edge of edges) {
    // 自环边（snodeId==enodeId）跳过（loader 已剔除，此处防御性，SPEC §9）
    if (edge.snodeId === edge.enodeId) {
      continue
    }

    // 2. 采样为场景坐标点序列（含切线）；零长度返回 null 跳过
    const sceneSamples = sampleEdge(edge, isFlipY, bezierMaxSegments)
    if (!sceneSamples || sceneSamples.length < 2) {
      continue
    }

    // 3. 配对类型 → 偏移符号：paired=1、orphan=0（isBackEdge 不参与偏移）
    const sign = offsetSign(getPairKind(edge, pairIndex))

    // 逐采样点叠加双车道法线偏移（场景 xz 平面，法线由场景切线算）
    const offsetPts = sceneSamples.map((s) =>
      applyLaneOffset({ x: s.x, z: s.z }, s.tx, s.tz, sign, laneOffset),
    )

    // 4. 成对 segment 顶点：相邻两点 → 1 段（2 顶点 = 6 float）
    //    直线 2 点 = 1 段；贝塞尔 N 点 = N−1 段。不使用 NaN 分隔。
    const [r, g, b] = edge.isBackEdge ? colorBack : colorForward
    for (let i = 0; i < offsetPts.length - 1; i++) {
      const a = offsetPts[i]
      const c = offsetPts[i + 1]
      // 位置：每段 2 顶点，每顶点 (x, yEdge, z)
      positions.push(a.x, Y_EDGE, a.z, c.x, Y_EDGE, c.z)
      // 颜色：每顶点 (r,g,b)，与 positions 顶点一一对应
      colors.push(r, g, b, r, g, b)
    }

    // 同步产出边采样路径元数据（供箭头 / 路径标签复用，避免重复 tessellate）
    // length = 偏移后折线在场景 xz 平面的弧长（相邻偏移点弦长累加）
    let length = 0
    for (let i = 0; i < offsetPts.length - 1; i++) {
      length += Math.hypot(
        offsetPts[i + 1].x - offsetPts[i].x,
        offsetPts[i + 1].z - offsetPts[i].z,
      )
    }
    edgeSamplePaths.push({
      edgeId: edge.id,
      edgeName: edge.name,
      isBackEdge: edge.isBackEdge,
      // 偏移后位置（y 固定 yEdge）+ 场景单位切线（平移不变，沿用采样切线）
      points: sceneSamples.map((s, i) => ({
        x: offsetPts[i].x,
        y: Y_EDGE,
        z: offsetPts[i].z,
        tx: s.tx,
        tz: s.tz,
      })),
      length,
    })
  }

  return { positions, colors, edgeSamplePaths }
}
