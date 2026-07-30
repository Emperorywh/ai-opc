/**
 * 大屏长时运行生命周期的确定性状态机与 resize 防抖（领域层，TASK-015，SPEC §7.4）。
 *
 * 角色与依赖方向：
 * - 本模块属于领域层（src/lib），把「WebGL context 丢失 / 恢复事件 + resize 尺寸输入」确定性变换为
 *   「显式运行时阶段 + 防抖后的最终尺寸」。它是纯函数 / 纯状态变换，不依赖 React / R3F / Three.js /
 *   DOM / 计时器，故自动化测试可在 Node 环境完整覆盖「context 状态迁移正确」「resize 防抖只产生有限
 *   次提交且最终尺寸 = 最后一次输入」「非法迁移被忽略」等不变量，无需启动浏览器 / WebGL（人工恢复与
 *   连续 resize 的端到端验收见 docs/performance-measurement-record.md 的无头验证记录）。
 *
 * 生命周期状态迁移（集中编排：生命周期状态集中编排，场景层和 UI 只消费状态）：
 * - 阶段空间：running（正常运行）→ context-lost（context 丢失，渲染暂停）→ restoring（context 已恢复，
 *   重建 GPU 资源中）→ running（恢复成功，回到正常运行）或 restore-failed（恢复失败，显式终态 + 诊断）。
 * - 迁移规则由 reduceRuntimeLifecycle 纯函数确定性表达：非法迁移（如 running 直接收到 restore-succeeded）
 *   被忽略（保持原状态），避免错误事件破坏不变量。场景层与 UI 只消费阶段（phase + failureMessage），
 *   不各自监听 context 事件、不各自维护阶段。
 *
 * GPU 资源恢复与 CPU 领域数据生命周期分离（不得因 context 丢失重复解码 32MB 高程数组或重复下载资产）：
 * - 本状态机不持有 / 不接触 CPU 高程像素（Uint16Array）或任何资产数据——它只产出阶段。CPU 领域资产由
 *   App 根部的资产 hook（useHeightmap 等）一次性加载，跨 context 丢失 / 恢复保持同一引用（React state
 *   不因 context 事件重置），渲染层在恢复阶段只对 GPU 纹理打 needsUpdate=true（复用同一份 CPU 像素重建
 *   GPU 纹理），绝不重新 fetch / 重新解码 .r16——本状态机的阶段是「是否需要 / 是否完成 GPU 重建」的信号，
 *   不是「是否需要重新取数」的信号。
 *
 * resize 防抖（防抖不得吞掉最终尺寸，不得依赖浏览器自动刷新解决错乱）：
 * - 防抖状态（ResizeDebouncerState）以纯变换表达：recordResizeInput 只把最新尺寸记入 pending（连续输入
 *   只保留最后一次），commitPendingResize 把 pending 提交为 committed（commitCount++）。定时常由运行时层
 *   （RuntimeLifecycleController 的 setTimeout）承载，本模块只负责「记什么 / 提交什么」的确定性语义——
 *   自动化测试可直接断言「连续 N 次输入 + 一次提交 → committed = 最后一次输入、commitCount = 1」。
 *
 * 无分配 / 无隐式状态（SPEC §7.4「无运行时几何分配循环」「动画时钟统一」）：
 * - 本模块不创建 THREE.Clock / setInterval / 闭包计时器；所有变换是 (state, event) → state 的纯函数。
 *   计时器 / 监听器由运行时层单点注册、单点清理，本模块只提供它们所变换的确定性语义。
 */

/**
 * 运行时生命周期阶段（显式状态空间，集中编排的唯一信号源）。
 *
 * - running：正常运行（含初始态与恢复成功后的回归态）。
 * - context-lost：WebGL context 丢失——渲染暂停、不推进视觉状态（入场 elapsed / 水面 uTime 冻结）。
 * - restoring：context 已恢复（浏览器触发 webglcontextrestored），正在重建 GPU 资源。
 * - restore-failed：GPU 资源重建失败——显式终态，带诊断信息；不进入空白死循环、不自动请求外部资源 /
 *   回退旧实现（恢复失败必须显式暴露，不提供低清、平面、旧资产或远程 fallback）。
 *
 * 注：恢复成功不设独立 'restored' 终态而直接回到 running——restored 与 running 在「页面是否正常运行」上
 * 语义等价（交互 / 渲染 / 入场均正常），独立阶段只增加 UI 分支而无新行为；onPhaseChange 回调在
 * restoring→running 切换帧仍会通知上层（使 DOM 可短暂提示「已恢复」，见 RuntimeStatusOverlay），但阶段
 * 本身归一为 running，避免状态空间膨胀。
 */
