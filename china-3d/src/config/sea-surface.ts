/**
 * 动态海面视觉与几何配置——唯一事实源（TASK-007，SPEC §3.5）。
 *
 * 角色与依赖方向：
 * - 本模块属于运行时配置层（src/config），是「海平面世界 y、海面半透明基线、深蓝青基线色、
 *   双层流动扰动参数、海面 plane 米制覆盖范围」的**唯一**权威。海面渲染层（src/three/SeaSurface）、
 *   海面着色器（src/three/sea-surface-shaders 经组件注入 uniform）、自动化测试都只能通过本模块取得
 *   这些参数——禁止在组件 / 着色器 / 测试里各自复制一份海平面高度或透明度。
 * - 单向依赖：本模块只依赖坐标层 src/lib/projection（MAIN_MAP_WORLD_BOUNDS —— 主图世界米制包围盒的
 *   唯一源），用来派生海面 plane 的米制覆盖范围（与地形 plane 同一份世界范围）。不依赖 React /
 *   R3F / Three.js / DOM，故自动化测试可在 Node 环境直接断言「海平面 = 0（与地形同米制）」
 *   「透明度落在 [0.55, 0.7]」「覆盖范围 = 主图世界包围盒」「波动参数有限且细微」等不变量。
 *
 * 海平面 = 地形海平面（同一米制 y=0，不得用视觉偏移掩盖坐标不一致）：
 * - 地形 vertex shader 把真实海拔 h 位移到世界 y = h·k（SPEC §3.2、src/config/terrain-config）；
 *   h=0（海平面）时世界 y=0。故海面 plane 放在世界 y=0 即恰好落在地形的海平面——二者共用同一
 *   米制海平面，无需任何视觉偏移。SEA_LEVEL_Y_METERS = 0 是这一不变量的显式锚点：组件据此放置
 *   mesh（position.y=0），测试据此断言「海平面 y = 0」。任何把海面抬 / 降以掩盖坐标不一致的改动
 *   都会改本常量，从而被测试捕获。
 *
 * 半透明基线（SPEC §3.5「半透明（opacity ≈ 0.55–0.7）」）：
 * - 取 0.6（区间内）：既能透过海面看到水下大陆架（保留负高程地形可见），又足够「是水」而非虚无。
 *   透明度是基线 uniform（uOpacity），片元着色器直接作为输出 alpha——不参与陆地色阶、不随高程变化。
 * - 半透明 + depthWrite=false（见组件）：海面在透明通道绘制、不写深度，使水下地形（不透明、已写
 *   深度、world-y<0 在海面之下）透过海面可见；陆地 world-y>0 在海面之上、先写深度，海面片元在陆地
 *   区域通不过深度测试被丢弃——海面只覆盖海域、不遮陆地。单张平面无自相交 / 无多层透明叠加，
 *   故无透明排序闪烁。
 *
 * 大陆架透视由「水下地形色阶 + 海面半透明」共同呈现，不由海面着色（SPEC §3.5「海面不参与分层设色」）：
 * - 水下地形（h<0）由地形层按高程色阶着色：近岸 h→0⁻ 偏亮（过渡向平原青绿 #1f4d3a）、远海
 *   h→−1500 近黑（#06121c），分段线性过渡（src/config/elevation-color-ramp 唯一事实源）。
 *   海面只是覆盖其上的半透明面——透视看到的「近岸浅、远海深」明→暗梯度来自水下地形本身，
 *   海面着色恒为深蓝青基线色 + 细微扰动，**不**读取 heightmap、**不**重做色阶。
 * - 故本模块**不**携带任何高程 / 色阶字段（domain / ramp / breakpoints / minH / maxH），测试断言
 *   其上不存在这些字段，证明海面层不会改写高程或色阶配置。
 *
 * 双层流动扰动（SPEC §3.5「fragment shader 用时间驱动的法线扰动（双层流动 noise / gerstner 概念
 * 简化）模拟微波」）：
 * - 两层正弦波（不同 UV 频率、不同方向、不同流速、不同相位）叠加为扰动量，对海面基线色做细微
 *   亮度调制——正弦的空间导数即微法线倾斜，亮度调制是该法线扰动的简化呈色（gerstner 概念简化），
 *   模拟微波涟漪。幅度刻意压低（< 0.1），保证「细微、不喧宾夺主」。
 * - 两层都消费**同一个** uTime uniform（由 R3F 共享时钟驱动，见 SeaSurface 组件）——这是「统一时钟、
 *   不建独立漂移时钟」（SPEC §7.4）的结构性保证：着色器只声明一个 uniform float uTime，两层波动
 *   的时间项都是 uTime·speed。测试据此断言「着色器内 uTime 声明恰一次」「两层 sin 均含 uTime 项」。
 *
 * 与 TASK-008（场景氛围）的边界：
 * - 可选轻雾（SPEC §3.4）已由 TASK-008 装配：雾色 / 雾密度的事实源是 src/config/scene-atmosphere
 *   （SCENE_ATMOSPHERE_CONFIG.fog），以同一 FogExp2 公式同时补进地形与海面片元（见
 *   terrain-shaders.ts / sea-surface-shaders.ts）。本模块不携带任何雾参数——海面层只消费「海面
 *   语义」参数，雾是场景氛围横切关注点，归场景氛围配置。
 */

