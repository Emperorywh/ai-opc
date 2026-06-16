/**
 * 地形材质 —— GPU 顶点位移 + 基础高度分层着色（SPEC §6.1 / §2.2 / §2.3，Task 04）。
 *
 * 顶点着色器：采样 R32F heightmap，按 Task 03 锁定的高度解码契约
 *   `worldY = h * uHeightScale + uHeightOffset`（= computeHeightUniforms(meta)）
 *   沿世界 +Y 位移顶点（×2.5 夸张已烘焙进 scale）。
 * 片元着色器：基础高度分区分层上色（海岸→平原→丘陵→山脉→雪线，smoothstep 软过渡）
 *   + 自包含 Lambert 光照（方向光 + 半球光，无 shadow / 无镜面，SPEC §2.2 Lambert-like）。
 *
 * ⚠️ M1 范围切割：水彩噪声叠加 / 坡度强调 / 软描边轮廓 / 海岸线 fwidth 等高线
 *    留 M2 Task 08；normal.png 细节增强留 Task 05/08（M1 用片元导数几何法线）。
 */
import * as THREE from 'three'
import { PLANE_WIDTH, PLANE_HEIGHT, computeHeightUniforms } from '../../config/projection'
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
 * 基础高度分层配色（SPEC §2.1，取自 palette；雪线色 SPEC 未给，用近白）。
 * 对应世界 Y 阈值见 fragment shader 注释（y = meters × 2.5 × 1e-5）。
 */
const LAYER_COLORS = {
  oceanShallow: '#5BA8A4', // 海床占位（M1 无海洋 mesh，M2 Ocean shader 覆盖）
  oceanDeep: '#2E6E73',
  beach: '#D9C39B', // 海岸/沙滩（desert 浅赭石）
  plain: '#8FA98A', // 平原（grassland 鼠尾草绿）
  hill: '#9AA892', // 丘陵（mountain 浅）
  mountain: '#7E8B76', // 山脉（mountain 深）
  snow: '#E8EAEC', // 雪线
} as const

/**
 * shader 位移公式（与 CPU `heightToWorldY` 同源；导出供单测验证 R3 一致性）。
 * GLSL：`worldY = h * uHeightScale + uHeightOffset`。
 */
export function shaderWorldY(h: number, scale: number, offset: number): number {
  return h * scale + offset
}

// ---------------------------------------------------------------------------
// GLSL
// ---------------------------------------------------------------------------

const TERRAIN_VERT = /* glsl */ `
  uniform sampler2D uHeightmap;
  uniform float uHeightScale;
  uniform float uHeightOffset;
  uniform float uPlaneWidth;
  uniform float uPlaneHeight;

  varying vec3 vWorldPos;
  varying float vWorldY;

  void main() {
    // 位移前世界坐标（PlaneGeometry 经 rotation[-90° X]：本地 (x,y,0) → 世界 (x,0,-y)）
    vec3 worldPos0 = (modelMatrix * vec4(position, 1.0)).xyz;
    // 世界平面坐标 → heightmap UV（与 project() / sampleHeight 同源）：
    //   lon = worldX / (PLANE_WIDTH/2) * 180   →  u = (lon+180)/360 = worldX / uPlaneWidth + 0.5
    //   lat = -worldZ / (PLANE_HEIGHT/2) * 90  →  v = (90-lat)/180  = 0.5 + worldZ / uPlaneHeight
    vec2 heightUv = vec2(worldPos0.x / uPlaneWidth + 0.5, 0.5 + worldPos0.z / uPlaneHeight);
    float h = texture2D(uHeightmap, heightUv).r;
    // Task 03 契约
    float dispY = h * uHeightScale + uHeightOffset;
    // 沿世界 +Y 位移 = 增加本地 z（旋转后世界 Y = 本地 z）
    vec3 transformed = position;
    transformed.z += dispY;
    vWorldPos = (modelMatrix * vec4(transformed, 1.0)).xyz;
    vWorldY = dispY;
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

  varying vec3 vWorldPos;
  varying float vWorldY;

  // 基础高度分层上色（世界 Y 空间；米 ≈ y / (2.5e-5) = y × 40000）。
  // 海平面 y=0；沙滩~200m=0.005；平原~1500m=0.0375；丘陵~3000m=0.075；山脉~4500m=0.1125；雪~5500m=0.1375。
  vec3 layerColor(float y) {
    if (y < 0.0) {
      // 海平面下：M1 占位水面（深青绿随深度变暗），M2 Ocean shader 覆盖
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
    // 几何法线（片元导数；normal.png 细节增强留 Task 05/08）
    vec3 N = normalize(cross(dFdx(vWorldPos), dFdy(vWorldPos)));
    if (N.y < 0.0) N = -N; // 确保 +Y 朝上
    // 半球环境光（按法线朝向在天/地间插值，SPEC §2.3 环境光主导）
    vec3 ambient = mix(uGroundColor, uSkyColor, N.y * 0.5 + 0.5) * uHemiIntensity;
    // 方向光 Lambert（无镜面，SPEC §2.2 Lambert-like 漫反射）
    float diff = max(dot(N, normalize(uLightDir)), 0.0);
    vec3 diffuse = uLightColor * diff * uLightIntensity;
    vec3 linear = base * (ambient + diffuse);
    // raw ShaderMaterial 不自动 sRGB encode，手动 gamma 近似（Task 05/08 可精调）
    gl_FragColor = vec4(pow(linear, vec3(1.0 / 2.2)), 1.0);
  }
`

// ---------------------------------------------------------------------------
// 材质工厂
// ---------------------------------------------------------------------------

/**
 * 由地形资产构建地形材质（SPEC §6.1：自定义 uniform 位移，无内置 displacementScale/Bias）。
 * THREE.Color 在 ColorManagement enabled（默认）下把 sRGB hex 转线性存，shader 按线性运算。
 */
export function createTerrainMaterial(assets: TerrainAssets): THREE.ShaderMaterial {
  const { scale, offset } = computeHeightUniforms(assets.meta)
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
      uColorOceanShallow: { value: new THREE.Color(LAYER_COLORS.oceanShallow) },
      uColorOcean: { value: new THREE.Color(LAYER_COLORS.oceanDeep) },
      uColorBeach: { value: new THREE.Color(LAYER_COLORS.beach) },
      uColorPlain: { value: new THREE.Color(LAYER_COLORS.plain) },
      uColorHill: { value: new THREE.Color(LAYER_COLORS.hill) },
      uColorMtn: { value: new THREE.Color(LAYER_COLORS.mountain) },
      uColorSnow: { value: new THREE.Color(LAYER_COLORS.snow) },
    },
    vertexShader: TERRAIN_VERT,
    fragmentShader: TERRAIN_FRAG,
  })
}
