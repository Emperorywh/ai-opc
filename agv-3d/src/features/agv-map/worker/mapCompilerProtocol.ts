import type { CompileProgressReport, RenderPacket } from '../domain/renderPacket'

/**
 * 后台地图编译的 Worker 通信契约（SPEC §5.2、TASK-007）。
 *
 * 该模块定义主线程适配器与编译 Worker 之间的消息协议。全部消息为纯数据，
 * 不携带函数或 Three.js 实例，可安全跨 Worker 边界结构化克隆；其中的 TypedArray
 * 通过 postMessage 的 transfer 列表转移所有权，避免大地图字节复制（SPEC §5.4）。
 *
 * 依赖方向（SPEC §5.1）：协议位于 worker 层，仅依赖 domain（RenderPacket 等）。
 * Worker 与主线程适配器共同引用同一套消息类型；适配器以 `import type` 引入，
 * 不产生运行时耦合。Worker 自身的错误码独立于应用层 MapLoadErrorCode，
 * 由应用层加载用例做稳定映射，避免 worker → application 反向依赖。
 */

/** 编译请求：主线程 → Worker。携带资产 URL 与会话 requestId 用于过期隔离。 */
export interface CompileRequest {
  readonly type: 'compile'
  /** 所属加载会话的 requestId；Worker 在每条回复中原样携带，主线程据此隔离过期结果。 */
  readonly requestId: number
  /** 自托管地图资产的同源 URL（SPEC §4.1）。 */
  readonly assetUrl: string
}

/**
 * Worker 内部错误码封闭联合，独立于应用层 MapLoadErrorCode（SPEC §5.1）。
 *
 * Worker 只描述错误的语义来源；应用层加载用例据此映射到状态机的稳定错误码
 * （如 DOWNLOAD_FAILED → ASSET_DOWNLOAD_FAILED）。这样 Worker 不反向依赖
 * application 层，错误分类也可在纯 Node 环境独立验证。
 */
export type CompilationErrorCode =
  | 'DOWNLOAD_FAILED'
  | 'INTEGRITY_FAILED'
  | 'PARSE_FAILED'
  | 'VALIDATION_FAILED'
  | 'COMPILE_FAILED'
  | 'UNEXPECTED_ERROR'

/** 解析阶段离散事件：只报告开始与完成，不伪造连续进度（SPEC §10.1）。 */
export type ParseStageEvent = 'parse-start' | 'parse-done'

/**
 * 编译流程向上报告的事件（Worker → 主线程）。
 *
 * 事件顺序遵循状态机阶段顺序：download-progress → parse-start → parse-done →
 * validate-progress → compile-progress(nodes) → compile-progress(paths) → success/error。
 * 主线程加载用例按该顺序驱动状态机，保证进度单调。
 */
export type CompilationEvent =
  | { readonly kind: 'download-progress'; readonly received: number; readonly total: number }
  | { readonly kind: 'parse'; readonly stage: ParseStageEvent }
  | { readonly kind: 'validate-progress'; readonly processed: number; readonly total: number }
  | { readonly kind: 'compile-progress'; readonly report: CompileProgressReport }
  | { readonly kind: 'success'; readonly packet: RenderPacket }
  | {
      readonly kind: 'error'
      readonly code: CompilationErrorCode
      readonly message: string
      readonly details: readonly string[]
    }

/** Worker → 主线程的消息：把事件与会话 requestId 绑定，便于过期隔离。 */
export interface CompileWorkerMessage {
  readonly type: 'event'
  readonly requestId: number
  readonly event: CompilationEvent
}

/** 主线程 → Worker 的消息联合：目前仅编译请求；保留为联合以便未来扩展取消等指令。 */
export type ToWorkerMessage = CompileRequest

/** Worker → 主线程的消息联合。 */
export type FromWorkerMessage = CompileWorkerMessage
