/**
 * 海洋材质与几何配置（SPEC §6.2 / §4.3，Task 07：Gerstner 海洋 shader）。
 *
 * Task 06 半透明纯色占位 → Task 07 升级为自定义 ShaderMaterial：
 *   1. Gerstner 波（≤5 个，顶点位移 + 解析法线，GPU Gems 1 Ch.1 公式，SPEC §6.2.1 / D8）
 *   2. 菲涅尔柔和反射 pow(1-dot(N,V),3)（掠射角偏亮青绿，§6.2.2）
 *   3. 深浅渐变（heightmap 水深采样：浅 #7FC4C0 → 深 #2E6E73，§6.2.3）
 *   4. uTime 驱动流动（波相位滚动，§6.2.4）
 *   体积感（§6.2.5）由 Gerstner 波峰/波谷自然提供（海平面 y=seaLevel 契约不变）。
 *
 * shader 复杂度开关（SPEC §8 / D18）：波数经 uWaveCount uniform 控制，
 *   低档（oceanWaves=0）降级为 1 个 Q=0 正弦波（§6.2.1「低档减为正弦波」）；
 *   M2 默认高档（qualityConfigs[defaultQualityTier].oceanWaves=5），
 *   M3 Task 11 AdaptiveQuality 仅改 uniform value 不动 shader（开关位预留）。
 *
 * 透明渲染顺序契约（SPEC §4.3，Task 06 风险验证 #1，本 Task 保持不退化）：
 *   transparent=true + depthWrite=false + depthTest=true + DoubleSide + renderOrder=1。
 *
 * 独立非组件模块（导出常量/函数），使 Ocean.tsx 满足 react-refresh「单组件导出」规则
 *（与 terrainMaterial.ts / Terrain.tsx 同构）。
 */
import * as THREE from 'three'
import {
  PLANE_WIDTH,
  PLANE_HEIGHT,
  metersToWorldY,
  computeHeightUniforms,
} from '../../config/projection'
import { palette } from '../../config/palette'
import { qualityConfigs, defaultQualityTier } from '../../config/quality'
import type { TerrainAssets } from '../../data/types'

/** 海洋网格细分密度（segments）。256×128 为 Gerstner 顶点位移提供足够分辨率
 *  （最短波长 ≈0.12 世界单位 → ≈15 格/波长，平滑）；M3 按质量档缩放。 */
export const OCEAN_SEGMENTS = { x: 256, y: 128 } as const

/** 最大 Gerstner 波数（GLSL uniform 数组定长；高档=5）。 */
export const MAX_OCEAN_WAVES = 5

/** 深浅渐变参考水深（米）→ 世界 Y（uMaxDepth）：超过此深度饱和为深青绿。
 *  2500m → 0.0625 世界 Y（大陆架浅海渐变 + 深海饱和）。 */
export const OCEAN_MAX_DEPTH_METERS = 2500

/** 海洋半透明度（SPEC §4.3：可见海床纵深；与 Task 06 同量级）。 */
export const OCEAN_OPACITY = 0.72

/** 菲涅尔掠射微光色（SPEC §6.2.2：掠射角偏亮青绿）与强度。 */
export const OCEAN_FRESNEL_COLOR = '#BFEDE8'
export const OCEAN_FRESNEL_STRENGTH = 0.6

/**
 * 海洋材质透明属性（SPEC §4.3 透明渲染顺序契约，Task 06 验证过，本 Task 保持）。
 *   transparent=true + depthWrite=false → Ocean 后绘且不污染深度缓冲；
 *   depthTest=true（ShaderMaterial 默认）→ 与 Terrain 已写深度比较，陆地遮挡海洋、海床被覆盖；
 *   DoubleSide → 倾斜相机掠射角两面可见（波浪亦需）。
 * 导出 plain object 供单测断言渲染顺序契约。
 */
export const OCEAN_MATERIAL_OPTS = {
  transparent: true,
  depthWrite: false,
  side: THREE.DoubleSide,
} as const

