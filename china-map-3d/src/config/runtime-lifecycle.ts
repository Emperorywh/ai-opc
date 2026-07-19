/**
 * 大屏长时运行恢复生命周期的运行时参数——唯一事实源（TASK-022）。
 *
 * 角色与依赖方向：
 * - 本模块属于运行时配置层（src/config），是「context 丢失后等待恢复的超时、resize 防抖窗口」的**唯一**
 *   权威。运行时控制器（src/three/RuntimeLifecycleController）、自动化测试都只能通过本模块取得这些参数——
 *   禁止在控制器 / 测试里各自复制一份超时或防抖常量（TASK-022 实现约束「不得隐式状态、跨层耦合」）。
 * - 单向依赖：本模块不依赖 React / R3F / Three.js / DOM（纯数值常量），故自动化测试可在 Node 环境直接
 *   断言「防抖窗口为正有限」「超时为正有限」等不变量（TASK-022 验证方式 1）。
 *
 * context 丢失后等待恢复的超时（TASK-022 输出约束「恢复失败时显示可诊断状态，不进入空白死循环」）：
 * - context-lost 阶段下，若浏览器在超时内未触发 webglcontextrestored，控制器把状态迁移到 restore-failed
 *   并附「context 恢复超时」诊断——这使「context 丢失后永不恢复」的场景有显式终态而非无限等待。
 * - 取 8 秒：远长于浏览器常规 context 恢复延迟（通常 < 1 秒），又不过长（大屏运维能及时看到诊断）。
 *
 * resize 防抖窗口（TASK-022 实现约束「resize 事件经过防抖后更新渲染器、相机和 overlay 所需尺寸」）：
 * - 每次尺寸变化重置定时器，窗口内无新变化才提交——连续拖拽 resize 只在停顿后提交一次最终尺寸，
 *   不产生更新风暴。取 160ms：人手拖拽窗口的帧间间隙通常 < 100ms，160ms 能稳定识别「拖拽暂停」，
 *   又不过长（用户感知不到延迟）。
 */

/**
 * context 丢失后等待 webglcontextrestored 的超时（毫秒）。
 *
 * 超时后控制器迁移到 restore-failed（显式终态 + 诊断），避免 context-lost 无限等待。8 秒远长于浏览器常规
 * 恢复延迟，正常恢复路径不会误触超时。
 */
export const RUNTIME_CONTEXT_RESTORE_TIMEOUT_MS = 8000

/**
 * resize 防抖窗口（毫秒）。
 *
 * 尺寸变化后等待本窗口内无新变化才提交最终尺寸。160ms 平衡「过滤连续拖拽」与「无明显延迟」。
 */
export const RUNTIME_RESIZE_DEBOUNCE_MS = 160

/**
 * 运行时生命周期参数（冻结）。
 *
 * 控制器与测试共享的同一份事实源：context 恢复超时 + resize 防抖窗口。冻结防止运行时被偷偷改（如把防抖
 * 改 0 会退化为逐次提交造成更新风暴、把超时改 0 会误把正常恢复判为失败），任何调整都必须改本模块并同步测试。
 */
export const RUNTIME_LIFECYCLE_CONFIG = Object.freeze({
  /** context 丢失后等待恢复的超时（毫秒）。 */
  contextRestoreTimeoutMs: RUNTIME_CONTEXT_RESTORE_TIMEOUT_MS,
  /** resize 防抖窗口（毫秒）。 */
  resizeDebounceMs: RUNTIME_RESIZE_DEBOUNCE_MS,
})
