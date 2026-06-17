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
 *  - `createTouchAdapter`：多点触控（双指 pinch zoom / tap 点击），SPEC §9 明确 Phase 2
 *    （Task 30）接入；此处仅预留 stub，保证抽象完整、未来替换不动控制器。
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

/**
 * 触屏适配器（SPEC §9：预留，Phase 2 / Task 30 接入）。
 *
 * MVP 不实现真实多点触控（单指 pan 已由 mouse-trackpad 的 pointer 事件覆盖；
 * 双指 pinch zoom / tap 点击需 touchstart/move/end 多点状态机）。
 * 仅占位返回 no-op attach，保证 InputAdapter 抽象完整 —— 未来实现替换此处，
 * 控制器（SandboxControls）零改动。
 */
export function createTouchAdapter(): InputAdapter {
  return {
    kind: 'touch',
    attach() {
      // Phase 2（Task 30）：touchstart/move/end 单指 pan + 双指 pinch zoom + tap 点击选国家。
      return () => {}
    },
  }
}
