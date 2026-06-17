/**
 * 地形材质 —— GPU 顶点位移 + 水彩着色（SPEC §6.1 / §2.2 / §2.3，Task 04 基础 → Task 08 水彩完善）。
 *
 * 顶点着色器：采样 R32F heightmap，按 Task 03 锁定的高度解码契约
 *   `worldY = h * uHeightScale + uHeightOffset`（= computeHeightUniforms(meta)）
 *   沿世界 +Y 位移顶点（×2.5 夸张已烘焙进 scale）。
 *
 * 片元着色器（Task 08 水彩完善，SPEC §2.2 全要素）：
 *   1. 高度分区分层上色（海岸→沙滩→平原→丘陵→山脉→雪线，smoothstep 软过渡）—— Task 04 基础
 *   2. normal.png 细节增强（§6.1.3）：片元采样烘焙法线，按权重 blend 进几何法线，治「低频发软」
 *   3. 坡度强调（§2.2.3）：陡坡偏暖灰绿、缓坡偏草绿
 *   4. 水彩噪声（§2.2.2）：hash fbm 调制明度形成「水彩颗粒」（无纹理依赖）
 *   5. 海岸线 fwidth 等高线（§2.4）：y≈0 处导数抗锯齿描边（非额外几何）
 *   6. 软描边轮廓（§2.2.4）：`1-dot(N,V)` 暖白 rim
 *   + 自包含 Lambert 光照（方向光 + 半球光，无 shadow / 无镜面，SPEC §2.2 Lambert-like）。
 *
 * palette 完整接入（Task 08）：所有色值源自 `config/palette` + `desaturateHex`（S 降 20%，§2.1）。
 *
 * shader 复杂度开关（SPEC §8 / D18，为 M3 Task 11 AdaptiveQuality 预留 uniform 钩子）：
 *   uSlopeEmphasis / uWatercolorNoise / uCoastline / uRimOutline / uDetailNormal。
 *   M2 默认高档（TERRAIN_EFFECTS）；M3 仅改 uniform value 不动 shader。
 *
 * 透明渲染顺序契约（Task 06/07）：Terrain 不透明先绘写深度，Ocean 后绘关深度写入，本材质保持 opaque。
 */
import * as THREE from 'three'
import { PLANE_WIDTH, PLANE_HEIGHT, computeHeightUniforms } from '../../config/projection'
import { palette, desaturateHex } from '../../config/palette'
import type { TerrainAssets } from '../../data/types'

/** M1 地形网格细分密度（segments）。512×256 → 513×257 ≈ 13.2 万顶点，沙盘观感与性能平衡。
 *  M3 Task 11 接 AdaptiveQuality 后按质量档缩放（SPEC §6.1：512×256 ~ 2048×1024）。 */
export const TERRAIN_SEGMENTS = { x: 512, y: 256 } as const

/**
 * 光照参数（SPEC §2.3：单一暖白方向光俯角~50° + 半球光，无 shadow / 无镜面）。
 *
 * 自定义 ShaderMaterial 不接收 R3F 灯光系统，故 shader 自包含光照、参数在此定义；
 * Scene 的 `<directionalLight>`/`<hemisphereLight>` 引用同一组参数（M2 起若改 standard
 * 材质可直接复用，且保证视觉一致）。
 */
export const terrainLight = {
  directional: {
    color: '#FFF2D8',
    /** 光源方向 L（从地表指向光源，用于 dot(N,L)）；俯角 50°、方位 135°(东南)。 */
    direction: new THREE.Vector3(0.454, 0.766, -0.454).normalize(),
    intensity: 0.9,
  },
  hemisphere: {
    sky: '#E8F0F2',
    ground: '#9C9078',
    intensity: 0.6,
  },
} as const

/**
 * 水彩效果开关默认值（高档，SPEC §8 高档全开）。
 * M3 Task 11 AdaptiveQuality 经 store 改 uniform value（低档置 0）；M2 用此默认。
 */
