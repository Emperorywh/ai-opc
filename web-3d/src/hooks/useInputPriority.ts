/**
 * 输入优先级管理 Hook（阶段 14）
 *
 * 设计规格 §7.2 状态机：
 * [鼠标模式] ──检测到手──→ [手势模式]
 * [手势模式] ──手离开帧──→ [鼠标模式]
 * [任意模式] ──3秒无输入──→ [空闲模式]
 * [空闲模式] ──任何输入──→ [最后活跃的模式]
 *
 * 集中管理所有模式转换逻辑，取代各组件中分散的 setInputMode 调用。
 * 运行在 useFrame 中，每帧检测条件并分发模式切换。
 *
 * 帧序：InputPriority 应在 Scene.tsx 中排在 IdleOrbit 之前，
 *       确保模式切换先于公转动画和控制逻辑执行。
 */
import { useRef } from 'react'
import { useFrame } from '@react-three/fiber'
import { store } from '../stores/store'
import { setInputMode, setLastActiveMode } from '../stores/inputSlice'
import { IDLE_TIMEOUT } from '../utils/constants'

/** 空闲检测轮询间隔（秒） */
const IDLE_CHECK_INTERVAL = 1.0 / 30 // 30fps，足够检测空闲

export function useInputPriority() {
  const prevHandDetected = useRef(false)
  const prevLastInputTime = useRef(0)
  const elapsed = useRef(0)

  useFrame((_, delta) => {
    const { input } = store.getState()
    elapsed.current += delta

    // 仅以 ~30fps 频率检测模式切换（低频 UI 状态，无需每帧）
    if (elapsed.current < IDLE_CHECK_INTERVAL) return
    elapsed.current = 0

    const now = Date.now()
    const timeSinceInput = (now - input.lastInputTime) / 1000

    // ── 手进入画面：保存当前模式 → 切换到手势模式 ──────────
    if (input.handDetected && !prevHandDetected.current) {
      if (input.mode !== 'idle') {
        store.dispatch(setLastActiveMode(input.mode as 'mouse' | 'gesture'))
      }
      store.dispatch(setInputMode('gesture'))
    }

    // ── 手离开画面：恢复上一次活跃模式 ────────────────────
    if (!input.handDetected && prevHandDetected.current) {
      store.dispatch(setInputMode(input.lastActiveMode))
    }

    prevHandDetected.current = input.handDetected

    // ── 空闲检测：3 秒无输入 → 保存模式 → 切换到空闲 ──────
    if (input.mode !== 'idle' && timeSinceInput > IDLE_TIMEOUT) {
      store.dispatch(setLastActiveMode(input.mode as 'mouse' | 'gesture'))
      store.dispatch(setInputMode('idle'))
    }

    // ── 从空闲中唤醒：检测到输入 → 恢复最后活跃模式 ──────
    if (input.mode === 'idle' && input.lastInputTime !== prevLastInputTime.current) {
      // 手在画面中 → 手势模式，否则 → lastActiveMode
      if (input.handDetected) {
        store.dispatch(setInputMode('gesture'))
      } else {
        store.dispatch(setInputMode(input.lastActiveMode))
      }
    }

    prevLastInputTime.current = input.lastInputTime
  })
}

/**
 * 输入优先级组件（渲染占位）
 * 仅运行 useInputPriority hook，不产生任何视觉元素
 */
export function InputPriority() {
  useInputPriority()
  return null
}