import { MAIN_MAP_WORLD_BOUNDS } from '../lib/projection'

/**
 * 海平面世界 y（米）= 0。
 *
 * 与地形高程同一米制海平面：地形真实海拔 h 经 vertex shader 位移到世界 y = h·k，h=0 时 y=0。
 * 海面 mesh 放在 position.y = SEA_LEVEL_Y_METERS = 0 即落在地形海平面，无视觉偏移。
 * 单独导出此常量使「海平面 = 0」成为可读、可测的不变量锚点（测试断言其为 0）。
 */
export const SEA_LEVEL_Y_METERS = 0

/**
 * 海面基线透明度下限（含）。SPEC §3.5：opacity ≈ 0.55–0.7。
 *
 * 透明度必须足以透视水下地形（≤ 上限），又必须「是水」（≥ 下限，不是虚无）。两端都来自 SPEC，
 * 测试据此断言「透明度落在 [0.55, 0.7]」。
 */
export const SEA_SURFACE_OPACITY_MIN = 0.55
/** 海面基线透明度上限（含）。SPEC §3.5：opacity ≈ 0.55–0.7。 */
export const SEA_SURFACE_OPACITY_MAX = 0.7
/**
 * 海面基线透明度。取 0.6（SPEC 区间内）：透视水下大陆架与「是水」的平衡点。
 *
 * 作为 uOpacity uniform 注入片元着色器，直接成为输出 alpha（半透明混合，见组件 depthWrite=false）。
 * 不随高程 / 时间变化——海面透明度是恒定基线，水下深度梯度由地形色阶承担。
 */
export const SEA_SURFACE_OPACITY = 0.6

/**
 * 海面深蓝青基线色（SPEC §3.5「深蓝青色」，十六进制）。
 *
 * 取 #0a3340（r=10、g=51、b=64）：蓝通道占优、青绿次之、红最低，呈深蓝青；明度低于陆地层设色的
 * 近岸色（平原 #1f4d3a）以读作「水」，又高于深海近黑（#06121c）以在半透明下仍可辨。颜色是恒定
 * 基线（uColor uniform），不读 heightmap、不参与陆地色阶——大陆架透视看到的深浅梯度来自水下地形
 * 色阶透过半透明海面，而非海面自身着色。
 */
export const SEA_SURFACE_HEX = '#0a3340'

/** RGB 颜色（每通道 0–255，与浏览器 / three.js 字节色一致）。 */
export interface SeaSurfaceRgbColor {
  readonly r: number
  readonly g: number
  readonly b: number
}

