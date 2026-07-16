/**
 * 环境空间布局集中配置（SPEC §6.3、§8.4、§11.1、§12，TASK-012）。
 *
 * 本文件承载由渲染边界（renderBounds）推导深色沙盘环境范围所需的空间参数：统一环境边距、
 * 方向光空间朝向（位置由边界中心推导）、雾距因子、阴影正交相机范围与偏置、网格单元与径向
 * 衰减因子、本地 PMREM 生成参数。所有参数携带单位后缀（SPEC §12）。
 *
 * 与 visualTheme / performanceConfig 的分工（SPEC §12 配置按职责拆分）：
 * - 颜色、材质、光强等"看起来如何"的视觉参数集中于 visualTheme（环境视觉主题）。
 * - 阴影贴图分辨率属于性能预算，集中于 performanceConfig（SHADOW_MAP_SIZE_PIXELS）。
 * - 本文件只承载"在空间中铺多大、铺到哪里"的几何布局参数（边距、因子、单元尺寸），
 *   由 environmentLayout 纯函数消费后输出绝对世界尺寸，供 EnvironmentLayer 渲染消费。
 *
 * 不变量：
 * - 纯数据：不依赖 Three.js / React / 浏览器对象，可在 Node 环境直接断言数值与 SPEC 一致。
 * - 不写死 V76 世界坐标：所有"范围"以 renderBounds 的边距或半径的因子表达；改变边界尺寸时
 *   环境范围同步缩放（TASK-012 异常路径：改变渲染边界尺寸与中心，无硬编码裁切）。
 * - 统一边距：地面、网格与阴影正交范围统一以 ENVIRONMENT_MARGIN_M 外扩 renderBounds，
 *   不出现各自不同的散落边距（SPEC §6.3 "统一环境边距"，由 renderBounds 加统一环境边距推导）。
 */

/**
 * 统一环境边距，单位米（SPEC §6.3）。
 *
 * 地面尺寸、网格尺寸、阴影正交相机水平范围与雾距半径基准统一以该边距外扩 renderBounds：
 *   environmentBounds = renderBounds 各轴外扩 ENVIRONMENT_MARGIN_M。
 *
 * 取值面向 V76 基线（数十米尺度）：10 m 边距使地面/网格铺满初始 framing 的 5% 安全区之外，
 * 远端不出现裁切；同时阴影正交相机以同一外扩覆盖全部节点足迹，保证节点阴影完整落入贴图。
 * 该值为固定绝对边距（SPEC §6.3 "统一环境边距"），随 renderBounds 线性外扩，不写死世界坐标。
 */
export const ENVIRONMENT_MARGIN_M = 10

/**
 * 方向光的空间朝向（SPEC §8.3 一个带阴影的方向光）。
 *
 * 方向光位置由 renderBounds 中心加该朝向与距离推导（见 environmentLayout），不写死世界坐标。
 * 光的颜色与强度属视觉参数，集中于 visualTheme.ENVIRONMENT_THEME.directionalLight / ambientLight。
 *
 * - elevationDeg：光源仰角，自地平面向上度数。越大越接近顶光、阴影越短；取 55° 形成稳定斜影。
 * - azimuthDeg：光源方位角，自世界 +X 起、朝 +Z 为正（与相机方位角同约定，SPEC §6.2）。
 *   取 150° 使光源位于相机方位（45°）的对侧偏后方，节点侧面与阴影均面向相机可见。
 */
export interface DirectionalLightDirection {
  readonly elevationDeg: number
  readonly azimuthDeg: number
}

export const DIRECTIONAL_LIGHT_DIRECTION: DirectionalLightDirection = {
  elevationDeg: 55,
  azimuthDeg: 150,
}

/**
 * 方向光到边界中心的距离因子（SPEC §8.3）。
 *
 * 光距 = environmentBounds 包围球半径 × 该因子，使光源位于场景之外；方向光为正交投影，
 * 光距只影响阴影相机近远面，不影响阴影正交范围（由 environmentBounds 外扩决定）。
 */
export const DIRECTIONAL_LIGHT_DISTANCE_FACTOR = 3

/**
 * 线性雾近/远因子（SPEC §8.4 线性 Fog，相对 environmentBounds 包围球半径）。
 *
 * three.js Fog 以片段到相机的深度（非到地心的距离）计算雾化因子：
 *   fogFactor = (depth − near) / (far − near)。
 *
 * 初始 framing 相机距边界中心约 2～3 × 半径，最远拓扑点距相机约 4 × 半径（§9.1）。
 * 取 near = 1.0 × R、far = 5.0 × R 保证：近端拓扑几乎不雾化、远端拓扑雾化因子 < 1，
 * 完整拓扑在初始 framing 下仍可辨识（SPEC §8.4、§16.2 验收）。
 */
export const FOG_NEAR_FACTOR = 1.0

