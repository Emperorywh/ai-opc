// ============================================================================
// 数据层类型定义：与真实后端 JSON 字段一一对齐
// ----------------------------------------------------------------------------
// 本文件只声明「纯类型」，不含任何运行时代码，因此天然满足
// `erasableSyntaxOnly`（禁用 enum / namespace）与 `verbatimModuleSyntax`
// （类型即类型，无运行时副作用）两项 tsconfig 约束。
// 所有「类型」均采用字面量联合 + interface 形式，禁止使用 enum。
// 字段命名严格遵循真实样例（见 docs/SPEC_agv-map-phase1.md §2），
// loader 解析后产出的就是这些类型，供下游几何/渲染层直接消费。
// ============================================================================

// ----------------------------------------------------------------------------
// 边类型（路径的几何形态）
// - LINE：直线段，仅由起点 (sx, sy) 与终点 (ex, ey) 决定几何
// - BEZIER：三次贝塞尔曲线，P0=(sx,sy) P1=(cx,cy) P2=(dx,dy) P3=(ex,ey)
// 采用字面量联合而非 enum，以兼容 erasableSyntaxOnly。
// ----------------------------------------------------------------------------
export type EdgeType = 'LINE' | 'BEZIER'

// ----------------------------------------------------------------------------
// 节点类型（5 种语义，按颜色区分；见 SPEC §5.2）
// - node：普通节点（默认浅灰）
// - warehouse：仓储点
// - park：停放点
// - charge：充电点
// - work：作业点
// 未知类型在 loader 中统一归一化为 'node' 并产出告警。
// ----------------------------------------------------------------------------
export type NodeType = 'node' | 'warehouse' | 'park' | 'charge' | 'work'

// ----------------------------------------------------------------------------
// Edge：路径
// 坐标均为「地图原始坐标（米）」，loader 不做任何坐标系映射，
// 映射（含 isFlipY 翻转）统一交给渲染层 src/render/coordinates.ts 处理。
// cx/cy/dx/dy 为贝塞尔两个控制点，直线边为 null。
// ----------------------------------------------------------------------------
export interface Edge {
  id: string
  name: string
  mapId: string
  edgeType: EdgeType
  // 起点（地图坐标，米）
  sx: number
  sy: number
  // 终点（地图坐标，米）
  ex: number
  ey: number
  // 贝塞尔第一控制点 P1（仅 BEZIER 有意义；LINE 恒为 null）
  cx: number | null
  cy: number | null
  // 贝塞尔第二控制点 P2（仅 BEZIER 有意义；LINE 恒为 null）
  dx: number | null
  dy: number | null
  // 反向边标志：仅用于渲染分色，不参与双车道左右偏移判定（SPEC §4.4）
  isBackEdge: boolean
  // 起止节点引用（Phase 1 仅留作语义，几何定位信任边自带坐标）
  snodeId: string
  enodeId: string
}

// ----------------------------------------------------------------------------
// Node：节点
// x/y 为地图原始坐标（米）；angle 为朝向角（弧度），
// 为 null 时不渲染朝向小三角（SPEC §5.3）。
// ----------------------------------------------------------------------------
export interface Node {
  id: string
  name: string
  mapId: string
  type: NodeType
  x: number
  y: number
  angle: number | null
}

// ----------------------------------------------------------------------------
// 告警：loader 在解析/退化过程中产出的非致命问题清单
// 渲染层可据此在 UI 上提示「地图存在 N 条退化数据」。
// 所有告警均为「已自动处理」，不会中断渲染。
// ----------------------------------------------------------------------------
export type MapWarningKind =
  // 零长度边（起点==终点），已跳过不绘制
  | 'ZERO_LENGTH'
  // 自环边（snodeId==enodeId），已跳过不绘制
  | 'SELF_LOOP'
  // BEZIER 控制点缺失，已退化为直线绘制
  | 'BEZIER_MISSING_CTRL'
  // LINE 边携带了控制点，已忽略控制点按直线绘制
  | 'LINE_IGNORE_CTRL'
  // 节点 type 不在 5 种枚举内，已归一化为 node
  | 'NODE_TYPE_UNKNOWN'
  // 地图 mapState 非 ENABLED，仍继续渲染但提示
  | 'MAP_STATE_DISABLED'
  // 顶层结构解析失败，返回空场景
  | 'PARSE_ERROR'

export interface MapWarning {
  kind: MapWarningKind
  // 关联的节点/边 id（解析可用时附带）
  id?: string
  // 人类可读补充信息
  detail?: string
}

// ----------------------------------------------------------------------------
// 二维包围盒（地图坐标，米）
// 仅用边端点与节点坐标计算，不含贝塞尔控制点（SPEC §2.2 信任端点坐标）。
// ----------------------------------------------------------------------------
export interface Box2XY {
  minX: number
  maxX: number
  minY: number
  maxY: number
}

// ----------------------------------------------------------------------------
// MapData：loader 的最终产物，是整条渲染管线的「可信数据源」
// 包含标题/标识、清洗后的节点与边、包围盒，以及退化告警列表。
// ----------------------------------------------------------------------------
export interface MapData {
  mapId: string
  mapName: string
  nodes: Node[]
  edges: Edge[]
  bbox: Box2XY
  warnings: MapWarning[]
}
