/**
 * 地形明暗照明配置——唯一事实源（TASK-006）。
 *
 * 角色与依赖方向：
 * - 本模块属于运行时配置层（src/config），是「地形片元着色器的方向光法线明暗」的**唯一**参数权威：
 *   主光方向 / 光色 / 光强与半球环境光天色 / 地色 / 强度。ChinaTerrainMesh 把本配置注入地形着色器
 *   uniform（地形是自定义 ShaderMaterial，不自动消费 three.js 场景灯），自动化测试在 Node 环境断言
 *   「主光来自西北偏高」「半球环境光低强度」等不变量——禁止在组件 / 着色器 / 测试里各自复制一份
 *   光向或颜色。
 * - 单向依赖：本模块只依赖 TypeScript 自身，不依赖 React / R3F / Three.js / DOM / 场景对象。
 *
 * 与 TASK-008（场景氛围）的边界：
 * - 本模块只回答「地形着色器内的法线明暗用什么光」，对应 SPEC §3.1「叠加方向光产生的法线明暗」
 *   与 §3.4 的光向决策。场景级装配（深蓝黑背景、场景 directionalLight / hemisphereLight、可选轻雾、
 *   相机限位）由 TASK-008 的 scene-atmosphere 承担；场景灯的光向 / 光色应以本配置为同一事实源
 *   （或反向被吸收为唯一来源），不得另写一套方位角 / 仰角常量形成第二光向源。
 *
 * 光向取舍（SPEC §3.4「方向光从西北偏高方位照射，强调青藏—东海的地势梯度」）：
 * - 主光方位角采用与相机相同的约定（从 +Z 南向 +X 东量起）：西北 = 225°（0=南、90=东、180=北、
 *   270=西，225 = 北与西的角平分线）。光源位于地图西北上方，光线朝东南下行，使青藏高原（西、高）
 *   的东南坡受光、东北坡背光，隆起感与西高东低的梯度同时被强调。
 * - 主光仰角 50°（水平面以上）：「偏高方位」——既保留足够侧向分量产生明暗对比（坡向可辨），
 *   又不至于过陡接近正俯（正俯会压平地势、丢失方向感）。
 * - 方向向量是「从地表指向光源」（surface-to-light），与 Lambert 漫反射 dot(N, L) 中 L 的约定一致。
 *
 * 阴影取舍（SPEC §3.4「地形本身不投递阴影贴图（4096² 级阴影图成本过高）」）：
 * - 地势方向感完全由「方向光 Lambert 明暗 + 半球环境光」体现，不依赖任何 shadow map——地形着色器
 *   不含阴影采样。未来若 hover / 省界高亮需要局部软阴影，应由后续 TASK 以受控、局部、低成本方式
 *   单独引入。
 *
 * 颜色空间约定：
 * - 颜色以 #rrggbb 十六进制存储（单一形态）；注入着色器 uniform 时经 hexToShaderFloat3 转成
 *   [0,1]³（字节值 / 255）。这与分层设色 ramp（sRGB 字节直接当线性用）同一约定——光照在「伪线性」
 *   空间与基线色相乘。完整 sRGB↔线性管理是独立议题，不在本 TASK 范围。
 */

/** 把角度（度）换算为弧度。 */
function degToRad(degrees: number): number {
  return (degrees * Math.PI) / 180
}

/** RGB 颜色（每通道 0–255，与浏览器 / three.js 字节色一致）。 */
export interface RgbColor {
  readonly r: number
  readonly g: number
  readonly b: number
}

/** 把 #rrggbb 形式的十六进制色串解析为 RgbColor（每通道 0–255）。 */
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
 * 与分层设色 ramp 的颜色空间约定一致（sRGB 字节直接当线性用），使光照与基线色在同一「伪线性」
 * 空间相乘。导出供 ChinaTerrainMesh 把主光色 / 半球环境色注入着色器 uniform，避免在组件 / 着色器内
 * 各自重写十六进制解析。
 */
export function hexToShaderFloat3(hex: string): readonly [number, number, number] {
  const { r, g, b } = parseHex(hex)
  return [r / 255, g / 255, b / 255]
}