/** 线性雾远端因子（见 FOG_NEAR_FACTOR 说明，SPEC §8.4）。 */
export const FOG_FAR_FACTOR = 5.0

/**
 * 阴影正交相机深度范围（SPEC §8.3、§11.1）。
 *
 * 阴影相机以正交投影覆盖 environmentBounds；近/远面由 environmentLayout 紧贴场景前后缘推导：
 *   near = lightDistance − envRadius，far = lightDistance + envRadius，
 * 其中 lightDistance = envRadius × DIRECTIONAL_LIGHT_DISTANCE_FACTOR（因子 3）。该范围把 24bit
 * 阴影深度精度集中到实际场景段，避免 [0, 光距−envRadius] 空白段稀释精度、加剧阴影量化条纹
 * （TASK-012：此前近面固定 0.5、远面 = 光距 × 2，在 V76 量级下 [0.5, 78] 段空白占用深度缓冲，
 * 实际场景段精度被稀释）。envRadius 是包围 environmentBounds（已含 ENVIRONMENT_MARGIN_M）的
 * 球半径，对 AABB 略有高估，正好为前后缘留出安全余量，无需额外近面下限或远面因子常量。
 */

/**
 * 阴影偏置（SPEC §8.3，视觉防阴影瑕疵参数）。
 *
 * 负偏置消除自阴影阴影痤（shadow acne）；值集中配置，不在组件内散落。
 */
export const SHADOW_BIAS = -0.0002

/**
 * 阴影法线偏置（SPEC §8.3）。
 *
 * 沿法线偏移采样点，进一步消除低倾角下的阴影瑕疵；单位为世界米，与真实尺度一致（§6.1）。
 */
export const SHADOW_NORMAL_BIAS = 0.02

/**
 * 网格空间参数（SPEC §8.4 独立网格图层，透明度随距地图中心距离衰减）。
 *
 * 网格单元与粗倍数确定网格疏密；径向衰减内/外因子（相对 renderBounds 水平半径）控制
 * 从地图中心向外透明度衰减：fade = 1 − smoothstep(inner, outer, dist)。
 * 网格颜色与基础透明度属视觉参数，集中于 visualTheme.ENVIRONMENT_THEME.grid。
 *
 * 衰减以 renderBounds 水平半径（拓扑足迹）为基准：inner = 0.5 × R 在中心半半径内满透明度，
 * outer = 1.5 × R 在拓扑外缘外完成衰减，使网格随拓扑而非相机衰减（§8.4 不依赖相机）。
 */
export const GRID_FINE_CELL_M = 2.0

/** 粗网格相对细网格的倍数（每 N 个细单元出现一条更亮的粗线）。 */
export const GRID_COARSE_MULTIPLIER = 5

/** 网格径向衰减内半径因子（相对 renderBounds 水平半径，该范围内满透明度）。 */
export const GRID_FADE_INNER_FACTOR = 0.5

/** 网格径向衰减外半径因子（相对 renderBounds 水平半径，该范围外完全透明）。 */
export const GRID_FADE_OUTER_FACTOR = 1.5

/**
 * 本地程序化 PMREM 环境生成参数（SPEC §8.3 本地程序化环境，不请求远程 HDR）。
 *
 * PMREM 由 PMREMGenerator.fromScene 烘焙一个程序化渐变球面场景得到，不下载任何远程资源。
 * 梯度颜色属视觉参数，集中于 visualTheme.ENVIRONMENT_THEME.pmremGradient。
 *
 * - resolution：PMREM 立方体贴图单面分辨率（像素）。SPEC 未规定 PMREM 预算，取 128 兼顾
 *   质量与显存（three.js 默认 256；128 对纯环境光照足够）。
 * - blurSigma：fromScene 的模糊半径（弧度），0 表示直接烘焙程序化场景，不二次模糊。
 * - sceneRadiusM：程序化渐变球面半径，仅需包围 fromScene 的内部相机，与主场景尺度无关。
 * - nearM / farM：fromScene 内部相机近远面，保证球面完整入画。
 */
export const PMREM_RESOLUTION = 128

export const PMREM_BLUR_SIGMA = 0

export const PMREM_SCENE_RADIUS_M = 10

export const PMREM_NEAR_M = 0.1

export const PMREM_FAR_M = 100

/** 度→弧度常量，避免散落 ×π/180。 */
const DEG_TO_RAD = Math.PI / 180

/** 方向光仰角，弧度（供 environmentLayout 消费）。 */
export const DIRECTIONAL_LIGHT_ELEVATION_RAD = DIRECTIONAL_LIGHT_DIRECTION.elevationDeg * DEG_TO_RAD

/** 方向光方位角，弧度（供 environmentLayout 消费）。 */
export const DIRECTIONAL_LIGHT_AZIMUTH_RAD = DIRECTIONAL_LIGHT_DIRECTION.azimuthDeg * DEG_TO_RAD
