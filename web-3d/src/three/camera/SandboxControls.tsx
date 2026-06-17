/**
 * 受限沙盘相机控制器（SPEC §6.6 / D13：固定倾斜 + 限 pan/zoom）。
 *
 * 交互（Task 09 内置最小输入；Task 10 抽象为 InputAdapter）：
 *  - 主键拖拽 → pan 目标点（世界坐标，clamp 到 §6.6 panBounds）
 *  - 滚轮 → zoom 距离（clamp 到 zoom.min/max，指数步长）
 *  - pitch 锁定 pitchDeg(45°) / yaw 锁定主朝向(0) → 输入不改 pitch/yaw，永不翻转
 *  - 阻尼平滑（帧率无关 lerp，状态机 current → goal）
 *
 * store：距离 → 归一化 zoom 写入 `cameraZoom` 切片（节流，供 M4 Task 15 LOD 联动）。
 *
 * 相机位姿同源 Task 04 静态相机（pitch/yaw=0 时见 cameraState.computeCameraPosition），
 * 故 M1→M3 切换无跳变。
 */
import { useEffect, useRef } from 'react'
import { useThree, useFrame } from '@react-three/fiber'
import type { PerspectiveCamera } from 'three'
import { cameraConfig } from '../../config/camera'
import { useStore } from '../../state/store'
import {
  type CameraState,
  initialCameraState,
  clampTarget,
  clampDistance,
  clampPitch,
  clampYaw,
  distanceToZoom,
  damp,
  computeCameraPosition,
} from './cameraState'

export function SandboxControls() {
  const camera = useThree((s) => s.camera)
  const gl = useThree((s) => s.gl)
  const setCameraZoom = useStore((s) => s.setCameraZoom)

  // 阻尼后实际状态（驱动相机）vs 目标状态（输入改变它）。
  const current = useRef<CameraState>(initialCameraState())
  const goal = useRef<CameraState>(initialCameraState())
  // 初始 zoom 与 initialCameraState().distance 同源（=initialDistance），不读 ref 以满足 react-hooks/refs。
  const lastZoom = useRef<number>(distanceToZoom(cameraConfig.initialDistance))

  // 输入：拖拽 pan + 滚轮 zoom（pitch/yaw 锁定，不绑定输入）。
  useEffect(() => {
    const el = gl.domElement
    let dragging = false
    let lastX = 0
    let lastY = 0

    const onPointerDown = (e: PointerEvent) => {
      // 仅主键（含触屏单指/笔）触发 pan；右键/中键留作未来（Task 10）。
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
      // 拖拽 = 移动目标点（拖地图方向）；灵敏度随距离缩放（远处拖一格走更远）。
      const factor = goal.current.distance * cameraConfig.panSensitivity
      const [tx, tz] = clampTarget(
        goal.current.targetX - dx * factor,
        goal.current.targetZ - dy * factor,
      )
      goal.current.targetX = tx
      goal.current.targetZ = tz
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
      // 向后滚(deltaY>0) → 拉远；向前滚 → 推近。指数步长平滑。
      goal.current.distance = clampDistance(
        goal.current.distance * Math.exp(e.deltaY * cameraConfig.wheelZoomFactor),
      )
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
  }, [gl])

  // 阻尼 + 应用到相机 + 节流写 store。
  useFrame((_, deltaRaw) => {
    const c = current.current
    const g = goal.current
    const delta = Math.min(deltaRaw, 0.1) // 防 tab 后台回切的大 delta 跳变
    const dm = cameraConfig.damping
    c.targetX = damp(c.targetX, g.targetX, dm, delta)
    c.targetZ = damp(c.targetZ, g.targetZ, dm, delta)
    c.distance = damp(c.distance, g.distance, dm, delta)
    // pitch/yaw 锁定：输入不改它们；clamp 保留以约束外部设置，防翻转。
    c.pitch = clampPitch(c.pitch)
    c.yaw = clampYaw(c.yaw)

    const cam = camera as PerspectiveCamera
    const [x, y, z] = computeCameraPosition(c)
    cam.position.set(x, y, z)
    cam.lookAt(c.targetX, 0, c.targetZ)

    // 节流写 store（变化超阈值才 set，避免每帧触发订阅者）。
    const zoom = distanceToZoom(c.distance)
    if (Math.abs(zoom - lastZoom.current) > 0.001) {
      lastZoom.current = zoom
      setCameraZoom(zoom)
    }
  })

  // 初始化 store cameraZoom 与实际距离一致（store 默认 1 ≠ 初始 zoom）。
  useEffect(() => {
    setCameraZoom(distanceToZoom(current.current.distance))
  }, [setCameraZoom])

  return null
}
