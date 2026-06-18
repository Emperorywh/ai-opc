/**
 * 输入适配器抽象（SPEC §9 / D20：鼠标 + 触控板为主，触屏同步支持）。
 *
 * Task 10 把 Task 09 内置在 SandboxControls 的 pointer/wheel 绑定抽成平台适配器：
 * 原生 DOM 事件 → 语义输入意图（pan / rotate / zoom）。控制器（cameraState.ts + SandboxControls）
 * 的状态机 / 约束 / 阻尼 **不变** —— 适配器只产出意图，由控制器消费并 clamp。
 *
 * 适配器职责切分（自由轨道范式：左键旋转 / 右键平移 / 滚轮缩放）：
 *  - `createMouseTrackpadAdapter`：鼠标 + 触控板统一。
 *    主键拖拽 → rotate（yaw/pitch）；右键拖拽 → pan（平移目标点）；
 *    wheel（滚轮 / 双指滚动 / pinch）→ zoom。触屏(pointerType=touch)交由 touch 适配器，本适配器忽略。
 *  - `createTouchAdapter`：触屏全手势。单指拖 → rotate；双指 → pan（质心位移）+ zoom（间距比）同时。
 *    与 mouse-trackpad 鼠标路径互不重叠，桌面 + 触屏全手势覆盖，无需设备检测。
 */
import { cameraConfig, type CameraConfig } from '../../config/camera'

/** 语义输入意图 —— 适配器翻译原生事件后回调控制器（控制器内 clamp 到约束区间）。 */
export type CameraInputHandlers = {
  /**
   * 屏幕拖拽像素增量 → pan 目标点（右键 / 触屏双指）。
   * dx>0 右拖、dy>0 下拖（控制器按"拖地图方向"换算 target 偏移，Task 09 同源）。
   */
  onPan(dx: number, dy: number): void
  /**
   * 屏幕拖拽像素增量 → 旋转朝向（左键 / 触屏单指）。
   * dx>0 右拖、dy>0 下拖 → 控制器换算 yaw/pitch 增量（拖向哪、看向哪）。
   */
  onRotate(dx: number, dy: number): void
  /**
   * 距离乘子 → zoom。>1 拉远、<1 推近（控制器 `distance *= factor` 后 clamp 到 zoom.min/max）。
   */
  onZoom(factor: number): void
}

/** 适配器接口：attach 绑定到 DOM 元素，返回 detach 清理函数。 */
export interface InputAdapter {
  readonly kind: 'mouse-trackpad' | 'touch'
  attach(el: HTMLElement, handlers: CameraInputHandlers): () => void
}

/** WheelEvent.deltaMode 命名常量（node 测试环境无 WheelEvent 全局，用字面量 + 注释）。 */
// deltaMode=0(PIXEL)：触控板 / 现代鼠标 —— 原样使用（默认分支无需缩放）
const DELTA_LINE = 1 // 老式鼠标 / 键盘
const DELTA_PAGE = 2

/**
 * wheel 事件 → zoom 乘子（SPEC §9：鼠标滚轮 + 触控板双指滚动/捏合统一）。
 *
 * 量级归一化（鼠标 vs 触控板 deltaY 差异核心，Task 10）：
 *  - deltaMode=PIXEL(0)：触控板 / 现代鼠标，deltaY 为像素值，原样使用。
 *  - deltaMode=LINE(1)：老式鼠标 / 键盘，deltaY 为行数 → ×16 归一到像素量级（一行约 16px）。
 *  - deltaMode=PAGE(2)：×400 归一（一页约 400px）。
 * 触控板双指捏合（浏览器映射为 ctrlKey=true 的 wheel）走独立 pinchZoomFactor（deltaY 更小、更敏感）。
 *
 * 回归不变量：deltaMode=PIXEL + ctrlKey=false 时 = Task 09 的 `exp(deltaY · wheelZoomFactor)`。
 */
export function wheelToZoomFactor(
  deltaY: number,
  deltaMode: number,
  ctrlKey: boolean,
  cfg: CameraConfig = cameraConfig,
): number {
  let px = deltaY
  if (deltaMode === DELTA_LINE) px *= 16
  else if (deltaMode === DELTA_PAGE) px *= 400
  const k = ctrlKey ? cfg.pinchZoomFactor : cfg.wheelZoomFactor
  return Math.exp(px * k)
}