/** 把 #rrggbb 形式的十六进制色串解析为 SeaSurfaceRgbColor（每通道 0–255）。仅供本模块内部构建常量。 */
function parseHex(hex: string): SeaSurfaceRgbColor {
  const value = hex.startsWith('#') ? hex.slice(1) : hex
  if (value.length !== 6) {
    throw new Error(`颜色必须是 #rrggbb 六位十六进制，实际为 ${hex}。`)
  }
  const r = Number.parseInt(value.slice(0, 2), 16)
  const g = Number.parseInt(value.slice(2, 4), 16)
  const b = Number.parseInt(value.slice(4, 6), 16)
  if ([r, g, b].some((channel) => !Number.isFinite(channel) || channel < 0 || channel > 255)) {
    throw new Error(`颜色通道必须落在 [0,255]，实际为 ${hex}。`)
  }
  return { r, g, b }
}

/** 海面基线色的字节 RGB（= parseHex(SEA_SURFACE_HEX)，冻结）。 */
export const SEA_SURFACE_RGB: Readonly<SeaSurfaceRgbColor> = Object.freeze(parseHex(SEA_SURFACE_HEX))

/**
 * 单层流动正弦波的参数（UV 空间）。
 *
 * 各字段语义：
 * - frequencyU / frequencyV：在 UV（[0,1]²）空间的波数——决定海面上可见的涟漪密度。UV 空间与分辨率
 *   无关，使涟漪尺度随 plane 大小自然伸缩（plane 覆盖整个主图海域）。
 * - speed：流速——uTime 的系数（两层都乘同一个 uTime，故 speed 只控制相对快慢，不引入第二时钟）。
 * - amplitude：亮度调制幅度——对基线色乘以 (1 + 扰动)；刻意 < 0.1 以「细微、不喧宾夺主」。
 * - phase：相位偏移——使两层不同步，叠加后呈非周期涟漪而非驻波。
 */
export interface SeaWaveLayerConfig {
  readonly frequencyU: number
  readonly frequencyV: number
  readonly speed: number
  readonly amplitude: number
  readonly phase: number
}

/**
 * 第一层流动波（低频长波，主导微波方向感）。
 *
 * 频率 / 流速 / 幅度均为内部调参（具体波形实现属于内部选择），仅受「幅度 < 0.1（细微）」
 * 「参数有限」「两层消费同一 uTime」三道不变量约束（测试断言）。
 */
export const SEA_WAVE_LAYER_1: Readonly<SeaWaveLayerConfig> = Object.freeze({
  frequencyU: 110,
  frequencyV: 70,
  speed: 0.28,
  amplitude: 0.035,
  phase: 0.0,
})

/**
 * 第二层流动波（高频短波，与第一层方向 / 相位不同，叠加丰富涟漪）。
 *
 * 与第一层共享同一 uTime（统一时钟）；V 方向取负使两层交叉流动，叠加后呈细微连续涟漪。
 */
export const SEA_WAVE_LAYER_2: Readonly<SeaWaveLayerConfig> = Object.freeze({
  frequencyU: 180,
  frequencyV: 120,
  speed: 0.2,
  amplitude: 0.02,
  phase: 1.3,
})

/**
 * 海面 plane 的米制覆盖范围（与地形 plane 同一份世界范围，模块加载时一次性派生并冻结）。
 *
 * 由 MAIN_MAP_WORLD_BOUNDS 派生（与 src/three/terrain-layout 的 TERRAIN_PLANE_LAYOUT 同一公式、
 * 同一字段命名）：
 * - worldWidthX：plane 在世界 x（东）方向的米制跨度 = maxX − minX。
 * - worldHeightZ：plane 在世界 z（南）方向的米制跨度 = maxZ − minZ。
 * - centerZ：mesh 在世界 z 方向的定位，使 plane 覆盖 [minZ, maxZ]；x 关于原点对称故 mesh x=0。
 *
 * 海面与地形必须共面同范围（SPEC §3.5「覆盖主图海域范围」且不改变水下地形网格）：测试断言
 * SEA_SURFACE_PLANE_LAYOUT 与 TERRAIN_PLANE_LAYOUT 逐字段相等——保证海面与地形逐米对齐，
 * 不存在第二套范围常量导致的海陆错位。
 */