export const TERRAIN_EFFECTS = {
  /** 坡度强调强度（§2.2.3）：陡坡偏暖灰绿。 */
  slopeEmphasis: 1.0,
  /** 水彩噪声强度（§2.2.2）：明度调制幅度。 */
  watercolorNoise: 1.0,
  /** 海岸线等高线强度（§2.4）。 */
  coastline: 1.0,
  /** 软描边轮廓强度（§2.2.4）：暖白 rim。 */
  rimOutline: 1.0,
  /** normal.png 细节法线 blend 权重（§6.1.3）：0=纯几何法线，1=纯细节法线。 */
  detailNormal: 0.3,
} as const

/**
 * 水彩效果开关入参（M3 Task 11 由 config/quality 的分档值注入；全 number 可承接分档配置）。
 * 字段与 TERRAIN_EFFECTS 同键，均为 number（不用字面量类型，以便接收 qualityConfigs 分档值）。
 */
export type TerrainEffectOpts = {
  slopeEmphasis?: number
  watercolorNoise?: number
  coastline?: number
  rimOutline?: number
  detailNormal?: number
}

/** 地形配色（源自 palette + S 降 20%，SPEC §2.1「低饱和化统一处理」）。
 *  对应世界 Y 阈值见 fragment shader 注释（y = meters × 2.5 × 1e-5）。 */
const TERRAIN_COLORS = {
  oceanShallow: desaturateHex(palette.oceanShallow), // 海床占位（被 Ocean shader 覆盖，半透可见）
  oceanDeep: desaturateHex(palette.oceanDeep),
  beach: desaturateHex(palette.desert[0]), // 海岸/沙滩（desert 浅赭石）
  plain: desaturateHex(palette.grassland[0]), // 平原（grassland 鼠尾草绿）
  hill: desaturateHex(palette.mountain[1]), // 丘陵（mountain 浅）
  mountain: desaturateHex(palette.mountain[0]), // 山脉（mountain 深）
  snow: desaturateHex(palette.snow), // 雪线
  coast: desaturateHex(palette.border), // 海岸线描边（§2.4 暖白）
  rim: desaturateHex(palette.border), // 软描边轮廓（§2.2.4 暖白）
} as const

/**
 * shader 位移公式（与 CPU `heightToWorldY` 同源；导出供单测验证 R3 一致性）。
 * GLSL：`worldY = h * uHeightScale + uHeightOffset`。
 */
export function shaderWorldY(h: number, scale: number, offset: number): number {
  return h * scale + offset
}

// ===========================================================================
// shader 数学（纯函数，与 GLSL 同源，供单测验证）
// ===========================================================================

/** GLSL `smoothstep(e0, e1, x)` 的 TS 同源（Hermite 插值）。 */
function smoothstep(edge0: number, edge1: number, x: number): number {
  if (edge1 === edge0) return x < edge0 ? 0 : 1
  const t = Math.max(0, Math.min(1, (x - edge0) / (edge1 - edge0)))
  return t * t * (3 - 2 * t)
}

/**
 * 坡度强调权重（SPEC §2.2.3）：法线越接近水平（陡坡）→ 权重越接近 1（偏暖灰绿）。
 * GLSL：`slope = 1 - clamp(N.y, 0, 1); steep = smoothstep(0.30, 0.65, slope)`。
 */
export function shaderSlopeFactor(normalY: number): number {
  const slope = 1 - Math.max(0, Math.min(1, normalY))
  return smoothstep(0.3, 0.65, slope)
}

/**
 * 软描边轮廓权重（SPEC §2.2.4）：掠射角（N·V 小）→ 接近 1（亮暖白 rim）。
 * GLSL：`pow(1 - max(dot(N,V), 0), 2)`。
 */
export function shaderRimFactor(nDotV: number): number {
  return Math.pow(1 - Math.max(nDotV, 0), 2)
}

/**
 * 海岸线等高线权重（SPEC §2.4）：距海平面 y=0 越近 → 越接近 1（描边）。
 * GLSL：`1 - smoothstep(0, lineWidth, abs(y))`（lineWidth = fwidth(y)·k 抗锯齿）。
 */
