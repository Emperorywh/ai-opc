import { ACESFilmicToneMapping, SRGBColorSpace } from 'three'
import type { ToneMapping } from 'three'
import type { RawNodeType } from '../domain/rawDto'

/**
 * 视觉主题集中配置（SPEC §8.2、§8.5、§12）。
 *
 * 颜色、Emissive、材质、灯光与 Bloom 参数必须集中定义，禁止组件内散落色值或阈值
 * （SPEC §8.2 末条、§8.5、§12 visualTheme 承载颜色/材质/灯光/Bloom）。本文件承载 HSL 元组、
 * 标量与色彩管线常量；色彩管线部分引用 Three.js 的渲染状态常量（SRGBColorSpace、
 * ACESFilmicToneMapping），它们是纯标量值（字符串/数字），不触达 WebGL 上下文或任何浏览器
 * 对象，因此整体仍可在 Node 环境直接验证色值、Bloom 参数与色彩管线目标与 SPEC 一致；展示层
 * 负责把 HSL 元组转换为 THREE.Color（见 NodeLayer）、把色彩管线常量写入 renderer（见 MapSceneView）。
 *
 * Emissive 目标（SPEC §8.2）：node 低于 Bloom 阈值、work 接近阈值、charge/park 高于阈值。
 * emissiveIntensity 按"低于/接近/高于 Bloom 阈值"的目标排序（node < work < park ≈ charge）；
 * Bloom 亮度阈值（1.0，见 BLOOM_THEME）确定后，发光层次由本表与路径流光强度共同表达。
 */

/** HSL 颜色：H 为 0～360 度，S/L 为 0～1。 */
export interface HslColor {
  readonly h: number
  readonly s: number
  readonly l: number
}

/** 节点颜色主题：基础色与自发光强度。 */
export interface NodeColorTheme {
  /** 基础色（SPEC §8.2 基础色列）。 */
  readonly baseColor: HslColor
  /**
   * 自发光强度初值（SPEC §8.2 Emissive 目标）。
   * 表示该类节点相对 Bloom 阈值的发光倾向，非最终像素亮度。
   */
  readonly emissiveIntensity: number
}

/** 节点标准材质参数（SPEC §8.3：节点固定使用 MeshStandardMaterial）。 */
export interface NodeMaterialTheme {
  readonly metalness: number
  readonly roughness: number
}

/** 单类节点的完整视觉主题。 */
export interface NodeVisualTheme {
  readonly color: NodeColorTheme
  readonly material: NodeMaterialTheme
}

/** 按节点类型索引的视觉主题表。 */
export type NodeVisualThemeTable = Record<RawNodeType, NodeVisualTheme>

/**
 * 节点视觉主题初值（SPEC §8.2）。
 *
 * 基础色逐字对齐 SPEC §8.2 调色板；emissiveIntensity 按"低于/接近/高于 Bloom 阈值"的
 * 目标排序给出可见度初值，使无后处理时四类节点仍具备可辨识的亮度层次。
 */
export const NODE_VISUAL_THEME: NodeVisualThemeTable = {
  node: {
    color: { baseColor: { h: 210, s: 0.9, l: 0.6 }, emissiveIntensity: 0.0 },
    material: { metalness: 0.1, roughness: 0.6 },
  },
  work: {
    color: { baseColor: { h: 180, s: 0.9, l: 0.55 }, emissiveIntensity: 0.25 },
    material: { metalness: 0.2, roughness: 0.45 },
  },
  charge: {
    color: { baseColor: { h: 48, s: 1.0, l: 0.6 }, emissiveIntensity: 0.6 },
    material: { metalness: 0.25, roughness: 0.4 },
  },
  park: {
    color: { baseColor: { h: 140, s: 0.8, l: 0.55 }, emissiveIntensity: 0.45 },
    material: { metalness: 0.2, roughness: 0.45 },
  },
}

