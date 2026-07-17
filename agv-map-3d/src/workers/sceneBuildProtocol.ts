/*
 * 场景构建 worker 消息协议（workers 层，SPEC 3.1 / 3.3 / 4.1 / 4.2 / 4.3 / 14.1）。
 *
 * 信任边界定位（TASK-013）：
 *   - 本模块定义主线程 ↔ scene-build worker 的显式消息契约：输入请求、阶段进度、
 *     成功与失败三类回复，全部可被结构化克隆（SPEC 4.1 postMessage 转移）。
 *   - 协议只由纯类型与稳定阶段名常量组成：不持有可变状态、不执行 I/O、不创建
 *     Three / React / DOM / GPU 资源。application 层（后续 TASK）与 worker 入口
 *     共同消费本契约，二者对消息形状的认知只来自本文件，不存在第二套隐式协议。
 *
 * 请求关联不变量（SPEC 4.2 / 任务约束）：
 *   - 每条回复消息都携带原请求 ID；worker 不判断结果是否过期，当前请求归属由
 *     application 层统一决定。主线程用单调递增 requestId 区分多次加载，避免把
 *     过期 worker 结果错误提交到新一轮状态机。
 *
 * 阶段语义（SPEC 4.2 显式状态机 / 任务约束）：
 *   - loading：worker 正在请求样本（fetch）。
 *   - preparing：解析、校验、几何构建中。
 *   进度消息报告当前阶段与子阶段名，阶段名稳定且可供 UI 显示；请求开始报告 loading，
 *   进入解析 / 校验 / 几何构建后报告 preparing。
 *
 * 错误归属（SPEC 14.1 / 任务约束）：
 *   - 失败消息携带稳定 code、当前阶段、失败发生的管线位置、中文消息、JSON path、
 *     实体 ID（可用时）与上下文，全部可结构化克隆。
 *   - 失败整体终止：worker 不返回部分场景、不输出部分数组（SPEC 16）；application 层
 *     收到失败消息后整体转入 error，禁止画简化地图。
 */
import type { MapErrorCode } from '../domain/mapDataError'
import type { SceneModel } from './buildSceneModel'

/*
 * 单调请求 ID 类型：主线程分配，worker 在每条回复中原样回传。
 * 用 number 别名表达语义，便于 application 层与测试按 ID 关联请求与回复。
 */
export type SceneBuildRequestId = number

/*
 * 输入消息：主线程 → worker（SPEC 4.2）。
 * type 闭合为 'build'，便于后续扩展（如显式取消）时保持协议显式与向后可识别。
 */
export interface SceneBuildRequest {
  readonly type: 'build'
  readonly requestId: SceneBuildRequestId
}

/*
 * SPEC 4.2 显式状态机阶段名（稳定字面量，任务约束：阶段名稳定且可供 UI 显示）。
 *   - LOADING：请求样本阶段。
 *   - PREPARING：解析、校验、几何构建阶段。
 * UI 据此显示"加载中 / 准备中"，测试据此断言进度消息顺序与失败消息所处阶段。
 */
export const SCENE_BUILD_PHASE = {
  LOADING: 'loading',
  PREPARING: 'preparing',
} as const
export type SceneBuildPhase = (typeof SCENE_BUILD_PHASE)[keyof typeof SCENE_BUILD_PHASE]

/*
 * 准备阶段子阶段名（稳定字面量）。
 *   - PARSING：JSON.parse（样本字符串 → JS 对象）。
 *   - VALIDATING：parseSampleEnvelope + validateMapSemantics + normalizeSceneMap
 *                 （响应包与实体严格校验、一次性坐标归一化）。
 *   - BUILDING：buildSceneModel（轨迹、ribbon、实例、标签、bounds 与交付前自校验）。
 * 子阶段名供 UI 显示细粒度进度，也作为失败定位的稳定依据。
 */
