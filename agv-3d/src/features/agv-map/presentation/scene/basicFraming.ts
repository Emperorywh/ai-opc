import type { Bounds3Data } from '../../domain/renderPacket'

/**
 * 基础相机框选（SPEC §9.1）。
 *
 * 这是 TASK-009 的最小可用框选：以渲染边界包围球推算相机距离与位置，确保四类节点在
 * 倾斜沙盘视角下全部可见、可人工辨识形状与朝向。TASK-011 将以包围盒八角点在相机空间的
 * 水平/垂直需求与 5% 安全区精算（含 16:9 与 21:9 双比例约束）替换本函数；届时本文件可移除，
 * 上层只依赖返回的 CameraFrame 契约。
 *
 * 不变量：纯函数，相同边界产生相同相机参数，不读取系统时间或 DOM。
 */

/** 初始透视相机配置（SPEC §9.1：FOV 45°、near 0.1 m）。 */
export const CAMERA_FOV_DEG = 45
export const CAMERA_NEAR_M = 0.1
/** 初始俯仰角 45°（SPEC §9.1、§9.2）。 */
export const INITIAL_POLAR_DEG = 45
/** 初始方位角，给出 3/4 斜视以同时呈现形状剪影与朝向。 */
const INITIAL_AZIMUTH_DEG = 45
/** 基础框选的安全边距（包围球法），TASK-011 精算后将收紧为 5%。 */
const BASE_FRAMING_MARGIN = 0.15

/** 框选产物：相机位置、目标点与远裁面，供 Canvas 与控件消费。 */
export interface CameraFrame {
  readonly position: readonly [number, number, number]
  readonly target: readonly [number, number, number]
  /** 远裁面：不小于 1000 m 且不小于包围球半径的 10 倍（SPEC §9.1）。 */
  readonly far: number
}

/**
 * 由渲染边界推算基础相机框选。
 *
 * - target 取边界中心在地面的投影（SPEC §9.1）。
 * - distance 由包围球半径与半 FOV 正弦推算，加边距保证整体入画。
 * - 极角/方位角固定为初始沙盘视角，位置 = target + distance·(球坐标)。
 * - far 取 max(1000, 包围球半径 × 10)，保证远端拓扑不被裁切。
 */
export function computeBasicFraming(bounds: Bounds3Data): CameraFrame {
  const [minX, minY, minZ] = bounds.min
  const [maxX, maxY, maxZ] = bounds.max
  const cx = (minX + maxX) / 2
  const cz = (minZ + maxZ) / 2
  const dx = maxX - minX
  const dy = maxY - minY
  const dz = maxZ - minZ
  // 包围球半径：取包围盒对角线之半，覆盖全部节点与路径。
  const radius = Math.hypot(dx, dy, dz) / 2

  const fov = (CAMERA_FOV_DEG * Math.PI) / 180
  const safeRadius = radius * (1 + BASE_FRAMING_MARGIN)
  const distance = safeRadius / Math.sin(fov / 2)

  const polar = (INITIAL_POLAR_DEG * Math.PI) / 180
  const azimuth = (INITIAL_AZIMUTH_DEG * Math.PI) / 180
  const sinPolar = Math.sin(polar)
  const cosPolar = Math.cos(polar)
  const sinAzimuth = Math.sin(azimuth)
  const cosAzimuth = Math.cos(azimuth)

  const target: readonly [number, number, number] = [cx, 0, cz]
  const height = Math.max(distance * cosPolar, CAMERA_NEAR_M * 2)
  const position: readonly [number, number, number] = [
    cx + distance * sinPolar * cosAzimuth,
    height,
    cz + distance * sinPolar * sinAzimuth,
  ]
  const far = Math.max(1000, radius * 10)
  return { position, target, far }
}
