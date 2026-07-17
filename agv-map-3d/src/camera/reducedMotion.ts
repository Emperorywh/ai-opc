/*
 * 减少动态偏好与相机阻尼决策（camera 层，SPEC §12.5 / §16 / 任务约束）。
 *
 * 信任边界定位（TASK-020）：
 *   - 本模块集中表达 SPEC §12.5 “prefers-reduced-motion: reduce 时关闭 damping”的纯决策：
 *     把媒体查询字符串与“是否启用阻尼”的映射抽为可脱离浏览器单测的常量与纯函数。
 *     matchMedia 事件接线归 app-root 的 MapCameraController，不在本层依赖浏览器 API。
 *
 * reduced-motion 不变量（SPEC §12.5 / 任务“只改变阻尼过程，不得改变允许的操作、
 *   最终相机位置、视觉内容或启用自动低质量模式”）：
 *   - prefersReducedMotion = true → enableDamping = false：旋转 / 缩放的离散输入单帧到位。
 *   - prefersReducedMotion = false → enableDamping = true：保持 SPEC §12.4 dampingFactor = 0.08
 *     的平滑过程；由于 OrbitControls 阻尼下离散旋转累计收敛到同一角度（几何级数和 = 输入角），
 *     最终相机位置与关闭阻尼时一致，仅过程不同。
 *   - 该决策不影响允许的键位、target clamp、near/far、视觉内容或渲染质量。
 *
 * 依赖方向（SPEC 3.3）：仅依赖本层自身，是纯数据 / 纯函数；
 *   不依赖 Three / R3F / React / 浏览器 API。
 */

/*
 * SPEC §12.5：减少动态效果的系统媒体查询。
 * 由事件接线层传入 window.matchMedia，本常量是唯一查询字符串来源，
 * 避免在组件中散落第二份查询文本。
 */
export const REDUCED_MOTION_MEDIA_QUERY = '(prefers-reduced-motion: reduce)'

/*
 * 由减少动态偏好推导 OrbitControls.enableDamping（SPEC §12.5）。
 *
 * 调用方契约：
 *   - prefersReducedMotion：matchMedia(query).matches 的当前值（true = 用户请求减少动态）。
 *   - 返回值写入 controls.enableDamping；dampingFactor 保持 orbitControlsContract 的 0.08 不变。
 *
 * 不变量：reduce → false（关闭阻尼）；无偏好 → true（保持阻尼）。最终相机位置不受该值影响。
 */
export function dampingEnabledForMotion(
  prefersReducedMotion: boolean,
): boolean {
  return !prefersReducedMotion
}
