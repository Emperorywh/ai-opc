/**
 * 相机约束（SPEC §6.6 / D13：固定倾斜 + 限 pan/zoom）。
 *
 * ⚠️ Task 01 仅落地约束常量骨架；静态倾斜相机在 Task 04，受限控制器
 *    SandboxControls 在 Task 09。
 */

export const cameraConfig = {
  /** 俯仰角 pitch（度），固定倾斜，锁定 ~45°（可配 45–60°）。 */
  pitchDeg: 45,
  pitchMinDeg: 45,
  pitchMaxDeg: 60,
  /** 偏航 yaw 小范围摆动（度）。 */
  yawRangeDeg: 15,
  /** 平移目标点边界（世界平面坐标，SPEC §6.6）。 */
  panBounds: { xMin: -1.1, xMax: 1.1, zMin: -0.6, zMax: 0.6 },
  /** 缩放距离区间。 */
  zoom: { min: 1.2, max: 3.5 },
  /** 阻尼平滑系数。 */
  damping: 0.1,
} as const

export type CameraConfig = typeof cameraConfig
