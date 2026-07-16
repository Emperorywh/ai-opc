import type { Bounds3Data } from '../../domain/renderPacket'
import {
  DIRECTIONAL_LIGHT_AZIMUTH_RAD,
  DIRECTIONAL_LIGHT_DISTANCE_FACTOR,
  DIRECTIONAL_LIGHT_ELEVATION_RAD,
  ENVIRONMENT_MARGIN_M,
  FOG_FAR_FACTOR,
  FOG_NEAR_FACTOR,
  GRID_FADE_INNER_FACTOR,
  GRID_FADE_OUTER_FACTOR,
} from '../../config/environmentConfig'

/**
 * 环境空间布局纯函数（SPEC §6.3、§8.4、§9.1，TASK-012）。
 *
 * 职责：由 renderBounds 推导深色沙盘环境的全部绝对世界尺寸——外扩后的环境 AABB、地面与网格
 * 水平尺寸、线性雾近远、阴影正交相机范围、方向光位置与目标、网格径向衰减半径。所有"范围"
 * 统一由 renderBounds + ENVIRONMENT_MARGIN_M 推导，不写死 V76 世界坐标（SPEC §6.3）。
 *
 * 与 cameraFraming 同属展示层布局纯函数：相同 bounds 产生相同布局，不读取系统时间、相机或
 * 展示状态（SPEC §7.1 精神），可在 Node 环境直接断言范围、预算与边界覆盖关系。
 *
 * 不变量：
 * - 统一边距：environmentBounds = renderBounds 各轴外扩 ENVIRONMENT_MARGIN_M；地面、网格、
 *   阴影正交水平范围统一基于该外扩 AABB，不出现散落边距（SPEC §6.3）。
 * - 不依赖相机：网格衰减、雾距、阴影范围均以边界几何推导，不读取相机姿态（SPEC §8.4）。
 * - 有限性：对任意有限 renderBounds，全部输出为有限值；near < far、inner < outer、
 *   shadowExtent > 0，保证渲染参数合法。
 */

/**
 * 二维水平边界（世界 XZ 平面），由 renderBounds 外扩统一边距得到。
 * minZ/maxZ 对应世界 Z（map −y 方向）。
 */
export interface EnvironmentLayout {
  /**
   * 外扩后的环境 AABB（SPEC §6.3：renderBounds + 统一环境边距）。
   * 地面、网格、阴影范围统一基于该边界推导。
   */
  readonly environmentBounds: Bounds3Data
  /** 地面水平宽度（X 方向），单位米。等于 environmentBounds X 跨度。 */
  readonly groundWidthM: number
  /** 地面水平深度（Z 方向），单位米。等于 environmentBounds Z 跨度。 */
  readonly groundDepthM: number
  /** 网格水平宽度（X 方向），单位米。与地面共面同尺寸。 */
  readonly gridWidthM: number
  /** 网格水平深度（Z 方向），单位米。 */
  readonly gridDepthM: number
  /** 边界水平中心在世界 XZ 的投影 [x, z]，地面/网格/光目标/网格衰减中心据此居中。 */
  readonly center: readonly [number, number]
  /** 线性雾近端（相机空间深度），单位米。 */
  readonly fogNearM: number
  /** 线性雾远端（相机空间深度），单位米。完整拓扑在初始 framing 下仍可辨识（§8.4）。 */
  readonly fogFarM: number
  /** 方向光世界位置 [x, y, z]；y > 0 位于场景上方。 */
  readonly lightPosition: readonly [number, number, number]
  /** 方向光目标点 [x, y, z]；取边界中心地面投影 (cx, 0, cz)。 */
  readonly lightTarget: readonly [number, number, number]
  /** 阴影正交相机水平半范围，单位米；left/right/top/bottom = ±该值覆盖 environmentBounds。 */
  readonly shadowExtentM: number
  /** 阴影正交相机近面，单位米。 */
  readonly shadowCameraNearM: number
  /** 阴影正交相机远面，单位米。 */
  readonly shadowCameraFarM: number
  /** 网格径向衰减内半径（该范围内满透明度），单位米。 */
  readonly gridFadeInnerM: number
  /** 网格径向衰减外半径（该范围外完全透明），单位米。 */
  readonly gridFadeOuterM: number
}

/**
 * renderBounds 的包围球半径：取空间对角线之半（与 cameraFraming.boundsRadius 同约定，
 * 覆盖全部角点）。此处基于 environmentBounds 计算，使雾距随统一边距一同推导（§6.3）。
 */
function boundsRadius(bounds: Bounds3Data): number {
  const dx = bounds.max[0] - bounds.min[0]
  const dy = bounds.max[1] - bounds.min[1]
  const dz = bounds.max[2] - bounds.min[2]
  return Math.hypot(dx, dy, dz) / 2
}

/**
 * renderBounds 的水平半径：XZ 平面对角线之半，作为网格径向衰减基准（拓扑足迹半径）。
 */
function horizontalRadius(bounds: Bounds3Data): number {
  const dx = bounds.max[0] - bounds.min[0]
  const dz = bounds.max[2] - bounds.min[2]
  return Math.hypot(dx, dz) / 2
}

/**
 * 把 renderBounds 各轴外扩统一边距得到环境 AABB（SPEC §6.3）。
 *
 * Y 轴顶部外扩完整边距，使阴影正交相机与环境包围球覆盖地面以上的体积；Y 轴底部取
 * max(0, min[1] − margin)，保证环境底部不低于地面 y=0（renderBounds.min[1] 本就贴地 ≈ 0，
 * 对负输入也钳到 0，语义明确不依赖外层 Math.min）。
 */
