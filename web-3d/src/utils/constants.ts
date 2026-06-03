/**
 * Sci-Fi Earth MVP — 全局常量
 */

// ── 颜色 ──────────────────────────────────────────────
/** 主色调：冰蓝 / 青色 */
export const COLOR_PRIMARY = 0x4db8ff
export const COLOR_ACCENT = 0x00e5ff

/** Fresnel 边缘发光颜色（归一化 RGB） */
export const FRESNEL_COLOR = { r: 0.3, g: 0.7, b: 1.0 }

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

// ── 空闲模式 ──────────────────────────────────────────
/** 无输入多少秒后进入空闲模式 */
export const IDLE_TIMEOUT = 3.0 // 秒

// ── 手势平滑 ──────────────────────────────────────────
/** 低通滤波截止频率 (Hz) */
export const GESTURE_SMOOTH_CUTOFF = 2.0
/** 运动阻尼因子 */
export const GESTURE_DAMPING_FACTOR = 0.05

// ── 粒子规模 ──────────────────────────────────────────
export const ORBITAL_PARTICLE_COUNT = 3000
export const AMBIENT_DUST_COUNT = 3000
export const SURFACE_PULSE_COUNT = 200

// ── 星空 ──────────────────────────────────────────────
export const STAR_COUNT = 2000

// ── 后处理 ────────────────────────────────────────────
export const BLOOM_INTENSITY = 1.2
export const BLOOM_LUMINANCE_THRESHOLD = 0.6
export const BLOOM_LUMINANCE_SMOOTHING = 0.3
export const VIGNETTE_DARKNESS = 0.4
export const VIGNETTE_OFFSET = 0.5
export const NOISE_OPACITY = 0.02

// ── 加载秀场（阶段 15~16）──────────────────────────────
/** 聚合粒子数量 */
export const LOADING_PARTICLE_COUNT = 5000
/** 起始散布球壳内径 */
export const LOADING_SCATTER_RADIUS_MIN = 5.0
/** 起始散布球壳外径 */
export const LOADING_SCATTER_RADIUS_MAX = 12.0
/** 目标球体半径（= 地球半径） */
export const LOADING_TARGET_RADIUS = 1.0
/** 聚合动画时长（秒） */
export const LOADING_DURATION = 3.0
/** 加载粒子淡出时长（秒）—— texture 阶段 */
export const LOADING_FADE_OUT_DURATION = 1.5
/** 纹理显现时长（秒）—— texture 阶段 */
export const LOADING_TEXTURE_REVEAL_DURATION = 2.0
/** 系统激活时长（秒）—— activate 阶段 */
export const LOADING_ACTIVATE_DURATION = 1.0
