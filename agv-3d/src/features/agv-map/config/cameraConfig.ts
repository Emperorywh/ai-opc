/**
 * 相机与控件集中配置（SPEC §9、§12）。
 *
 * 配置按职责集中、所有参数携带单位或含义后缀（SPEC §12）。本文件承载透视相机固有参数、
 * 初始沙盘视角、OrbitControls 受控范围与 framing 安全边距，供 cameraFraming 纯函数与
 * CameraRig 展示组件共享，禁止组件内散落这些数值（§9.1、§9.2）。
 *
 * 不变量：
 * - 纯数据：不依赖 Three.js、React 或浏览器对象，可在 Node 环境直接验证数值与 SPEC 一致。
 * - FOV 与距离解耦：FOV 固定 45°，framing 只通过计算相机距离完成，不同时动态修改二者（§9.1）。
 * - 控件只管相机行为：极角、距离与平移边界均为几何约束，不承载业务点击或悬停状态（§9.2）。
 */

/**
 * 透视相机垂直视野，单位度（SPEC §9.1：固定 45°）。
 * 水平视野由 aspect 派生，运行期不单独修改 FOV（§9.1 FOV 与距离解耦）。
 */
export const CAMERA_FOV_DEG = 45

/** 近裁面，单位米（SPEC §9.1：固定 0.1 m）。 */
export const CAMERA_NEAR_M = 0.1

/** 初始俯仰角（polar angle，从 +Y 轴起算），单位度（SPEC §9.1、§9.2：45°）。 */
export const INITIAL_POLAR_DEG = 45

/**
 * 初始方位角，单位度。
 * 给出 3/4 斜视以同时呈现四类节点的形状剪影与方向性节点的朝向；SPEC 未强制该值，
 * 属不影响架构边界的局部视角选择（§1 关键词"可"）。纯函数消费，不依赖运行时状态。
 */
export const INITIAL_AZIMUTH_DEG = 45

/**
 * framing 安全边距，无量纲（SPEC §9.1：保留 5% 安全边距）。
 * 取 0.05 表示内容投影不超过画面半视场的 95%，使完整 renderBounds 位于画面 5% 安全区内（§16.2）。
 */
export const FRAMING_MARGIN = 0.05

/**
 * framing 参考宽高比（SPEC §9.1：16:9 与 21:9 均必须完整容纳）。
 *
 * 水平容纳能力随 aspect 增大而增强（水平半视场正切 = tan(vHalf) × aspect），故在常见宽屏里
 * 16:9 是比 21:9 更紧的水平约束。framing 以 16:9 为参考计算相机距离，可同时保证：
 * - 16:9 画面下内容刚好落在 5% 安全区内；
 * - 21:9 画面（水平更宽容纳）下内容更靠中央、仍在安全区内。
 *
 * 运行期窗口比例可能随 resize 变化，但 framing 只在初始计算一次、distance 不随 resize 改变
 * （§9.3 resize 不重新编译静态设置）；极端窄屏（aspect < 16:9）允许 letterbox（§9.3）。
 */
export const FRAMING_REFERENCE_ASPECT = 16 / 9

/** 极角下限，单位度（SPEC §9.2：25°，禁止完全俯视）。 */
export const MIN_POLAR_DEG = 25

/** 极角上限，单位度（SPEC §9.2：70°，禁止接近水平或进入地面以下）。 */
export const MAX_POLAR_DEG = 70

/**
 * 最近距离的包围球半径因子（SPEC §9.2：半径 × 0.05）。
 * 与 MIN_DISTANCE_FLOOR_M 取较大值作为 OrbitControls.minDistance。
 */
export const MIN_DISTANCE_RADIUS_FACTOR = 0.05

/** 最近距离的绝对下限，单位米（SPEC §9.2：2 m）。 */
export const MIN_DISTANCE_FLOOR_M = 2

/** 最远距离的包围球半径因子（SPEC §9.2：半径 × 4）。 */
export const MAX_DISTANCE_RADIUS_FACTOR = 4

/**
 * 平移 target 允许区域相对 renderBounds 水平范围的外扩比例（SPEC §9.2：向外扩展 20%）。
 * 即 target 的 x/z 被限制在 [min - ext·size, max + ext·size]，ext = 0.20。
 */
export const PAN_BOUND_EXPANSION = 0.2

/** OrbitControls 阻尼系数（SPEC §9.2：启用阻尼）。越大响应越快、惯性越小。 */
export const DAMPING_FACTOR = 0.08

/** 远裁面绝对下限，单位米（SPEC §9.1：不小于 1000 m）。 */
export const FAR_MIN_M = 1000

/** 远裁面的包围球半径因子（SPEC §9.1：不小于包围球半径的 10 倍）。 */
export const FAR_RADIUS_FACTOR = 10

/** 度→弧度常量，避免散落 ×π/180。 */
const DEG_TO_RAD = Math.PI / 180

/** 初始极角，弧度（供 framing 纯函数消费）。 */
export const INITIAL_POLAR_RAD = INITIAL_POLAR_DEG * DEG_TO_RAD

/** 初始方位角，弧度。 */
export const INITIAL_AZIMUTH_RAD = INITIAL_AZIMUTH_DEG * DEG_TO_RAD

/** 极角下限，弧度（供 OrbitControls minPolarAngle）。 */
export const MIN_POLAR_RAD = MIN_POLAR_DEG * DEG_TO_RAD

/** 极角上限，弧度（供 OrbitControls maxPolarAngle）。 */
export const MAX_POLAR_RAD = MAX_POLAR_DEG * DEG_TO_RAD

/** 相机垂直半视场，弧度（framing 投影计算用）。 */
export const CAMERA_HALF_FOV_RAD = (CAMERA_FOV_DEG * DEG_TO_RAD) / 2
