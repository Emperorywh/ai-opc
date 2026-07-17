/*
 * 轨迹模型类型与几何常量（geometry 层，SPEC 2.4 / 7.1 / 9.1 / 9.2 / 9.3 / 10.2 / 16）。
 *
 * 信任边界定位（TASK-006）：
 *   - 本文件定义“精确反向轨迹分组与双车道中心线”的输出契约与几何算法常量。
 *   - 输入是 TASK-005 交付的不可变 SceneMap（坐标已一次性转换到场景系 x/z）；
 *     输出是纯数值与不可变描述符，不创建 Three / R3F / React / 浏览器对象。
 *   - 本层的 LaneGeometry / TrackModel 是 ribbon、边箭头与边标签共同消费的“唯一车道事实来源”，
 *     后续模块不得再各自重复推导车道偏移、切线或弧长。
 *
 * isBackEdge 隔离不变量（SPEC 2.4 / 9.1 / 9.2 / 任务约束）：
 *   - isBackEdge 只决定边的颜色，绝不参与重合判断、方向推断、点序反转、箭头反转或车道分配。
 *   - 本层的类型只把 isBackEdge 作为“颜色语义”透传给下游；分组与车道偏移只依赖几何（控制点）。
 *
 * 依赖方向（SPEC 3.3）：
 *   - 仅依赖 domain（ScenePoint），是 geometry 层自身契约。
 *   - 不依赖 adapters / application / workers / rendering / scene / config，也不依赖 Three / React。
 *
 * 常量归属说明：
 *   - SPEC 7.1 常量表面向渲染层；但分层约束禁止 geometry 导入 config。
 *   - 此处定义的是几何算法自身的数学常量（贝塞尔段数、匹配容差、车道偏移、切线阈值），
 *     它们是 SPEC 9.1 / 9.2 / 9.3 / 9.4 明确给出的算法参数，不是渲染层视觉常量。
 *   - 渲染层（TASK-007 及以后）如需引用同一名义值，由 config 自行定义；
 *     两层各自常量都引用同一 SPEC 来源，不存在隐式第二套语义。
 */
import type { ScenePoint } from '../domain/sceneMap'

/*
 * SPEC 9.1：贝塞尔固定分段数。
 * 32 段产生 33 个采样点；在实现、测试与诊断中“32 段 / 33 点”必须保持一致，
 * 禁止自适应采样或按视觉效果改变段数。
 */
export const BEZIER_SEGMENTS = 32

/*
 * SPEC 9.1：贝塞尔采样点数 = 段数 + 1。
 * 单独导出便于测试与诊断交叉引用，避免“32 + 1”散落为魔法算式。
 */
export const BEZIER_POINT_COUNT = BEZIER_SEGMENTS + 1

/*
 * SPEC 9.2：精确反向轨迹匹配容差（米）。
 * - 量化候选桶与原始双精度逐项确认都使用该值作为上界。
 * - 量化 key 只能缩小候选范围；最终是否成组只由原始 number 坐标逐项最大差 ≤ 本容差决定。
 */
export const TRACK_MATCH_EPSILON = 1e-6

/*
 * SPEC 7.1 / 9.3：成对边单侧中心偏移（米）。
 * - 精确反向成对时，每条边沿自身行驶方向的左法线偏移本值。
 * - 反向边的左法线天然相反，因此两条中心线相距 2 × 本值 = 0.06m，
 *   边缘之间保留 0.01m 可见间隔（每条边宽 0.05m，半宽 0.025m）。
 * - 单边轨迹的中心偏移固定为 0。
 */
export const PAIRED_LANE_OFFSET = 0.03

/*
 * SPEC 5.3 第 10 项 / 9.3 / 9.4：切线与退化阈值（米）。
 * - 单段切线长度小于本值视为零切线，整体报错（禁止任取相邻段或零角度降级）。
 * - 曲线内部相邻归一化切线之和长度小于本值视为 U 形折返，整体报错。
 * - 与 validateMapSemantics 的 EDGE_CHORD_EPSILON 同源（SPEC 5.3 第 10 项），单独定义避免跨层导入。
 */
