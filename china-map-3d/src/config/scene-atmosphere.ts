/**
 * 深色地势照明与背景层次的视觉配置——唯一事实源（TASK-012）。
 *
 * 角色与依赖方向：
 * - 本模块属于运行时配置层（src/config），是「场景背景 / 主光方向与强度 / 半球环境光 / 可选轻雾 /
 *   阴影预算」的**唯一**权威。场景氛围装配（src/three/SceneAtmosphere）、地形片元着色器
 *   （src/three/terrain-shaders 经 ChinaTerrainMesh 注入 uniform）、自动化测试都只能通过本模块取得
 *   这些参数——禁止在组件 / 着色器 / 测试里各自复制一份光向或背景色（TASK-012 实现约束「视觉参数
 *   集中管理，场景装配不复制色阶或相机领域逻辑」）。
 * - 单向依赖：本模块只依赖坐标层 src/lib/projection（MAIN_MAP_WORLD_BOUNDS —— 主图世界米制包围盒的
 *   唯一源），用来把雾密度表达成「相对地图对角线的系数」，而非魔法绝对密度。本模块不依赖 React /
 *   R3F / Three.js / DOM，故自动化测试可在 Node 环境直接断言「主光来自西北偏高」「单主光」「环境光
 *   存在」「地形阴影关闭」「无外部纹理请求」等不变量（TASK-012 验证方式 1）。
 *
 * 光向取舍（SPEC §3.4「方向光从西北偏高方位照射，强调青藏—东海的地势梯度」）：
 * - 主光方位角沿用相机同一约定（src/three/camera-constraints：从 +Z 南向 +X 东量起）：西北 = 225°
 *   （0=南、90=东、180=北、270=西，225 = 北与西的角平分线）。光源位于地图西北上方，光线朝东南下行，
 *   使青藏高原（西、高）的东南坡受光、东北坡背光，隆起感与西高东低的梯度同时被强调。
 * - 主光仰角 50°（水平面以上）：「偏高方位」——既保留足够侧向分量产生明暗对比（坡向可辨），又不至于
 *   过陡接近正俯（正俯会压平地势、丢失方向感）。仰角 → 方向向量 +Y 分量 = sin(50°) ≈ 0.77。
 * - 方向向量是「从地表指向光源」（surface-to-light），与 Lambert 漫反射 dot(N, L) 中 L 的约定一致；
 *   它同时就是 three.js DirectionalLight 的 position 方向（光从该方向照向 target=原点）。故场景灯与
 *   着色器共用同一份方向，不存在第二套光向常量（实现约束「光照 / 背景层只能依赖场景视觉配置」）。
 *
 * 阴影预算取舍（SPEC §3.4「地形本身不投递阴影贴图（4096² 级阴影图成本过高）」、TASK-012 实现约束
 * 「地形不投递高分辨率阴影贴图；任何可选阴影能力必须保持局部、低成本且不成为本 TASK 完成条件」）：
 * - 本 TASK 显式关闭主光投影（MAIN_LIGHT_CAST_SHADOW=false）与渲染器阴影图（SHADOWS_ENABLED=false）。
 *   地势方向感完全由「方向光 Lambert 明暗 + 半球环境光」体现，不依赖任何 shadow map——这是结构性
 *   决定，不是默认值凑巧为 false：测试断言这两个字段为 false，任何「偷偷开启地形阴影」的改动都会被
 *   捕获。未来若 hover / 省界高亮需要局部软阴影，应由后续 TASK 以受控、局部、低成本的方式单独引入，
 *   不得通过把本配置改成全局阴影图来实现（会回归到 4096² 阴影的成本陷阱）。
 *
 * 雾的取舍（SPEC §3.4「可选极轻微指数雾，柔化地图远缘与背景的衔接（勿过浓，免吞细节）」、
 * TASK-012 实现约束「若启用雾则南海和远缘地形仍可读」）：
 * - 启用极轻微 FogExp2：密度表达为 FOG_DENSITY_FACTOR / 地图对角线（系数 0.2），使雾的作用尺度随地图
 *   范围自动伸缩，而非写死一个绝对密度。在该密度下，地图中心（距相机约一个默认距离）雾因子约 4%、
 *   远角约 9%——远缘被柔化而南海诸岛 / 边界 / 标签完全可读（不会被吞）。
 * - 雾色 = 背景色：地图远缘的地形片元淡入背景，形成「自然衔接」而非一条硬边；雾色与背景色必须一致，
 *   否则远缘会淡入一个与背景不同的色块，产生接缝（TASK-012 验证方式 4「背景衔接自然」）。测试断言
 *   二者同色。若人工验收发现雾过浓，调小 FOG_DENSITY_FACTOR 即可（单一参数，作用边界清楚）。
 *
 * 颜色空间约定（与既有地形着色器一致，TASK-012 不引入颜色管理重构）：
 * - 本模块的颜色以 #rrggbb 十六进制存储（单一形态）。提供给 R3F 灯光时直接用十六进制串；提供给地形
 *   着色器 uniform 时用 hexToShaderFloat3 转成 [0,1]³（字节值 / 255）。这与既有分层设色 ramp（sRGB
 *   字节直接当线性用）同一约定——光照在「伪线性」空间与基线色相乘，结果与 TASK-010 已验收的视觉
 *   连续。完整 sRGB↔线性管理是独立议题，不在本 TASK 范围（避免回归 TASK-010 已验收色阶）。
 */

