import type { RenderPacket } from '../domain/renderPacket'

/**
 * 显式加载状态机（SPEC §5.3、§10.1、TASK-006）。
 *
 * 不变量：
 * - 纯函数：状态转换只依赖当前状态与命令，不读取系统时间、随机源、相机或任何展示状态。
 *   相同输入恒产生相同输出，可在不启动浏览器的环境中完整验证（TASK-006 验收）。
 * - 单向向前：阶段只能按规定顺序逐个向前跃迁，进度始终处于 0～1 且单调不下降；
 *   任何非法转换被拒绝并返回原因，绝不产生半完成或回退状态。
 * - 终态封闭：ready 与 error 为终态，离开终态只能通过显式 start 重新开始一次全新加载；
 *   不自动重试、不降级、不切换实现（SPEC §10.2）。
 *
 * 进度区间（SPEC §10.1）固定按阶段映射：调用方以 0～1 的 fraction 表达阶段内进度
 * （已读字节占比、已处理记录数占比等），本模块将其映射到该阶段对应的全局进度区间，
 * 保证 UI 展示的百分比始终单调。
 */

/** 下载与编译阶段的有序子阶段（SPEC §5.3 loading 状态）。 */
export type LoadStage =
  | 'downloading'
  | 'parsing'
  | 'validating'
  | 'compiling-nodes'
  | 'compiling-paths'

/** 场景准备阶段的有序子阶段（SPEC §5.3 preparing 状态，持有渲染数据包）。 */
export type PrepareStage = 'creating-scene' | 'fading'

/** 全部有序活跃阶段，用于进度区间与跃迁顺序查表。 */
export type ActiveStage = LoadStage | PrepareStage

/** 活跃阶段的严格先后顺序（SPEC §5.3、§10.1）。 */
export const STAGE_SEQUENCE: readonly ActiveStage[] = [
  'downloading',
  'parsing',
  'validating',
  'compiling-nodes',
  'compiling-paths',
  'creating-scene',
  'fading',
]

/**
 * 各阶段对应的全局进度区间 [下界, 上界]（SPEC §10.1）。
 *
 * 相邻阶段的区间端点相接（前阶段上界等于后阶段下界），保证阶段跃迁时进度不回退。
 * parsing 区间为单点 [0.30, 0.30]：JSON.parse 不伪造连续进度，只报告开始与完成。
 */
export const STAGE_PROGRESS_BOUNDS: Readonly<Record<ActiveStage, readonly [number, number]>> = {
  downloading: [0.0, 0.3],
  parsing: [0.3, 0.3],
  validating: [0.3, 0.4],
  'compiling-nodes': [0.4, 0.55],
  'compiling-paths': [0.55, 0.9],
  'creating-scene': [0.9, 0.98],
  fading: [0.98, 1.0],
}

/** 单调性比较的浮点容差，吸收映射过程中的舍入噪声，仍能拒绝真实回退。 */
const PROGRESS_EPSILON = 1e-9

/** 下载起始进度（downloading 阶段下界）。 */
export const INITIAL_PROGRESS = STAGE_PROGRESS_BOUNDS.downloading[0]

/** 加载错误码封闭联合（SPEC §10.2）。各加载阶段错误稳定映射到对应错误码。 */
export type MapLoadErrorCode =
  | 'ASSET_DOWNLOAD_FAILED'
  | 'ASSET_INTEGRITY_FAILED'
  | 'JSON_PARSE_FAILED'
  | 'SCHEMA_VALIDATION_FAILED'
  | 'GEOMETRY_COMPILE_FAILED'
  | 'WEBGL_RESOURCE_FAILED'

/**
 * 各错误码对应的规范发生阶段（SPEC §10.2）。
 *
 * 完整性校验在下载完成后、解析前执行，归属 downloading；几何编译横跨 compiling-nodes
 * 与 compiling-paths，规范阶段取 compiling-paths。实际写入 error 状态的阶段由 fail 命令
 * 触发时的当前活跃阶段决定（见 applyLoadStateCommand），二者通常一致。
 */
export const ERROR_CODE_STAGE: Readonly<Record<MapLoadErrorCode, ActiveStage>> = {
  ASSET_DOWNLOAD_FAILED: 'downloading',
  ASSET_INTEGRITY_FAILED: 'downloading',
  JSON_PARSE_FAILED: 'parsing',
  SCHEMA_VALIDATION_FAILED: 'validating',
  GEOMETRY_COMPILE_FAILED: 'compiling-paths',
  WEBGL_RESOURCE_FAILED: 'creating-scene',
}

/**
 * 各错误码的简短中文说明（SPEC §10.2）。
 * 作为 fail 命令未显式提供消息时的默认说明，调用方可传入更具体的消息覆盖。
 */
export const ERROR_CODE_MESSAGE: Readonly<Record<MapLoadErrorCode, string>> = {
  ASSET_DOWNLOAD_FAILED: '地图资产下载失败',
  ASSET_INTEGRITY_FAILED: '地图资产完整性校验失败',
  JSON_PARSE_FAILED: '地图资产解析失败',
  SCHEMA_VALIDATION_FAILED: '地图数据结构校验失败',
  GEOMETRY_COMPILE_FAILED: '地图几何编译失败',
  WEBGL_RESOURCE_FAILED: '场景资源创建失败',
}

