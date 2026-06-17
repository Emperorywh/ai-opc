/**
 * 受限沙盘相机状态机（SPEC §6.6 / D13：固定倾斜 + 限 pan/zoom）。
 *
 * 相机模型 —— 绕目标点 (targetX, 0, targetZ) 的球面：
 *   camPos = target + distance · (cos pitch · sin yaw,  sin pitch,  cos pitch · cos yaw)
 *
 * 约束（全部纯函数，便于单测覆盖 SPEC §6.6 边界）：
 *   - pitch ∈ [pitchMin°, pitchMax°]（锁定 pitchDeg，永不翻转）
 *   - yaw   ∈ [±yawRange°]（锁定主朝向 0，保留小范围摆动配置）
 *   - target ∈ panBounds（x∈[-1.1,1.1], z∈[-0.6,0.6]，SPEC §6.6）
 *   - distance ∈ [zoom.min, zoom.max]
 *
 * Task 09：控制器内核 + 内置 pointer/wheel 输入（见 SandboxControls.tsx）。
 * Task 10：输入抽象为 InputAdapter，本状态机/约束/阻尼不变。
 */
import { cameraConfig, type CameraConfig } from '../../config/camera'

/** 球面相机状态。target 投影在 y=0 平面。 */
export type CameraState = {
  targetX: number
  targetZ: number
  distance: number
  /** 俯仰（弧度），锁定 pitchDeg。 */
  pitch: number
  /** 偏航（弧度），锁定主朝向 0。 */
  yaw: number
}

/** 初始相机状态：看地图中心，距离 = initialDistance，pitch = pitchDeg。 */
export function initialCameraState(cfg: CameraConfig = cameraConfig): CameraState {
  return {
    targetX: 0,
    targetZ: 0,
    distance: cfg.initialDistance,
    pitch: (cfg.pitchDeg * Math.PI) / 180,
    yaw: 0,
  }
}

/** 三参夹紧。 */
export function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v
}

/**
 * pan 目标点边界 clamp（SPEC §6.6：x∈[-1.1,1.1], z∈[-0.6,0.6]）。
 * 返回 [x, z]（已 clamp 到 panBounds 框内）。
 */
export function clampTarget(
  x: number,
  z: number,
  cfg: CameraConfig = cameraConfig,
): readonly [number, number] {
  const b = cfg.panBounds
  return [clamp(x, b.xMin, b.xMax), clamp(z, b.zMin, b.zMax)]
}

/** zoom 距离 clamp（SPEC §6.6：min/max 距离）。 */
export function clampDistance(d: number, cfg: CameraConfig = cameraConfig): number {
  return clamp(d, cfg.zoom.min, cfg.zoom.max)
}

/** pitch clamp（SPEC §6.6：锁定 45–60°）。>90° 翻转区被压回 pitchMax → 永不翻转。 */
export function clampPitch(p: number, cfg: CameraConfig = cameraConfig): number {
  return clamp(p, (cfg.pitchMinDeg * Math.PI) / 180, (cfg.pitchMaxDeg * Math.PI) / 180)
}

/** yaw clamp（SPEC §6.6：±yawRangeDeg 小范围摆动；锁定主朝向时 yaw=0）。 */
export function clampYaw(y: number, cfg: CameraConfig = cameraConfig): number {
  const r = (cfg.yawRangeDeg * Math.PI) / 180
  return clamp(y, -r, r)
}

/**
 * 距离 → 归一化 zoom ∈ [0,1]（最远=0，最近=1）。
 * 供 store `cameraZoom` 切片（M4 Task 15 LOD 联动订阅）。
 */
export function distanceToZoom(d: number, cfg: CameraConfig = cameraConfig): number {
  const { min, max } = cfg.zoom
  return clamp((max - d) / (max - min), 0, 1)
}

/**
 * 帧率无关阻尼平滑（指数趋近）。
 * `damping` 越小越平滑（追上越慢）；delta 为帧间隔（秒）。
 * 等价：每 1/60s 追上 `damping` 比例 —— 与帧率无关。
 */
export function damp(current: number, target: number, damping: number, delta: number): number {
  const k = 1 - Math.pow(1 - damping, delta * 60)
  return current + (target - current) * k
}

/**
 * 由球面状态算相机世界位置（SPEC §6.6 模型）。
 *
 * pitch = pitchDeg(45°)、yaw = 0 时退化为 Task 04 StaticCamera 同源位置：
 *   (targetX, sin(pitch)·distance, targetZ + cos(pitch)·distance)
 * 再 `lookAt(targetX, 0, targetZ)` —— 与静态倾斜相机完全一致，保证 M1→M3 相机连续。
 */
export function computeCameraPosition(s: CameraState): readonly [number, number, number] {
  const { targetX, targetZ, distance: d, pitch, yaw } = s
  const cp = Math.cos(pitch)
  return [
    targetX + d * cp * Math.sin(yaw),
    d * Math.sin(pitch),
    targetZ + d * cp * Math.cos(yaw),
  ]
}