/** 海洋渲染顺序（SPEC §4.3：透明物体后绘）。Terrain 默认 0 先绘，Ocean=1 后绘。 */
export const OCEAN_RENDER_ORDER = 1

/** 海平面世界 Y（Task 03 契约：seaLevelMeters → 世界 Y，CPU/GPU 同源）。
 *  Task 07 保持精确 seaLevel（=0）；体积感由 Gerstner 波振幅提供（不破坏 R3 契约）。 */
export function seaLevelWorldY(assets: TerrainAssets): number {
  return metersToWorldY(assets.meta.seaLevelMeters)
}

// ===========================================================================
// Gerstner 波参数（世界尺度）
// ===========================================================================

export type GerstnerWaveSet = {
  /** 实际活跃波数（1..MAX）。 */
  count: number
  /** 水平单位方向（世界 X,Z）。长度恒为 MAX_OCEAN_WAVES，超出 count 的置零。 */
  dirs: THREE.Vector2[]
  /** 振幅（世界 Y）。 */
  amps: number[]
  /** 角频率 ω。 */
  freqs: number[]
  /** 相位速度。 */
  speeds: number[]
  /** 陡度 Q（0 = 正弦）。 */
  steeps: number[]
}

/**
 * 生成 Gerstner 波参数集（世界尺度，固定表 → 可复现）。
 *
 * 方向/频率/振幅递减分布，叠加成自然柔和浪涌（非写实细碎噪声）。
 * `count<=0`（低档 oceanWaves=0）→ 1 个 Q=0 正弦波（SPEC §6.2.1「低档减为正弦波」）。
 */
export function buildGerstnerWaves(count: number): GerstnerWaveSet {
  // [Dx, Dz, 振幅A, 频率ω, 速度speed, 陡度Q]
  const table: ReadonlyArray<readonly [number, number, number, number, number, number]> = [
    [1.0, 0.0, 0.0040, 13.96, 0.6, 0.7],
    [0.7, 0.71, 0.0028, 20.94, 0.8, 0.6],
    [-0.6, 0.8, 0.0019, 28.56, 0.7, 0.5],
    [0.3, -0.95, 0.0013, 39.27, 0.9, 0.4],
    [-0.8, -0.6, 0.0009, 52.36, 1.0, 0.3],
  ]
  const sinMode = count <= 0
  const active = sinMode ? 1 : Math.min(Math.floor(count), MAX_OCEAN_WAVES)
  const dirs: THREE.Vector2[] = []
  const amps: number[] = []
  const freqs: number[] = []
  const speeds: number[] = []
  const steeps: number[] = []
  for (let i = 0; i < MAX_OCEAN_WAVES; i++) {
    const [dx, dz, a, w, s, q] = table[i]
    dirs.push(new THREE.Vector2(dx, dz).normalize())
    if (i < active) {
      amps.push(a)
      freqs.push(w)
      speeds.push(s)
      steeps.push(sinMode ? 0 : q)
    } else {
      amps.push(0)
      freqs.push(0)
      speeds.push(0)
      steeps.push(0)
    }
  }
  return { count: active, dirs, amps, freqs, speeds, steeps }
}

// ===========================================================================
// shader 数学（纯函数，与 GLSL 同源，供单测验证）
// ===========================================================================

/**
 * 深浅渐变因子（SPEC §6.2.3）：地形世界 Y 越低（海底越深）→ 因子越接近 1（深色）。
 * GLSL：`depth = clamp(-terrainY / uMaxDepth, 0, 1)`。
 */
export function oceanDepthFactor(terrainWorldY: number, maxDepthWorldY: number): number {
  if (maxDepthWorldY <= 0) return 0
  return Math.max(0, Math.min(1, -terrainWorldY / maxDepthWorldY))
}

/**
 * 菲涅尔因子（SPEC §6.2.2）：掠射角（N·V 小）→ 接近 1（亮），正视 → 0。
 * GLSL：`pow(1 - max(dot(N,V), 0), 3)`。
 */