function expandBounds(bounds: Bounds3Data, margin: number): Bounds3Data {
  return {
    min: [
      bounds.min[0] - margin,
      Math.max(0, bounds.min[1] - margin),
      bounds.min[2] - margin,
    ],
    max: [
      bounds.max[0] + margin,
      bounds.max[1] + margin,
      bounds.max[2] + margin,
    ],
  }
}

/**
 * 由渲染边界推导完整环境空间布局（SPEC §6.3、§8.4，TASK-012 核心）。
 *
 * 推导步骤：
 * 1. environmentBounds = renderBounds 各轴外扩 ENVIRONMENT_MARGIN_M（统一环境边距）。
 * 2. 地面/网格水平尺寸 = environmentBounds XZ 跨度；中心取 environmentBounds XZ 中心。
 * 3. 雾近/远 = environmentBounds 包围球半径 × FOG_NEAR/FAR_FACTOR（随统一边距推导）。
 * 4. 方向光位置 = 中心 + 距离 × 单位朝向（仰角/方位角来自 environmentConfig）；
 *    距离 = environmentBounds 包围球半径 × DIRECTIONAL_LIGHT_DISTANCE_FACTOR。
 * 5. 阴影正交水平半范围 = max(environmentBounds X/Z 半跨度)；近/远面 = 光距 ∓ envRadius，
 *    紧贴场景前后缘以集中阴影深度精度。
 * 6. 网格径向衰减内/外半径 = renderBounds 水平半径 × 因子（基于拓扑足迹而非相机，§8.4）。
 *
 * @param bounds 渲染边界（世界空间 AABB，来自 RenderPacket.renderBounds）。
 */
export function computeEnvironmentLayout(bounds: Bounds3Data): EnvironmentLayout {
  const environmentBounds = expandBounds(bounds, ENVIRONMENT_MARGIN_M)

  const groundWidthM = environmentBounds.max[0] - environmentBounds.min[0]
  const groundDepthM = environmentBounds.max[2] - environmentBounds.min[2]
  const center: readonly [number, number] = [
    (environmentBounds.min[0] + environmentBounds.max[0]) / 2,
    (environmentBounds.min[2] + environmentBounds.max[2]) / 2,
  ]

  // 雾距随 environmentBounds 包围球推导（§6.3 由 renderBounds 加统一环境边距推导雾效范围）。
  const envRadius = boundsRadius(environmentBounds)
  const fogNearM = envRadius * FOG_NEAR_FACTOR
  const fogFarM = envRadius * FOG_FAR_FACTOR

  // 方向光朝向：从中心指向光源的单位向量（仰角自地平面起、方位角自 +X 朝 +Z）。
  const elev = DIRECTIONAL_LIGHT_ELEVATION_RAD
  const azim = DIRECTIONAL_LIGHT_AZIMUTH_RAD
  const cosE = Math.cos(elev)
  const dirX = cosE * Math.cos(azim)
  const dirY = Math.sin(elev)
  const dirZ = cosE * Math.sin(azim)
  const lightDistance = envRadius * DIRECTIONAL_LIGHT_DISTANCE_FACTOR
  const lightPosition: readonly [number, number, number] = [
    center[0] + dirX * lightDistance,
    dirY * lightDistance,
    center[1] + dirZ * lightDistance,
  ]
  const lightTarget: readonly [number, number, number] = [center[0], 0, center[1]]

  // 阴影正交相机：正方形水平范围覆盖 environmentBounds XZ 外接；深度方向紧贴场景前后缘
  // （光距 ± envRadius）。envRadius 是包围 environmentBounds（已含 ENVIRONMENT_MARGIN_M）的球半径，
  // 对 AABB 略有高估，正好为前后缘留出安全余量；同时把 24bit 阴影深度精度集中到实际场景段，
  // 避免 [0, 光距−envRadius] 空白段稀释精度、加剧阴影量化条纹（SPEC §8.3 阴影覆盖完整节点足迹）。
  // lightDistance = envRadius × DIRECTIONAL_LIGHT_DISTANCE_FACTOR（因子 3 > 1），故
  //   near = lightDistance − envRadius = 2 × envRadius > 0、far = lightDistance + envRadius = 4 × envRadius，
  //   对任意有限边界恒有 0 < near < far，无需额外近面下限常量。
  const halfX = groundWidthM / 2
  const halfZ = groundDepthM / 2
  const shadowExtentM = Math.max(halfX, halfZ)
  const shadowCameraNearM = lightDistance - envRadius
  const shadowCameraFarM = lightDistance + envRadius

  // 网格径向衰减：以 renderBounds（拓扑足迹）水平半径为基准，不依赖相机（§8.4）。
  const topoRadius = horizontalRadius(bounds)
  const gridFadeInnerM = topoRadius * GRID_FADE_INNER_FACTOR
  const gridFadeOuterM = topoRadius * GRID_FADE_OUTER_FACTOR

  return {
    environmentBounds,
    groundWidthM,
    groundDepthM,
    gridWidthM: groundWidthM,
    gridDepthM: groundDepthM,
    center,
    fogNearM,
    fogFarM,
    lightPosition,
    lightTarget,
    shadowExtentM,
    shadowCameraNearM,
    shadowCameraFarM,
    gridFadeInnerM,
    gridFadeOuterM,
  }
}
