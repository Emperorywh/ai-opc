/**
 * 地球全局常量
 */

// ── 地球参数 ──────────────────────────────────────────
export const EARTH_RADIUS = 1.0
export const EARTH_SEGMENTS = 64
export const EARTH_TILT = 23.5 * (Math.PI / 180) // 真实轴倾斜角
export const EARTH_ROTATION_SPEED = 0.02 // rad/s

// ── 相机参数 ──────────────────────────────────────────
export const CAMERA_INITIAL_DISTANCE = 3.5
export const CAMERA_FOV = 45
export const CAMERA_ZOOM_MIN = 2.0
export const CAMERA_ZOOM_MAX = 8.0
export const CAMERA_NEAR = 0.1
export const CAMERA_FAR = 1000
