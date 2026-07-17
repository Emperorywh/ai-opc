/*
 * 统一键盘导航事件接线（app-root 层，SPEC §12.5 / §13 / 任务约束）。
 *
 * 信任边界定位（TASK-020）：
 *   - 本模块是“window keydown → 焦点边界判定 → preventDefault → 派发结构化意图”的纯 DOM 接线，
 *     把 SPEC §12.5 的焦点边界与默认行为抑制规则集中为可脱离 Three / R3F 单测的工厂函数。
 *   - 相机意图 → 相机写入由调用方（MapCameraController）经回调完成；本模块不接触 camera / controls /
 *     Three，只消费 camera/keyboardIntent 的纯决策（decideKeyConsumption）。
 *
 * 焦点边界不变量（SPEC §12.5 / 任务“仅在地图容器拥有焦点且键位被本系统消费时阻止默认行为”）：
 *   - 仅当 container 非 null 且 document.activeElement 落在 container 内（容器或其内容拥有焦点）
 *     时才进入消费判定；否则直接 return，不 preventDefault、不派发意图（不劫持页面全局键盘）。
 *   - 若焦点元素本身是可编辑控件（input / textarea / select / contenteditable），亦不消费，
 *     避免劫持页面文本输入。
 *
 * 默认行为抑制范围不变量（SPEC §12.5 / 任务“不得劫持页面全局键盘输入”）：
 *   - 仅当 decideKeyConsumption 判定 consume = true 时才 event.preventDefault()；未知键放行。
 *
 * 重复按键不变量（SPEC §12.5 / 任务验证方式第 4 项“长按重复”）：
 *   - 每次 keydown（含 event.repeat 自动重复）均按新一次按键处理：长按方向键 / +/- / Q/E 产生连续
 *     平移 / 缩放 / 旋转；Home 重复仅重复复位（幂等，无副作用）。
 *
 * 按需渲染不变量（任务“每个被消费的键盘操作在完成同一相机状态更新后显式请求 demand 帧；
 *   未消费按键不得触发渲染”）：
 *   - 未消费按键本模块不派发意图、不 preventDefault → 调用方不触发任何相机更新或 invalidate。
 *
 * 依赖方向（SPEC 3.3）：app-root 允许 camera / 浏览器 DOM；本模块不依赖 React / R3F / Three，
 *   故 jsdom 集成测试可在不挂载 WebGL 的情况下验证焦点边界与消费范围。
 */
import { decideKeyConsumption } from './camera/keyboardIntent'
import type {
  PanIntent,
  RotateIntent,
  ZoomIntent,
} from './camera/keyboardIntent'

/*
 * 键盘导航意图派发回调（SPEC §12.5）。由 createMapKeyboardHandler 在消费按键后调用，
 * 把结构化意图交回控制器拥有的相机用例；handler 本身不接触 Three / camera 状态。
 */
export interface KeyboardNavigationCallbacks {
  onPan(intent: PanIntent): void
  onZoom(intent: ZoomIntent): void
  onRotate(intent: RotateIntent): void
  onHome(): void
}

/*
 * 判断当前焦点元素是否为可编辑控件（SPEC §12.5 / 任务“不劫持可编辑控件输入”）。
 * input / textarea / select 或 contenteditable 一律视为可编辑，键盘层不消费其按键。
 */
function isEditableElement(el: HTMLElement): boolean {
  const tag = el.tagName
  return (
    tag === 'INPUT' ||
    tag === 'TEXTAREA' ||
    tag === 'SELECT' ||
    el.isContentEditable
  )
}

/*
 * 创建统一键盘导航 handler（SPEC §12.5 / 任务约束）。
 *
 * 调用方契约：
 *   - container：可聚焦的地图外层容器（app-root 注入）；null 表示尚未挂载，handler 不消费任何按键。
 *   - callbacks：四种意图的相机用例回调，由 MapCameraController 提供。
 *   - 返回一个 keydown handler，调用方挂到 window（或容器）；cleanup 时 removeEventListener。
 *
 * 导出供 jsdom 集成测试在不挂载 Three 的情况下验证焦点边界 / 消费范围 / 重复按键 / preventDefault。
 */
export function createMapKeyboardHandler(
  container: HTMLElement | null,
  callbacks: KeyboardNavigationCallbacks,
): (event: KeyboardEvent) => void {
  return (event: KeyboardEvent) => {
    // 焦点边界：容器未挂载或焦点不在容器内 → 不消费（不劫持页面全局键盘）。
    if (container === null) return
    const active = document.activeElement
    if (active === null || !container.contains(active)) return
    // 可编辑控件来源：不劫持文本输入。
    const fromEditable =
      active instanceof HTMLElement && isEditableElement(active)
    const decision = decideKeyConsumption({
      key: event.key,
      isFromEditableTarget: fromEditable,
    })
    if (!decision.consume) return
    // 仅消费时阻止默认行为（如方向键页面滚动），不劫持无关按键。
    event.preventDefault()
    const intent = decision.intent
    switch (intent.kind) {
      case 'pan':
        callbacks.onPan(intent)
        break
      case 'zoom':
        callbacks.onZoom(intent)
        break
      case 'rotate':
        callbacks.onRotate(intent)
        break
      case 'home':
        callbacks.onHome()
        break
      case 'none':
        break
    }
  }
}
