/**
 * 逐帧场景状态管理（模块级共享单例）
 * 地球自转等逐帧数据，用 ref 管理，不触发 React re-render
 *
 * 阶段 17 优化：
 * - 重构为模块级单例（与 useCameraState 同一模式）
 * - 消除 Earth + PulsePoints 各自注册 useFrame 带来的重复计算
 * - 新增 getSceneState() 直接读取共享状态（不注册帧循环）
 *
 * 设计规格 §13.3：
 * - 逐帧更新的数据，完全绕过 React 渲染循环
 * - useFrame 中直接读写 ref.current
 */
import { useRef } from 'react'
import { useFrame } from '@react-three/fiber'
import { EARTH_ROTATION_SPEED } from '../utils/constants'

interface SceneMutableState {
  /** 地球当前自转角度（弧度） */
  earthRotation: number
  /** 地球自转速度（rad/s） */
  earthRotationSpeed: number
}

// ── 模块级共享单例 ──────────────────────────────────────
const sharedState: SceneMutableState = {
  earthRotation: 0,
  earthRotationSpeed: EARTH_ROTATION_SPEED, // 0.02 rad/s
}

/**
 * 获取共享场景状态（不注册 useFrame）。
 * 适用于需要在 useFrame 中读取场景状态但不需要触发帧循环的组件。
 */
export function getSceneState(): SceneMutableState {
  return sharedState
}

/**
 * 逐帧场景状态 hook。
 * 返回的 ref 在 useFrame 中直接读写，永不触发 React re-render。
 * 注册帧循环：每帧递增 earthRotation。
 *
 * ⚠️ 整个场景中只应有一个组件调用此 hook（当前为 Earth），
 *    其他组件请使用 getSceneState() 直接获取共享状态。
 */
export function useSceneState() {
  const state = useRef(sharedState)

  useFrame((_, delta) => {
    sharedState.earthRotation += sharedState.earthRotationSpeed * delta
  })

  return state
}
