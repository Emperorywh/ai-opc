import type { RawNodeType } from './rawDto'

/**
 * AGV 地图规范化领域模型。
 *
 * 该模型是原始数据校验通过后的纯净数据，不依赖 React、R3F、Three.js、
 * Worker API 或任何浏览器对象（SPEC §4.5）。所有渲染层均从该模型派生，
 * 不直接接触原始 JSON。
 */

/** 二维地图坐标，单位米，位于地图 XY 平面。 */
export interface Point2 {
  x: number
  y: number
}

/** 规范化节点。位置由原始 x/y 提取，角度沿用原始弧度约定。 */
export interface MapNode {
  id: string
  type: RawNodeType
  position: Point2
  angle: number | null
}

/**
 * 有向路径。采样方向始终从 sourceNodeId 指向 targetNodeId。
 * LINE 与 BEZIER 的差异在采样器内部消解，领域层统一表达。
 */
export type DirectedPath =
  | { kind: 'line'; start: Point2; end: Point2 }
  | {
      kind: 'cubic-bezier'
      start: Point2
      control1: Point2
      control2: Point2
      end: Point2
    }

/** 有向边。端点保留边自身坐标，不被节点坐标覆盖。 */
export interface DirectedEdge {
  id: string
  sourceNodeId: string
  targetNodeId: string
  path: DirectedPath
}

/** 规范化地图模型，包含全部节点与有向边。 */
export interface MapModel {
  nodes: readonly MapNode[]
  edges: readonly DirectedEdge[]
}
