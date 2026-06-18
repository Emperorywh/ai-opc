/**
 * 河流材质（SPEC §6.4 流动发光 shader，Task 29）。
 *
 * ─── 数据契约（Task 28 rivers.bin，前端零几何逻辑）──────────────────────────────
 * pipeline 已烘焙带状几何：position=已投影 worldXY + heightmap 采样高度 + ε（贴地不穿山/不悬空），
 *   uv: u=累积弧长（世界单位，沿流向单调）/ v∈{-1,+1}（左 / 右边缘），index=带状三角形全局索引。
 * 本材质**仅消费 uv** 驱动：沿 u（弧长）方向移动的流动光带 + 青蓝发光（emissive 近似）+ 边缘软过渡。
 *
 * ─── 抗 z-fighting（SPEC §6.4.4 双保险）─────────────────────────────────────────
 * pipeline 已 +ε（RIVER_Y_OFFSET，与边界 BOUNDARY_Y_OFFSET 同义）抬高越过深度量化误差；
 * 材质再加 `polygonOffset`（负值推近相机）—— 双保险确保河流贴地不被地形遮挡、不闪烁。
 *
 * ─── 流动 / 发光（SPEC §6.4.3）──────────────────────────────────────────────────
 * 流动光带：phase = fract(u·freq − time·speed)，smoothstep 三角脉冲（phase=0.5 峰值，两端 0），
 *   沿河流向（u 增大）移动（uTime 驱动，同 Ocean §6.2.4）。
 * 发光（emissive 近似，非全局 Bloom §13 默认不做）：脉冲亮色 mix 进基色 + level 亮度增益
 *   （大河 level=3 更醒目，兑现 types.ts「Task 29 决定渲染亮度」）。
 *
 * ─── shader 复杂度开关（SPEC §8 / D18）─────────────────────────────────────────
 * `uPulseStrength` 控制流动脉冲（0=静态青蓝带）；Rivers.tsx 订阅 store qualityTier 传值，
 *   低档关脉冲省片元 smoothstep——不动 GLSL（开关位预留，同 ocean uWaveCount 模式）。
 *
 * ─── 透明渲染顺序契约（SPEC §4.3）──────────────────────────────────────────────
 * transparent + depthWrite=false + depthTest=true（默认）+ DoubleSide + renderOrder=RIVER_RENDER_ORDER
 *   → 读 Terrain 已写深度（山体遮挡后方河流），后绘不污染深度缓冲。
 *
 * 独立非组件模块（导出常量 / 纯函数 / 工厂），使 Rivers.tsx 满足 react-refresh「单组件导出」规则
 * （与 oceanMaterial.ts / boundaryGeometry.ts / highlight.ts 同构）。
 */
import * as THREE from 'three'
import { palette } from '../../config/palette'
import type { RiverData } from '../../data/types'

// ---------------------------------------------------------------------------
// 颜色 / 视觉常量（SPEC §2.1 palette.river 青蓝发光）
// ---------------------------------------------------------------------------

/** 河流基色（SPEC §2.1 palette.river 青蓝发光）。 */
export const RIVER_COLOR = palette.river
/** 流动脉冲亮色（青蓝偏亮高光，发光感；与基色 mix 形成光带）。 */
export const RIVER_GLOW_COLOR = '#B6F0FF'
/** 河流中心不透明度（边缘经 edge 衰减；<1 保持水彩通透感）。 */
export const RIVER_OPACITY = 0.9
/** 边缘软化范围（|v| 从 1−edgeSoft 起 alpha 渐降至边缘 0，软过渡无硬边）。 */
export const RIVER_EDGE_SOFT = 0.45

// ---------------------------------------------------------------------------
// 流动参数（沿 u 弧长方向的光带）
// ---------------------------------------------------------------------------

/** 光带频率（沿 u 每世界单位的周期数；河流弧长 ~0.1–0.5 → 数个流动光点）。 */
export const RIVER_FLOW_FREQ = 10.0
/** 流动速度（u/秒，光带沿河流向移动；正值 = 从源头流向河口）。 */
export const RIVER_FLOW_SPEED = 0.6
/** 流动脉冲强度（0=静态带 / 1=满脉冲；低档 AdaptiveQuality 置 0）。 */
export const RIVER_PULSE_STRENGTH = 1.0

// ---------------------------------------------------------------------------
// level 亮度增益（大河 level=3 更亮，兑现 types.ts「Task 29 决定亮度」）
// ---------------------------------------------------------------------------

/** 最大流量级别（与 pipeline RIVER_LEVELS.LARGE = 3 同源）。 */
export const RIVER_MAX_LEVEL = 3
/** level 亮度增益（大河提亮 +level/maxLevel×boost，emissive 近似）。 */
export const RIVER_LEVEL_BOOST = 0.5

