/*
 * 应用加载状态机的纯状态、事件与 reducer（application 层，SPEC 4.2 / 4.3 / 13 / 14.1 / 15.3）。
 *
 * 信任边界定位（TASK-016）：
 *   - 本模块是“加载状态唯一所有者”的纯核心：定义 idle / loading / preparing / ready / error
 *     五种互斥状态、允许事件与状态转换，并以一个纯 reducer 函数集中完成全部转换。
 *   - 纯度不变量：reducer 不创建 / 释放资源、不发起异步、不读全局可变状态、不接触 DOM；
 *     全部副作用（资源释放、worker 终止、字体回调）由 loadOrchestrator 按本模块返回的
 *     不可变契约执行。这样状态转换规则只有一份，测试可脱离浏览器与 React 直接驱动。
 *   - application 层只编排已定义端口：本模块只依赖 domain（MapDataError）与 workers
 *     （SceneModel / SceneBuildPhase / SceneBuildStage 契约类型），不依赖 rendering / three。
 *     资源以泛型 TResource（约束为 DisposableResource）携带，application 对其内部结构无知。
 *
 * SPEC 4.2 显式状态机：
 *   idle → loading → preparing → ready
 *                   ↘ error
 *   - loading：worker 正在请求样本。
 *   - preparing：解析 / 校验 / 几何构建 / 资源准备 / 字体预加载；三道门禁全部满足后才进入 ready。
 *   - ready：SceneModel、Three 资源与本地字体均成功。
 *   - error：任一阶段失败；不携带可展示的部分地图资源。
 *
 * requestId 竞态不变量（SPEC 4.2 / 任务约束）：
 *   - 每条携带 requestId 的事件只在“当前请求”时被采纳；过期事件被 reducer 静默丢弃，
 *     不覆盖当前状态、不进入资源适配、不触发部分资源创建。
 *   - start 事件必须严格大于当前 requestId（单调递增），否则视为无效，防止回退覆盖。
 *   - 资源 / 字体的异步结果由 orchestrator 在派发前先做 requestId 判定（清理副作用），
 *     reducer 的判定是纯安全网：即使过期结果误派发也不会改变状态。
 *
 * ready 门禁不变量（任务约束）：
 *   - 只有 preparing 同时持有 model（非空）、resources（非空）且 fontReady = true 时，
 *     才一次性转换为 ready；缺少任一项都停留在 preparing。
 *   - 门禁判定只由本 reducer 完成，禁止其它组件维护“模型已到达 / 资源已创建 / 字体已加载”布尔。
 *
 * 清理不变量（SPEC 4.3 / 任务约束）：
 *   - 离开持有资源的 preparing / ready（进入 error、被新 start 取代或被 abort）时，
 *     旧资源进入返回结果的 released 列表，由 orchestrator 幂等释放。
 *   - error 状态不携带资源；ready → 资源随状态存续，直至被取代或 abort。
 */
import type { MapDataError } from '../domain/mapDataError'
import type { SceneModel } from '../workers/buildSceneModel'
import type {
  SceneBuildFailureStage,
  SceneBuildPhase,
  SceneBuildStage,
} from '../workers/sceneBuildProtocol'

/*
 * 加载失败发生的管线位置（统一三类失败源的细粒度定位，SPEC 14.1 overlay 据此显示阶段）。
 *   - fetch / parse / validate / build：worker 内部管线位置，由 SceneBuildFailure 原样透传。
 *   - resource：主线程 Three 资源创建（rendering 层 createMapResources），worker 已成功交付后失败。
 *   - font：主线程本地字体预加载（labels 层 preloadLabelFont），含字形覆盖与资产加载两道门禁。
 * 与 SceneBuildFailureStage 的关系：后者只描述 worker 内部位置；本类型是其超集，
 * 覆盖 application 层编排的全部失败点，使“阶段”在三类失败间表示一致、不靠 code 反推。
 */
export type LoadFailureStage = SceneBuildFailureStage | 'resource' | 'font'

