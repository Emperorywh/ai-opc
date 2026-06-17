/**
 * 大气层辉光材质与几何配置（SPEC §6.7 + §4.3 渲染管线末项，Task 16）。
 *
 * 贴合倾斜平面沙盘边缘的「扁椭圆上半球弧壳」：
 *   - 上半球壳（SphereGeometry thetaLength=π/2）→ scale 成扁椭圆贴合 2:1 平面
 *     （scaleZ/scaleX = PLANE_HEIGHT/PLANE_WIDTH，边缘与平面长方形外缘吻合）
 *   - BackSide（渲染朝向地图的内表面）+ AdditiveBlending + fresnel → 边缘柔和光晕
 *   - SPEC §6.7「背面弧壳（BackSide，曲面而非整球）」；§13「不引入全局 Bloom，用 fresnel shell」
 *
 * shader 复杂度开关（SPEC §8 / D18）：辉光强度随质量档（低档关闭省片元开销，§8「低档关辉光」）。
 *   质量分档用**模块内映射** `ATMOSPHERE_BY_TIER`（不改 quality.ts 集中配置，守 Task 16
 *   允许边界 `src/three/atmosphere/**`；与 oceanWaves/terrainEffects 同模式，仅配置位置不同）。
 *   AtmosphereRim 订阅 store qualityTier，仅改 uniform value / 是否渲染（不动 shader）。
 *
 * 独立非组件模块（导出常量/函数/GLSL/工厂），使 AtmosphereRim.tsx 满足 react-refresh
 * 「单组件导出」（与 oceanMaterial.ts / terrainMaterial.ts 同构）。
 */
import * as THREE from 'three'
import { PLANE_WIDTH, PLANE_HEIGHT } from '../../config/projection'
import { desaturateHex, SATURATION_REDUCTION } from '../../config/palette'
import type { QualityTier } from '../../config/quality'

/** 辉光壳基球半径（单位球；实际椭圆尺寸由 SHELL_SCALE_* 控制）。 */
export const SHELL_RADIUS = 1.0

/** 椭圆壳 X 方向缩放（覆盖平面半宽 PLANE_WIDTH/2=1.0 + 边缘辉光余量）。 */
export const SHELL_SCALE_X = 1.18

/** 椭圆壳 Z 方向缩放（= SHELL_SCALE_X × PLANE_HEIGHT/PLANE_WIDTH，保持 2:1 贴合平面边缘）。 */
export const SHELL_SCALE_Z = SHELL_SCALE_X * (PLANE_HEIGHT / PLANE_WIDTH)

/** 壳的垂直压扁（上半球 → 贴合平面的扁弧壳；值越小越扁、越贴地）。 */
export const SHELL_FLATTEN = 0.12

/** 球壳网格细分（弧壳曲面平滑度；中等密度足够 fresnel 边缘光晕，省顶点）。 */
export const SHELL_SEGMENTS = { width: 64, height: 32 } as const

/** 上半球的 theta 取值范围（thetaStart=0..thetaLength=π/2 → 北半球壳）。 */
export const SHELL_THETA_LENGTH = Math.PI / 2

/** 辉光色（SPEC §2.1 低饱和；冷青白与水彩暖调协调，经 desaturateHex S 降 20%）。 */
export const ATMOSPHERE_GLOW_COLOR = desaturateHex('#9FC4D2', SATURATION_REDUCTION)

/** fresnel 边缘光晕锐利度（pow 指数；值大→边缘更窄更锐，3.0 为柔和大气感）。 */
export const ATMOSPHERE_FRESNEL_POWER = 3.0

/** 高档辉光强度（克制，SPEC 风险验证「辉光不抢戏」）。 */
export const ATMOSPHERE_INTENSITY_HIGH = 0.6

/**
 * 大气辉光材质透明属性（SPEC §6.7：additive + BackSide + 不写深度）。
 *   - transparent + AdditiveBlending → 边缘光晕发光叠加（src·a + dst）；
 *   - depthWrite=false → 不污染深度缓冲（不遮挡后续，虽为管线末项无后续）；
 *   - depthTest=false → 光晕始终叠加不被地形遮挡（壳顶 fresnel rim≈0 不可见，
 *     仅掠射边缘 rim 大发光，故中心不过亮；与大气辉光壳标准做法一致）；
 *   - BackSide → 渲染朝向地图的内表面（从相机看壳的背面=内侧发光面）。
 * 导出 plain object 供单测断言材质契约。
 */