// ---------------------------------------------------------------------------
// 抗 z-fighting（polygonOffset 双保险）
// ---------------------------------------------------------------------------

/** polygonOffset factor（负值推近相机，与 ε 配合避免河流被地形遮挡 / 闪烁）。 */
export const RIVER_POLYGON_OFFSET_FACTOR = -1
/** polygonOffset units（同上，深度单位偏移）。 */
export const RIVER_POLYGON_OFFSET_UNITS = -1

/**
 * 河流材质透明属性（SPEC §4.3 透明渲染顺序契约 + §6.4.4 polygonOffset 双保险）。
 *   transparent + depthWrite=false → 后绘不污染深度；
 *   depthTest=true（默认）→ 与 Terrain 已写深度比较，山体遮挡后方河流；
 *   DoubleSide → 倾斜相机掠射角两面可见（与 Ocean / 国家填充同）；
 *   polygonOffset=true（factor/units 负值）→ 推近相机抗 z-fighting。
 * 导出 plain object 供单测断言渲染顺序契约（同 OCEAN_MATERIAL_OPTS 模式）。
 */
export const RIVER_MATERIAL_OPTS = {
  transparent: true,
  depthWrite: false,
  side: THREE.DoubleSide,
  polygonOffset: true,
  polygonOffsetFactor: RIVER_POLYGON_OFFSET_FACTOR,
  polygonOffsetUnits: RIVER_POLYGON_OFFSET_UNITS,
} as const

/**
 * 河流渲染顺序（SPEC §4.3：透明物体后绘）。
 *   Terrain=0 → Ocean=1 → 国家填充=2 → 描边=3 → 争议虚线=4 → **河流=5** → AtmosphereRim=10。
 * 河流贴地透明读 Terrain 深度；放边界层之上使其发光带可见（河流与边界极少重叠）。
 */
export const RIVER_RENDER_ORDER = 5

// ===========================================================================
// shader 数学（纯函数，与 GLSL 同源，供 Node 单测验证）
// ===========================================================================

/**
 * 流动脉冲因子（SPEC §6.4.3，沿 u 弧长方向移动的光带）。
 *
 * GLSL：`phase = fract(u·freq − time·speed)`；脉冲在 phase=0.5 达峰值 1、两端（0/1）为 0，
 * smoothstep 软化光带边缘。`time` 增大 → phase 减小 → 等相面 u 增大 → 光带沿河流向（源头→河口）移动。
 *
 * @returns [0,1] 脉冲强度（0 无光带 / 1 光带中心）
 */
export function riverFlowPulse(u: number, time: number, freq: number, speed: number): number {
  // fract（JS % 对负数不规整，手动 +1 归一到 [0,1)，与 GLSL fract 等价）
  let phase = (u * freq - time * speed) % 1
  if (phase < 0) phase += 1
  // 距峰值 0.5 的归一化距离 d∈[0,1]（0.5 峰 → 0 / 0,1 谷 → 1）
  const d = Math.abs(phase - 0.5) * 2
  // smoothstep 软化：d=0 → 1, d=1 → 0
  const t = Math.max(0, 1 - d)
  return t * t * (3 - 2 * t)
}

/**
 * 边缘软过渡因子（SPEC §6.4.3「边缘软过渡」）。
 *
 * GLSL：`1 − smoothstep(1−edgeSoft, 1, |v|)`。v=0（中心）→ 1（满）；
 * |v| 从 1−edgeSoft 起 alpha 渐降至 |v|=1（边缘）→ 0，避免带状边缘硬切。
 *
 * @param v 边缘坐标（pipeline uv.v ∈ [-1,+1]）
 * @returns [0,1] 边缘 mask（中心满 / 边缘零）
 */
export function riverEdgeMask(v: number, edgeSoft: number): number {
  const a = Math.abs(v)
  const start = 1 - edgeSoft
  if (a <= start) return 1
  if (a >= 1) return 0
  const t = (a - start) / edgeSoft // [0,1]
  const s = t * t * (3 - 2 * t) // smoothstep(0,1,t)
  return Math.max(0, 1 - s)
}

/**
 * level 亮度增益（SPEC §6.4 / types.ts「Task 29 决定渲染亮度」）。
 *
 * GLSL：`clamp(level / maxLevel, 0, 1) · boost`。大河（level=3）最亮、小河（level=1）较暗，
 * 让长江 / 亚马逊等大河在视觉上突出。返回值加到片元色（emissive 近似提亮）。
 *
 * @returns [0, boost] 亮度增益
 */