/**
 * 鼠标 + 触控板统一适配器（左键旋转 / 右键平移 + wheel 缩放）。
 *
 * pointer 拖拽按按键分流：主键(button 0) → rotate（yaw/pitch）、右键(button 2) → pan（平移目标点）；
 * wheel（滚轮 / 双指滚动 / pinch）→ zoom。触屏(pointerType=touch)整体交由 touch 适配器
 * （单指 rotate / 双指 pan+zoom），本适配器忽略触屏 pointer 以免与 touch 双指手势重复触发。
 * 右键拖拽需 preventDefault `contextmenu` 防浏览器右键菜单弹出。
 */
export function createMouseTrackpadAdapter(cfg: CameraConfig = cameraConfig): InputAdapter {
  return {
    kind: 'mouse-trackpad',
    attach(el, handlers) {
      // 当前拖拽模式：'rotate'(主键) | 'pan'(右键) | null(未拖拽)。
      let dragMode: 'rotate' | 'pan' | null = null
      let lastX = 0
      let lastY = 0

      const onPointerDown = (e: PointerEvent) => {
        // 触屏交由 touch 适配器（pointerType=touch 单/双指），本适配器只管鼠标。
        if (e.pointerType === 'touch') return
        if (e.button === 0) dragMode = 'rotate' // 主键 → 旋转
        else if (e.button === 2) dragMode = 'pan' // 右键 → 平移
        else return // 中键等忽略
        lastX = e.clientX
        lastY = e.clientY
        el.setPointerCapture(e.pointerId)
      }
      const onPointerMove = (e: PointerEvent) => {
        if (dragMode === null) return
        const dx = e.clientX - lastX
        const dy = e.clientY - lastY
        lastX = e.clientX
        lastY = e.clientY
        if (dragMode === 'rotate') handlers.onRotate(dx, dy)
        else handlers.onPan(dx, dy)
      }
      const endDrag = (e: PointerEvent) => {
        if (dragMode === null) return
        dragMode = null
        try {
          el.releasePointerCapture(e.pointerId)
        } catch {
          // pointerId 可能已失效，忽略。
        }
      }
      const onWheel = (e: WheelEvent) => {
        e.preventDefault()
        handlers.onZoom(wheelToZoomFactor(e.deltaY, e.deltaMode, e.ctrlKey, cfg))
      }
      // 右键拖拽期间阻止浏览器右键菜单弹出。
      const onContextMenu = (e: Event) => e.preventDefault()

      el.addEventListener('pointerdown', onPointerDown)
      el.addEventListener('pointermove', onPointerMove)
      el.addEventListener('pointerup', endDrag)
      el.addEventListener('pointercancel', endDrag)
      el.addEventListener('wheel', onWheel, { passive: false })
      el.addEventListener('contextmenu', onContextMenu)

      return () => {
        el.removeEventListener('pointerdown', onPointerDown)
        el.removeEventListener('pointermove', onPointerMove)
        el.removeEventListener('pointerup', endDrag)
        el.removeEventListener('pointercancel', endDrag)
        el.removeEventListener('wheel', onWheel)
        el.removeEventListener('contextmenu', onContextMenu)
      }
    },
  }
}

/** 触屏触摸点结构子集（clientX/clientY，兼容真实 Touch 与测试 plain 对象）。 */
type TouchPoint = { clientX: number; clientY: number }

/**
 * 两指间欧氏距离（屏幕像素）—— pinch zoom 的输入量。
 * 取 touches[0]/[1]，无论哪两指，距离比的符号与绝对值都不依赖指序。
 */
export function touchPinchDistance(a: TouchPoint, b: TouchPoint): number {
  return Math.hypot(b.clientX - a.clientX, b.clientY - a.clientY)
}

/** 双指状态：间距（pinch zoom 量）+ 质心（pan 位移量）。 */
type PinchState = { dist: number; cx: number; cy: number }

/** 由两指算 {间距, 质心}。 */
function pinchCentroid(a: TouchPoint, b: TouchPoint): PinchState {
  return {
    dist: touchPinchDistance(a, b),
    cx: (a.clientX + b.clientX) / 2,
    cy: (a.clientY + b.clientY) / 2,
  }
}