export const ATMOSPHERE_MATERIAL_OPTS = {
  transparent: true,
  depthWrite: false,
  depthTest: false,
  side: THREE.BackSide,
  blending: THREE.AdditiveBlending,
} as const

/** 大气辉光渲染顺序（SPEC §4.3 管线末项，最后绘于 Terrain/Ocean/LabelLayer 之上叠加）。
 *  高于 Ocean（renderOrder=1）。 */
export const ATMOSPHERE_RENDER_ORDER = 10

// ===========================================================================
// 质量分档（SPEC §8：低档关辉光；模块内自包含，不改 quality.ts）
// ===========================================================================

export type AtmosphereTierConfig = {
  /** 是否启用辉光（低档关闭省片元开销）。 */
  enabled: boolean
  /** 辉光强度（高档克制、中档减弱）。 */
  intensity: number
}

export const ATMOSPHERE_BY_TIER: Record<QualityTier, AtmosphereTierConfig> = {
  high: { enabled: true, intensity: ATMOSPHERE_INTENSITY_HIGH },
  medium: { enabled: true, intensity: ATMOSPHERE_INTENSITY_HIGH * 0.65 },
  low: { enabled: false, intensity: 0 },
}

// ===========================================================================
// shader 数学（纯函数，与 GLSL 同源，供单测验证）
// ===========================================================================

/**
 * fresnel 边缘因子（SPEC §6.7，与 GLSL 同源）：
 *   正对相机（|N·V|≈1）→ 0（壳顶暗）；掠射边缘（|N·V|≈0）→ 1（亮）。
 *   用 abs 兼容 BackSide 法线朝向（朝地图内），rim 只依赖掠射角度。
 * GLSL：`pow(clamp(1 - abs(dot(N,V)), 0, 1), power)`。
 */
export function atmosphereFresnel(nDotV: number, power: number): number {
  return Math.pow(Math.max(0, Math.min(1, 1 - Math.abs(nDotV))), power)
}

// ===========================================================================
// GLSL
// ===========================================================================

const ATMOSPHERE_VERT = /* glsl */ `
  precision highp float;

  varying vec3 vNormal;
  varying vec3 vViewDir;

  void main() {
    // view-space（normalMatrix 含 inverse-transpose，非均匀缩放下法线正确；
    // fresnel 只依赖 N·V 角度，与坐标空间无关，view-space 等价世界空间）。
    vNormal = normalize(normalMatrix * normal);
    vec4 mvPos = modelViewMatrix * vec4(position, 1.0);
    vViewDir = normalize(-mvPos.xyz); // view space：眼在原点，视线指向眼 = -mvPos
    gl_Position = projectionMatrix * mvPos;
  }
`

const ATMOSPHERE_FRAG = /* glsl */ `
  precision highp float;

  uniform vec3 uGlowColor;
  uniform float uFresnelPower;
  uniform float uIntensity;

  varying vec3 vNormal;
  varying vec3 vViewDir;

  void main() {
    // fresnel 边缘光晕（掠射 rim≈1 亮、正视 rim≈0 暗），abs 兼容 BackSide 法线
    float rim = pow(clamp(1.0 - abs(dot(normalize(vNormal), normalize(vViewDir))), 0.0, 1.0), uFresnelPower);
    float a = rim * uIntensity;
    vec3 col = uGlowColor * a;
    // raw ShaderMaterial 不自动 sRGB encode，手动 gamma（与 ocean/terrain 一致）；
    // AdditiveBlending 混合公式 src·a + dst → alpha 控制光晕亮度
    gl_FragColor = vec4(pow(col, vec3(1.0 / 2.2)), a);
  }
`

// ===========================================================================
// 材质工厂
// ===========================================================================

/**
 * 构建大气辉光材质（SPEC §6.7：fresnel + additive + BackSide 弧壳）。
 *
 * @param intensity 辉光强度（高档 ATMOSPHERE_INTENSITY_HIGH；AdaptiveQuality 经
 *   ATMOSPHERE_BY_TIER 传入，低档 enabled=false 时组件不渲染故不调用）。
 */
export function createAtmosphereMaterial(
  intensity: number = ATMOSPHERE_INTENSITY_HIGH,
): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    ...ATMOSPHERE_MATERIAL_OPTS,
    uniforms: {
      uGlowColor: { value: new THREE.Color(ATMOSPHERE_GLOW_COLOR) },
      uFresnelPower: { value: ATMOSPHERE_FRESNEL_POWER },
      uIntensity: { value: intensity },
    },
    vertexShader: ATMOSPHERE_VERT,
    fragmentShader: ATMOSPHERE_FRAG,
  })
}