export const SCENE_BUILD_STAGE = {
  PARSING: 'parsing',
  VALIDATING: 'validating',
  BUILDING: 'building',
} as const
export type SceneBuildStage = (typeof SCENE_BUILD_STAGE)[keyof typeof SCENE_BUILD_STAGE]

/*
 * 失败发生的管线位置（任务约束：保留对应阶段，与错误码共同定位失败）。
 * 与 SCENE_BUILD_STAGE 不同：fetch 与 parse 失败的 code 不属于 MapDataError 体系，
 * 但失败位置仍需显式报告，便于 application 层 overlay 与诊断按阶段归因。
 */
export type SceneBuildFailureStage = 'fetch' | 'parse' | 'validate' | 'build'

/*
 * 进度消息：worker → 主线程，报告当前阶段与子阶段。
 * loading 阶段无子阶段（stage = null）；preparing 阶段报告 parsing / validating / building。
 */
export interface SceneBuildProgress {
  readonly type: 'progress'
  readonly requestId: SceneBuildRequestId
  readonly phase: SceneBuildPhase
  readonly stage: SceneBuildStage | null
}

/*
 * 各阶段耗时快照（毫秒，SPEC 14.2 诊断）。
 * 仅随成功消息返回；失败时不计算后续阶段耗时（对应字段保持 0）。
 * 字段名固定，便于诊断与测试按字段断言存在性与非负性。
 */
export interface SceneBuildTimings {
  readonly fetch: number
  readonly parse: number
  readonly validate: number
  readonly build: number
}

/*
 * 成功消息：worker → 主线程，携带完整 SceneModel 与阶段耗时（SPEC 4.1 / 5.2）。
 *
 * 转移所有权（SPEC 4.1 / 4.3 / 任务约束）：
 *   - model 中的 Float32Array 底层 ArrayBuffer 通过 postMessage transfer list
 *     一次性转移给主线程；转移后 worker 侧不得再次访问（SPEC 4.3）。
 *   - labels 是普通 JS 描述符，随结构化克隆传递，不进入 transfer list。
 *   - transfer list 由 runSceneBuild 通过 collectTransferableBuffers 产出并在 send 时
 *     附带；本协议只定义消息形状，不规定传输实现。
 */
export interface SceneBuildSuccess {
  readonly type: 'success'
  readonly requestId: SceneBuildRequestId
  readonly model: SceneModel
  readonly timings: SceneBuildTimings
}

/*
 * 失败消息：worker → 主线程（SPEC 14.1 / 任务约束）。
 *
 * 字段语义：
 *   - code：稳定错误码（SAMPLE_FETCH_FAILED / SAMPLE_JSON_INVALID /
 *     MAP_ENVELOPE_INVALID / MAP_ENTITY_INVALID / MAP_GEOMETRY_INVALID）。
 *   - phase：失败发生时所处的状态机阶段（loading / preparing）。
 *   - failureStage：失败发生的管线位置（fetch / parse / validate / build）。
 *   - message：简体中文可读消息，直接面向 overlay 与日志。
 *   - jsonPath：失败位置在原始响应中的 JSON 路径（fetch / parse 失败为 '$'）。
 *   - entityId：可用时的实体 ID；响应包级失败为 null。
 *   - context：可选附加诊断字段（期望值 / 实际值 / 字段名等），全部为可克隆基本类型。
 */
export interface SceneBuildFailure {
  readonly type: 'failure'
  readonly requestId: SceneBuildRequestId
  readonly code: MapErrorCode
  readonly phase: SceneBuildPhase
  readonly failureStage: SceneBuildFailureStage
  readonly message: string
  readonly jsonPath: string
  readonly entityId: string | null
  readonly context: Readonly<Record<string, unknown>> | null
}

/*
 * worker → 主线程消息联合。
 * application 层按 type 字段做判别联合匹配，分别驱动 loading / preparing / ready / error 状态。
 */
export type SceneBuildMessage =
  | SceneBuildProgress
  | SceneBuildSuccess
  | SceneBuildFailure
