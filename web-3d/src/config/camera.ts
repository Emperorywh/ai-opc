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
  /** 垂直视场角（度）。 */
  fov: 45,
  /** M1 静态相机距地图中心的距离（落在 zoom.min/max 内）；M3 由 SandboxControls 接管。 */
  initialDistance: 2.5,
  /** 阻尼平滑系数（越小越平滑；每 1/60s 追上此比例）。 */
  damping: 0.1,
  /** 拖拽 pan 灵敏度（世界单位/像素，乘以当前距离）。Task 10 触控板可调。 */
  panSensitivity: 0.0015,
  /** 滚轮 zoom 指数步长系数（distance *= exp(deltaY · 系数)）。 */
  wheelZoomFactor: 0.001,
} as const

export type CameraConfig = typeof cameraConfig