/**
 * 由「光源方位角 + 仰角」派生 surface-to-light 单位方向向量（世界坐标）。
 *
 * 方位角从 +Z（南）向 +X（东）量起；仰角为水平面以上的角度。方向向量各分量：
 * - +X（东）= cos(仰角)·sin(方位角)；+Z（南）= cos(仰角)·cos(方位角)；+Y（上）= sin(仰角)。
 * 西北（方位角 225°）→ sin/cos(225°) 均为 −√2/2，故 +X、+Z 分量为负（西、北），+Y 为正（上）。
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

/** 主光方位角（度）：西北 225°（光源位于地图西北上方，与 SPEC §4.1 相机东南视角相对）。 */
export const TERRAIN_MAIN_LIGHT_AZIMUTH_DEGREES = 225
/** 主光仰角（度）：水平面以上 50°（「偏高方位」，保留侧向明暗又不压平地势）。 */
export const TERRAIN_MAIN_LIGHT_ELEVATION_DEGREES = 50

/**
 * 主光方向（surface-to-light，世界坐标，单位向量）。
 *
 * 由西北 225° + 仰角 50° 派生：(−X 西、+Y 上、−Z 北)。测试断言 x<0（西）、y>0（上）、z<0（北）
 * 以证明「西北偏高」。
 */
export const TERRAIN_MAIN_LIGHT_DIRECTION = Object.freeze(
  directionFromAzimuthElevation(TERRAIN_MAIN_LIGHT_AZIMUTH_DEGREES, TERRAIN_MAIN_LIGHT_ELEVATION_DEGREES),
)

/** 主光颜色（冷白，SPEC §3.4「暖白偏冷」，适配深色科技风）。 */
export const TERRAIN_MAIN_LIGHT_HEX = '#e8edf5'

/**
 * 主光强度。
 *
 * 主光是地势明暗的主要来源（与半球环境光相加），取 0.9 使坡向明暗明显但不过曝。
 * 具体强度由人工验收在 SPEC 基线附近微调。
 */
export const TERRAIN_MAIN_LIGHT_INTENSITY = 0.9

/** 半球环境光天空色（SPEC §3.4「低强度半球光（天 / 地双色）」的天色，冷调暗蓝）。 */
export const TERRAIN_HEMISPHERE_SKY_HEX = '#2a3a55'
/** 半球环境光地面色（暗暖，模拟地表反射的暖环境光）。 */
export const TERRAIN_HEMISPHERE_GROUND_HEX = '#1c1812'
/**
 * 半球环境光强度。
 *
 * 取 0.6（「低强度」）：与主光相加后背光面仍可辨认（不死黑）、受光面不过曝，
 * 又不冲淡分层设色。测试断言 < 1（低强度不变量）。
 */
export const TERRAIN_HEMISPHERE_INTENSITY = 0.6

/**
 * 地形明暗照明的全部参数（冻结）。
 *
 * 这是 ChinaTerrainMesh 注入地形着色器 uniform 与自动化测试共享的同一份事实源：主光方向·色·强度、
 * 半球环境光天色·地色·强度全部在此，不存在第二套地形照明常量。冻结防止运行时被偷偷修改；
 * 任何调整都必须改本模块并同步测试。
 */
export const TERRAIN_SHADING_CONFIG = Object.freeze({
  mainLight: Object.freeze({
    /** 光向（surface-to-light，世界坐标，单位向量；西北偏高 → x<0、y>0、z<0）。 */
    direction: TERRAIN_MAIN_LIGHT_DIRECTION,
    /** 光色（冷白，十六进制）。 */
    hex: TERRAIN_MAIN_LIGHT_HEX,
    rgb: Object.freeze(parseHex(TERRAIN_MAIN_LIGHT_HEX)),
    /** 光强（主明暗来源）。 */
    intensity: TERRAIN_MAIN_LIGHT_INTENSITY,
    /** 方位角（度，文档性：西北 225°）。 */
    azimuthDegrees: TERRAIN_MAIN_LIGHT_AZIMUTH_DEGREES,
    /** 仰角（度，文档性：偏高 50°）。 */
    elevationDegrees: TERRAIN_MAIN_LIGHT_ELEVATION_DEGREES,
  }),
  hemisphereAmbient: Object.freeze({
    /** 天空色（冷调暗蓝，十六进制）。 */
    skyHex: TERRAIN_HEMISPHERE_SKY_HEX,
    skyRgb: Object.freeze(parseHex(TERRAIN_HEMISPHERE_SKY_HEX)),
    /** 地面色（暗暖，十六进制）。 */
    groundHex: TERRAIN_HEMISPHERE_GROUND_HEX,
    groundRgb: Object.freeze(parseHex(TERRAIN_HEMISPHERE_GROUND_HEX)),
    /** 强度（低强度，< 1）。 */
    intensity: TERRAIN_HEMISPHERE_INTENSITY,
  }),
})