export function oceanFresnel(nDotV: number): number {
  return Math.pow(1 - Math.max(nDotV, 0), 3)
}

// ===========================================================================
// GLSL
// ===========================================================================

const OCEAN_VERT = /* glsl */ `
  precision highp float;

  uniform sampler2D uHeightmap;     // 深浅渐变 per-pixel 采样（同地形 R32F heightmap）
  uniform float uHeightScale;       // Task 03 高度解码契约（与 terrain 同源）
  uniform float uHeightOffset;
  uniform float uPlaneWidth;
  uniform float uPlaneHeight;
  uniform float uTime;

  const int MAX_WAVES = ${MAX_OCEAN_WAVES};
  uniform int uWaveCount;
  uniform vec2 uWaveDir[MAX_WAVES];
  uniform float uWaveAmp[MAX_WAVES];
  uniform float uWaveFreq[MAX_WAVES];
  uniform float uWaveSpeed[MAX_WAVES];
  uniform float uWaveSteep[MAX_WAVES];

  varying vec3 vNormal;
  varying vec3 vViewDir;
  varying vec2 vHeightUv;

  void main() {
    // 位移前世界坐标（PlaneGeometry rotation[-90° X]：本地 (x,y,0) → 世界 (x,0,-y)）
    vec3 worldPos0 = (modelMatrix * vec4(position, 1.0)).xyz;
    vec2 p = worldPos0.xz; // 世界水平坐标（Gerstner 输入）

    // Gerstner 位移 + 解析法线累积（GPU Gems 1 Ch.1 公式）
    float offX = 0.0;   // 世界 X 位移
    float offZ = 0.0;   // 世界 Z 位移
    float dispY = 0.0;  // 世界 Y 位移
    // Binormal B（沿世界 X）、Tangent T（沿世界 Z）；flat water 初值
    float Bx = 1.0, By = 0.0, Bz = 0.0;
    float Tx = 0.0, Ty = 0.0, Tz = 1.0;
    for (int i = 0; i < MAX_WAVES; i++) {
      if (i >= uWaveCount) break;
      vec2 D = uWaveDir[i];
      float A = uWaveAmp[i];
      float w = uWaveFreq[i];
      float spd = uWaveSpeed[i];
      float Q = uWaveSteep[i];
      float phase = w * dot(D, p) + spd * uTime;
      float S = sin(phase);
      float C = cos(phase);
      // 水平位移（Gerstner 尖峰；Q=0 时为零 → 退化为正弦）
      offX += Q * A * D.x * C;
      offZ += Q * A * D.y * C;
      dispY += A * S;
      // 法线累积（GPU Gems：B = (1-ΣQ·Dx·WAx·S, ΣWAx·C, -ΣQ·Dy·WAx·S) 等）
      float WAx = w * A * D.x;
      float WAy = w * A * D.y;
      Bx -= Q * D.x * WAx * S;
      By += WAx * C;
      Bz -= Q * D.y * WAx * S;
      Tx -= Q * D.x * WAy * S;
      Ty += WAy * C;
      Tz -= Q * D.y * WAy * S;
    }
    vec3 N = normalize(cross(vec3(Bx, By, Bz), vec3(Tx, Ty, Tz)));
    if (N.y < 0.0) N = -N; // 保 +Y 朝上

    // 应用位移到本地坐标（本地 x=世界 X，本地 y=世界 -Z，本地 z=世界 Y）
    vec3 transformed = position;
    transformed.x += offX;
    transformed.y -= offZ;
    transformed.z += dispY;
    vec3 worldPos = (modelMatrix * vec4(transformed, 1.0)).xyz; // 位移后世界坐标
    vNormal = N;
    vViewDir = normalize(cameraPosition - worldPos); // cameraPosition 为 three 内建 vertex uniform
    // 深浅渐变用位移前世界坐标（地理固定 → 海岸线稳定，不受波浪水平位移影响）
    vHeightUv = vec2(worldPos0.x / uPlaneWidth + 0.5, 0.5 + worldPos0.z / uPlaneHeight);
    gl_Position = projectionMatrix * modelViewMatrix * vec4(transformed, 1.0);
  }
`

