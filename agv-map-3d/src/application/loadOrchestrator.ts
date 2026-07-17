/*
 * 应用加载状态机编排器（application 层，SPEC 4.2 / 4.3 / 13 / 14.1 / 15.3 / 任务约束）。
 *
 * 信任边界定位（TASK-016）：
 *   - 本模块是 worker 请求、场景模型提交、Three 资源准备与本地字体预加载的唯一编排者：
 *     把注入端口产生的异步结果归一化为 LoadEvent，经 reduceLoadState 集中转换状态，
 *     并按 reducer 返回的 released 清单幂等释放资源。
 *   - application 层只编排已定义端口与不可变契约：不解析 JSON、不生成几何、不创建具体 Three 资源、
 *     不预加载之外创建文字、不维护相机或标签可见状态（任务约束）。
 *   - 不实现 WebGL DOM 事件绑定、context restore、R3F 场景与错误 overlay；后续集成通过本编排器
 *     的事件与 subscribe 扩展，不得建立第二套加载状态。
 *
 * requestId 竞态编排（SPEC 4.2 / 任务“过期结果丢弃、worker 终止、资源释放”）：
 *   - start / retry 分配严格单调递增的 requestId，并先终止旧 worker（其 in-flight 消息按旧 requestId 被丢弃）。
 *   - 异步结果（worker success、资源创建、字体回调）在派发前先与 currentRequestId 比对：
 *       · 过期 worker success：不存储 model、不启动准备（引用脱离状态、可被 GC）。
 *       · 过期资源创建结果：资源已为废弃请求创建，直接 dispose，不进入状态。
 *       · 过期字体回调：静默忽略。
 *   - reducer 的 requestId 判定是纯安全网；orchestrator 是副作用（资源释放）的真正门控者。
 *
 * ready 门禁编排（任务“三道门禁”）：
 *   - worker success 到达后并发启动资源创建与字体预加载（二者均为 Promise，可任意顺序完成）。
 *   - 三道材料（model / resources / fontReady）全部就绪时 reducer 一次性推进到 ready；
 *     此前始终保持 preparing，且只提交一次 ready。
 *
 * 清理与 StrictMode 幂等（SPEC 4.3 / 任务“20 次挂载/卸载计数不增长”）：
 *   - dispose 幂等：首次调用终止 worker、派发 abort、释放全部资源、清空订阅；此后任意次调用为空操作。
 *   - dispose 为终态：disposed = true 后 start 被硬性拒绝（不再启动 worker、不分配 requestId），
 *     防止 StrictMode 的 cleanup→setup 在同一实例上误启动。集成层（TASK-017）必须为每次挂载
 *     new 出全新 LoadOrchestrator 实例：StrictMode 的 setup→cleanup→setup 产生两个独立实例，
 *     cleanup 调 dispose 终结第一个，第二次 setup 持有第二个全新实例并以自身 requestId 进入 loading。
 *   - 在途异步回调（资源 / 字体）在 dispose 后 settle 时直接释放资源并忽略事件，杜绝卸载后泄漏。
 *   - 单资源 dispose 抛错不阻断其余资源释放（与 ResourceRegistry 一致的异常隔离策略）。
 *
 * 错误阶段透传（SPEC 14.1 / 任务“结构化错误状态包含错误码、阶段、消息、上下文”）：
 *   - 三类失败源统一派发携带 phase（loading / preparing）与 failureStage 的事件，
 *     使 error 状态在 worker / 资源 / 字体失败间拥有一致的阶段表示，overlay 不必凭 code 反推阶段。
 *   - worker 失败原样透传消息的 phase 与 failureStage；资源失败固定 preparing / resource；
 *     字体失败固定 preparing / font（细粒度门禁 coverage / asset 已写入 MapDataError.context）。
 *
 * 依赖方向（SPEC 3.3）：domain（MapDataError）+ workers（SceneBuild 协议与 SceneModel）+
 *   labels（preloadLabelFont / LabelFontPreloadPort）+ application 自身；外部仅 node。
 */
