/**
 * 空闲自动公转组件（阶段 11）
 * 3 秒无输入后相机缓慢自动公转
 *
 * 阶段 14 改动：
 * - 移除 setInputMode('idle') 调用，模式切换由 useInputPriority 统一管理
 * - 仅保留公转动画逻辑
 *
 * 设计规格 §7.1：
 * - 空闲模式：3 秒无任何输入 → 相机缓慢自动公转
 * - 任意输入 → 立即退出空闲模式
 *
 * 设计规格 §7.2 注：
 * - 切换时相机状态平滑过渡，不产生跳变
 *
 * 帧序说明：
 * IdleOrbit 的 useFrame 在 CameraController 的 useFrame 之前运行
 * （由 Scene.tsx 中的组件顺序决定），因此 theta 修改先于相机位置更新。
 */
import { useRef } from 'react'
import { useFrame } from '@react-three/fiber'
import { store } from '../../stores/store'
import { getCameraState } from '../../stores/useCameraState'

/** 空闲公转速度（rad/s）——缓慢水平公转，营造电影感 */
const IDLE_ORBIT_SPEED = 0.08

/** 淡入速度（指数逼近，值越大越快；1.5 → 约 0.7 秒到 63%） */
const BLEND_IN_SPEED = 1.5

/** 淡出速度（快速交还控制权；8.0 → 约 0.12 秒到 63%） */
const BLEND_OUT_SPEED = 8.0

export function IdleOrbit() {
  /** 空闲公转混合因子：0 = 不公转，1 = 完全公转 */
  const idleBlend = useRef(0)

  useFrame((_, delta) => {
    const { input } = store.getState()

    // ── 混合因子平滑过渡 ─────────────────────────────
    // 阶段 14：不再在此处 dispatch setInputMode('idle')，
    //          由 useInputPriority 统一管理模式切换
    const isIdle = input.mode === 'idle'
    const target = isIdle ? 1 : 0
    const speed = isIdle ? BLEND_IN_SPEED : BLEND_OUT_SPEED
    idleBlend.current += (target - idleBlend.current) * Math.min(1, delta * speed)

    // 混合因子极小值裁剪（避免浮点噪声）
    if (idleBlend.current < 0.001) {
      idleBlend.current = 0
    }

    // ── 应用空闲公转 ─────────────────────────────────
    // 直接修改 theta（不经过 velocity），避免与阻尼系统冲突
    if (idleBlend.current > 0) {
      const state = getCameraState()
      state.theta += IDLE_ORBIT_SPEED * delta * idleBlend.current
    }
  })

  return null
}