const OCEAN_FRAG = /* glsl */ `
  precision highp float;

  uniform sampler2D uHeightmap;
  uniform float uHeightScale;
  uniform float uHeightOffset;
  uniform float uMaxDepth;
  uniform vec3 uColorShallow;
  uniform vec3 uColorDeep;
  uniform vec3 uFresnelColor;
  uniform float uFresnelStrength;
  uniform float uOpacity;

  varying vec3 vNormal;
  varying vec3 vViewDir;
  varying vec2 vHeightUv;

  void main() {
    // 深浅渐变（per-pixel heightmap 水深，与 terrain 同源解码）
    float h = texture2D(uHeightmap, vHeightUv).r;
    float terrainY = h * uHeightScale + uHeightOffset;
    float depth = clamp(-terrainY / uMaxDepth, 0.0, 1.0);
    vec3 col = mix(uColorShallow, uColorDeep, depth);
    // 菲涅尔柔和反射（掠射角偏亮青绿，SPEC §6.2.2）
    float fres = pow(1.0 - max(dot(normalize(vNormal), normalize(vViewDir)), 0.0), 3.0);
    col = mix(col, uFresnelColor, clamp(fres, 0.0, 1.0) * uFresnelStrength);
    // raw ShaderMaterial 不自动 sRGB encode，手动 gamma（与 terrainMaterial 一致）
    gl_FragColor = vec4(pow(col, vec3(1.0 / 2.2)), uOpacity);
  }
`

// ===========================================================================
// 材质工厂
// ===========================================================================

/**
 * 由地形资产构建海洋材质（SPEC §6.2：Gerstner + 菲涅尔 + 深浅渐变 + 流动）。
 *
 * @param opts.waveCount 波数（≤0 正弦降级；默认高档 qualityConfigs[defaultQualityTier].oceanWaves）。
 *   M3 Task 11 接 store 后由 AdaptiveQuality 传入；M2 用默认。
 */
export function createOceanMaterial(
  assets: TerrainAssets,
  opts?: { waveCount?: number },
): THREE.ShaderMaterial {
  const { scale, offset } = computeHeightUniforms(assets.meta)
  const waveCount = opts?.waveCount ?? qualityConfigs[defaultQualityTier].oceanWaves
  const waves = buildGerstnerWaves(waveCount)
  return new THREE.ShaderMaterial({
    ...OCEAN_MATERIAL_OPTS,
    uniforms: {
      uHeightmap: { value: assets.heightTexture },
      uHeightScale: { value: scale },
      uHeightOffset: { value: offset },
      uPlaneWidth: { value: PLANE_WIDTH },
      uPlaneHeight: { value: PLANE_HEIGHT },
      uMaxDepth: { value: metersToWorldY(OCEAN_MAX_DEPTH_METERS) },
      uTime: { value: 0 },
      uWaveCount: { value: waves.count },
      uWaveDir: { value: waves.dirs },
      uWaveAmp: { value: waves.amps },
      uWaveFreq: { value: waves.freqs },
      uWaveSpeed: { value: waves.speeds },
      uWaveSteep: { value: waves.steeps },
      uColorShallow: { value: new THREE.Color(palette.oceanShallow) },
      uColorDeep: { value: new THREE.Color(palette.oceanDeep) },
      uFresnelColor: { value: new THREE.Color(OCEAN_FRESNEL_COLOR) },
      uFresnelStrength: { value: OCEAN_FRESNEL_STRENGTH },
      uOpacity: { value: OCEAN_OPACITY },
    },
    vertexShader: OCEAN_VERT,
    fragmentShader: OCEAN_FRAG,
  })
}