/** SPEC §8.2 节点基础色调色板，供测试与展示层共享断言基准。 */
export const NODE_BASE_COLORS: Readonly<Record<RawNodeType, HslColor>> = {
  node: { h: 210, s: 0.9, l: 0.6 },
  work: { h: 180, s: 0.9, l: 0.55 },
  charge: { h: 48, s: 1.0, l: 0.6 },
  park: { h: 140, s: 0.8, l: 0.55 },
}

/**
 * 路径扁带色彩主题（SPEC §8.2 路径扁带 / 流动高亮）。
 *
 * 不变量：
 * - 基础色低于 Bloom 阈值（§8.2、§8.5）：扁带作为底层拓扑呈现，不进入 Bloom。
 * - 流动高亮明确高于 Bloom 阈值：在着色器中按高亮强度叠加，使峰值线性亮度 > 1.0，
 *   TASK-013 接入 Bloom 后形成稳定发光脉冲；当前无后处理时仍以亮青色脉冲可见。
 * - 色值集中定义，展示层禁止散落色值（§8.2 末条）。
 */
export interface PathColorTheme {
  /** 扁带基础色（SPEC §8.2：hsl(200, 85%, 55%)）。 */
  readonly baseColor: HslColor
  /** 流动高亮色（SPEC §8.2：hsl(185, 100%, 75%)）。 */
  readonly flowHighlightColor: HslColor
  /**
   * 流动高亮叠加强度。在线性空间与脉冲峰值相乘，使峰值亮度明确高于 Bloom 阈值 1.0
   * （§8.2、§8.5）；无后处理时仍保证脉冲在扁带基础色之上清晰可辨。
   */
  readonly flowHighlightIntensity: number
}

/**
 * 流光动画参数（SPEC §7.6 初始流光参数）。
 *
 * 不变量：
 * - 单位显式标注（_M / _MPS / _SECONDS），不通过散落数字隐式表达业务规则（§12）。
 * - 三参数满足 repeat = speed × period 的运动学关系（2.0 = 0.4 × 5.0），
 *   即一个周期内脉冲恰好推进一个重复距离，动画首尾相接无跳变。
 * - 为展示层纯动画配置，非几何编译参数（§12：颜色/材质/Bloom 归 visualTheme）。
 */
export interface PathFlowConfig {
  /** 流光沿弧长的重复距离，单位米（SPEC §7.6：2.0 m）。 */
  readonly flowRepeatM: number
  /** 流光推进速度，单位米/秒（SPEC §7.6：0.4 m/s）。 */
  readonly flowSpeedMps: number
  /** 流光相位有界周期，单位秒（SPEC §7.6：5 s）。 */
  readonly flowPeriodSeconds: number
}

/**
 * 路径视觉主题初值（SPEC §8.2、§7.6）。
 *
 * 基础色与高亮色逐字对齐 SPEC §8.2；流光参数对齐 §7.6；高亮强度初值使脉冲峰值
 * 明确超过 Bloom 阈值，TASK-013 按 Bloom 亮度阈值最终精调时只改本表数值。
 */
export const PATH_VISUAL_THEME: Readonly<{
  readonly color: PathColorTheme
  readonly flow: PathFlowConfig
}> = {
  color: {
    baseColor: { h: 200, s: 0.85, l: 0.55 },
    flowHighlightColor: { h: 185, s: 1.0, l: 0.75 },
    flowHighlightIntensity: 1.5,
  },
  flow: {
    flowRepeatM: 2.0,
    flowSpeedMps: 0.4,
    flowPeriodSeconds: 5.0,
  },
}

/** SPEC §8.2 路径扁带基础色，供测试与展示层共享断言基准。 */
export const PATH_BASE_COLOR: HslColor = { h: 200, s: 0.85, l: 0.55 }

/** SPEC §8.2 流动高亮色，供测试与展示层共享断言基准。 */
export const PATH_FLOW_HIGHLIGHT_COLOR: HslColor = { h: 185, s: 1.0, l: 0.75 }