/*
 * 可释放资源协议（与 rendering 层 ResourceRegistry / MapResources 同构）。
 * application 只通过 dispose() 释放，不访问资源内部结构，避免跨层耦合 Three 对象。
 * 泛型 TResource 约束为本接口，使状态持有的资源类型在编译期可见、运行期仅暴露 dispose。
 */
export interface DisposableResource {
  dispose(): void
}

/*
 * SPEC 4.2 五种互斥加载状态。
 *
 * 字段语义：
 *   - requestId：分配给本次加载的单调 ID；idle 无请求、其余状态携带当前请求 ID。
 *   - stage（preparing）：最近一次 preparing 子阶段（parsing / validating / building），
 *     稳定阶段名供 UI 显示；loading 完成进入 preparing 时为首个子阶段。
 *   - model / resources / fontReady（preparing）：三道 ready 门禁的当前材料；
 *     model 由 worker success 提供、resources 由资源端口提供、fontReady 由 字体回调置位。
 *   - error / phase / failureStage（error）：稳定结构化错误（code / message / jsonPath /
 *     context）+ 失败发生时的状态机阶段（loading / preparing）+ 管线位置
 *     （fetch / parse / validate / build / resource / font），供 overlay 投影阶段与原因。
 */
export type LoadState<TResource extends DisposableResource> =
  | { readonly kind: 'idle' }
  | { readonly kind: 'loading'; readonly requestId: number }
  | {
      readonly kind: 'preparing'
      readonly requestId: number
      readonly stage: SceneBuildStage | null
      readonly model: SceneModel | null
      readonly resources: TResource | null
      readonly fontReady: boolean
    }
  | {
      readonly kind: 'ready'
      readonly requestId: number
      readonly model: SceneModel
      readonly resources: TResource
    }
  | {
      /*
       * error 携带稳定结构化错误与失败发生时的阶段定位（SPEC 14.1 overlay 据此显示
       * 错误码 + 阶段 + 简体中文消息 + 可用上下文）。
       *   - error：稳定 MapDataError（code / message / jsonPath / entityId / context）。
       *   - phase：失败发生时的状态机阶段（loading / preparing），三类失败源统一携带。
       *   - failureStage：失败发生的管线位置（fetch / parse / validate / build / resource / font）。
       * error 状态结构上不持有 resources 字段，即不携带可展示的部分地图资源（任务约束）。
       */
      readonly kind: 'error'
      readonly requestId: number
      readonly error: MapDataError
      readonly phase: SceneBuildPhase
      readonly failureStage: LoadFailureStage
    }

/*
 * 驱动状态机的事件（任务“可供后续 UI 直接投影的结构化状态”的输入侧）。
 *
 * - start：开始或重新加载，分配的新 requestId 必须严格大于当前。
 * - progress：worker 进度（loading / preparing + 子阶段）。
 * - model-arrived / model-failed：worker success / failure 的归一化结果。
 * - resources-created / resource-creation-failed：资源端口的成功 / 失败结果。
 * - font-ready / font-failed：字体预加载的成功 / 失败结果。
 * - abort：卸载 / HMR 清理，回到 idle 并释放当前请求已创建的全部资源。
 *
 * 每条异步结果事件都携带 requestId；reducer 据此丢弃过期结果（SPEC 4.2 当前请求判定）。
 * 三类失败事件（model-failed / resource-creation-failed / font-failed）还携带 phase 与
 * failureStage，使 error 状态在三类失败源间拥有统一的阶段表示（SPEC 14.1 overlay 依赖）。
 */