import { isMapDataError, MapDataError, MapErrorCode } from '../domain/mapDataError'
import { preloadLabelFont } from '../labels/fontPreload'
import type { SceneModel } from '../workers/buildSceneModel'
import type {
  SceneBuildFailure,
  SceneBuildMessage,
  SceneBuildSuccess,
} from '../workers/sceneBuildProtocol'
import { SCENE_BUILD_PHASE } from '../workers/sceneBuildProtocol'
import type { LoadOrchestratorConfig } from './loadPorts'
import type {
  DisposableResource,
  LoadEvent,
  LoadState,
} from './loadState'
import { reduceLoadState } from './loadState'

/*
 * 把 worker failure 消息重建为不可变 MapDataError（消息本身可结构化克隆，字段已稳定）。
 * application 不持有 worker 抛出的原始对象，只消费协议字段，避免跨线程对象耦合。
 */
function failureToError(failure: SceneBuildFailure): MapDataError {
  return new MapDataError({
    code: failure.code,
    message: failure.message,
    jsonPath: failure.jsonPath,
    entityId: failure.entityId,
    context: failure.context ? { ...failure.context } : undefined,
  })
}

/*
 * 把资源 / 字体等非 worker 阶段的未知失败收敛为 MapDataError（任务“稳定错误码与阶段”）。
 * 资源创建失败映射为 MAP_GEOMETRY_INVALID（与 rendering 层 createMapResources 的错误码同源）；
 * 已是 MapDataError 的失败（如字体 FONT_*）原样透传，不重写 code。
 */
function coerceError(err: unknown, fallbackCode: MapErrorCode): MapDataError {
  if (isMapDataError(err)) return err
  const message = err instanceof Error ? err.message : String(err)
  return new MapDataError({
    code: fallbackCode,
    message,
    jsonPath: 'application.load',
  })
}

/*
 * 单资源幂等释放（异常隔离）：dispose 抛错时吞掉，不阻断其余资源释放。
 * 与 ResourceRegistry.dispose 的单资源异常隔离策略一致。
 */
function safeDispose(resource: DisposableResource): void {
  try {
    resource.dispose()
  } catch {
    // 单资源释放失败不阻断其余资源；继续释放剩余资源（SPEC 4.3 尽可能释放）。
  }
}

/*
 * 加载编排器：加载状态与请求竞态的唯一所有者。
 *
 * 实例字段语义：
 *   - state：当前不可变加载状态（由 reducer 唯一推进）。
 *   - currentRequestId：最近一次 start 分配的 requestId；异步结果据此判定是否过期。
 *   - requestCounter：单调递增计数器，保证每次 start / retry 分配严格更大的 requestId。
 *   - listeners：状态变更订阅者（供 UI / 后续 overlay 投影）。
 *   - disposed：幂等清理标志，防止 StrictMode / HMR 重复清理产生副作用。
 */
export class LoadOrchestrator<TResource extends DisposableResource> {
  private state: LoadState<TResource> = { kind: 'idle' }
  private requestCounter = 0
  private currentRequestId = 0
  private readonly listeners = new Set<(state: LoadState<TResource>) => void>()
  private disposed = false
  private readonly config: LoadOrchestratorConfig<TResource>

  constructor(config: LoadOrchestratorConfig<TResource>) {
    this.config = config
  }

  /*
   * 当前不可变加载状态（供消费者只读投影，不得外部突变）。
   */
  getState(): LoadState<TResource> {
    return this.state
  }

  /*
   * 订阅状态变更，返回取消订阅函数。UI / overlay 据此投影 idle / loading / preparing / ready / error。
   * 卸载时调用返回的取消函数，避免持有已卸载组件的回调（任务约束：不维护组件级重复状态）。
   */
  subscribe(listener: (state: LoadState<TResource>) => void): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  /*
   * 开始一次加载（首次或重新加载）。
   *
   * 竞态与清理编排：
   *   - 分配严格更大的 requestId；先终止旧 worker（其 in-flight 消息按旧 requestId 被丢弃）。
   *   - 派发 start 事件：reducer 释放旧状态资源（进入 released）并进入 loading。
   *   - 启动新 worker，把消息路由到 handleWorkerMessage。
   *   - 已 dispose 的编排器不再 start（终态保护：防止卸载后误启动；
   *     集成层需为重新挂载 new 全新实例，不得在同一实例上 dispose→start）。
   */
  start(): void {
    if (this.disposed) return
    const requestId = ++this.requestCounter
    this.currentRequestId = requestId
    // 先终止旧 worker：其 in-flight 消息携带旧 requestId，将被统一丢弃。
    this.config.workerPort.terminate()
    // 派发 start：reducer 释放旧资源并进入 loading（requestId 严格单调，必然采纳）。
    this.apply({ type: 'start', requestId })
    // 启动新 worker：消息路由到统一处理器，按 currentRequestId 判定请求归属。
    this.config.workerPort.start(requestId, (message) => {
      this.handleWorkerMessage(message)
    })
  }