/**
 * 深色沙盘环境视觉主题（SPEC §8.2 背景、§8.3 材质与灯光、§8.4 地面/网格/雾，TASK-012）。
 *
 * 颜色、材质与灯光等"看起来如何"的视觉参数集中于此（SPEC §8.2 末条禁止组件内散落色值、
 * §8.3 所有材质参数由主题配置统一提供、§12 visualTheme 承载颜色/材质/灯光/Bloom）。
 * 环境的空间布局参数（边距、距离因子、单元尺寸）不属视觉，集中于 environmentConfig。
 *
 * 不变量：
 * - 背景与雾色取 SPEC §8.2 背景 #05080F；雾色与背景一致使远端拓扑无缝融入、不出现色带。
 * - 地面为本期深色不透明基线（SPEC §8.4 反射地面属后续任务，TASK-012 不混入平面反射）；
 *   粗糙度高、金属度低，配合本地 PMREM 呈现深色哑光沙盘底。
 * - 网格使用细/粗双色与低基础透明度，避免遮蔽路径与节点；径向衰减距离取自 environmentConfig。
 * - 方向光高色温低强度塑形、环境光低强度补底（SPEC §8.3 一个带阴影方向光 + 低强度环境光）。
 */

/** 场景背景色（SPEC §8.2：#05080F）。CSS hex 字符串，供 R3F <color attach="background"> 直接消费。 */
export const ENVIRONMENT_BACKGROUND_HEX = '#05080F'

/** 线性雾色（SPEC §8.4，与背景一致以无缝融入远端）。 */
export const ENVIRONMENT_FOG_HEX = '#05080F'

/** 环境方向光视觉参数（SPEC §8.3 一个带阴影方向光）。颜色为 sRGB HSL，由展示层线性化。 */
export interface DirectionalLightTheme {
  /** 光色（SPEC §8.3 集中定义；取冷白偏蓝与深色科技底协调）。 */
  readonly color: HslColor
  /** 光强（SPEC §8.3 由主题统一提供；配合 ACES 色调映射塑形节点体积感）。 */
  readonly intensity: number
}

/** 环境光视觉参数（SPEC §8.3 低强度环境光补底）。 */
export interface AmbientLightTheme {
  /** 环境光色（取冷蓝底色，与深色沙盘一致）。 */
  readonly color: HslColor
  /** 环境光强（SPEC §8.3 低强度补光，不喧宾夺主）。 */
  readonly intensity: number
}

/** 地面材质视觉参数（SPEC §8.3、§8.4 深色不透明反射地面基线）。 */
export interface GroundMaterialTheme {
  /** 基础色（深色沙盘底，略高于纯背景以接收阴影可辨）。 */
  readonly color: HslColor
  /** 粗糙度（高粗糙度呈哑光，配合 PMREM 柔和反射环境光）。 */
  readonly roughness: number
  /** 金属度（低金属度，避免镜面高光喧宾夺主）。 */
  readonly metalness: number
}

/**
 * 平面反射视觉参数（SPEC §8.4 真实平面反射 + 一次粗糙模糊，TASK-013）。
 *
 * 不变量：
 * - 反射呈现真实倒影：mirror 控制反射纹理覆盖地面基础色的比例（0=无反射、1=纯反射），
 *   配合 mixStrength 决定反射亮度，使节点与路径在地面形成可辨识倒影（§16.2、TASK-013）。
 * - 一次粗糙模糊：mixBlur 与地面 roughness 共同决定模糊反射与清晰反射的混合比例；
 *   blurWidth/blurHeight 控制 BlurPass 的模糊扩散（ConvolutionMaterial 分辨率单位），
 *   实现深色哑光地面的粗糙而非镜面倒影（SPEC §8.4 "一次粗糙模糊"）。
 * - 反射 RenderTarget 分辨率属性能预算，集中于 performanceConfig（§12），不在此处重复。
 * - 视觉参数集中定义，展示层禁止散落数值（§8.2 末条）。
 */
