/**
 * 逐帧场景状态 hook（地球自转等）
 * 用 ref 管理，不触发 React re-render
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

export function useSceneState() {
  const state = useRef<SceneMutableState>({
    earthRotation: 0,
    earthRotationSpeed: EARTH_ROTATION_SPEED, // 0.02 rad/s
  })

  useFrame((_, delta) => {
    state.current.earthRotation += state.current.earthRotationSpeed * delta
  })

  return state
}