export const SEA_SURFACE_PLANE_LAYOUT = Object.freeze({
  worldWidthX: MAIN_MAP_WORLD_BOUNDS.maxX - MAIN_MAP_WORLD_BOUNDS.minX,
  worldHeightZ: MAIN_MAP_WORLD_BOUNDS.maxZ - MAIN_MAP_WORLD_BOUNDS.minZ,
  centerZ: (MAIN_MAP_WORLD_BOUNDS.minZ + MAIN_MAP_WORLD_BOUNDS.maxZ) / 2,
})

/**
 * 海面 plane 每边分段数。
 *
 * 波动是片元着色器内的亮度调制（SPEC §3.5「fragment shader 用时间驱动的法线扰动」），不需要顶点
 * 位移，故 plane 只需 1 段（2 三角形）即可覆盖整个海域——顶点预算极低，与地形 2048² 分段无关。
 * 海面是独立渲染层，分段不与地形共享 / 不影响地形网格。
 */
export const SEA_SURFACE_SEGMENTS = 1

/**
 * 判断给定透明度是否落在 SPEC 半透明基线区间 [0.55, 0.7]（含端点）。
 *
 * 供自动化测试断言「透明度边界」，也供未来调试复算。基线透明度必须在该区间内：低于 0.55 海面过浓
 * 看不见大陆架、高于 0.7 海面过淡读不出「水」。
 */
export function seaOpacityIsInRange(opacity: number): boolean {
  return Number.isFinite(opacity) && opacity >= SEA_SURFACE_OPACITY_MIN && opacity <= SEA_SURFACE_OPACITY_MAX
}

/**
 * 海面渲染的全部参数（冻结）。
 *
 * 这是海面装配（SeaSurface）、海面着色器 uniform 与自动化测试共享的同一份事实源：海平面 y /
 * 透明度·上下限 / 基线色·字节 RGB / plane 覆盖范围 / 分段 / 双层波动参数全部在此，不存在第二套
 * 海面常量。冻结防止运行时被偷偷改（如把透明度调到 1.0 会变不透明遮住大陆架），任何调整都必须
 * 改本模块并同步测试。
 */
export const SEA_SURFACE_CONFIG = Object.freeze({
  /** 海平面世界 y（米）= 0（与地形同米制海平面）。 */
  levelYMeters: SEA_LEVEL_Y_METERS,
  /** 海面基线透明度（SPEC §3.5 区间内）。 */
  opacity: SEA_SURFACE_OPACITY,
  /** 透明度下限（含）= 0.55。 */
  opacityMin: SEA_SURFACE_OPACITY_MIN,
  /** 透明度上限（含）= 0.70。 */
  opacityMax: SEA_SURFACE_OPACITY_MAX,
  /** 海面基线色（深蓝青，十六进制）。 */
  colorHex: SEA_SURFACE_HEX,
  /** 海面基线色的字节 RGB（每通道 0–255）。 */
  colorRgb: SEA_SURFACE_RGB,
  /** 海面 plane 米制覆盖范围（= 地形 plane 范围）。 */
  planeLayout: SEA_SURFACE_PLANE_LAYOUT,
  /** 海面 plane 每边分段数（波动在片元，1 段即可）。 */
  segments: SEA_SURFACE_SEGMENTS,
  /** 双层流动波动参数。 */
  waves: Object.freeze({
    layer1: SEA_WAVE_LAYER_1,
    layer2: SEA_WAVE_LAYER_2,
  }),
})
