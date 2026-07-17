/*
 * 相机浏览导航状态机（camera 层，SPEC §12.4 / 任务约束）。
 *
 * 信任边界定位（TASK-019）：
 *   - 本模块是“用户是否已浏览”与“resize / Home 应采取的视图动作”的纯决策核心：把 SPEC §12.4
 *     的 hasUserNavigated 分支规则集中为可脱离浏览器与 React 单测的纯函数。
 *   - 单一相机状态所有者不变量（任务约束）：OrbitControls.target 与 camera.position 是 target /
 *     距离 / 朝向的唯一事实来源；hasUserNavigated 标记唯一由控制器持有，本模块只给出该标记在
 *     各事件下的转换与对应视图动作，不维护第二套 target / 距离 / 朝向。
 *
 * resize 分支不变量（SPEC §12.4 / 任务约束）：
 *   - 用户尚未浏览时，resize 重新执行标准 3/4 fit（与首次 fit 等价）。
 *   - 用户已浏览后，resize 保留 target / 距离 / 朝向，仅更新 aspect / 裁剪面 / 标签查询所需状态，
 *     不重置视图（任务“resize 不会在用户已导航后重置视图”）。
 *
 * Home 复位不变量（SPEC §12.4 / 任务约束）：
 *   - Home 重新执行标准 3/4 fit 并把 hasUserNavigated 置回 false；此后状态等价于“未浏览”，
 *     后续 resize 进入重新 fit 分支，直到用户再次交互。
 *
 * 依赖方向（SPEC 3.3）：仅依赖本层自身，是纯函数；
 *   不依赖 Three / R3F / React / 浏览器 API。
 */

/*
 * 用户导航标记（SPEC §12.4 hasUserNavigated）。
 * true：用户已 orbit / pan / zoom，resize 不应重置视图；false：尚未浏览，resize 重新 fit。
 */
export type NavigationFlag = boolean

/*
 * 视图动作：fit = 重新执行标准 3/4 fit；preserve = 保留当前 target / 距离 / 朝向。
 */
export type ViewAction = 'fit' | 'preserve'

/*
 * 导航决策结果：转换后的导航标记 + 应采取的视图动作。
 */
export interface NavigationDecision {
  readonly flag: NavigationFlag
  readonly action: ViewAction
}

/*
 * 用户开始交互（OrbitControls 'start'）：标记已浏览（SPEC §12.4）。
 *
 * 视图动作不适用（用户正直接驱动相机，既非 fit 也非 preserve）；返回 preserve 仅表示
 * “不主动 fit”，实际相机位由 OrbitControls 事件流更新。flag 恒置 true。
 */
export function onUserInteractionStart(): NavigationDecision {
  return { flag: true, action: 'preserve' }
}

/*
 * resize 视图动作判定（SPEC §12.4 / 任务“resize 不会在用户已导航后重置视图”）。
 *
 * 未导航 → fit（重新执行标准 3/4 fit，与首次 fit 等价）；已导航 → preserve（保留 target / 距离 /
 * 朝向，仅更新 aspect / 裁剪面）。导航标记不变：resize 本身不改变“是否已浏览”。
 */
export function decideResizeAction(flag: NavigationFlag): NavigationDecision {
  return {
    flag,
    action: flag ? 'preserve' : 'fit',
  }
}

/*
 * Home 复位决策（SPEC §12.4）。
 *
 * 清除用户导航标记（flag = false）+ 重新执行标准 3/4 fit（action = 'fit'）。
 * 此后状态等价于“未浏览”，后续 resize 进入重新 fit 分支，直到用户再次交互。
 */
export function decideHomeReset(): NavigationDecision {
  return { flag: false, action: 'fit' }
}
