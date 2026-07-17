/*
 * 不可变场景领域模型（domain 层，SPEC 5.2 / 6.1 / 6.2）。
 *
 * 信任边界定位（TASK-005）：
 *   - 本文件定义坐标转换完成后的不可变领域数据：ScenePoint / SceneNode / SceneEdge /
 *     SceneMap，以及显式场景变换 MapTransform 与 source bounds SourceBounds2D。
 *   - 这些类型只表达场景平面坐标 x/z；原始地图 y 已经在适配层一次性映射为场景 z，
 *     不会再穿透到几何、标签、应用或 R3F 层（SPEC 6.2 单次转换不变量）。
 *   - 本层不持有可变运行状态，也不依赖 Three / R3F / React / 浏览器 API。
 *
 * 轴映射不变量（SPEC 6.1，唯一坐标规则）：
 *   - absoluteWorld = (mapX, 0, -mapY)
 *   - 场景原点取已验证 source bounds 的中心，所有几何统一减去该原点：
 *       sceneX = mapX - absoluteWorldOriginX
 *       sceneZ = -mapY - absoluteWorldOriginZ
 *   - 一米对应一个 Three.js 世界单位；重心平移只改变原点，不改变尺度与距离。
 *
 * origin 所有权不变量（SPEC 6.2）：
 *   - absoluteWorldOriginX / Z 是场景原点在 Three 绝对世界系下的坐标，由已验证
 *     source bounds 的中心计算并以显式 MapTransform 传递；
 *     禁止把 81.82 / 12.54 或任何样本中心散落为魔法数。
 *   - MapTransform 与 SourceBounds2D 是只读诊断与可逆定位信息，不形成第二套坐标来源。
 *
 * 精度不变量（SPEC 2.3 / 6.2）：
 *   - 全部坐标在 JavaScript number 精度下表达；只有后续 GPU typed array 写入阶段
 *     才允许转 Float32。本层不持有任何 Float32Array。
 *
 * 依赖方向（SPEC 3.3）：
 *   - 仅依赖本层（mapPrimitives 的 NodeType），是依赖图的根。
 */
import type { NodeType } from './mapPrimitives'

/*
 * 场景平面点（SPEC 5.2 ScenePoint）。
 * - 只表达 x/z：原始地图 y 已一次性映射为 z，后续模块不得再把 z 当成地图 y，
 *   也不得再次取负、交换轴或平移。
 * - 高度 worldY 由各渲染层单独决定（Ground Y / Ribbon Y / Node Y 等），不混入本二维领域坐标。
 */
export interface ScenePoint {
  readonly x: number
  readonly z: number
}

/*
 * 不可变场景节点（SPEC 5.2 SceneNode）。
 * - position 已完成坐标转换，以场景重心为原点，一米一世界单位。
 * - angle 保留原始弧度语义：普通节点为 null（不得替换为零），其余三类为有限弧度。
 */
export interface SceneNode {
  readonly id: string
  readonly name: string
  readonly type: NodeType
  readonly position: ScenePoint
  readonly angle: number | null
}

/*
 * 直线边（SPEC 5.2 SceneLineEdge）。
 * - start / end 由边自身 sx/sy/ex/ey 一次性转换得到；snodeId/enodeId 只表示拓扑关系，
 *   绝不以引用节点坐标覆盖边端点（SPEC 2.3 / 6.1 边坐标所有权）。
 */
export interface SceneLineEdge {
  readonly kind: 'line'
  readonly id: string
  readonly name: string
  readonly startNodeId: string
  readonly endNodeId: string
  readonly start: ScenePoint
  readonly end: ScenePoint
  readonly isBackEdge: boolean
}

/*
 * 三次贝塞尔边（SPEC 5.2 SceneBezierEdge）。
 * - start / control1 / control2 / end 由边自身 S/C1/C2/E 四点一次性转换得到，
 *   每个控制点都走同一个 toScenePoint，不存在第二次转换机会。
 */
export interface SceneBezierEdge {
  readonly kind: 'cubic'
  readonly id: string
  readonly name: string
  readonly startNodeId: string
  readonly endNodeId: string
  readonly start: ScenePoint
  readonly control1: ScenePoint
  readonly control2: ScenePoint
  readonly end: ScenePoint
  readonly isBackEdge: boolean
}