export interface ReflectionTheme {
  /** 反射覆盖率 0~1：反射纹理覆盖地面基础色的比例（diffuseColor *= (1−mirror) + 反射×mixStrength）。 */
  readonly mirror: number
  /** 反射亮度倍率（与 mirror 共同决定反射强度，呈现真实而非发糊的倒影）。 */
  readonly mixStrength: number
  /** 模糊反射与清晰反射的混合比例 0~1（与地面 roughness 相乘后钳到 [0,1]）。 */
  readonly mixBlur: number
  /** 一次粗糙模糊的水平扩散（BlurPass ConvolutionMaterial 分辨率单位，越大越模糊）。 */
  readonly blurWidth: number
  /** 一次粗糙模糊的垂直扩散（与 blurWidth 共同决定各向异性模糊形态）。 */
  readonly blurHeight: number
}

/** 网格视觉参数（SPEC §8.4 独立网格图层）。径向衰减距离取自 environmentConfig。 */
export interface GridTheme {
  /** 细网格线色（较低明度，作为底层参考格）。 */
  readonly sectionColor: HslColor
  /** 粗网格线色（略亮，强调大尺度划分）。 */
  readonly centerColor: HslColor
  /** 基础透明度（叠加在径向衰减之上，低值避免遮蔽拓扑，§16.2 不遮蔽拓扑）。 */
  readonly baseOpacity: number
}

/** 程序化 PMREM 渐变球面色（SPEC §8.3 本地程序化环境）。底色与顶色在球面垂直方向线性插值。 */
export interface PmremGradientTheme {
  /** 渐变底部色（球面下方，对应地面反射方向，取近背景深色）。 */
  readonly bottom: HslColor
  /** 渐变顶部色（球面上方，对应天空反射方向，略亮冷蓝提供柔和顶光）。 */
  readonly top: HslColor
}

/** 环境视觉主题初值（SPEC §8.2、§8.3、§8.4、§8.4 反射，TASK-012/013）。 */
export const ENVIRONMENT_THEME: Readonly<{
  readonly backgroundHex: string
  readonly fogHex: string
  readonly directionalLight: DirectionalLightTheme
  readonly ambientLight: AmbientLightTheme
  readonly ground: GroundMaterialTheme
  readonly reflection: ReflectionTheme
  readonly grid: GridTheme
  readonly pmremGradient: PmremGradientTheme
}> = {
  backgroundHex: ENVIRONMENT_BACKGROUND_HEX,
  fogHex: ENVIRONMENT_FOG_HEX,
  directionalLight: {
    color: { h: 210, s: 0.3, l: 0.85 },
    intensity: 2.4,
  },
  ambientLight: {
    color: { h: 220, s: 0.4, l: 0.35 },
    intensity: 0.35,
  },
  ground: {
    color: { h: 225, s: 0.4, l: 0.05 },
    roughness: 0.85,
    metalness: 0.1,
  },
  // SPEC §8.4 真实平面反射 + 一次粗糙模糊：深色哑光地面呈现节点/路径的粗糙倒影。
  // mirror 0.5 使深色基础色与反射各半，倒影可辨且地面不沦为纯镜面；mixStrength 1.0
  // 保留反射真实亮度；mixBlur 与地面 roughness(0.85) 联合给出约 0.5 的模糊混合；
  // blurWidth/blurHeight 各向异性扩散形成"粗糙"而非清晰镜面倒影（§8.4、TASK-013）。
  reflection: {
    mirror: 0.5,
    mixStrength: 1.0,
    mixBlur: 0.6,
    blurWidth: 400,
    blurHeight: 100,
  },
  grid: {
    sectionColor: { h: 210, s: 0.5, l: 0.3 },
    centerColor: { h: 200, s: 0.6, l: 0.45 },
    baseOpacity: 0.22,
  },
  pmremGradient: {
    bottom: { h: 225, s: 0.5, l: 0.03 },
    top: { h: 210, s: 0.6, l: 0.18 },
  },
}