export function riverLevelBoost(level: number, maxLevel: number, boost: number): number {
  if (maxLevel <= 0) return 0
  return Math.max(0, Math.min(1, level / maxLevel)) * Math.max(0, boost)
}

/**
 * 构建每顶点 `level` 属性（与 buildCountryIdAttribute 同源遍历）。
 *
 * 每条河 vertexOffset..vertexCount 填该河 `level`（1/2/3）；shader 据 level 调亮度（大河更亮）。
 * 长度对齐 `vertices.length / 3`（顶点数）。纯函数，可在 Node 单测（合成 RiverData）。
 */
export function buildRiverLevelAttribute(data: RiverData): Float32Array {
  const n = data.vertices.length / 3
  const levels = new Float32Array(n)
  for (const r of data.rivers) {
    for (let i = 0; i < r.vertexCount; i++) {
      levels[r.vertexOffset + i] = r.level
    }
  }
  return levels
}

// ===========================================================================
// GLSL
// ===========================================================================

const RIVER_VERT = /* glsl */ `
  precision highp float;

  attribute float level;   // 流量级别 1/2/3（buildRiverLevelAttribute，每顶点）

  varying vec2 vUv;        // u=累积弧长 / v=边缘 -1..1
  varying float vLevel;

  void main() {
    vUv = uv;              // uv / position / projectionMatrix / modelViewMatrix 由 ShaderMaterial 自动注入
    vLevel = level;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`

const RIVER_FRAG = /* glsl */ `
  precision highp float;

  uniform float uTime;
  uniform float uFlowFreq;
  uniform float uFlowSpeed;
  uniform float uPulseStrength;
  uniform float uEdgeSoft;
  uniform vec3 uColor;
  uniform vec3 uGlowColor;
  uniform float uOpacity;
  uniform float uLevelBoost;
  uniform float uMaxLevel;

  varying vec2 vUv;
  varying float vLevel;

  void main() {
    // 边缘软过渡（|v| 中心满 / 边缘零，无硬切）
    float edge = 1.0 - smoothstep(1.0 - uEdgeSoft, 1.0, abs(vUv.y));
    // 流动脉冲（沿 u 弧长移动的光带；与 riverFlowPulse 同源）
    float phase = fract(vUv.x * uFlowFreq - uTime * uFlowSpeed);
    float d = abs(phase - 0.5) * 2.0;
    float t = clamp(1.0 - d, 0.0, 1.0);
    float pulse = t * t * (3.0 - 2.0 * t) * uPulseStrength;
    // level 亮度增益（大河 level=3 更亮，emissive 近似）
    float lvl = clamp(vLevel / uMaxLevel, 0.0, 1.0) * uLevelBoost;
    // 基色 → 脉冲亮色 mix + 提亮（不引全局 Bloom）
    vec3 col = mix(uColor, uGlowColor, pulse);
    col += col * lvl;
    float alpha = uOpacity * edge;
    if (alpha <= 0.0) discard;
    // raw ShaderMaterial 不自动 sRGB encode，手动 gamma（与 ocean / terrain 一致）
    gl_FragColor = vec4(pow(col, vec3(1.0 / 2.2)), alpha);
  }
`

// ===========================================================================
// 材质工厂
// ===========================================================================

/**
 * 构建河流材质（SPEC §6.4：UV 流动光带 + 青蓝发光 + 边缘软过渡 + polygonOffset 抗 z-fighting）。
 *
 * @param opts.pulseStrength 流动脉冲强度（0=静态带，默认 RIVER_PULSE_STRENGTH）。
 *   Rivers.tsx 订阅 store qualityTier：低档置 0（省片元 smoothstep），中/高档满脉冲。
 */
export function createRiverMaterial(opts?: { pulseStrength?: number }): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    ...RIVER_MATERIAL_OPTS,
    uniforms: {
      uTime: { value: 0 },
      uFlowFreq: { value: RIVER_FLOW_FREQ },
      uFlowSpeed: { value: RIVER_FLOW_SPEED },
      uPulseStrength: { value: opts?.pulseStrength ?? RIVER_PULSE_STRENGTH },
      uEdgeSoft: { value: RIVER_EDGE_SOFT },
      uColor: { value: new THREE.Color(RIVER_COLOR) },
      uGlowColor: { value: new THREE.Color(RIVER_GLOW_COLOR) },
      uOpacity: { value: RIVER_OPACITY },
      uLevelBoost: { value: RIVER_LEVEL_BOOST },
      uMaxLevel: { value: RIVER_MAX_LEVEL },
    },
    vertexShader: RIVER_VERT,
    fragmentShader: RIVER_FRAG,
  })
}