/**
 * 结构化加载错误（SPEC §10.2）。
 *
 * 错误状态对外只暴露稳定错误码、发生阶段与简短中文说明；details 保留可供开发定位的
 * 详细字段路径（如校验问题的 "nodes[3].x" 或几何错误的边 id），不直接展示给最终用户。
 */
export interface MapLoadError {
  readonly code: MapLoadErrorCode
  readonly stage: ActiveStage
  readonly message: string
  readonly details: readonly string[]
}

/**
 * 显式加载状态（SPEC §5.3）。
 *
 * loading 与 preparing 阶段携带 0～1 的单调进度；preparing 与 ready 携带渲染数据包；
 * error 携带结构化错误。该类型为封闭联合，不包含 idle 或 cancelled 变体——取消是会话级
 * 概念，由会话控制器阻止后续写入，不引入新的状态变体（SPEC §5.3、TASK-006）。
 *
 * 阶段以 LoadStage / PrepareStage 字面量联合表达（与 SPEC §5.3 preparing 变体一致），
 * 既保留按 stage 精确收窄的能力，又允许状态机以统一字段构造各阶段状态。
 */
export type MapSceneState =
  | { readonly status: 'loading'; readonly stage: LoadStage; readonly progress: number }
  | {
      readonly status: 'preparing'
      readonly stage: PrepareStage
      readonly progress: number
      readonly packet: RenderPacket
    }
  | { readonly status: 'ready'; readonly packet: RenderPacket }
  | { readonly status: 'error'; readonly error: MapLoadError }

/** 活跃加载/准备状态（非终态），用于辅助函数的参数收窄。 */
type ActiveLoadState = Extract<MapSceneState, { status: 'loading' | 'preparing' }>

/** fail 命令的精确类型，供辅助函数参数收窄。 */
type FailCommand = Extract<LoadStateCommand, { type: 'fail' }>

/**
 * 状态机命令（TASK-006）。
 *
 * - start：从任何状态（含 null、ready、error）重置为 downloading 初始态，开启新一次加载。
 * - report-progress：在当前阶段内以 0～1 的 fraction 报告进度，映射到该阶段的全局区间。
 * - advance：按相邻顺序跃迁到下一阶段（不含进入 creating-scene 与完成）。
 * - attach-packet：在路径编译完成后挂载渲染数据包，进入 creating-scene。
 * - complete：在淡入完成后进入 ready 终态。
 * - fail：从活跃阶段进入 error 终态，携带错误码与定位信息。
 */
export type LoadStateCommand =
  | { readonly type: 'start' }
  | { readonly type: 'report-progress'; readonly fraction: number }
  | { readonly type: 'advance'; readonly to: ActiveStage }
  | { readonly type: 'attach-packet'; readonly packet: RenderPacket }
  | { readonly type: 'complete' }
  | {
      readonly type: 'fail'
      readonly code: MapLoadErrorCode
      readonly message?: string
      readonly details?: readonly string[]
    }

/** 状态机转换结果：成功携带新状态，失败携带原因（不抛异常，便于在纯环境验证）。 */
export type LoadStateResult =
  | { readonly ok: true; readonly state: MapSceneState }
  | { readonly ok: false; readonly reason: string }

/**
 * 相邻阶段的下一阶段查表（SPEC §5.3 阶段顺序）。
 *
 * advance 命令只允许相邻前跃迁，保证按规定阶段顺序推进。compiling-paths 的下一跳是
 * creating-scene（由 attach-packet 完成）、fading 的下一跳是 ready（由 complete 完成），
 * 故二者不在 advance 路径上，表中不收录。
 */
const NEXT_STAGE: Readonly<Partial<Record<ActiveStage, ActiveStage>>> = {
  downloading: 'parsing',
  parsing: 'validating',
  validating: 'compiling-nodes',
  'compiling-nodes': 'compiling-paths',
  'creating-scene': 'fading',
}

/** 将 fraction 限制到 [0, 1]，NaN 视作 0，吸收调用方舍入或越界。 */
function clampFraction(fraction: number): number {
  if (Number.isNaN(fraction)) return 0
  if (fraction < 0) return 0
  if (fraction > 1) return 1
  return fraction
}

/** 取某阶段的进度下界。 */
function stageLowerBound(stage: ActiveStage): number {
  return STAGE_PROGRESS_BOUNDS[stage][0]
}

/**
 * 把阶段内的 fraction 映射到全局进度（SPEC §10.1）。
 * 导出供加载用例将真实处理进度（已读字节、已处理记录数）转换为全局进度。
 */
export function computeStageProgress(stage: ActiveStage, fraction: number): number {
  const [lo, hi] = STAGE_PROGRESS_BOUNDS[stage]
  return lo + clampFraction(fraction) * (hi - lo)
}

