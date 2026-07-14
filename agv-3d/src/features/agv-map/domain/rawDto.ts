/**
 * AGV 地图原始数据传输对象（DTO）类型。
 *
 * 这些类型只描述 map.json 中 `data.currentMapInfoVersion.mapJson` 的期望字段形状，
 * 不代表运行时数据一定合法。运行时合法性由 `validation` 模块的严格校验保证，
 * 校验通过后再由 `normalize` 模块在边界处转换为领域模型。
 *
 * 依据 SPEC §4.3，原始记录中除下述字段外的其他字段（name、mapId、cost、
 * actions、userDefinedProperties 等）都不属于渲染契约，在规范化时被显式丢弃。
 */

/** 节点类型封闭联合，渲染层依据该值选择几何与配色。 */
export type RawNodeType = 'node' | 'work' | 'charge' | 'park'

/** 边类型封闭联合，决定路径采样方式。 */
export type RawEdgeType = 'LINE' | 'BEZIER'

/** 原始节点记录。 */
export interface RawMapNode {
  id: string
  type: RawNodeType
  x: number
  y: number
  /**
   * 普通节点（type === 'node'）必须为 null；其他三类必须为有限弧度。
   * 该约束由校验层强制。
   */
  angle: number | null
}

/** 原始有向边记录。端点坐标是渲染权威数据，不吸附到节点坐标。 */
export interface RawMapEdge {
  id: string
  edgeType: RawEdgeType
  sx: number
  sy: number
  ex: number
  ey: number
  /** 三次贝塞尔第一控制点；直线为 null。 */
  cx: number | null
  cy: number | null
  /** 三次贝塞尔第二控制点；直线为 null。 */
  dx: number | null
  dy: number | null
  snodeId: string
  enodeId: string
  /**
   * 仅供原始 DTO 审计信息保留，与真实反向几何并不完全一致，
   * 因此不进入校验结论与车道布局决策（SPEC §4.2、§4.4）。
   */
  isBackEdge: boolean
}

/** mapJson 载荷结构。 */
export interface RawMapPayload {
  nodes: RawMapNode[]
  edges: RawMapEdge[]
  /** 当前数据契约要求为空数组。 */
  zones: unknown[]
  /** 当前数据契约要求为空数组。 */
  nodeEdgeGroups: unknown[]
}

/** map.json 顶层结构，载荷位于 `data.currentMapInfoVersion.mapJson`。 */
export interface RawMapAsset {
  data: {
    currentMapInfoVersion: {
      mapJson: RawMapPayload
    }
  }
}
