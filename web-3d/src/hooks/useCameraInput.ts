/**
 * 相机输入 hook（SPEC §9 / D20）—— 把 InputAdapter 绑定到 R3F canvas DOM 元素。
 *
 * Task 10：从 SandboxControls 抽出输入绑定生命周期。adapter 把原生事件翻译成语义意图
 * （pan/zoom），handlers 写入控制器 goal 状态；状态机 / 约束 / 阻尼（cameraState.ts）不变。
 *
 * 稳定性处理（react-hooks 惯例，Task 07/09 同源）：
 *  - handlers 经 ref 透传最新值 → 调用方无需 useCallback/稳定化对象引用；
 *  - 默认 adapter（mouse-trackpad）用 useState 懒初始化（读参数非 ref，避开 react-hooks/refs），
 *    引用稳定 → attach effect 仅在 el/active 变化时重新绑定。
 */
import { useEffect, useRef, useState } from 'react'
import {
  type CameraInputHandlers,
  type InputAdapter,
  createMouseTrackpadAdapter,
} from '../three/camera/inputAdapter'

export function useCameraInput(
  el: HTMLElement | null,
  handlers: CameraInputHandlers,
  adapter?: InputAdapter,
): void {
  // adapter 首次确定后不变（默认 mouse-trackpad，引用稳定）→ attach effect 仅在 el 变化时重绑。
  const [active] = useState<InputAdapter>(
    () => adapter ?? createMouseTrackpadAdapter(),
  )

  // handlers 最新值经 ref 透传，避免每次 render 新对象触发重新绑定。
  const latest = useRef(handlers)
  useEffect(() => {
    latest.current = handlers
  }, [handlers])

  useEffect(() => {
    if (!el) return
    const wrapped: CameraInputHandlers = {
      onPan: (dx, dy) => latest.current.onPan(dx, dy),
      onZoom: (factor) => latest.current.onZoom(factor),
    }
    return active.attach(el, wrapped)
  }, [el, active])
}
