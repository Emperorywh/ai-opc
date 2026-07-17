/*
 * 标签可见集查询调度（labels 层，SPEC 11.3 第 8 项 / 16）。
 *
 * 信任边界定位（TASK-021）：
 *   - 本模块是“controls 事件 / resize → 是否立即查询可见集”的单一调度职责（SPEC 11.3 第 8 项）。
 *   - 纯决策：消费事件类型、当前单调时钟（显式传入）与上次查询时间，输出“是否查询 + 新调度状态”；
 *     不创建计时器、不注册帧回调、不接触 OrbitControls / R3F / 浏览器 API（任务约束）。
 *   - 实际可见集计算与差量挂载由调用方（后续 scene 层）在收到“应查询”后执行；
 *     本模块只决定时机，不维护已挂载标签集合。
 *
 * 调度契约不变量（SPEC 11.3 第 8 项 / 任务约束）：
 *   - controls 移动（'controls-change'）期间至多 10Hz 查询：距上次查询 >= 100ms 才查询，
 *     并把 lastQueryMs 更新为当前时钟；不足 100ms 的查询被节流跳过（不更新 lastQueryMs）。
 *   - controls 'end' 与 'resize' 立即查询一次：不受 10Hz 节流吞掉，且更新 lastQueryMs，
 *     保证连续移动末尾 / 尺寸变化后的最终状态不漏。
 *   - 初始状态 lastQueryMs = -∞，使首个 'controls-change' 必然查询。
 *
 * 单一调度职责不变量（任务约束）：
 *   - 频率限制只由本模块完成；调用方不得为每个标签注册事件 / 帧回调或第二套节流。
 *   - 时钟显式传入（nowMs），不在本模块内调用 Date.now / performance.now，保证决策确定性可单测。
 *
 * 依赖方向（SPEC 3.3）：仅依赖本层（labelVisibilityConfig）；外部仅 Node 内置；纯函数无副作用。
 */
import { LABEL_QUERY_MIN_INTERVAL_MS } from './labelVisibilityConfig'

/*
 * 触发可见集查询的事件类型（SPEC 11.3 第 8 项）。
 *   - 'controls-change'：OrbitControls 连续 change（含 damping 惯性），受 10Hz 节流。
 *   - 'controls-end'：OrbitControls 'end'（用户手势 / 惯性结束），立即查询。
 *   - 'resize'：画布尺寸变化，立即查询。
 */
export type VisibilityQueryEvent = 'controls-change' | 'controls-end' | 'resize'

/*
 * 调度状态：上次实际查询的单调时钟（毫秒）。初始为 -∞ 使首个 change 必然查询。
 * 不可变：每次决策返回新状态，调用方持有唯一状态实例，不形成第二套时钟。
 */
export interface VisibilitySchedulerState {
  readonly lastQueryMs: number
}

/*
 * 调度决策结果。
 *   - shouldQuery：本事件是否应立即执行一次可见集查询。
 *   - state：决策后的新调度状态（无论是否查询，调用方都应持有新状态；查询时更新 lastQueryMs）。
 */
export interface VisibilitySchedulerDecision {
  readonly shouldQuery: boolean
  readonly state: VisibilitySchedulerState
}

/*
 * 初始调度状态：lastQueryMs = -∞，使首个 'controls-change' 必然满足 >= 100ms 而查询。
 * 适用于场景首次 ready 后、用户尚未交互前的调度起点。
 */
export function initialVisibilitySchedulerState(): VisibilitySchedulerState {
  return { lastQueryMs: Number.NEGATIVE_INFINITY }
}

/*
 * 调度决策主入口（SPEC 11.3 第 8 项 / 任务约束）。
 *
 * 调用方契约：
 *   - state 为上次决策返回的新状态（唯一持有，不维护第二套时钟）。
 *   - event 为本次触发事件（controls-change / controls-end / resize）。
 *   - nowMs 为当前单调时钟（毫秒），由调用方从 performance.now() 等显式传入；本模块不读时钟。
 *
 * 决策（SPEC 11.3 第 8 项）：
 *   - 'controls-change'：shouldQuery = (nowMs - lastQueryMs) >= 100；查询时更新 lastQueryMs = nowMs，
 *     跳过时不更新（保持 10Hz 上限，且不因跳过而无限延后下一次查询时机）。
 *   - 'controls-end' / 'resize'：shouldQuery 恒为 true，立即查询并更新 lastQueryMs = nowMs，
 *     保证移动末尾 / 尺寸变化后的最终状态不被 10Hz 节流吞掉。
 */
export function decideVisibilityQuery(
  state: VisibilitySchedulerState,
  event: VisibilityQueryEvent,
  nowMs: number,
): VisibilitySchedulerDecision {
  // 'controls-end' / 'resize'：立即查询，不被节流吞掉（SPEC 11.3 第 8 项 / 任务约束）。
  if (event === 'controls-end' || event === 'resize') {
    return { shouldQuery: true, state: { lastQueryMs: nowMs } }
  }

  // 'controls-change'：10Hz 节流；距上次查询 >= 100ms 才查询并更新时钟（SPEC 11.3 第 8 项）。
  if (nowMs - state.lastQueryMs >= LABEL_QUERY_MIN_INTERVAL_MS) {
    return { shouldQuery: true, state: { lastQueryMs: nowMs } }
  }
  // 节流跳过：不更新 lastQueryMs，使下一次查询时机仍由上次实际查询时刻起算。
  return { shouldQuery: false, state }
}