export const TANGENT_EPSILON = 1e-9

/*
 * 单条边的方向性车道几何描述（应用车道偏移后的最终几何）。
 *
 * 字段语义：
 *   - points：应用 laneOffset 后的方向性中心线折线。LINE 恒为 2 点，BEZIER 恒为 33 点。
 *     方向始终保持“边自身 start → end”，isBackEdge 与车道分组都不反转点序。
 *   - cumulativeArcLength：沿 points 的累计弧长，points[0] = 0，长度等于 points.length。
 *   - segmentTangents：points 每段的单位切线 (tx,tz)，长度 = points.length - 1。
 *     边箭头按累计弧长定位所在段后直接复用对应切线，无需二次推导。
 *   - totalArcLength：累计弧长末值；边箭头长度按 min(0.30, totalArcLength × 0.32) 收缩。
 *   - laneOffset：车道中心偏移。单边为 0，精确反向成对为 PAIRED_LANE_OFFSET。
 *   - paired：是否属于双车道组（精确反向成对）。
 *
 * 唯一事实来源不变量：
 *   - ribbon 三角化、边箭头定位与边标签锚点都消费同一份 points / cumulativeArcLength，
 *     任何模块都不得再从原始 SceneEdge 重复推导车道偏移或重新采样。
 */
export interface LaneGeometry {
  readonly edgeId: string
  readonly kind: 'line' | 'cubic'
  readonly isBackEdge: boolean
  readonly points: readonly ScenePoint[]
  readonly cumulativeArcLength: readonly number[]
  readonly segmentTangents: readonly ScenePoint[]
  readonly totalArcLength: number
  readonly laneOffset: number
  readonly paired: boolean
}

/*
 * 精确反向成对的轨迹组（SPEC 2.4 / 9.2）。
 * edgeIds 为成对两条边的稳定 ID；顺序按“扫描时先出现者在前”。
 * kind 表示该组几何类型（LINE 或 BEZIER），同组两条边类型必然相同。
 */
export interface CoincidentTrackPair {
  readonly kind: 'line' | 'cubic'
  readonly edgeIds: readonly [string, string]
}

/*
 * 精确反向轨迹分组结果与诊断计数（SPEC 2.4 / 5.2 SceneDiagnostics.pairedTrackCount）。
 *
 * 计数不变量：
 *   - pairedTrackCount：双车道组数（真实样本固定 979）。
 *   - pairedEdgeCount：成对边数（= pairedTrackCount × 2，固定 1958）。
 *   - uniqueTrackCount：唯一物理轨迹数（= pairedTrackCount + 单边轨迹数，固定 2064）。
 *   - linePairCount / cubicPairCount：按几何类型拆分的双车道组数（固定 977 / 2）。
 *   - pairedEdgeIds：成对边 ID 集合，供采样阶段决定 laneOffset 取值。
 */
export interface TrackGrouping {
  readonly pairs: readonly CoincidentTrackPair[]
  readonly pairedEdgeIds: ReadonlySet<string>
  readonly pairedTrackCount: number
  readonly pairedEdgeCount: number
  readonly uniqueTrackCount: number
  readonly linePairCount: number
  readonly cubicPairCount: number
}

/*
 * TASK-006 的唯一输出：每条边的车道几何 + 精确反向分组结果。
 *
 * trackByEdgeId 提供 O(1) 查找；tracks 保持“按 SceneMap.edges 原顺序”的只读数组，
 * 供下游 ribbon 合并、边箭头实例矩阵与边标签锚点稳定消费。
 */
export interface TrackModel {
  readonly tracks: readonly LaneGeometry[]
  readonly trackByEdgeId: ReadonlyMap<string, LaneGeometry>
  readonly grouping: TrackGrouping
}
