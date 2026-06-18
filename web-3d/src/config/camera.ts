/**
 * 相机约束 —— 自由轨道相机（原 SPEC §6.6 / D13「固定倾斜 + 限 pan/zoom」已放宽）。
 *
 * 交互范式（左键旋转 / 右键平移 / 滚轮缩放，见 inputAdapter.ts / SandboxControls.tsx）：
 *  - pitch ∈ [pitchMin°, pitchMax°]（10–85°，防贴地穿模 + 防翻到平面背面）
 *  - yaw 全自由 360°（yawRangeDeg=180 ⇒ clampYaw 透传不夹紧；周期量靠 sin/cos 归一）
 *  - target ∈ panBounds（右键 / 触屏双指平移目标点边界）
 *  - distance ∈ [zoom.min, zoom.max]（min 放宽到 0.3 看清国家细节）
 *
 * ⚠️ Task 01 落地约束常量骨架；静态倾斜相机在 Task 04，控制器 SandboxControls 在 Task 09；
 *    本轮（自由轨道化）放开 pitch/yaw/zoom 三组约束 + 新增旋转手势。
 */

export const cameraConfig = {
  /** 俯仰角 pitch 初值（度），自由轨道起始 ~45°（自由轨道化后不再锁定，可由旋转手势改变）。 */
  pitchDeg: 45,
  /** pitch 下限：低角度侧视（防贴地穿模；极端低角度可能轻微穿入山体，地图查看器常见）。 */
  pitchMinDeg: 10,
  /** pitch 上限：近俯视（防翻到平面背面——世界地图为单面平面）。 */
  pitchMaxDeg: 85,
  /** 偏航 yaw 旋转范围（度）。=180 ⇒ 全自由 360°（clampYaw 透传不夹紧，yaw 为周期量）。 */
  yawRangeDeg: 180,
  /** 平移目标点边界（世界平面坐标，SPEC §6.6）。 */
  panBounds: { xMin: -1.1, xMax: 1.1, zMin: -0.6, zMax: 0.6 },
  /** 缩放距离区间。min 放宽到 0.3（地图半宽 1.0）以看清国家细节。 */
  zoom: { min: 0.3, max: 3.5 },
  /** 垂直视场角（度）。 */
  fov: 45,
  /** M1 静态相机距地图中心的距离（落在 zoom.min/max 内）；M3 由 SandboxControls 接管。 */
  initialDistance: 2.5,
  /** 阻尼平滑系数（越小越平滑；每 1/60s 追上此比例）。 */
  damping: 0.1,
  /** 拖拽 pan 灵敏度（世界单位/像素，乘以当前距离）。Task 10 触控板可调。 */
  panSensitivity: 0.0015,
  /** 旋转灵敏度（弧度/像素，左键 / 触屏单指拖拽 → yaw/pitch 角度增量）。 */
  rotateSensitivity: 0.005,
  /** 滚轮 zoom 指数步长系数（distance *= exp(deltaY · 系数)）。鼠标滚轮 / 触控板双指滚动。 */
  wheelZoomFactor: 0.001,
  /** 触控板双指捏合 zoom 系数（浏览器把 pinch 映射为 ctrlKey=true 的 wheel，deltaY 量级更小，故系数更大）。 */
  pinchZoomFactor: 0.01,
} as const

export type CameraConfig = typeof cameraConfig
