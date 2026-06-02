/**
 * 逐帧相机状态管理（模块级共享单例）
 * 球坐标系（distance / theta / phi）+ 速度阻尼
 *
 * 设计规格 §13.3：
 * - 返回的 ref 在 useFrame 中直接读写，永不触发 React re-render
 * - 每帧：应用速度 → 阻尼衰减 → 范围约束 → 写入 Three.js camera
 *
 * 球坐标约定：
 * - theta：水平方位角（绕 Y 轴）
 * - phi：极角（从 Y 轴正方向向下）
 *   - phi = 0 → 北极上方
 *   - phi = π/2 → 赤道
 *   - phi = π → 南极下方
 * - distance：到原点的距离
 *
 * 阶段 11 改动：
 * - 状态提升为模块级单例，多个组件可安全共享
 * - 新增 getCameraState() 直接获取共享状态（不注册 useFrame）
 * - useCameraState() 保持向后兼容，仍返回 ref + 注册帧循环
 */
import { useRef } from 'react'
import { useFrame } from '@react-three/fiber'
import * as THREE from 'three'
import {
  CAMERA_INITIAL_DISTANCE,
  CAMERA_ZOOM_MIN,
  CAMERA_ZOOM_MAX,
} from '../utils/constants'

export interface CameraMutableState {
  distance: number
  theta: number
  phi: number
  velocity: { theta: number; phi: number; zoom: number }
}

/** 每帧阻尼系数（0.95 → 约 0.5 秒衰减至 5%） */
const DAMPING = 0.95

/** phi 极角范围约束（避免极点万向锁） */
const PHI_MIN = 0.1
const PHI_MAX = Math.PI - 0.1

// ── 模块级共享单例 ──────────────────────────────────────
/** 初始相机：从正前方 (0, 0, 3.5) 看向原点 */
const sharedState: CameraMutableState = {
  distance: CAMERA_INITIAL_DISTANCE,
  theta: Math.PI / 2, // 对应 camera position (0, 0, 3.5)
  phi: Math.PI / 2,
  velocity: { theta: 0, phi: 0, zoom: 0 },
}

/**
 * 获取共享相机状态（不注册 useFrame）。
 * 适用于需要在 useFrame 中读写相机状态但不需要触发帧循环的组件（如 IdleOrbit）。
 */
export function getCameraState(): CameraMutableState {
  return sharedState
}

/**
 * 逐帧相机状态 hook。
 * 返回的 ref 在 useFrame 中直接读写，永不触发 React re-render。
 * 注册帧循环：应用速度 → 阻尼衰减 → 范围约束 → 写入 Three.js camera。
 *
 * ⚠️ 整个场景中只应有一个组件调用此 hook（当前为 CameraController），
 *    其他组件请使用 getCameraState() 直接获取共享状态。
 */
export function useCameraState() {
  const state = useRef(sharedState)

  useFrame(({ camera }, delta) => {
    const s = sharedState

    // 应用速度
    s.theta += s.velocity.theta * delta
    s.phi += s.velocity.phi * delta
    s.distance += s.velocity.zoom * delta

    // 阻尼衰减
    s.velocity.theta *= DAMPING
    s.velocity.phi *= DAMPING
    s.velocity.zoom *= DAMPING

    // 极小速度归零（避免无限微振动）
    if (Math.abs(s.velocity.theta) < 0.0001) s.velocity.theta = 0
    if (Math.abs(s.velocity.phi) < 0.0001) s.velocity.phi = 0
    if (Math.abs(s.velocity.zoom) < 0.0001) s.velocity.zoom = 0

    // 范围约束
    s.phi = THREE.MathUtils.clamp(s.phi, PHI_MIN, PHI_MAX)
    s.distance = THREE.MathUtils.clamp(s.distance, CAMERA_ZOOM_MIN, CAMERA_ZOOM_MAX)

    // 写入 Three.js camera（球坐标 → 直角坐标）
    camera.position.set(
      s.distance * Math.sin(s.phi) * Math.cos(s.theta),
      s.distance * Math.cos(s.phi),
      s.distance * Math.sin(s.phi) * Math.sin(s.theta),
    )
    camera.lookAt(0, 0, 0)
  })

  return state
}