/*
 * 边的判别联合（SPEC 5.2 SceneEdge）。
 * 由 kind 区分直线与三次贝塞尔；上游 edgeType 字面量 LINE/BEZIER 映射到本联合。
 */
export type SceneEdge = SceneLineEdge | SceneBezierEdge

/*
 * 显式场景变换（SPEC 5.2 SceneModel.transform / 6.2 MapTransform）。
 *
 * 字段语义：
 *   - absoluteWorldOriginX：场景原点在 Three 绝对世界系下的 X 坐标，
 *     等于 source bounds 中心 mapX：`(mapMinX + mapMaxX) / 2`。
 *   - absoluteWorldOriginZ：场景原点在 Three 绝对世界系下的 Z 坐标，
 *     等于 source bounds 中心 mapY 取负：`-(mapMinY + mapMaxY) / 2`
 *     （因为 absoluteWorld.z = -mapY）。
 *
 * 真实样本固定值：absoluteWorldOriginX ≈ -81.82、absoluteWorldOriginZ ≈ -12.54，
 *   但该值由 bounds 派生，不在代码中散落为魔法数。
 */
export interface MapTransform {
  readonly absoluteWorldOriginX: number
  readonly absoluteWorldOriginZ: number
}

/*
 * 二维 source bounds（地图坐标系，SPEC 2.3 / 6.1）。
 *
 * 由全部节点坐标、边端点与贝塞尔控制点扫描得到；真实样本中与节点 bounds 相同
 * （边端点 / 控制点未越界）。保留在 SceneMap 中仅供诊断与可逆定位，
 * 不参与后续场景坐标推导，也不被几何 / 标签 / 渲染层消费。
 */
export interface SourceBounds2D {
  readonly minX: number
  readonly maxX: number
  readonly minY: number
  readonly maxY: number
}

/*
 * 三维数值 bounds（场景坐标系，SPEC 5.2 NumericBox3）。
 *
 * 信任边界定位（TASK-007）：
 *   - 这是各几何子系统（ribbon、节点、箭头）输出数值 bounds 的统一载体，
 *     也是后续 SceneModel.contentBounds 的元素类型。
 *   - 本类型只描述一个轴对齐包围盒的六个数值边界，不携带任何渲染语义；
 *     合并 / fit / 裁剪面推导由上层按需在此类型上实现。
 *
 * 有限数不变量（SPEC 16）：
 *   - 任一分量非有限即视为构建失败；构造方必须保证六个值均为有限数。
 *   - min ≤ max 由调用方在合并时维护，本类型不内嵌断言以保持为纯数据。
 */
export interface NumericBox3 {
  readonly minX: number
  readonly minY: number
  readonly minZ: number
  readonly maxX: number
  readonly maxY: number
  readonly maxZ: number
}

/*
 * 场景地图元数据（SPEC 2.1 / 5.2）。
 * 来自受校验 RawMapMetadata，只保留渲染管线与诊断实际消费的字段；
 * envelopeMapId 仅用于 TASK-004 的全链路一致性校验，通过后不再下沉到本层。
 */
export interface SceneMapMetadata {
  readonly mapId: string
  readonly mapName: string
  readonly version: string
}

/*
 * 不可变场景地图（SPEC 5.2 SceneMap）。
 *
 * 这是适配层一次性坐标转换后交付的不可变领域数据：
 *   - metadata / transform / sourceBounds 为只读诊断与可逆定位信息，不形成第二套坐标来源。
 *   - nodes / edges 的全部平面坐标已统一到场景坐标系（x/z），后续模块只消费 ScenePoint，
 *     不存在第二次坐标转换机会。
 *   - 后续 buildSceneModel（worker）在此之上生成 typed array 几何；本结构仍是 number 精度。
 */
export interface SceneMap {
  readonly metadata: SceneMapMetadata
  readonly transform: MapTransform
  readonly sourceBounds: SourceBounds2D
  readonly nodes: readonly SceneNode[]
  readonly edges: readonly SceneEdge[]
}