/** 在保持阶段与数据包不变的前提下更新进度。 */
function withProgress(state: ActiveLoadState, progress: number): MapSceneState {
  if (state.status === 'preparing') {
    return { status: 'preparing', stage: state.stage, progress, packet: state.packet }
  }
  return { status: 'loading', stage: state.stage, progress }
}

function ok(state: MapSceneState): LoadStateResult {
  return { ok: true, state }
}

function rejected(reason: string): LoadStateResult {
  return { ok: false, reason }
}

/**
 * 应用一条状态机命令，返回转换结果（SPEC §5.3、TASK-006）。
 *
 * 所有非法转换（回退、跨阶、终态后再转换、未启动即报告进度等）均被拒绝并返回原因，
 * 当前状态不受影响。调用方（会话控制器）据此决定是否采纳新状态。
 */
export function applyLoadStateCommand(
  state: MapSceneState | null,
  command: LoadStateCommand,
): LoadStateResult {
  switch (command.type) {
    case 'start':
      return ok({ status: 'loading', stage: 'downloading', progress: INITIAL_PROGRESS })
    case 'report-progress':
      return applyReportProgress(state, command.fraction)
    case 'advance':
      return applyAdvance(state, command.to)
    case 'attach-packet':
      return applyAttachPacket(state, command.packet)
    case 'complete':
      return applyComplete(state)
    case 'fail':
      return applyFail(state, command)
  }
}

function applyReportProgress(
  state: MapSceneState | null,
  fraction: number,
): LoadStateResult {
  if (state === null) return rejected('尚未启动加载，无法报告进度')
  if (state.status === 'ready') return rejected('已就绪，无法报告进度')
  if (state.status === 'error') return rejected('已处于错误状态，无法报告进度')
  // state 收窄为 loading | preparing，二者均携带 stage 与 progress。
  const mapped = computeStageProgress(state.stage, fraction)
  if (mapped < state.progress - PROGRESS_EPSILON) {
    return rejected(`进度回退：当前 ${state.progress}，新值 ${mapped}`)
  }
  return ok(withProgress(state, mapped))
}

function applyAdvance(
  state: MapSceneState | null,
  to: ActiveStage,
): LoadStateResult {
  if (state === null) return rejected('尚未启动加载，无法跃迁阶段')
  if (state.status === 'ready') return rejected('已就绪，无法跃迁阶段')
  if (state.status === 'error') return rejected('已处于错误状态，无法跃迁阶段')
  if (to === 'downloading') return rejected('不能跃迁到 downloading，请使用 start')
  if (to === 'creating-scene') {
    return rejected('不能跃迁到 creating-scene，请使用 attach-packet 挂载数据包')
  }
  // advance 只允许相邻前跃迁；NEXT_STAGE 不含 compiling-paths/fading 的下一跳，
  // 故从 compiling-paths 或 fading 出发的 advance 必然因 !== to 被拒绝。
  if (NEXT_STAGE[state.stage] !== to) {
    return rejected(`非法阶段跃迁：${state.stage} → ${to}`)
  }
  if (to === 'fading') {
    // 进入 fading 必然来自 creating-scene（NEXT_STAGE 保证），保留渲染数据包。
    if (state.status !== 'preparing' || state.stage !== 'creating-scene') {
      return rejected('进入 fading 必须来自 creating-scene')
    }
    return ok({
      status: 'preparing',
      stage: 'fading',
      progress: stageLowerBound('fading'),
      packet: state.packet,
    })
  }
  // to 收窄为 parsing | validating | compiling-nodes | compiling-paths，均为 LoadStage 子集。
  return ok({ status: 'loading', stage: to, progress: stageLowerBound(to) })
}

function applyAttachPacket(
  state: MapSceneState | null,
  packet: RenderPacket,
): LoadStateResult {
  if (state === null) return rejected('尚未启动加载，无法挂载数据包')
  if (state.status !== 'loading' || state.stage !== 'compiling-paths') {
    return rejected('仅可在路径编译完成后挂载数据包')
  }
  return ok({
    status: 'preparing',
    stage: 'creating-scene',
    progress: stageLowerBound('creating-scene'),
    packet,
  })
}

function applyComplete(state: MapSceneState | null): LoadStateResult {
  if (state === null) return rejected('尚未启动加载，无法进入就绪')
  if (state.status !== 'preparing' || state.stage !== 'fading') {
    return rejected('仅可在淡入完成后进入就绪')
  }
  return ok({ status: 'ready', packet: state.packet })
}

function applyFail(
  state: MapSceneState | null,
  command: FailCommand,
): LoadStateResult {
  if (state === null) return rejected('尚未启动加载，无法进入错误状态')
  if (state.status === 'ready') return rejected('已就绪，无法进入错误状态')
  if (state.status === 'error') return rejected('已处于错误终态，不支持重复失败')
  // 错误阶段取当前活跃阶段，保证与错误发生位置一致；消息默认取错误码对应中文说明。
  const error: MapLoadError = {
    code: command.code,
    stage: state.stage,
    message: command.message ?? ERROR_CODE_MESSAGE[command.code],
    details: command.details ?? [],
  }
  return ok({ status: 'error', error })
}
