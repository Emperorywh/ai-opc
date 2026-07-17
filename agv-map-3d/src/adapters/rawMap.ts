/*
 * 受校验的原始地图数据契约（adapters 层，SPEC 5.1）。
 *
 * 信任边界定位：
 *   - 本文件定义 parseSampleEnvelope 的输出契约 RawMap。任何字段都只有经过
 *     adapters 层逐字段校验后才会出现在这里；未校验的 unknown 不会穿透。
 *   - RawMap 是“原始但已校验”的数据，仍保留地图坐标系（mapX/mapY），尚未做
 *     坐标转换与重心平移。坐标转换由后续 normalizeSceneMap（TASK-004）完成。
 *   - 本契约只保留 SPEC 明确消费的字段；actions / 速度 / 载荷 / 车辆组等业务
 *     元数据即使在样本中存在，也不会进入这里，更不会进入领域层。
 *
 * 依赖方向（SPEC 3.3）：
 *   - 依赖 domain（NodeType / EdgeType），不依赖 React / Three / 浏览器 API。
 *
 * 关键不变量（SPEC 5.1 / 6.1）：
 *   - 边自身的 sx/sy/ex/ey/cx/cy/dx/dy 是显示几何唯一事实来源；
 *     snodeId/enodeId 只表示拓扑关系，不得用节点坐标覆盖边端点。
 *   - LINE 的四个控制字段必须全部为 null；BEZIER 的四个控制字段必须全部为有限数。
 *   - 所有数值字段均为有限 JavaScript number；禁止数字字符串、NaN、Infinity。
 */
import type { NodeType } from '../domain/mapPrimitives'

/*
 * 受校验的节点 DTO（SPEC 5.1 RawNode）。
 * - type 只允许四种固定值；angle 在普通 node 上为 null，其余三类为有限弧度。
 * - 坐标保留原始地图系（x、y），尚未转换为场景坐标。
 */
export interface RawNode {
  readonly id: string
  readonly name: string
  readonly type: NodeType
  readonly mapId: string
  readonly x: number
  readonly y: number
  readonly angle: number | null
}

/*
 * 边公共字段（SPEC 5.1 RawEdgeBase）。
 * - snodeId / enodeId 仅表示拓扑关系，几何由 sx/sy/ex/ey 与控制点决定。
 * - isBackEdge 只决定颜色，不影响点序、切线或方向（SPEC 9.1）。
 */
export interface RawEdgeBase {
  readonly id: string
  readonly name: string
  readonly mapId: string
  readonly snodeId: string
  readonly enodeId: string
  readonly sx: number
  readonly sy: number
  readonly ex: number
  readonly ey: number
  readonly isBackEdge: boolean
}

/*
 * LINE 边（SPEC 5.1 RawLineEdge）。
 * 四个控制字段必须全部为 null；任一非空即判别联合失败。
 */
export interface RawLineEdge extends RawEdgeBase {
  readonly edgeType: 'LINE'
  readonly cx: null
  readonly cy: null
  readonly dx: null
  readonly dy: null
}

/*
 * BEZIER 边（SPEC 5.1 RawBezierEdge）。
 * 四个控制字段必须全部为有限数；部分为空即判别联合失败。
 */
export interface RawBezierEdge extends RawEdgeBase {
  readonly edgeType: 'BEZIER'
  readonly cx: number
  readonly cy: number
  readonly dx: number
  readonly dy: number
}

/*
 * 边的判别联合：由 edgeType 区分 LINE 与 BEZIER。
 * 解析边界先读取 edgeType，再据此严格校验四个控制字段的形态。
 */
export type RawEdge = RawLineEdge | RawBezierEdge

/*
 * 地图元数据（SPEC 2.1）。
 * 取自提取路径 direct 父对象 currentMapInfoVersion，跨实体一致性校验在后续 TASK。
 */
export interface RawMapMetadata {
  readonly mapId: string
  readonly mapName: string
  readonly version: string
}

/*
 * parseSampleEnvelope 的输出契约。
 * - nodes / edges 只保留受校验的被消费字段。
 * - zones / nodeEdgeGroups 仅校验为数组后透传为 unknown[]；其元素结构不被
 *   解析（SPEC 1.3 排除其渲染），空集合断言由后续 normalizeSceneMap 完成。
 */
export interface RawMap {
  readonly metadata: RawMapMetadata
  readonly nodes: readonly RawNode[]
  readonly edges: readonly RawEdge[]
  readonly zones: readonly unknown[]
  readonly nodeEdgeGroups: readonly unknown[]
}
