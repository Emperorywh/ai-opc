import type { MapCompilerPort } from '../application/mapCompilerPort'
import type {
  CompileRequest,
  CompilationEvent,
  ToWorkerMessage,
  FromWorkerMessage,
} from '../domain/compilerProtocol'

/**
 * 后台地图编译 Worker 的主线程适配器（SPEC §5.1 infrastructure、§5.4、TASK-006/007）。
 *
 * 职责：创建并持有编译 Worker、发送编译请求、把 Worker 消息翻译为事件回调、
 * 在取消或销毁时终止 Worker。适配器实现应用层 MapCompilerPort 端口，是编译协议的具体载体：
 * 应用层加载用例只依赖端口抽象，由展示层组合根把本适配器注入应用层协调器。
 *
 * 不变量：
 * - 单 Worker 生命期：一个适配器实例对应一个 Worker；terminate 后不再可用。
 * - requestId 透传：Worker 每条消息携带请求时的 requestId，适配器原样交给回调，
 *   由上层加载用例配合会话控制器隔离过期结果（SPEC §5.4）。
 * - 取消即终止：取消下载的唯一可靠方式是 terminate Worker（终止其 fetch 流与微任务），
 *   随后由调用方重建新适配器开启新会话，保证后台执行单元归零（SPEC §5.4、TASK-007）。
 *
 * 依赖方向（SPEC §5.1、TASK-006）：位于 infrastructure，引用 application（端口契约）
 * 与 domain（编译协议），不再反向引用 worker 层——编译协议已收敛到 domain，
 * 使 infrastructure 单向依赖 application/domain。
 */

/** 编译事件回调：接收 requestId 与事件，便于上层做会话隔离。 */
export type MapCompilerEventListener = (requestId: number, event: CompilationEvent) => void

/** 适配器构造时可注入的 Worker 工厂，便于在测试中替换为伪造 Worker。 */
export interface MapCompilerWorkerFactory {
  create(): Worker
}

/**
 * 默认 Worker 工厂：用 Vite 的 `new Worker(new URL(...))` 语法加载 module Worker。
 * Vite 在构建与开发时分别产出独立 Worker chunk，资产同源自托管（SPEC §4.1）。
 */
function createDefaultWorker(): Worker {
  return new Worker(new URL('../worker/mapCompiler.worker.ts', import.meta.url), {
    type: 'module',
  })
}

/**
 * 编译 Worker 客户端：封装单次编译请求的生命期与事件转发。
 *
 * start() 发送请求并注册一次性事件回调；返回的句柄提供 cancel() 与 done 标记，
 * 供加载用例在会话结束或组件卸载时统一回收。
 */
export class MapCompilerClient implements MapCompilerPort {
  private readonly worker: Worker
  private readonly factory: MapCompilerWorkerFactory
  private listener: MapCompilerEventListener | null = null
  private currentRequestId = 0
  private terminated = false

  constructor(factory: MapCompilerWorkerFactory = { create: createDefaultWorker }) {
    this.factory = factory
    this.worker = this.factory.create()
    this.worker.addEventListener('message', this.handleMessage)
    this.worker.addEventListener('error', this.handleError)
  }

  /**
   * 发起一次编译并注册事件回调。
   *
   * 同一时间只支持一个有效监听；重复 start 会覆盖前一次回调与 requestId。
   * 调用方应在收到 success/error 后或取消时调用 cancel/terminate 清理。
   */
  start(request: CompileRequest, onEvent: MapCompilerEventListener): void {
    if (this.terminated) {
      throw new Error('MapCompilerClient 已终止，不能再次发起编译')
    }
    this.currentRequestId = request.requestId
    this.listener = onEvent
    const message: ToWorkerMessage = request
    this.worker.postMessage(message)
  }

  /**
   * 取消当前编译并终止 Worker。
   *
   * 终止 Worker 是中止在途 fetch 与后台微任务的唯一可靠手段；终止后该实例不可再用，
   * 新会话须由调用方创建新的 MapCompilerClient（SPEC §5.4 后台执行单元归零）。
   */
  cancel(): void {
    this.terminate()
  }

  /** 终止 Worker 并清理监听；幂等，多次调用安全。 */
  terminate(): void {
    if (this.terminated) return
    this.terminated = true
    this.listener = null
    this.worker.removeEventListener('message', this.handleMessage)
    this.worker.removeEventListener('error', this.handleError)
    this.worker.terminate()
  }

  private readonly handleMessage = (event: MessageEvent<FromWorkerMessage>): void => {
    const message = event.data
    if (!message || message.type !== 'event') return
    if (this.terminated || this.listener === null) return
    this.listener(message.requestId, message.event)
  }

  /**
   * 处理 Worker 级别错误（脚本加载失败、未捕获异常等）。
   *
   * 这类错误没有结构化 event，归为不可预期的下载/执行失败，
   * 以最近一次请求的 requestId 上报，保证有效会话能进入显式错误状态而非静默挂起。
   */
  private readonly handleError = (event: ErrorEvent): void => {
    if (this.terminated || this.listener === null) return
    this.listener(this.currentRequestId, {
      kind: 'error',
      code: 'DOWNLOAD_FAILED',
      message: '编译 Worker 发生未捕获错误',
      details: [
        typeof event.message === 'string' ? event.message : 'unknown worker error',
        event.filename ? `at ${event.filename}:${event.lineno}:${event.colno}` : '',
      ].filter(Boolean),
    })
  }
}