export type LoadEvent<TResource extends DisposableResource> =
  | { readonly type: 'start'; readonly requestId: number }
  | {
      readonly type: 'progress'
      readonly requestId: number
      readonly phase: SceneBuildPhase
      readonly stage: SceneBuildStage | null
    }
  | { readonly type: 'model-arrived'; readonly requestId: number; readonly model: SceneModel }
  | {
      readonly type: 'model-failed'
      readonly requestId: number
      readonly error: MapDataError
      readonly phase: SceneBuildPhase
      readonly failureStage: LoadFailureStage
    }
  | {
      readonly type: 'resources-created'
      readonly requestId: number
      readonly resources: TResource
    }
  | {
      readonly type: 'resource-creation-failed'
      readonly requestId: number
      readonly error: MapDataError
      readonly phase: SceneBuildPhase
      readonly failureStage: LoadFailureStage
    }
  | { readonly type: 'font-ready'; readonly requestId: number }
  | {
      readonly type: 'font-failed'
      readonly requestId: number
      readonly error: MapDataError
      readonly phase: SceneBuildPhase
      readonly failureStage: LoadFailureStage
    }
  | { readonly type: 'abort' }

/*
 * reducer 返回结果：新状态 + 需 orchestrator 释放的资源清单。
 *
 * released 语义：本次转换后不再被状态持有的可释放资源（被新 start 取代、进入 error 或 abort）。
 * reducer 不直接 dispose（保持纯度）；orchestrator 按 released 幂等释放。
 * 正常推进 preparing（材料累加）或 preparing → ready 时 released 为空（资源仍在状态内）。
 */
export interface LoadReducerResult<TResource extends DisposableResource> {
  readonly state: LoadState<TResource>
  readonly released: readonly TResource[]
}

/*
 * 取当前状态所属的 requestId；idle 视为 0（无请求），用于 start 单调性判定。
 */
function currentRequestIdOf<TResource extends DisposableResource>(
  state: LoadState<TResource>,
): number {
  if (state.kind === 'idle') return 0
  return state.requestId
}

/*
 * 判定 requestId 是否属于当前请求。
 * idle 永远不接受异步事件；其余状态要求 requestId 与状态携带的当前请求严格相等。
 */
function isCurrent<TResource extends DisposableResource>(
  state: LoadState<TResource>,
  requestId: number,
): boolean {
  if (state.kind === 'idle') return false
  return state.requestId === requestId
}

/*
 * 把 preparing 阶段的材料更新应用后判定是否越过 ready 门禁（任务“ready 门禁”）。
 *
 * 门禁规则：model、resources 均非空且 fontReady = true → 一次性进入 ready；
 * 否则停留在 preparing，保留已就绪材料，等待剩余门禁。三道门禁以任意顺序完成后都只提交一次 ready。
 */
function advancePreparing<TResource extends DisposableResource>(
  prep: Extract<LoadState<TResource>, { readonly kind: 'preparing' }>,
  patch: Partial<
    Omit<
      Extract<LoadState<TResource>, { readonly kind: 'preparing' }>,
      'kind' | 'requestId'
    >
  >,
): LoadReducerResult<TResource> {
  const next = { ...prep, ...patch }
  if (next.model !== null && next.resources !== null && next.fontReady) {
    return {
      state: {
        kind: 'ready',
        requestId: next.requestId,
        model: next.model,
        resources: next.resources,
      },
      released: [],
    }
  }
  return { state: next, released: [] }
}

/*
 * 从一个状态收集它当前持有的可释放资源（用于被取代 / error / abort 时进入 released）。
 * idle / loading / error 不持有资源；preparing 可能持有部分资源；ready 持有完整资源。
 */
function ownedResources<TResource extends DisposableResource>(
  state: LoadState<TResource>,
): readonly TResource[] {
  if (state.kind === 'preparing') {
    return state.resources !== null ? [state.resources] : []
  }
  if (state.kind === 'ready') {
    return [state.resources]
  }
  return []
}