export function shaderCoastlineFactor(worldY: number, lineWidth: number): number {
  if (lineWidth <= 0) return 0
  return 1 - smoothstep(0, lineWidth, Math.abs(worldY))
}

/**
 * normal.png 细节法线解码（SPEC §6.1.3）。
 *
 * 烘焙编码（`scripts/data-pipeline/lib/heightmap.mjs:computeNormals`，强度 strength=6）：
 *   纹理 R = worldX 法线分量，G = worldZ，B = worldY（均 `n·127.5+127.5` 落 [0,255]）。
 * 输入为纹理采样的原始 [0,1] 三通道；返回单位化世界法线 [X, Y, Z]。
 * GLSL：`vec3(n.rgb*2-1)` 后取 `(r, b, g)` → (worldX, worldY, worldZ)。
 */
export function shaderDetailNormalDecode(
  r: number,
  g: number,
  b: number,
): [number, number, number] {
  const nx = r * 2 - 1 // world X
  const nz = g * 2 - 1 // world Z
  const ny = b * 2 - 1 // world Y
  const len = Math.hypot(nx, ny, nz) || 1
  return [nx / len, ny / len, nz / len]
}

// ===========================================================================
// GLSL
// ===========================================================================

const TERRAIN_VERT = /* glsl */ `
  uniform sampler2D uHeightmap;
  uniform float uHeightScale;
  uniform float uHeightOffset;
  uniform float uPlaneWidth;
  uniform float uPlaneHeight;

  varying vec3 vWorldPos;
  varying float vWorldY;
  varying vec2 vHeightUv;   // heightmap/normal UV（与 project()/sampleHeight 同源）
  varying vec3 vViewDir;    // 顶点→相机方向（rim 用；cameraPosition 为 three vertex-only 内建）

  void main() {
    // 位移前世界坐标（PlaneGeometry 经 rotation[-90° X]：本地 (x,y,0) → 世界 (x,0,-y)）
    vec3 worldPos0 = (modelMatrix * vec4(position, 1.0)).xyz;
    // 世界平面坐标 → heightmap UV（与 project() / sampleHeight 同源）：
    //   lon = worldX / (PLANE_WIDTH/2) * 180   →  u = (lon+180)/360 = worldX / uPlaneWidth + 0.5
    //   lat = -worldZ / (PLANE_HEIGHT/2) * 90  →  v = (90-lat)/180  = 0.5 + worldZ / uPlaneHeight
    vec2 heightUv = vec2(worldPos0.x / uPlaneWidth + 0.5, 0.5 + worldPos0.z / uPlaneHeight);
    vHeightUv = heightUv;
    float h = texture2D(uHeightmap, heightUv).r;
    // Task 03 契约
    float dispY = h * uHeightScale + uHeightOffset;
    // 沿世界 +Y 位移 = 增加本地 z（旋转后世界 Y = 本地 z）
    vec3 transformed = position;
    transformed.z += dispY;
    vec3 worldPos = (modelMatrix * vec4(transformed, 1.0)).xyz;
    vWorldPos = worldPos;
    vWorldY = dispY;
    vViewDir = normalize(cameraPosition - worldPos);
    gl_Position = projectionMatrix * modelViewMatrix * vec4(transformed, 1.0);
  }
`