/**
 * pinch 距离比 → zoom 乘子（SPEC §9 双指捏合缩放，Task 30）。
 *
 *   factor = lastDist / currDist
 *   - 张开（currDist > lastDist）→ factor < 1 → onZoom 推近（内容放大）
 *   - 捏合（currDist < lastDist）→ factor > 1 → onZoom 拉远（内容缩小）
 *
 * 与 `CameraInputHandlers.onZoom`「>1 拉远 / <1 推近」语义同源，亦与 wheel 的
 * `exp(deltaY · k)`（deltaY>0 拉远）方向一致。防除零：currDist≤0 返回 1（不变）。
 */
export function pinchZoomFactor(currDist: number, lastDist: number): number {
  if (currDist <= 0) return 1
  return lastDist / currDist
}

/**
 * 触屏适配器（SPEC §9：单指旋转 + 双指平移缩放，自由轨道范式）。
 *
 * 触屏手势职责（与 mouse-trackpad 鼠标路径互不重叠）：
 *  - 单指拖：rotate（yaw/pitch），对应鼠标左键。拖向哪、看向哪。
 *  - 双指：同时 pan（质心位移 → 平移目标点）+ zoom（间距比 → 缩放距离）。
 *    两指间距变 = 缩放、两指整体平移 = 平移，互不干扰（OrbitControls 双指同源语义）。
 *
 * 状态切换防跳变：双指↔单指过渡时重置相应基准（rotateLast / pinch），避免位移/旋转突跳。
 * `touch-action: none` 在 attach 时设到元素上（detach 还原），声明式告诉浏览器本元素的
 * 所有触摸手势由代码全权处理。useCameraInput 默认把本适配器与 mouse-trackpad 同时 attach。
 */
export function createTouchAdapter(): InputAdapter {
  return {
    kind: 'touch',
    attach(el, handlers) {
      // 单指旋转的上一帧位置；null = 非单指态（双指 / 无指），不产出 rotate。
      let rotateLast: { x: number; y: number } | null = null
      // 双指的上一帧 {间距, 质心}；null = 非双指态，不产出 pan/zoom。
      let pinch: PinchState | null = null

      const onTouchStart = (e: TouchEvent) => {
        if (e.touches.length >= 2) {
          // 进入双指：记录间距 + 质心，停止单指旋转。
          pinch = pinchCentroid(e.touches[0], e.touches[1])
          rotateLast = null
        } else if (e.touches.length === 1) {
          // 进入单指：记录起点（含从双指回到单指时重置基准，避免旋转跳变）。
          rotateLast = { x: e.touches[0].clientX, y: e.touches[0].clientY }
          pinch = null
        }
      }
      const onTouchMove = (e: TouchEvent) => {
        if (e.touches.length >= 2 && pinch) {
          // 双指：pinch zoom（间距比）+ pan（质心位移）同时。
          const curr = pinchCentroid(e.touches[0], e.touches[1])
          handlers.onZoom(pinchZoomFactor(curr.dist, pinch.dist))
          handlers.onPan(curr.cx - pinch.cx, curr.cy - pinch.cy)
          pinch = curr
          e.preventDefault() // 阻止浏览器页面 pinch-zoom（双指时）
        } else if (e.touches.length === 1 && rotateLast) {
          // 单指：旋转。
          const t = e.touches[0]
          handlers.onRotate(t.clientX - rotateLast.x, t.clientY - rotateLast.y)
          rotateLast = { x: t.clientX, y: t.clientY }
          e.preventDefault() // 阻止浏览器页面滚动惯性
        }
      }
      const onTouchEnd = (e: TouchEvent) => {
        if (e.touches.length === 0) {
          rotateLast = null
          pinch = null
        } else if (e.touches.length === 1) {
          // 双指松开一指 → 回到单指，重置单指基准避免跳变。
          rotateLast = { x: e.touches[0].clientX, y: e.touches[0].clientY }
          pinch = null
        }
      }

      // passive:false 以便 onTouchMove 能 preventDefault；touch-action:none 双保险。
      el.addEventListener('touchstart', onTouchStart, { passive: false })
      el.addEventListener('touchmove', onTouchMove, { passive: false })
      el.addEventListener('touchend', onTouchEnd)
      el.addEventListener('touchcancel', onTouchEnd)

      const prevTouchAction = el.style.touchAction
      el.style.touchAction = 'none'

      return () => {
        el.removeEventListener('touchstart', onTouchStart)
        el.removeEventListener('touchmove', onTouchMove)
        el.removeEventListener('touchend', onTouchEnd)
        el.removeEventListener('touchcancel', onTouchEnd)
        el.style.touchAction = prevTouchAction
      }
    },
  }
}