/**
 * 唯一色彩管线配置（SPEC §8.5，TASK-014）。
 *
 * 整个场景的色彩在唯一一处定义并写入 renderer：输出色彩空间 sRGB、色调映射 ACESFilmic、
 * 曝光 1.0。该配置由展示层在 Canvas 创建时写入 gl（见 MapSceneView），是 SPEC §8.5 的唯一
 * 色彩契约；着色器与后处理之间不重复执行 tone mapping 或色彩空间转换（见 BLOOM_THEME
 * 与 PostEffects 说明）。
 *
 * 不变量：
 * - 单一职责：全场景只有这一处定义输出色彩空间与色调映射；组件、着色器与后处理不得散落第二套
 *   色彩转换或阈值（SPEC §8.2 末条、§8.5、TASK-014 实现约束）。
 * - Three.js 常量引用：outputColorSpace / toneMapping 取自 three.js 的渲染状态常量（纯标量值，
 *   非浏览器对象），保证展示层写入的值与测试断言的值同源（SPEC §8.5）。
 * - 与后处理的协作：EffectComposer（@react-three/postprocessing）在渲染期临时把 renderer.toneMapping
 *   置为 NoToneMapping，使材质输出线性 HDR 供 Bloom 亮度阈值（1.0）触发；这不是"第二套"色调映射，
 *   而是后处理库的 HDR 机制。Composer 卸载时恢复本配置的 ACES（TASK-014 正常路径）。
 */
export interface ColorPipelineTheme {
  /** 输出色彩空间（SPEC §8.5：SRGBColorSpace）。 */
  readonly outputColorSpace: string
  /** 色调映射算法（SPEC §8.5：ACESFilmicToneMapping）。 */
  readonly toneMapping: ToneMapping
  /** 色调映射曝光（SPEC §8.5：1.0）。 */
  readonly toneMappingExposure: number
}

export const COLOR_PIPELINE: ColorPipelineTheme = {
  outputColorSpace: SRGBColorSpace,
  toneMapping: ACESFilmicToneMapping,
  toneMappingExposure: 1.0,
}

/**
 * Bloom 后处理视觉参数（SPEC §8.5、§8.2，TASK-014）。
 *
 * 不变量：
 * - 亮度阈值 1.0：只有线性空间亮度高于 1.0 的像素进入 Bloom。配合 EffectComposer 的 HDR 渲染
 *   （渲染期 NoToneMapping），流动高亮（峰值 ≈ 流光色线性峰值 × flowHighlightIntensity > 1.0，
 *   见 pathShader）与 charge/park 节点的发光层次触发 Bloom；基础路径扁带、背景与普通 node 节点
 *   线性亮度低于 1.0，不进入 Bloom（SPEC §8.5、§16.2 "基础路径和背景不得进入 Bloom"）。
 * - mipmapBlur：启用 mipmap 金字塔模糊，形成柔和而稳定的辉光，不叠加第二套抗锯齿或自研模糊
 *   （SPEC §8.5、TASK-014 实现约束）。
 * - 阈值、平滑、强度集中定义，组件与着色器内不得散落（SPEC §8.2 末条、§8.5）。
 */
export interface BloomTheme {
  /** 亮度阈值（SPEC §8.5：1.0）。线性亮度高于此值的像素进入 Bloom。 */
  readonly luminanceThreshold: number
  /** 亮度阈值平滑（SPEC §8.5：0.2）。控制阈值边界的过渡柔和度。 */
  readonly luminanceSmoothing: number
  /** Bloom 强度（SPEC §8.5：1.1）。辉光叠加倍率。 */
  readonly intensity: number
  /** 启用 mipmap blur（SPEC §8.5：启用）。 */
  readonly mipmapBlur: boolean
}

export const BLOOM_THEME: BloomTheme = {
  luminanceThreshold: 1.0,
  luminanceSmoothing: 0.2,
  intensity: 1.1,
  mipmapBlur: true,
}

/**
 * EffectComposer 多采样样本数（SPEC §8.5：multisampling = 0，TASK-014）。
 *
 * 设为 0 关闭 Composer 内部的 MSAA 管线，避免与 SMAA 叠加成第二套抗锯齿（SPEC §8.5
 * "EffectComposer 的 multisampling 设为 0"、"不叠加第二套抗锯齿"，§3 "不启用重复的 MSAA 管线"）。
 * Canvas 原生 antialias 同样关闭（见 MapSceneView），画面抗锯齿唯一由 SMAA 负责。
 */
export const COMPOSER_MULTISAMPLING = 0