export type RuntimeLifecyclePhase =
  | 'running'
  | 'context-lost'
  | 'restoring'
  | 'restore-failed'

/**
 * 驱动生命周期迁移的事件（由运行时层从 DOM 事件翻译而来）。
 *
 * 运行时层（RuntimeLifecycleController）是唯一监听 webglcontextlost / webglcontextrestored 的组件；它把这些
 * 浏览器事件 + GPU 重建结果翻译为本类型的纯事件，喂给 reduceRuntimeLifecycle。场景层 / UI 不各自发事件。
 */
export type RuntimeLifecycleEvent =
  | { readonly type: 'context-lost' }
  | { readonly type: 'context-restored' }
  | { readonly type: 'restore-succeeded' }
  | { readonly type: 'restore-failed'; readonly message: string }

/** 生命周期状态（阶段 + 失败诊断）。 */
export interface RuntimeLifecycleState {
  /** 当前阶段。 */
  readonly phase: RuntimeLifecyclePhase
  /** 恢复失败诊断（restore-failed 时为非空串，供 DOM 诊断显示；其余态为 null）。 */
  readonly failureMessage: string | null
}

/** 初始生命周期状态（挂载即 running——context 尚未丢失）。 */
export const INITIAL_RUNTIME_LIFECYCLE_STATE: RuntimeLifecycleState = Object.freeze({
  phase: 'running',
  failureMessage: null,
})

/**
 * 生命周期状态迁移规则（纯函数，确定性）。
 *
 * 合法迁移：
 * - running / restore-failed + context-lost → context-lost（context 可在任何运行态丢失；restore-failed 后若
 *   浏览器再次丢失 / 恢复 context，仍可重新走 restoring→running，给大屏一次自愈机会）。
 * - context-lost + context-restored → restoring（浏览器恢复了 context，开始重建 GPU 资源）。
 * - restoring + restore-succeeded → running（GPU 重建成功，回归正常运行）。
 * - restoring + restore-failed → restore-failed（GPU 重建抛错，显式终态 + 诊断）。
 * - context-lost + restore-failed → restore-failed（context 恢复超时——浏览器未在超时内触发 restored，
 *   显式终态 + 诊断，避免 context-lost 无限空白等待）。
 *
 * 非法迁移被忽略（返回原状态），避免错误事件破坏不变量：
 * - running + context-restored：context 未丢失谈不上恢复（忽略）。
 * - context-lost + restore-succeeded/failed：未进入 restoring 谈不上重建结果（忽略）。
 * - restoring + context-lost：restoring 期间再次丢失由「context-lost 可从 running 类态迁移」覆盖——
 *   restoring 不在此列，故忽略；浏览器若在 restoring 期间再次丢失，会先回到 context-lost（由丢失事件
 *   本身在 RuntimeLifecycleController 内部判定当前是否 running 类态决定是否接受，见控制器注释）。
 */
export function reduceRuntimeLifecycle(
  state: RuntimeLifecycleState,
  event: RuntimeLifecycleEvent,
): RuntimeLifecycleState {
  switch (event.type) {
    case 'context-lost':
      // running 与 restore-failed 均属「正常运行类」态，context 可从此丢失。
      if (state.phase === 'running' || state.phase === 'restore-failed') {
        return { phase: 'context-lost', failureMessage: null }
      }
      return state
    case 'context-restored':
      // 只有 context-lost 可收到恢复事件。
      if (state.phase === 'context-lost') {
        return { phase: 'restoring', failureMessage: null }
      }
      return state
    case 'restore-succeeded':
      // 只有 restoring 可收到重建成功。
      if (state.phase === 'restoring') {
        return { phase: 'running', failureMessage: null }
      }
      return state
    case 'restore-failed':
      // restoring（GPU 重建抛错）或 context-lost（恢复超时——浏览器未在超时内触发 restored）均可进入
      // restore-failed 终态。两条路径都附诊断信息，使「重建失败」与「context 恢复超时」均可被 DOM 诊断呈现，
      // 不进入空白死循环。
      if (state.phase === 'restoring' || state.phase === 'context-lost') {
        return { phase: 'restore-failed', failureMessage: event.message }
      }
      return state
    default:
      return state
  }
}

/**
 * 是否处于「暂停推进视觉状态」的阶段（context-lost / restoring）。
 *
 * 运行时层据此单一布尔冻结入场 elapsed 与水面 uTime（见 EntranceController / SeaSurface 对 runtimeFrame
 * 的消费）：context-lost 时 WebGL context 已失效，继续推进视觉状态无意义且会在「黑暗中」放完入场动画；
 * restoring 时 GPU 资源尚未重建完成，推进视觉状态会基于残缺资源渲染。running / restore-failed 不暂停——
 * running 正常渲染；restore-failed 虽不渲染恢复后的画面，但 DOM 诊断已覆盖，无需再冻结视觉时钟。
 */