import { MAIN_MAP_WORLD_BOUNDS } from '../lib/projection'

/**
 * 主图世界包围盒的对角线（米，模块加载时一次性计算）。
 *
 * 雾密度的唯一尺度输入：把密度表达成「系数 / 对角线」而非魔法绝对值，使雾的作用尺度随地图范围
 * 自动伸缩（与 src/three/camera-constraints 把距离约束表达成「半对角线 · 系数」同一哲学）。
 */
const MAP_DIAGONAL_METERS = Math.hypot(
  MAIN_MAP_WORLD_BOUNDS.maxX - MAIN_MAP_WORLD_BOUNDS.minX,
  MAIN_MAP_WORLD_BOUNDS.maxZ - MAIN_MAP_WORLD_BOUNDS.minZ,
)

/** 把角度（度）换算为弧度（内联等价于 Math.PI/180，避免为本模块引入更多依赖）。 */
function degToRad(degrees: number): number {
  return (degrees * Math.PI) / 180
}

/** RGB 颜色（每通道 0–255，与浏览器 / three.js 字节色一致）。 */
export interface RgbColor {
  readonly r: number
  readonly g: number
  readonly b: number
}

/** 把 #rrggbb 形式的十六进制色串解析为 RgbColor（每通道 0–255）。仅供本模块内部构建常量。 */
function parseHex(hex: string): RgbColor {
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

/**
 * 把十六进制色串转成着色器可直接用的 [0,1]³ 浮点向量（字节值 / 255）。
 *
 * 与既有分层设色 ramp 的颜色空间约定一致（sRGB 字节直接当线性用），使光照与基线色在同一「伪线性」
 * 空间相乘。导出供 ChinaTerrainMesh 把 MAIN_LIGHT_COLOR / 环境色注入着色器 uniform，避免在组件 /
 * 着色器内各自重写十六进制解析。
 */
export function hexToShaderFloat3(hex: string): readonly [number, number, number] {
  const { r, g, b } = parseHex(hex)
  return [r / 255, g / 255, b / 255]
}

/**
 * 由「光源方位角 + 仰角」派生 surface-to-light 单位方向向量（世界坐标）。
 *
 * 沿用相机约定（src/three/camera-constraints）：方位角从 +Z（南）向 +X（东）量起；仰角为水平面以上的
 * 角度。方向向量各分量：
 * - +X（东）= cos(仰角)·sin(方位角)；+Z（南）= cos(仰角)·cos(方位角)；+Y（上）= sin(仰角)。
 * 西北（方位角 225°）→ sin/cos(225°) 均为 −√2/2，故 +X、+Z 分量为负（西、北），+Y 为正（上）。
 *
 * 该向量同时是 three.js DirectionalLight 的 position 方向（光从该方向照向 target）与 Lambert 中
 * dot(N, L) 的 L——场景灯与着色器共用同一推导，单一光向源。
 */
function directionFromAzimuthElevation(azimuthDegrees: number, elevationDegrees: number): {
  readonly x: number
  readonly y: number
  readonly z: number
} {
  const azim = degToRad(azimuthDegrees)
  const elev = degToRad(elevationDegrees)
  const horiz = Math.cos(elev)
  const x = horiz * Math.sin(azim)
  const z = horiz * Math.cos(azim)
  const y = Math.sin(elev)
  // 归一化（azim/elev 分解在浮点上可能轻微偏离单位长，统一归一使 dot 量纲精确）。
  const len = Math.hypot(x, y, z)
  return { x: x / len, y: y / len, z: z / len }
}

/**
 * 场景背景色（深蓝黑纯色，SPEC §3.4 基线 `#070b16`）。
 *
 * 纯色（非天空盒、非卫星影像）——SPEC §3.4「不引入天空盒贴图」、TASK-012 实现约束「不引入天空盒 /
 * 卫星影像 / 人工阴影贴图」。深蓝黑与地表色阶的近黑端（深海 `#06121c`）足够接近又不重合，配合方向光
 * 明暗与轻雾，受光地形明显浮于背景之上，背光面仍可辨认（不致死黑）。具体明度可在 SPEC 基线附近由
 * 人工验收微调，但必须保持深蓝黑色相（测试断言三通道均低、蓝通道相对占优）。
 */
export const SCENE_BACKGROUND_HEX = '#070b16'

/** 主光方位角（度）：西北 225°（光源位于地图西北上方，与相机东南视角相对）。 */
export const MAIN_LIGHT_AZIMUTH_DEGREES = 225
/** 主光仰角（度）：水平面以上 50°（「偏高方位」，保留侧向明暗又不压平地势）。 */
export const MAIN_LIGHT_ELEVATION_DEGREES = 50

/**
 * 主光方向（surface-to-light，世界坐标，单位向量）。
 *
 * 由西北 225° + 仰角 50° 派生：(+X 西、+Y 上、+Z 北) 即 (−,+,−)。测试断言 x<0（西）、y>0（上）、
 * z<0（北）以证明「西北偏高」；着色器与 DirectionalLight 共用此向量（单一光向源）。
 */
export const MAIN_LIGHT_DIRECTION = Object.freeze(
  directionFromAzimuthElevation(MAIN_LIGHT_AZIMUTH_DEGREES, MAIN_LIGHT_ELEVATION_DEGREES),
)

/**
 * 主光颜色（冷白，SPEC §3.4「暖白偏冷」，适配深色科技风）。
 *
 * 以十六进制存储（单一形态）：R3F 灯光直接用串；着色器 uniform 经 hexToShaderFloat3 转 [0,1]³。
 */
export const MAIN_LIGHT_HEX = '#e8edf5'

/**
 * 主光强度。
 *
 * 主光是地势明暗的主要来源（与半球环境光相加），取 0.9 使坡向明暗明显但不过曝。与既有片元着色器
 * 「0.35 + 0.65·diffuse」的明暗幅度同量级（环境 ~0.35 + 漫反射峰值 ~0.65 ≈ 1.0）。具体强度由人工
 * 验收在 SPEC 基线附近微调。
 */
export const MAIN_LIGHT_INTENSITY = 0.9

/**
 * 主光是否投递阴影贴图。
 *
 * 显式 false（SPEC §3.4「地形本身不投递阴影贴图」、TASK-012 实现约束「地形不投递高分辨率阴影贴图」）。
 * 这是结构性决定：地势方向感由方向光 Lambert + 半球环境光体现，不依赖 shadow map。测试断言为 false，
 * 任何偷偷开启地形阴影的改动都会被捕获。hover / 省界局部软阴影应由后续 TASK 以局部、低成本方式单独
 * 引入，不得通过改本字段为 true 来实现（会落入 4096² 阴影图成本陷阱）。
 */
export const MAIN_LIGHT_CAST_SHADOW = false

/**
 * 半球环境光天空色（SPEC §3.4「低强度半球光（天 / 地双色）」的天色，冷调暗蓝）。
 *
 * 半球光按法线 +Y 分量在天 / 地色间插值：朝上表面偏天色、朝下表面偏地色，使背光面保留冷蓝环境补光
 * 而不死黑。颜色与强度都保持低调（「低强度」），不冲淡分层设色（TASK-012 实现约束「不以过强环境光
 * 冲淡高程色阶」）。
 */
export const HEMISPHERE_SKY_HEX = '#2a3a55'
/** 半球环境光地面色（暗暖，模拟地表反射的暖环境光）。 */
export const HEMISPHERE_GROUND_HEX = '#1c1812'
/**
 * 半球环境光强度。
 *
 * 取 0.6（「低强度」）：与主光相加后背光面仍可辨认、受光面不过曝。测试断言 < 1（低强度不变量）。
 */
export const HEMISPHERE_INTENSITY = 0.6

/**
 * 是否启用极轻微指数雾（SPEC §3.4「可选极轻微指数雾」）。
 *
 * 启用：地图远缘地形片元淡入背景，柔化硬边（TASK-012 可验证结果「地图远缘与背景自然衔接」）。雾极
 * 轻（见 FOG_DENSITY_FACTOR），南海诸岛 / 边界 / 标签完全可读（TASK-012 实现约束「若启用雾则南海和
 * 远缘地形仍可读」）。若人工验收发现不需要雾，置 false 即可——此时远缘衔接由背景色 + 构图承担
 * （实现约束「若不启用，地图远缘仍须通过背景和构图自然衔接」，二者已在背景色上对齐）。
 */
export const FOG_ENABLED = true

/**
 * 雾色（= 背景色）。
 *
 * 雾色必须与背景色一致：远缘片元淡入雾色 = 淡入背景色，形成无接缝的自然过渡；若雾色与背景色不同，
 * 远缘会淡入一个与背景不同的色块，产生可见接缝（TASK-012 验证方式 4）。测试断言 FOG_HEX ===
 * SCENE_BACKGROUND_HEX。本常量单独导出（而非让消费者直接复用 SCENE_BACKGROUND_HEX）是为了语义自显：
 * 「雾色」与「背景色」是两个视觉角色，恰好在当前决策下取同值，未来若分离仍各有一个命名锚点。
 */
export const FOG_HEX = SCENE_BACKGROUND_HEX

/**
 * 雾密度系数（无量纲）：雾密度 = 本系数 / 地图对角线（米）。
 *
 * 取 0.2：在该系数下，地图中心（距相机约一个默认距离 ≈ 对角线量级）雾因子约 4%、远角约 9%——远缘被
 * 柔化而南海 / 边界 / 标签完全可读（测试断言「远角雾因子落在轻微区间」证明不吞没要素）。系数无量纲、
 * 随地图对角线自动伸缩，避免写死绝对密度（与相机约束「半对角线 · 系数」同一哲学）。人工验收若觉过浓，
 * 调小本系数即可（单一参数，作用边界清楚）。
 */
export const FOG_DENSITY_FACTOR = 0.2

/**
 * 雾密度（单位 1/米，FogExp2 的 density 参数）。
 *
 * 由 FOG_DENSITY_FACTOR / MAP_DIAGONAL_METERS 派生，随地图范围伸缩。SceneAtmosphere 把它喂给
 * `<fogExp2>` 的 density；ChinaTerrainMesh 把它注入地形片元 uniform uFogDensity（地形是自定义
 * ShaderMaterial，不自动应用 scene.fog，需手动在片元内复算同一 FogExp2 公式——见 terrain-shaders.ts）。
 */
export const FOG_DENSITY = FOG_DENSITY_FACTOR / MAP_DIAGONAL_METERS

/**
 * 渲染器是否启用阴影图（Canvas shadows）。
 *
 * 显式 false：本 TASK 不启用任何 shadow map（SPEC §3.4、TASK-012 实现约束）。ChinaMapScreen 的 `<Canvas>`
 * 据此设 shadows={false}（也是 R3F 默认，但显式声明使「阴影关闭」成为可读、可测的不变量，而非默认值
 * 凑巧为 false）。测试断言为 false。
 */
export const SCENE_SHADOWS_ENABLED = false

/**
 * 场景氛围的全部视觉参数（冻结）。
 *
 * 这是场景氛围装配（SceneAtmosphere）、地形着色器 uniform（ChinaTerrainMesh）与自动化测试共享的同一份
 * 事实源：背景色 / 主光方向·色·强度·投影 / 半球环境光·色·强度 / 雾开关·色·密度 / 阴影总开关全部在此，
 * 不存在第二套氛围常量。冻结防止运行时被偷偷放宽（如把 MAIN_LIGHT_CAST_SHADOW 改成 true 会引入地形
 * 阴影图成本），任何调整都必须改本模块并同步测试。
 */
export const SCENE_ATMOSPHERE_CONFIG = Object.freeze({
  /** 背景色（深蓝黑纯色，十六进制）。 */
  backgroundHex: SCENE_BACKGROUND_HEX,
  backgroundRgb: Object.freeze(parseHex(SCENE_BACKGROUND_HEX)),
  mainLight: Object.freeze({
    /** 光向（surface-to-light，世界坐标，单位向量；西北偏高 → x<0、y>0、z<0）。 */
    direction: MAIN_LIGHT_DIRECTION,
    /** 光色（冷白，十六进制）。 */
    hex: MAIN_LIGHT_HEX,
    rgb: Object.freeze(parseHex(MAIN_LIGHT_HEX)),
    /** 光强（主明暗来源）。 */
    intensity: MAIN_LIGHT_INTENSITY,
    /** 是否投递阴影贴图（结构性 false）。 */
    castShadow: MAIN_LIGHT_CAST_SHADOW,
    /** 方位角（度，文档性：西北 225°）。 */
    azimuthDegrees: MAIN_LIGHT_AZIMUTH_DEGREES,
    /** 仰角（度，文档性：偏高 50°）。 */
    elevationDegrees: MAIN_LIGHT_ELEVATION_DEGREES,
  }),
  hemisphereAmbient: Object.freeze({
    /** 天空色（冷调暗蓝，十六进制）。 */
    skyHex: HEMISPHERE_SKY_HEX,
    skyRgb: Object.freeze(parseHex(HEMISPHERE_SKY_HEX)),
    /** 地面色（暗暖，十六进制）。 */
    groundHex: HEMISPHERE_GROUND_HEX,
    groundRgb: Object.freeze(parseHex(HEMISPHERE_GROUND_HEX)),
    /** 强度（低强度，< 1）。 */
    intensity: HEMISPHERE_INTENSITY,
  }),
  fog: Object.freeze({
    /** 是否启用极轻微指数雾。 */
    enabled: FOG_ENABLED,
    /** 雾色（= 背景色，十六进制）。 */
    hex: FOG_HEX,
    rgb: Object.freeze(parseHex(FOG_HEX)),
    /** 雾密度（1/米，= FOG_DENSITY_FACTOR / 地图对角线）。 */
    density: FOG_DENSITY,
    /** 密度系数（无量纲，文档性：0.2）。 */
    densityFactor: FOG_DENSITY_FACTOR,
  }),
  /** 渲染器阴影图总开关（结构性 false）。 */
  shadowsEnabled: SCENE_SHADOWS_ENABLED,
})

/**
 * 主光盏数（文档性不变量：单主光）。
 *
 * SPEC §3.4「单盏主光」、TASK-012 验证方式 1「单主光」。本配置以单一 mainLight 对象（而非数组）表达
 * 「单主光」——结构性保证不存在第二盏主光。本常量把这一结构事实显式化为可断言数值，测试据此证明
 * 「主光盏数 = 1」（任何引入第二盏主光的改动都会被迫改本常量或破坏结构，从而被捕获）。
 */
export const MAIN_LIGHT_COUNT = 1

/**
 * 由地图对角线与默认相机距离估算的「远缘典型距离」（米），用于在测试中评估雾因子是否过浓。
 *
 * 取 MAP_DIAGONAL_METERS · 1.5：东南斜俯视默认机位距地图中心约一个默认距离（≈ 2.1 · 半对角线 ≈ 对角线
 * 量级），地图西北远角再往外约一个半对角线，故远缘典型距离 ≈ 对角线 · 1.5 量级。这是「雾是否吞没远缘」
 * 的评估尺度，不是运行时消费的渲染参数。
 */
export const FOG_FAR_EDGE_REFERENCE_METERS = MAP_DIAGONAL_METERS * 1.5

/**
 * 计算给定距离下的 FogExp2 雾因子（0=无雾、1=全雾），与 three.js FogExp2 片元公式同一表达式。
 *
 * three.js FogExp2：fogFactor = 1 − exp(−density²·depth²)。本函数是该公式的 TypeScript 镜像，供测试
 * 在 Node 内断言「远缘雾因子落在轻微区间（不吞没要素）」，无需启动 WebGL。也供未来调试复算。
 */
export function computeFogFactor(depthMeters: number, density: number): number {
  return 1 - Math.exp(-density * density * depthMeters * depthMeters)
}