  /*
   * 重新加载：从 error（或任意状态）以新的 requestId 重新进入 loading。
   * 不复用失败请求的 worker、可变 SceneModel、资源或错误对象（任务约束）。
   */
  retry(): void {
    this.start()
  }

  /*
   * 卸载 / HMR 清理（幂等）。
   *
   * - 终止当前 worker、派发 abort（reducer 回到 idle 并释放全部资源）、清空订阅。
   * - 幂等：首次调用后 disposed = true，此后任意次调用为空操作（StrictMode 重复清理安全）。
   */
  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.config.workerPort.terminate()
    this.apply({ type: 'abort' })
    this.listeners.clear()
  }

  /*
   * 派发事件给 reducer 并执行副作用（资源释放 + 通知订阅者）。
   *
   * - reducer 纯推进状态、产出 released；orchestrator 据此幂等释放脱离状态的资源。
   * - 仅在 reducer 产出新状态（引用变化）时通知订阅者：被忽略的事件（过期 / 当前阶段
   *   不采纳）返回原状态引用，不触发多余通知，使“只提交一次 ready / error”在通知层
   *   也成立，避免过期回调导致 overlay 重复渲染。状态转换仍只由 reducer 完成。
   */
  private apply(event: LoadEvent<TResource>): void {
    const prev = this.state
    const { state: next, released } = reduceLoadState(prev, event)
    this.state = next
    for (const resource of released) {
      safeDispose(resource)
    }
    // 引用未变 = reducer 忽略了事件（released 此时必为空）；不再向订阅者派发。
    if (next === prev) return
    for (const listener of this.listeners) {
      listener(this.state)
    }
  }

  /*
   * worker → 主线程消息统一处理（SPEC 4.2 当前请求判定）。
   *
   * - progress：直接派发（reducer 按 requestId 判定采纳或忽略）。
   * - success：先判定 requestId 是否仍为当前；过期则不存储 model、不启动准备（引用脱离状态、可被 GC）。
   * - failure：把协议字段重建为 MapDataError 后派发 model-failed；reducer 据此进入 error。
   */
  private handleWorkerMessage(message: SceneBuildMessage): void {
    if (message.type === 'progress') {
      this.apply({
        type: 'progress',
        requestId: message.requestId,
        phase: message.phase,
        stage: message.stage,
      })
      return
    }
    if (message.type === 'success') {
      this.handleModelArrived(message)
      return
    }
    // failure：重建为不可变 MapDataError，原样透传 worker 消息的 phase 与 failureStage，
    // 使 error 状态在 worker 失败上保留完整阶段定位（SPEC 14.1）；过期失败由 reducer 静默忽略。
    this.apply({
      type: 'model-failed',
      requestId: message.requestId,
      error: failureToError(message),
      phase: message.phase,
      failureStage: message.failureStage,
    })
  }

  /*
   * worker success 处理：门控当前请求后存储 model 并并发启动资源 / 字体准备。
   *
   * 过期处理（任务“过期成功结果不得进入资源适配或状态”）：
   *   - 若 requestId 已不是当前请求，直接返回；model 引用不进入状态、不传给资源端口，
   *     其 ArrayBuffer 可被 GC 回收。
   *
   * 采纳校验（任务“过期成功结果不得进入资源适配”，防御协议异常）：
   *   - 派发 model-arrived 后，只有当 reducer 真正把 model 接入 preparing（状态为 preparing
   *     且持有同一 model）时才启动资源 / 字体准备。
   *   - 若因协议异常（未经历 preparing 阶段）reducer 忽略了 model，则不创建资源、不预加载，
   *     避免产生无人释放的资源泄漏。
   */
  private handleModelArrived(message: SceneBuildSuccess): void {
    if (message.requestId !== this.currentRequestId) {
      // 过期成功：model 不存储、不准备；引用脱离 application 状态，可被回收。
      return
    }
    const { requestId, model } = message
    this.apply({ type: 'model-arrived', requestId, model })
    const after = this.state
    // 仅当 reducer 真正采纳 model 时才启动剩余门禁，杜绝协议异常下的资源泄漏。
    if (after.kind !== 'preparing' || after.model !== model) {
      return
    }
    // 并发启动两道剩余门禁（均为 Promise，完成顺序任意）。
    this.startResourceCreation(requestId, model)
    this.startFontPreload(requestId, model)
  }

  /*
   * 启动资源创建门禁（任务“资源创建中途失败进入 error 并释放部分资源”）。
   *
   * 过期 / 卸载处理（任务“过期成功结果不得进入资源适配或状态”、SPEC 4.3 卸载释放）：
   *   - 资源端口 resolve 时若 requestId 已过期或编排器已 dispose，资源是为废弃请求创建的，
   *     直接 dispose，不进入状态（reducer 不会接管它）。dispose 后在途资源若不在此处释放将泄漏。
   * 失败处理：reject 收敛为 MAP_GEOMETRY_INVALID 并派发携带阶段（preparing / resource）的
   *   resource-creation-failed；reducer 据此释放本次部分资源并进入 error。dispose 后到达的
   *   reject 同样静默忽略，不为已卸载编排器派发事件。
   */
  private startResourceCreation(requestId: number, model: SceneModel): void {
    this.config.resourceFactory
      .create(model)
      .then(
        (resources) => {
          // 过期或已卸载：资源为废弃请求创建，直接释放，不进入状态（杜绝卸载后泄漏）。
          if (this.disposed || requestId !== this.currentRequestId) {
            safeDispose(resources)
            return
          }
          this.apply({ type: 'resources-created', requestId, resources })
        },
        (err) => {
          // 过期或已卸载的 reject 静默忽略：不覆盖当前请求、不为废弃请求派发事件。
          if (this.disposed || requestId !== this.currentRequestId) return
          this.apply({
            type: 'resource-creation-failed',
            requestId,
            error: coerceError(err, MapErrorCode.MAP_GEOMETRY_INVALID),
            phase: SCENE_BUILD_PHASE.PREPARING,
            failureStage: 'resource',
          })
        },
      )
      .catch(() => {
        // apply 内部不抛错；此处仅作防御，避免 then 链未捕获异常逃逸到全局。
      })
  }

  /*
   * 启动本地字体预加载门禁（TASK-015 / 任务“字体就绪/失败信号”）。
   *
   * - 标签文本来自当前 SceneModel.labels（唯一名称来源，不重建描述符、不读原始 JSON）。
   * - preloadLabelFont 先做字形覆盖门禁（FONT_GLYPH_MISSING），再调用注入端口预加载（FONT_ASSET_FAILED）；
   *   application 不直接 import troika，只消费 LabelFontPreloadPort 契约。
   * - 过期 / 卸载回调静默忽略（字体无资源需释放）；失败透传 FONT_* 错误并携带阶段
   *   （preparing / font），reducer 据此进入 error。dispose 后到达的回调同样忽略。
   */
  private startFontPreload(requestId: number, model: SceneModel): void {
    const texts = model.labels.map((label) => label.text)
    preloadLabelFont({
      texts,
      manifestCodePoints: this.config.fontConfig.manifestCodePoints,
      port: this.config.fontPort,
      fontUrl: this.config.fontConfig.fontUrl,
      sdfGlyphSize: this.config.fontConfig.sdfGlyphSize,
    }).then(
      (outcome) => {
        // 过期或已卸载的回调静默忽略：不覆盖当前请求、不为废弃请求派发事件。
        if (this.disposed || requestId !== this.currentRequestId) return
        if (outcome.status === 'ready') {
          this.apply({ type: 'font-ready', requestId })
        } else {
          this.apply({
            type: 'font-failed',
            requestId,
            error: outcome.error,
            phase: SCENE_BUILD_PHASE.PREPARING,
            failureStage: 'font',
          })
        }
      },
      () => {
        // preloadLabelFont 不 reject（失败经 outcome.status = 'error' 交付）；防御性忽略。
      },
    )
  }
}
