/**
 * 自由轨道相机控制器（原 SPEC §6.6 / D13「固定倾斜 + 限 pan/zoom」已放宽）。
 *
 * 交互（Task 10：经 InputAdapter 抽象，见 inputAdapter.ts / useCameraInput.ts）：
 *  - 左键拖拽 / 触屏单指 → rotate 朝向（yaw 360° + pitch 10–85°，clampPitch 防翻转）
 *  - 右键拖拽 / 触屏双指 → pan 目标点（世界坐标，clamp 到 §6.6 panBounds）
 *  - 滚轮 / 触控板双指 / 触屏双指捏合 → zoom 距离（clamp 到 zoom.min/max）
 *  - 阻尼平滑（帧率无关 lerp，状态机 current → goal；pitch/yaw 参与阻尼）
 *
 * store：距离 → 归一化 zoom 写入 `cameraZoom` 切片（节流，供 M4 Task 15 LOD 联动）。
 *
 * 相机位姿同源 Task 04 静态相机（pitch/yaw=初值时见 cameraState.computeCameraPosition），
 * 故 M1→M3 切换无跳变。Task 10 仅把输入层抽离，状态机/约束/阻尼/useFrame 结构不变；
 * 本轮（自由轨道化）新增旋转手势 + pitch/yaw 参与阻尼。
 */
import { useEffect, useRef, useCallback } from 'react'
import { useThree, useFrame } from '@react-three/fiber'
import type { PerspectiveCamera } from 'three'
import { cameraConfig } from '../../config/camera'
import { useStore } from '../../state/store'
import { useCameraInput } from '../../hooks/useCameraInput'
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

  // 输入意图 → goal 状态（Task 10：经 InputAdapter 抽象，状态机/约束不变）。
  const onPan = useCallback((dx: number, dy: number) => {
    // 右键 / 触屏双指拖拽 = 移动目标点（拖地图方向）；灵敏度随距离缩放（远处拖一格走更远）。
    const factor = goal.current.distance * cameraConfig.panSensitivity
    const [tx, tz] = clampTarget(
      goal.current.targetX - dx * factor,
      goal.current.targetZ - dy * factor,
    )
    goal.current.targetX = tx
    goal.current.targetZ = tz
  }, [])
  const onRotate = useCallback((dx: number, dy: number) => {
    // 左键 / 触屏单指拖拽 = 旋转朝向（拖地图方向：拖向哪、地图往哪翻）。
    // dx>0 右拖 → 地图右移（yaw 减）；dy>0 下拖 → 地图下翻（pitch 增、相机抬高俯视）。
    const s = cameraConfig.rotateSensitivity
    goal.current.yaw -= dx * s
    goal.current.pitch = clampPitch(goal.current.pitch + dy * s)
  }, [])
  const onZoom = useCallback((factor: number) => {
    // factor>1 拉远、<1 推近（wheelToZoomFactor 产出）。
    goal.current.distance = clampDistance(goal.current.distance * factor)
  }, [])

  useCameraInput(gl.domElement, { onPan, onRotate, onZoom })

  // 阻尼 + 应用到相机 + 节流写 store。
  useFrame((_, deltaRaw) => {
    const c = current.current
    const g = goal.current
    const delta = Math.min(deltaRaw, 0.1) // 防 tab 后台回切的大 delta 跳变
    const dm = cameraConfig.damping
    c.targetX = damp(c.targetX, g.targetX, dm, delta)
    c.targetZ = damp(c.targetZ, g.targetZ, dm, delta)
    c.distance = damp(c.distance, g.distance, dm, delta)
    // pitch/yaw 自由轨道化后由旋转手势驱动 → 参与阻尼。
    // pitch clamp 到 [pitchMin, pitchMax] 防翻转；yaw 无界（clampYaw 透传，周期量靠 sin/cos 归一）。
    c.pitch = clampPitch(damp(c.pitch, g.pitch, dm, delta))
    c.yaw = clampYaw(damp(c.yaw, g.yaw, dm, delta))

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
