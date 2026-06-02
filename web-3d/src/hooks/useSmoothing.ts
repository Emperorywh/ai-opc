/**
 * 手势平滑 Hook（阶段 13）
 *
 * 设计规格 §7.4：双阶段滤波
 *
 * 阶段 1（本 Hook）：对 MediaPipe 原始 landmark 数据做低通滤波
 *   - 截止频率 ~2Hz，消除追踪抖动
 *   - 数学：alpha = 1 - exp(-2π × cutoff × dt)
 *   - smoothed = smoothed + alpha × (raw - smoothed)
 *
 * 阶段 2（在 CameraController 中应用）：运动阻尼平滑
 *   - dampingFactor: 0.05
 *   - 实现"慢单感"，地球旋转丝般顺滑
 *   - 代价 ~150ms 延迟，电影感体验可接受
 */
import { useRef } from 'react'
import { GESTURE_SMOOTH_CUTOFF } from '../utils/constants'

export interface SmoothedGestureData {
  /** 平滑后的手掌中心 [x, y]，归一化 [0, 1] */
  palmCenter: [number, number]
  /** 平滑后的捏合距离，归一化 */
  pinchDistance: number
}

/**
 * 手势平滑 Hook
 *
 * 提供 Stage 1 低通滤波函数，将带噪声的 MediaPipe 原始数据
 * 转化为平滑的手掌位置和捏合距离。
 *
 * 使用方式：在 useFrame 循环中每帧调用 smoothStage1()，
 * 传入 Redux 中的 raw palmPosition / pinchDistance。
 */
export function useSmoothing() {
  const state = useRef<{
    palmCenter: [number, number]
    pinchDistance: number
    initialized: boolean
  }>({
    palmCenter: [0.5, 0.5],
    pinchDistance: 0.15,
    initialized: false,
  })

  /**
   * 阶段 1：对原始 MediaPipe 数据做低通滤波
   *
   * 首次调用（或 reset() 后）直接用原始值初始化，
   * 避免从默认位置 (0.5, 0.5) 拖拽产生假位移。
   *
   * @param rawPalm  原始手掌中心 [x, y]，归一化 [0, 1]
   * @param rawPinch 原始捏合距离，归一化
   * @param dt       帧间隔（秒）
   * @returns 平滑后的手势数据
   */
  function smoothStage1(
    rawPalm: [number, number],
    rawPinch: number,
    dt: number,
  ): SmoothedGestureData {
    const s = state.current

    // 低通滤波 alpha：截止频率越低，alpha 越小，平滑越强
    const alpha = 1 - Math.exp(-2 * Math.PI * GESTURE_SMOOTH_CUTOFF * dt)

    if (!s.initialized) {
      // 首次检测到手：直接用原始值，避免从默认值拖拽
      s.palmCenter = [rawPalm[0], rawPalm[1]]
      s.pinchDistance = rawPinch
      s.initialized = true
    } else {
      // 指数移动平均
      s.palmCenter[0] += alpha * (rawPalm[0] - s.palmCenter[0])
      s.palmCenter[1] += alpha * (rawPalm[1] - s.palmCenter[1])
      s.pinchDistance += alpha * (rawPinch - s.pinchDistance)
    }

    return {
      palmCenter: [s.palmCenter[0], s.palmCenter[1]],
      pinchDistance: s.pinchDistance,
    }
  }

  /**
   * 手离开画面时重置平滑状态。
   * 下次检测到手时，smoothStage1 会从新的原始位置重新初始化，
   * 避免从上次离开的位置拖拽。
   */
  function reset() {
    state.current.initialized = false
  }

  return { smoothStage1, reset }
}
