import { applyLoadStateCommand } from './loadState'
import type { LoadStateCommand, MapSceneState } from './loadState'

/**
 * 加载会话控制器：单一有效会话、取消与过期结果隔离（SPEC §5.4、TASK-006）。
 *
 * 该模块是 application 层的"取消与生命周期协调"（SPEC §5.1）。它把纯状态机包裹成可观察、
 * 可取消、可隔离过期结果的会话，供后续加载用例与展示层订阅。
 *
 * 不变量：
 * - 单一有效会话：start() 递增 requestId 并重置状态；旧 requestId 立即失效，
 *   旧会话的进度、成功或失败结果都不能覆盖当前状态（SPEC §5.4）。
 * - 取消隔离：cancel() 后即使 requestId 匹配也不再写入状态，永远不会进入 ready。
 *   取消不改变已暴露的状态（冻结在当前位置），由展示层决定后续呈现。
 * - 纯状态机驱动：所有状态变更经 applyLoadStateCommand 校验，非法转换被拒绝且不影响当前状态。
 * - 无隐式全局：控制器实例自持状态，不读写模块级可变对象，可被多实例独立驱动与回收，
 *   满足 React StrictMode 重复挂载不产生重复监听或状态串扰的要求（SPEC §5.4）。
 */

/** 状态变化监听器；接收当前状态快照（null 表示尚未启动）。 */
export type LoadSessionListener = (state: MapSceneState | null) => void

/** apply 命令的可观察结果，便于调用方区分过期、拒绝与正常写入。 */
export type ApplyOutcome = 'applied' | 'stale' | 'rejected'

export class LoadSessionController {
  private state: MapSceneState | null = null
  private requestId = 0
  private cancelled = false
  private readonly listeners = new Set<LoadSessionListener>()

  /** 当前状态；null 表示尚未启动任何会话。 */
  getState(): MapSceneState | null {
    return this.state
  }

  /** 当前会话 requestId；尚未启动时为 0，每次 start 递增。 */
  getCurrentRequestId(): number {
    return this.requestId
  }

  /**
   * 启动新会话。递增 requestId、清除取消标记、重置状态为下载初始态。
   * 旧会话的 requestId 不再匹配，其后续结果被自动隔离。
   * @returns 新会话的 requestId，调用方应仅以该 id 提交结果。
   */
  start(): number {
    this.requestId += 1
    this.cancelled = false
    const result = applyLoadStateCommand(this.state, { type: 'start' })
    // start 可从任何状态（含 null、ready、error）重置，恒为 ok。
    if (result.ok) {
      this.state = result.state
      this.emit()
    }
    return this.requestId
  }

  /**
   * 判定给定 requestId 是否属于当前有效（未取消、未被取代）会话。
   * requestId 为 0（从未启动）或被新会话取代、或已取消时均返回 false。
   */
  isActive(requestId: number): boolean {
    return !this.cancelled && requestId > 0 && requestId === this.requestId
  }

  /**
   * 取消当前会话。此后任何结果（即使 requestId 匹配）都不再写入状态，也不会进入 ready。
   * 适用于组件卸载场景：调用方在卸载时 cancel()，丢弃所有在途异步结果。
   */
  cancel(): void {
    this.cancelled = true
  }

  /**
   * 应用一条加载命令。仅当 requestId 匹配当前未取消会话、且状态机接受该转换时才写入。
   *
   * start 命令被拒绝——启动新会话必须经 start()，以生成新的 requestId 并隔离旧会话结果；
   * 直接 apply start 会绕过 requestId 递增，使在途的旧结果仍能覆盖重置后的状态。
   *
   * @returns 'applied' 已写入；'stale' requestId 过期或会话已取消，结果被隔离；'rejected' 状态机拒绝该转换。
   */
  apply(command: LoadStateCommand, requestId: number): ApplyOutcome {
    if (command.type === 'start') return 'rejected'
    if (!this.isActive(requestId)) return 'stale'
    const result = applyLoadStateCommand(this.state, command)
    if (!result.ok) return 'rejected'
    this.state = result.state
    this.emit()
    return 'applied'
  }

  /**
   * 订阅状态变化。状态每次成功写入时回调监听器；返回取消订阅函数。
   *
   * 不立即回调当前状态——调用方通过 getState() 读取初始快照，契合 useSyncExternalStore
   * 语义（subscribe 只注册、getSnapshot 只读）。监听器集合去重，重复订阅同一函数引用
   * 不会重复回调（SPEC §5.4 重复挂载安全）。
   */
  subscribe(listener: LoadSessionListener): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  private emit(): void {
    for (const listener of this.listeners) {
      listener(this.state)
    }
  }
}