const TERRAIN_FRAG = /* glsl */ `
  precision highp float;

  uniform vec3 uLightDir;
  uniform vec3 uLightColor;
  uniform float uLightIntensity;
  uniform vec3 uSkyColor;
  uniform vec3 uGroundColor;
  uniform float uHemiIntensity;
  uniform vec3 uColorOceanShallow;
  uniform vec3 uColorOcean;
  uniform vec3 uColorBeach;
  uniform vec3 uColorPlain;
  uniform vec3 uColorHill;
  uniform vec3 uColorMtn;
  uniform vec3 uColorSnow;
  uniform vec3 uColorCoast;
  uniform vec3 uColorRim;
  uniform sampler2D uNormalMap;   // 烘焙法线贴图（细节增强，§6.1.3）
  // 复杂度开关（M3 改 value 不动 shader，SPEC §8 / D18）
  uniform float uSlopeEmphasis;
  uniform float uWatercolorNoise;
  uniform float uCoastline;
  uniform float uRimOutline;
  uniform float uDetailNormal;

  varying vec3 vWorldPos;
  varying float vWorldY;
  varying vec2 vHeightUv;
  varying vec3 vViewDir;

  // ---- 水彩噪声（hash fbm，无纹理依赖，§2.2.2）----
  float hash21(vec2 p) {
    p = fract(p * vec2(123.34, 345.45));
    p += dot(p, p + 34.345);
    return fract(p.x * p.y);
  }
  float valueNoise(vec2 p) {
    vec2 i = floor(p);
    vec2 f = fract(p);
    vec2 u = f * f * (3.0 - 2.0 * f); // smoothstep 插值
    float a = hash21(i);
    float b = hash21(i + vec2(1.0, 0.0));
    float c = hash21(i + vec2(0.0, 1.0));
    float d = hash21(i + vec2(1.0, 1.0));
    return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
  }
  float fbm(vec2 p) {
    float v = 0.0;
    float a = 0.5;
    for (int i = 0; i < 4; i++) {
      v += a * valueNoise(p);
      p *= 2.0;
      a *= 0.5;
    }
    return v;
  }

  // 基础高度分层上色（世界 Y 空间；米 ≈ y / (2.5e-5) = y × 40000）。
  // 海平面 y=0；沙滩~200m=0.005；平原~1500m=0.0375；丘陵~3000m=0.075；山脉~4500m=0.1125；雪~5500m=0.1375。
  vec3 layerColor(float y) {
    if (y < 0.0) {
      // 海平面下：海床占位（被 Ocean 半透覆盖，纵深深青绿随深度变暗）
      float depth = clamp(-y / 0.06, 0.0, 1.0);
      return mix(uColorOceanShallow, uColorOcean, depth);
    }
    float w = 0.0035; // 分层软过渡宽度（SPEC §2.2：带间软过渡，非硬边）
    vec3 c = uColorBeach;
    c = mix(c, uColorPlain, smoothstep(0.005  - w, 0.005  + w, y));
    c = mix(c, uColorHill,  smoothstep(0.0375 - w, 0.0375 + w, y));
    c = mix(c, uColorMtn,   smoothstep(0.075  - w, 0.075  + w, y));
    c = mix(c, uColorSnow,  smoothstep(0.1125 - w, 0.1125 + w, y));
    return c;
  }

  void main() {
    vec3 base = layerColor(vWorldY);
    float land = step(0.0, vWorldY); // 陆地掩码（水下不叠陆地水彩效果）

    // ---- 几何法线（片元导数）----
    vec3 geoN = normalize(cross(dFdx(vWorldPos), dFdy(vWorldPos)));
    if (geoN.y < 0.0) geoN = -geoN; // 确保 +Y 朝上

    // ---- normal.png 细节法线（§6.1.3）：R=worldX / G=worldZ / B=worldY ----
    vec3 nrgb = texture2D(uNormalMap, vHeightUv).rgb;
    vec3 detailN = normalize(vec3(nrgb.r * 2.0 - 1.0, nrgb.b * 2.0 - 1.0, nrgb.g * 2.0 - 1.0));
    if (detailN.y < 0.0) detailN = -detailN;
    vec3 N = normalize(mix(geoN, detailN, uDetailNormal));

    // ---- 坡度强调（§2.2.3）：陡坡偏暖灰绿（仅陆地）----
    float slope = 1.0 - clamp(N.y, 0.0, 1.0);
    float steep = smoothstep(0.30, 0.65, slope);
    base = mix(base, uColorMtn, steep * uSlopeEmphasis * land);

    // ---- 水彩噪声（§2.2.2）：fbm 调制明度形成颗粒（仅陆地，±10%）----
    float grain = fbm(vHeightUv * 24.0);
    base *= 1.0 + (grain - 0.5) * 0.20 * uWatercolorNoise * land;

    // ---- 海岸线 fwidth 等高线（§2.4）：y≈0 处描边，导数抗锯齿 ----
    float lineWidth = fwidth(vWorldY) * 2.0;
    float coast = 1.0 - smoothstep(0.0, lineWidth, abs(vWorldY));
    base = mix(base, uColorCoast, coast * uCoastline);

    // ---- 光照（半球环境光 + Lambert，无镜面，§2.2 Lambert-like / §2.3）----
    vec3 ambient = mix(uGroundColor, uSkyColor, N.y * 0.5 + 0.5) * uHemiIntensity;
    float diff = max(dot(N, normalize(uLightDir)), 0.0);
    vec3 diffuse = uLightColor * diff * uLightIntensity;
    vec3 linear = base * (ambient + diffuse);

    // ---- 软描边轮廓（§2.2.4）：1-dot(N,V) 暖白 rim，掠射角偏亮（仅陆地）----
    float rim = pow(1.0 - max(dot(N, normalize(vViewDir)), 0.0), 2.0);
    linear += uColorRim * rim * uRimOutline * land * 0.6;

    // raw ShaderMaterial 不自动 sRGB encode，手动 gamma（与 oceanMaterial 一致）
    gl_FragColor = vec4(pow(linear, vec3(1.0 / 2.2)), 1.0);
  }
`