/*
 * 加载状态机纯 reducer 主入口（SPEC 4.2 / 任务约束）。
 *
 * 调用方契约：
 *   - 输入当前不可变状态与一条事件；返回新状态与需释放资源清单。
 *   - 不改变输入状态（返回新对象）；不执行任何副作用。
 *
 * 转换规则要点：
 *   - start：严格单调（requestId > 当前）；释放旧状态资源；进入 loading。
 *   - progress：仅在 loading / preparing 且 requestId 匹配时采纳；loading → preparing 首次切换。
 *   - model-arrived / resources-created / font-ready：仅在 preparing 且 requestId 匹配时累加材料并判门禁。
 *   - model-failed / resource-creation-failed / font-failed：当前阶段失败 → error，释放部分资源。
 *   - abort：无条件回到 idle，释放当前请求全部资源（卸载 / HMR）。
 *   - 其余情况（过期事件、idle 收到异步事件）静默忽略，状态不变、released 为空。
 */
export function reduceLoadState<TResource extends DisposableResource>(
  state: LoadState<TResource>,
  event: LoadEvent<TResource>,
): LoadReducerResult<TResource> {
  switch (event.type) {
    case 'start': {
      // start 必须严格单调递增；非递增视为无效（防止回退覆盖当前请求）。
      if (event.requestId <= currentRequestIdOf(state)) {
        return { state, released: [] }
      }
      // 新请求取代旧状态：旧资源进入 released，由 orchestrator 幂等释放。
      return {
        state: { kind: 'loading', requestId: event.requestId },
        released: ownedResources(state),
      }
    }

    case 'progress': {
      if (!isCurrent(state, event.requestId)) {
        return { state, released: [] }
      }
      if (state.kind === 'loading') {
        if (event.phase === 'loading') {
          // 仍在请求样本阶段：保持 loading。
          return { state, released: [] }
        }
        // loading → preparing：首次进入准备阶段，材料尚未到达。
        return {
          state: {
            kind: 'preparing',
            requestId: state.requestId,
            stage: event.stage,
            model: null,
            resources: null,
            fontReady: false,
          },
          released: [],
        }
      }
      if (state.kind === 'preparing') {
        // preparing 内子阶段更新；不退回 loading（后续阶段只前进）。
        if (event.phase === 'preparing') {
          return advancePreparing(state, { stage: event.stage })
        }
        return { state, released: [] }
      }
      // ready / error 收到的进度视为过期，忽略。
      return { state, released: [] }
    }

    case 'model-arrived': {
      if (!isCurrent(state, event.requestId) || state.kind !== 'preparing') {
        // 过期或非 preparing 的 model：不存储 → 引用脱离状态、可被 GC（任务约束）。
        return { state, released: [] }
      }
      return advancePreparing(state, { model: event.model })
    }

    case 'resources-created': {
      if (!isCurrent(state, event.requestId) || state.kind !== 'preparing') {
        // 过期资源：reducer 不接管；orchestrator 已在派发前判定并直接释放。
        return { state, released: [] }
      }
      return advancePreparing(state, { resources: event.resources })
    }

    case 'font-ready': {
      if (!isCurrent(state, event.requestId) || state.kind !== 'preparing') {
        return { state, released: [] }
      }
      return advancePreparing(state, { fontReady: true })
    }

    case 'model-failed':
    case 'resource-creation-failed':
    case 'font-failed': {
      // 内联 kind 判定以收窄联合：idle 无 requestId 且不接受异步事件；
      // 其余变体要求 requestId 与当前请求严格相等（过期失败静默忽略）。
      if (state.kind === 'idle' || state.requestId !== event.requestId) {
        return { state, released: [] }
      }
      // 当前阶段任一失败：整体进入 error，携带统一 phase / failureStage（SPEC 14.1
      // overlay 据此显示阶段），并释放本次已创建的部分资源（任务约束）。
      return {
        state: {
          kind: 'error',
          requestId: state.requestId,
          error: event.error,
          phase: event.phase,
          failureStage: event.failureStage,
        },
        released: ownedResources(state),
      }
    }

    case 'abort': {
      // 卸载 / HMR：无条件回到 idle，释放当前请求全部资源（幂等清理）。
      return {
        state: { kind: 'idle' },
        released: ownedResources(state),
      }
    }

    default: {
      return { state, released: [] }
    }
  }
}