export function isRuntimePaused(phase: RuntimeLifecyclePhase): boolean {
  return phase === 'context-lost' || phase === 'restoring'
}

/**
 * 是否处于需要 DOM 诊断显示的恢复失败终态。
 *
 * 供 RuntimeStatusOverlay 决定是否覆盖可诊断信息（恢复失败时显示可诊断状态）。
 */
export function isRuntimeFailed(phase: RuntimeLifecyclePhase): boolean {
  return phase === 'restore-failed'
}

/**
 * 单帧共享运行时帧（RuntimeLifecycleController 写入、各 useFrame 消费者只读）。
 *
 * 这是「集中编排 → 各消费者」的运行时载体：phase + paused。各渲染层（EntranceController / SeaSurface）
 * 据此决定是否冻结视觉状态推进，不由组件私自监听 context 事件（场景层只消费状态）。
 *
 * 字段刻意**非 readonly**（与 EntranceFrame 同理，SPEC §7.4「无运行时几何分配循环」）：
 * RuntimeLifecycleController 在阶段切换时「原地改写」本对象的 phase / paused 字段，而非整对象替换。
 * 对象本身由 App 的 useRef 一次性创建、同 fiber 跨重渲染保持同一引用，原地改写零分配。
 */
export interface RuntimeFrame {
  /** 当前生命周期阶段（由 RuntimeLifecycleController 写入；非 readonly 以允许原地写）。 */
  phase: RuntimeLifecyclePhase
  /** 是否暂停推进视觉状态（由 isRuntimePaused(phase) 派生；非 readonly 以允许原地写）。 */
  paused: boolean
}

/**
 * resize 防抖状态（纯变换，定时常由运行时层承载）。
 *
 * - pending：防抖窗口内最后一次输入的尺寸（连续输入只保留最后一次——防抖的核心不变量）。
 * - committed：最近一次提交的尺寸（commit 后更新；overlay / 相机 / 渲染器据此同步）。
 * - commitCount：累计提交次数（自动化测试据此断言「连续 N 次输入只产生有限次提交」）。
 */
export interface ResizeDebouncerState {
  readonly pending: { readonly width: number; readonly height: number } | null
  readonly committed: { readonly width: number; readonly height: number } | null
  readonly commitCount: number
}

/** 初始防抖状态（无 pending、无 committed、0 次提交）。 */
export const INITIAL_RESIZE_DEBOUNCER_STATE: ResizeDebouncerState = Object.freeze({
  pending: null,
  committed: null,
  commitCount: 0,
})

/**
 * 记录一次 resize 输入（不立即提交，只把 pending 更新为最新尺寸）。
 *
 * 防抖语义：连续输入只保留最后一次——这是「最终尺寸必须等于最后一次输入」的结构性保证
 * （resize 防抖不得吞掉最终尺寸）。非法尺寸（非有限 / 非正）被忽略，不污染 pending。
 */
export function recordResizeInput(
  state: ResizeDebouncerState,
  width: number,
  height: number,
): ResizeDebouncerState {
  // 非法尺寸（非有限 / 非正）忽略——不把脏值记入 pending，避免提交后撑爆渲染器 / 相机。
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    return state
  }
  return {
    ...state,
    pending: { width: Math.round(width), height: Math.round(height) },
  }
}

/**
 * 提交待处理的尺寸（防抖窗口结束后由运行时层调用）。
 *
 * - 无 pending → 无操作（返回原状态、committed=null）。
 * - pending 与 committed 相同 → 无操作（尺寸未变，不重复提交——「有限次更新」的保证）。
 * - 否则 → 提交 pending 为 committed，commitCount++，返回 { state, committed }。
 *
 * 返回值同时携带本次提交的尺寸（或 null），使运行时层据此决定是否触发相机 / 渲染器 / overlay 同步
 * （无提交则跳过，零开销）。
 */
export function commitPendingResize(
  state: ResizeDebouncerState,
): {
  readonly state: ResizeDebouncerState
  readonly committed: { readonly width: number; readonly height: number } | null
} {
  if (state.pending === null) {
    return { state, committed: null }
  }
  const prev = state.committed
  if (
    prev !== null &&
    prev.width === state.pending.width &&
    prev.height === state.pending.height
  ) {
    // 尺寸未变：不重复提交（commitCount 不增），但仍清空 pending（该输入已被「考虑」过）。
    return { state: { ...state, pending: null }, committed: null }
  }
  const committed = state.pending
  return {
    state: { pending: null, committed, commitCount: state.commitCount + 1 },
    committed,
  }
}
