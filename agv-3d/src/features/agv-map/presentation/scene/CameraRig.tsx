import { useLayoutEffect, useRef } from 'react'
import type { ComponentRef } from 'react'
import { useFrame, useThree } from '@react-three/fiber'
import { OrbitControls } from '@react-three/drei'
import type { PerspectiveCamera } from 'three'
import { DAMPING_FACTOR, MAX_POLAR_RAD, MIN_POLAR_RAD } from '../../config/cameraConfig'
import type { Bounds3Data } from '../../domain/renderPacket'
import {
  computeOrbitDistanceLimits,
  computePanBounds,
} from './cameraFraming'
import type { CameraFrame } from './cameraFraming'

/**
 * 相机立架：PerspectiveCamera + 受控 OrbitControls（SPEC §8.1 CameraRig、§9.2，TASK-011）。
 *
 * 职责：在 framing 计算的初始相机位置（由 Canvas camera prop 设置）之上，挂载 OrbitControls
 * 提供旋转、缩放、平移与阻尼，并把交互范围限制在 SPEC §9.2 规定的极角、距离与平移边界内。
 *
 * 不变量：
 * - 控件只管相机行为：不承载点击、悬停等业务状态（§9.2）；范围参数全部来自 cameraConfig，
 *   不在组件内散落数值（§12）。
 * - 极角受限：minPolarAngle/maxPolarAngle 限定 25°～70°，禁止完全俯视、接近水平或穿地（§9.2）。
 * - 距离受限：minDistance/maxDistance 由 renderBounds 包围球推导，允许贴近与拉远但不越界（§9.2）。
 * - 平移受限：target 的水平 x/z 被钳制到 renderBounds 水平范围外扩 20% 的矩形（§9.2）。
 * - 资源释放：drei OrbitControls 在卸载时自行 dispose 并移除 DOM 监听（§9.2 卸载移除监听器），
 *   本组件不额外注册全局监听，useFrame 回调随组件卸载自动停止。
 *
 * 平移钳制时序（见 cameraFraming 模块注释与 three-stdlib OrbitControls.update）：
 * OrbitControls 的平移带阻尼惯性，update 内部按 dampingFactor 把 panOffset 逐步累加到 target。
 * 本组件在每帧 OrbitControls.update 之后（drei 注册优先级 −1，本组件默认优先级 0 在其后执行）
 * 检查并钳制 target，同步平移相机以维持相机↔target 的相对偏移，避免视觉跳变；下一帧 update
 * 基于一致状态继续，惯性在边界处被自然吸收。
 */

/** drei OrbitControls 实例类型（forwardRef 的 ref 目标，即 three-stdlib OrbitControls）。 */
type OrbitControlsImpl = ComponentRef<typeof OrbitControls>

export interface CameraRigProps {
  /** 渲染边界，用于推导距离范围与平移边界。 */
  readonly bounds: Bounds3Data
  /** framing 计算的初始相机参数（target 用于初始化 OrbitControls 目标点）。 */
  readonly frame: CameraFrame
}

/**
 * 渲染受控 OrbitControls。
 *
 * 初始相机 position/fov/near/far 由 Canvas camera prop 提供（一次性），OrbitControls 接管后
 * 只在受控范围内改变 position 与 target；本组件负责把 target 初始化到框选目标并每帧钳制平移。
 */
export function CameraRig({ bounds, frame }: CameraRigProps) {
  const controlsRef = useRef<OrbitControlsImpl>(null)
  const camera = useThree((state) => state.camera) as PerspectiveCamera

  const distanceLimits = computeOrbitDistanceLimits(bounds)
  const panBounds = computePanBounds(bounds)

  // 初始化 target：OrbitControls 默认 target=(0,0,0)，需显式设到框选目标并立即 update，
  // 使首帧阻尼基于正确的 target↔position 偏移（SPEC §9.1 target 为边界中心地面投影）。
  // useLayoutEffect 在浏览器绘制前同步执行，确保首帧不会以 (0,0,0) target 闪现。
  useLayoutEffect(() => {
    const controls = controlsRef.current
    if (controls === null) return
    controls.target.set(frame.target[0], frame.target[1], frame.target[2])
    controls.update()
  }, [frame])

  // 每帧钳制平移 target 到允许矩形，同步平移相机吸收阻尼惯性（SPEC §9.2）。
  useFrame(() => {
    const controls = controlsRef.current
    if (controls === null || !controls.enabled) return
    const target = controls.target
    const clampedX = clamp(target.x, panBounds.minX, panBounds.maxX)
    const clampedZ = clamp(target.z, panBounds.minZ, panBounds.maxZ)
    if (clampedX !== target.x || clampedZ !== target.z) {
      // 平移相机补偿 target 钳制量，保持相机相对 target 的偏移不变。
      camera.position.x += clampedX - target.x
      camera.position.z += clampedZ - target.z
      target.x = clampedX
      target.z = clampedZ
    }
  })

  return (
    <OrbitControls
      ref={controlsRef}
      // SPEC §9.2：启用旋转、缩放、平移与阻尼。
      enableDamping
      enablePan
      enableZoom
      enableRotate
      dampingFactor={DAMPING_FACTOR}
      // SPEC §9.2：极角 25°～70°。
      minPolarAngle={MIN_POLAR_RAD}
      maxPolarAngle={MAX_POLAR_RAD}
      // SPEC §9.2：距离 max(2, r·0.05) ~ r·4。
      minDistance={distanceLimits.min}
      maxDistance={distanceLimits.max}
    />
  )
}

/** 三段式钳制：把 v 限制到 [lo, hi]，保证 lo ≤ v ≤ hi。 */
function clamp(value: number, lo: number, hi: number): number {
  if (value < lo) return lo
  if (value > hi) return hi
  return value
}
