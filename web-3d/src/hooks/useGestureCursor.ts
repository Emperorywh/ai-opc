/**
 * 手势光标状态 Hook（阶段 14）
 *
 * 设计规格 §7.5 手势光标：
 * - 从手掌中心投射半透明光线到地球表面
 * - 光标落点处产生冰蓝色涟漪效果
 * - 手离开时光标淡出（~0.3s 过渡）
 *
 * 实现方式：
 * 1. 读取 Redux 中的 palmPosition（归一化 [0,1] 坐标）
 * 2. 转换为 NDC 坐标（考虑 MediaPipe 自拍镜像）
 * 3. 使用 Raycaster 从相机发射射线，与地球球体求交
 * 4. 输出光束端点、涟漪中心、法线方向、透明度等状态
 */
import { useRef, useMemo } from 'react'
import { useFrame, useThree } from '@react-three/fiber'
import * as THREE from 'three'
import { store } from '../stores/store'
import { EARTH_RADIUS } from '../utils/constants'

/** 光标状态（由 GestureCursor 组件消费） */
export interface CursorState {
  /** 是否有有效的地球交点 */
  hasHit: boolean
  /** 光束起点（地球表面法线方向上方） */
  beamStart: THREE.Vector3
  /** 光束终点（地球表面交点） */
  beamEnd: THREE.Vector3
  /** 涟漪中心（= 光束终点） */
  rippleCenter: THREE.Vector3
  /** 交点处地球表面法线（归一化） */
  rippleNormal: THREE.Vector3
  /** 整体透明度（0~1，平滑淡入淡出） */
  opacity: number
  /** 涟漪动画时间累计（秒） */
  rippleTime: number
}

/** 淡入淡出速度（0.3 秒 → ~3.33 的指数逼近速率） */
const FADE_SPEED = 3.33

/** 光束在地球表面法线方向上的高度偏移 */
const BEAM_HEIGHT_ABOVE_SURFACE = 0.35

export function useGestureCursor() {
  const { camera } = useThree()

  const raycaster = useMemo(() => new THREE.Raycaster(), [])
  /** 地球碰撞球（中心在原点，半径 = EARTH_RADIUS） */
  const earthSphere = useMemo(
    () => new THREE.Sphere(new THREE.Vector3(0, 0, 0), EARTH_RADIUS),
    [],
  )
  /** 复用的 NDC 坐标向量 */
  const ndcCoords = useMemo(() => new THREE.Vector2(), [])

  const state = useRef<CursorState>({
    hasHit: false,
    beamStart: new THREE.Vector3(),
    beamEnd: new THREE.Vector3(),
    rippleCenter: new THREE.Vector3(),
    rippleNormal: new THREE.Vector3(0, 1, 0),
    opacity: 0,
    rippleTime: 0,
  })

  useFrame((_, delta) => {
    const { input } = store.getState()
    const s = state.current

    let hasHit = false

    if (input.handDetected && input.palmPosition) {
      // ── 坐标转换 ──────────────────────────────────
      // MediaPipe 自拍镜像：用户右手在画面中 x 较小 → 屏幕 x 应较大
      // NDC x = (1 - palmX) * 2 - 1
      ndcCoords.x = (1 - input.palmPosition[0]) * 2 - 1
      // y 轴翻转：MediaPipe y 向下增加，NDC y 向上增加
      ndcCoords.y = -(input.palmPosition[1] * 2 - 1)

      // ── 射线投射 ──────────────────────────────────
      raycaster.setFromCamera(ndcCoords, camera)

      const intersection = new THREE.Vector3()
      if (raycaster.ray.intersectSphere(earthSphere, intersection)) {
        hasHit = true
        s.beamEnd.copy(intersection)
        s.rippleCenter.copy(intersection)

        // 法线 = 交点方向（球体在原点，法线即交点归一化）
        s.rippleNormal.copy(intersection).normalize()

        // 光束起点 = 交点 + 法线 * 高度
        s.beamStart
          .copy(intersection)
          .addScaledVector(s.rippleNormal, BEAM_HEIGHT_ABOVE_SURFACE)
      }
    }

    s.hasHit = hasHit

    // ── 透明度平滑过渡 ────────────────────────────────
    const targetOpacity = hasHit ? 1 : 0
    s.opacity += (targetOpacity - s.opacity) * Math.min(1, delta * FADE_SPEED)
    // 极小值裁剪
    if (s.opacity < 0.005) s.opacity = 0
    if (s.opacity > 0.995) s.opacity = 1

    // ── 涟漪时间累计（仅可见时递增）──────────────────
    if (s.opacity > 0) {
      s.rippleTime += delta
    }
  })

  return state
}