// ===========================================================================
// 材质工厂
// ===========================================================================

/**
 * 由地形资产构建地形材质（SPEC §6.1：自定义 uniform 位移，无内置 displacementScale/Bias）。
 * THREE.Color 在 ColorManagement enabled（默认）下把 sRGB hex 转线性存，shader 按线性运算。
 *
 * @param opts 水彩效果开关（默认高档 TERRAIN_EFFECTS；M3 Task 11 经 store 注入分档值）。
 */
export function createTerrainMaterial(
  assets: TerrainAssets,
  opts?: TerrainEffectOpts,
): THREE.ShaderMaterial {
  const { scale, offset } = computeHeightUniforms(assets.meta)
  const effects = { ...TERRAIN_EFFECTS, ...opts }
  const lightDir = terrainLight.directional.direction
  return new THREE.ShaderMaterial({
    uniforms: {
      uHeightmap: { value: assets.heightTexture },
      uHeightScale: { value: scale },
      uHeightOffset: { value: offset },
      uPlaneWidth: { value: PLANE_WIDTH },
      uPlaneHeight: { value: PLANE_HEIGHT },
      uLightDir: { value: lightDir.clone() },
      uLightColor: { value: new THREE.Color(terrainLight.directional.color) },
      uLightIntensity: { value: terrainLight.directional.intensity },
      uSkyColor: { value: new THREE.Color(terrainLight.hemisphere.sky) },
      uGroundColor: { value: new THREE.Color(terrainLight.hemisphere.ground) },
      uHemiIntensity: { value: terrainLight.hemisphere.intensity },
      uColorOceanShallow: { value: new THREE.Color(TERRAIN_COLORS.oceanShallow) },
      uColorOcean: { value: new THREE.Color(TERRAIN_COLORS.oceanDeep) },
      uColorBeach: { value: new THREE.Color(TERRAIN_COLORS.beach) },
      uColorPlain: { value: new THREE.Color(TERRAIN_COLORS.plain) },
      uColorHill: { value: new THREE.Color(TERRAIN_COLORS.hill) },
      uColorMtn: { value: new THREE.Color(TERRAIN_COLORS.mountain) },
      uColorSnow: { value: new THREE.Color(TERRAIN_COLORS.snow) },
      uColorCoast: { value: new THREE.Color(TERRAIN_COLORS.coast) },
      uColorRim: { value: new THREE.Color(TERRAIN_COLORS.rim) },
      uNormalMap: { value: assets.normalTexture },
      uSlopeEmphasis: { value: effects.slopeEmphasis },
      uWatercolorNoise: { value: effects.watercolorNoise },
      uCoastline: { value: effects.coastline },
      uRimOutline: { value: effects.rimOutline },
      uDetailNormal: { value: effects.detailNormal },
    },
    vertexShader: TERRAIN_VERT,
    fragmentShader: TERRAIN_FRAG,
  })
}
