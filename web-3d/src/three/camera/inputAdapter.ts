/**
 * 输入适配器抽象（SPEC §9 / D20：鼠标 + 触控板为主，预留触屏）。
 *
 * Task 10 把 Task 09 内置在 SandboxControls 的 pointer/wheel 绑定抽成平台适配器：
 * 原生 DOM 事件 → 语义输入意图（pan / zoom）。控制器（cameraState.ts + SandboxControls）
 * 的状态机 / 约束 / 阻尼 **不变** —— 适配器只产出意图，由控制器消费并 clamp。
 *
 * 适配器职责切分：
 *  - `createMouseTrackpadAdapter`：鼠标 + 触控板统一（pointer 拖拽 pan + wheel 缩放）。
 *    pointer 事件天然覆盖触屏单指 pan（pointerType=touch），故触屏基础平移无需另接。
 *  - `createTouchAdapter`：双指 pinch zoom（touch 事件算两指距离比 → onZoom，Task 30）。
 *    单指 pan / tap 点击已由 mouse-trackpad 的 pointer pan 与 usePointerPick 的 pointer
 *    选中覆盖，本适配器只补 pinch —— useCameraInput 默认两者并存，桌面 + 触屏全支持。
 */
import { cameraConfig, type CameraConfig } from '../../config/camera'

/** 语义输入意图 —— 适配器翻译原生事件后回调控制器（控制器内 clamp 到约束区间）。 */
export type CameraInputHandlers = {
  /**
   * 屏幕拖拽像素增量 → pan 目标点。
   * dx>0 右拖、dy>0 下拖（控制器按"拖地图方向"换算 target 偏移，Task 09 同源）。
   */
  onPan(dx: number, dy: number): void
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
 * 鼠标 + 触控板统一适配器（pointer 拖拽 pan + wheel 缩放）。
 * 主键（含触屏单指/笔，pointer 事件同源）拖拽 → pan；wheel（滚轮/双指滚动/pinch）→ zoom。
 */
export function createMouseTrackpadAdapter(cfg: CameraConfig = cameraConfig): InputAdapter {
  return {
    kind: 'mouse-trackpad',
    attach(el, handlers) {
      let dragging = false
      let lastX = 0
      let lastY = 0

      const onPointerDown = (e: PointerEvent) => {
        // 仅主键触发 pan；右键/中键留作未来（触屏拾取等）。
        if (e.button !== 0) return
        dragging = true
        lastX = e.clientX
        lastY = e.clientY
        el.setPointerCapture(e.pointerId)
      }
      const onPointerMove = (e: PointerEvent) => {
        if (!dragging) return
        const dx = e.clientX - lastX
        const dy = e.clientY - lastY
        lastX = e.clientX
        lastY = e.clientY
        handlers.onPan(dx, dy)
      }
      const endDrag = (e: PointerEvent) => {
        if (!dragging) return
        dragging = false
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

      el.addEventListener('pointerdown', onPointerDown)
      el.addEventListener('pointermove', onPointerMove)
      el.addEventListener('pointerup', endDrag)
      el.addEventListener('pointercancel', endDrag)
      el.addEventListener('wheel', onWheel, { passive: false })

      return () => {
        el.removeEventListener('pointerdown', onPointerDown)
        el.removeEventListener('pointermove', onPointerMove)
        el.removeEventListener('pointerup', endDrag)
        el.removeEventListener('pointercancel', endDrag)
        el.removeEventListener('wheel', onWheel)
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
 * 触屏适配器（SPEC §9：双指 pinch zoom，Task 30）。
 *
 * 触屏三项手势的职责分工（与 mouse-trackpad / usePointerPick 协同，无重复触发）：
 *  - 单指 pan：由 mouse-trackpad 的 pointer 事件覆盖（pointerType=touch 单指拖拽）。
 *    本适配器**忽略单指**（仅追踪是否进入双指），避免与 pointer pan 重复移动目标点。
 *  - 双指 pinch zoom：浏览器不把触屏 pinch 合成为 wheel（默认缩放整个页面），必须用
 *    touch 事件自己算两指距离比 → onZoom。本适配器唯一职责。
 *  - 点击选国家：由 usePointerPick 的 pointer 事件覆盖（触屏 tap 合成 pointerdown/up）。
 *
 * `touch-action: none` 在 attach 时设到元素上（detach 还原），声明式告诉浏览器本元素的
 * 所有触摸手势由代码全权处理 —— 否则浏览器会抢占双指做页面缩放、单指做滚动惯性，
 * 盖过我们的处理。useCameraInput 默认把本适配器与 mouse-trackpad 同时 attach 到 canvas。
 */
export function createTouchAdapter(): InputAdapter {
  return {
    kind: 'touch',
    attach(el, handlers) {
      // 当前 pinch 的上一帧两指距离；null = 非双指态（单指/无指），不产出 zoom。
      let pinchDist: number | null = null

      const onTouchStart = (e: TouchEvent) => {
        pinchDist =
          e.touches.length >= 2
            ? touchPinchDistance(e.touches[0], e.touches[1])
            : null // 单指：让位 mouse-trackpad 的 pointer pan
      }
      const onTouchMove = (e: TouchEvent) => {
        if (e.touches.length < 2 || pinchDist === null) return
        const curr = touchPinchDistance(e.touches[0], e.touches[1])
        handlers.onZoom(pinchZoomFactor(curr, pinchDist))
        pinchDist = curr
        e.preventDefault() // 阻止浏览器页面 pinch-zoom（双指时）
      }
      const onTouchEnd = (e: TouchEvent) => {
        if (e.touches.length < 2) pinchDist = null
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
