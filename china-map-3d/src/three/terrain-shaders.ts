/**
 * GPU 地形位移着色器源码（TASK-009）。
 *
 * 角色与依赖方向：
 * - 本模块属于渲染层（src/three），只导出两段 GLSL 字符串（顶点 / 片元），供 ChinaTerrainMesh 装配
 *   shaderMaterial。本模块不依赖 React / R3F，只被 ChinaTerrainMesh.tsx 单向消费；不自行读取任何
 *   GeoJSON、不维护 hover、不加载外网（TASK-009 实现约束「渲染层不得自行读取 GeoJSON / 维护 hover /
 *   加载外网」）。所有数据（heightmap 纹理、min/max、夸张系数、网格尺寸）都以 uniform 形式由组件注入。
 *
 * GPU 顶点位移（SPEC §7.1 核心策略）：
 * - PlaneGeometry 的顶点位置是平面（local z=0），UV 覆盖 [0,1]²。vertex shader 按顶点 UV 采样
 *   heightmap 纹理得到「归一化高程码」（FloatType 存储，保留 16 位精度，见 load-heightmap-texture.ts），
 *   再按与 src/geo-contracts decodeUint16ToElevation 同一的仿射解码成真实米制 h，令
 *   displaced.z += h · k · uRise。经模型矩阵（含绕 X 轴 −90° 旋转）变换后，local z 映射到世界 y，
 *   即世界 y = h · k（SPEC §3.2）。位移完全在 GPU 完成——绝不在 CPU 为 2048²/4096² 逐顶点写位置。
 *
 * 纹理精度与 UV 对齐（SPEC §5.1、§7.1；TASK-009 实现约束「16 位端到端」）：
 * - heightmap 纹理以 RedFormat + FloatType 存储归一化码（code/65535）。FloatType 23 位尾数远超 16 位，
 *   故端到端无 8 位降级；硬件 LinearFilter 双线性采样归一化值，再在 shader 内仿射解码——由于
 *   decode 是仿射，双线性(decode) == decode(双线性)，与 CPU 高程查询层（src/lib/elevation）的
 *   「先解码四角再双线性米值」在浮点精度内一致（TASK-008 输出约束、docs/elevation.md §3）。
 * - UV 对齐：heightmap 行 0=北、列 0=西、u 随东增、v 随南增（见 elevation.ts）；PlaneGeometry 经
 *   −90° X 旋转后，其 uv.y=1 落到世界北（−Z），与 heightmap v=0（北）相反，故采样时翻转 v：
 *   heightmapUV = vec2(uv.x, 1.0 − uv.y)。u 方向一致（uv.x=0 西 → heightmap u=0 西），不翻转。
 *   详见 ChinaTerrainMesh.tsx 的方位对齐说明与 docs/projection.md。
 *
 * 法线（使起伏在斜俯视下可观察）：
 * - 平面几何的法线原本恒为 local +z（世界 +y），无法体现位移后的山体明暗。vertex shader 内对
 *   heightmap 做有限差分（采样 ±1 texel），结合 plane 的 local 像素间距构造两条切线，叉乘得位移后
 *   法线。这是「使真实起伏可观察」的最小着色，**不**是分层设色（颜色按高程映射，后续 TASK）也
 *   **不**是氛围（背景/雾/多光源，后续 TASK）；片元着色器只用一个固定方向光做 Lambert + 极淡的
 *   坡度倾向色，确保位移几何可读即可。后续 TASK 接管片元时只需替换片元着色器的颜色项。
 */

/**
 * 顶点着色器：按顶点 UV 采样 heightmap → 解码真实米制 → 位移 local z → 有限差分法线。
 *
 * uniform 语义（由 ChinaTerrainMesh 注入，全部来自受控路径，不在此硬编码领域常量）：
 * - uHeightmap：归一化高程码纹理（RedFormat/FloatType，LinearFilter）。
 * - uHeightmapSize：纹理像素尺寸（vec2，用于有限差分的 1-texel 步长）。
 * - uMinElevationMeters / uMaxElevationMeters：解码区间（来自经契约校验的 heightmap 元数据）。
 * - uExaggeration：垂直夸张系数 k（来自 resolveTerrainConfig，合法范围 [1.5, 3.0]）。
 * - uRise：入场升起进度 [0,1]（本 TASK 默认 1.0，保留给后续入场 TASK 驱动；0 时地形为平面）。
 * - uPlaneWorldWidth / uPlaneWorldHeight：plane 在世界 x / z 方向的米制跨度（用于法线切线的水平尺度，
 *   使法线方向反映真实坡度而非 uv 步长）。
 */
export const TERRAIN_VERTEX_SHADER = /* glsl */ `
uniform sampler2D uHeightmap;
uniform vec2 uHeightmapSize;
uniform float uMinElevationMeters;
uniform float uMaxElevationMeters;
uniform float uExaggeration;
uniform float uRise;
uniform float uPlaneWorldWidth;
uniform float uPlaneWorldHeight;

varying vec3 vWorldNormal;
varying float vElevationMeters;
varying vec3 vWorldPosition;

// 把归一化高程码（code/65535）仿射解码为真实米制海拔。
// 与 src/geo-contracts decodeUint16ToElevation 同一公式：h = normalized·(max−min) + min。
float decodeElevationMeters(float normalized) {
  return normalized * (uMaxElevationMeters - uMinElevationMeters) + uMinElevationMeters;
}

// 按 heightmap UV 采样归一化高程码。v 翻转以对齐 PlaneGeometry 旋转后的南北方位（见文件头）。
float sampleNormalizedCode(vec2 planeUV) {
  vec2 heightmapUV = vec2(planeUV.x, 1.0 - planeUV.y);
  return texture2D(uHeightmap, heightmapUV).r;
}

void main() {
  // 真实米制海拔 h（顶点 UV → heightmap 采样 → 仿射解码）。
  float normalizedCenter = sampleNormalizedCode(uv);
  float hCenter = decodeElevationMeters(normalizedCenter);

  // 位移 local z（plane 法线方向），经模型矩阵旋转后成为世界 y：世界 y = h · k · uRise（SPEC §3.2）。
  // uRise=1 时即真实夸张后的高程；uRise<1 用于入场「升起」动画（本 TASK 取 1.0）。
  vec3 displaced = position;
  displaced.z += hCenter * uExaggeration * uRise;

  // 有限差分法线：在 plane 的 local x / local y 方向各采样一次邻接高程，结合 plane 的米制水平
  // 跨度构造切线，叉乘得到位移后法线（local 空间），再经 normalMatrix 变到世界空间。
  // texel 步长取 1/uHeightmapSize，使邻接采样落在相邻 heightmap 像元上（与纹理分辨率对齐）。
  vec2 texelStep = vec2(1.0) / uHeightmapSize;
  float hPlusU = decodeElevationMeters(sampleNormalizedCode(uv + vec2(texelStep.x, 0.0)));
  float hPlusV = decodeElevationMeters(sampleNormalizedCode(uv + vec2(0.0, texelStep.y)));

  // plane 在 uv 空间跨度为 [0,1]，对应世界 uPlaneWorldWidth / uPlaneWorldHeight 米；
  // 在 uv 方向走 1 个 texelStep 对应的水平米距 = texelStep · 跨度。高程差已含 ·k·uRise。
  float dxMeters = texelStep.x * uPlaneWorldWidth;
  float dyMeters = texelStep.y * uPlaneWorldHeight;
  float dhU = (hPlusU - hCenter) * uExaggeration * uRise;
  float dhV = (hPlusV - hCenter) * uExaggeration * uRise;

  // local 切线（local x / local y / local z），叉乘得 local 法线（+z 朝上）。
  vec3 tangentX = vec3(dxMeters, 0.0, dhU);
  vec3 tangentY = vec3(0.0, dyMeters, dhV);
  vec3 localNormal = normalize(cross(tangentX, tangentY));

  // 变换到世界空间。mesh 仅含旋转（绕 X 轴 −90°，无非一致缩放），故用 mat3(modelMatrix) 把 local
  // 法线旋转到世界空间——**不**用 three.js 内建 normalMatrix（那是 view 空间，会与下方世界空间光向
  // 做跨空间点乘，导致随相机的错误明暗）。mat3(modelMatrix) 对纯旋转的刚体法线是精确的。
  vWorldNormal = normalize(mat3(modelMatrix) * localNormal);

  // 世界位置（含 mesh 定位偏移与位移）；同时把真实海拔（不含 k）透传给片元，供后续分层设色按真实 h 取色。
  vec4 worldPosition = modelMatrix * vec4(displaced, 1.0);
  vWorldPosition = worldPosition.xyz;
  vElevationMeters = hCenter;

  gl_Position = projectionMatrix * viewMatrix * worldPosition;
}
`

/**
 * 片元着色器：最小中性着色，仅使位移几何在斜俯视下可读。
 *
 * 本 TASK 只要求「可观察的真实起伏」；完整的分层设色（高程→颜色映射，SPEC §3.1）与氛围
 * （背景/雾/多光源，SPEC §3.4）由后续 TASK 接管，本处不预埋重复实现——仅用一个固定方向光做
 * Lambert 漫反射、辅以极淡的坡度倾向色（高坡偏冷、低地偏暖），让青藏高原的隆起与盆地的凹陷
 * 在相机视角下产生明暗可辨的立体感。颜色不映射任何业务数据（TASK-009 实现约束）。
 */
export const TERRAIN_FRAGMENT_SHADER = /* glsl */ `
varying vec3 vWorldNormal;
varying float vElevationMeters;
varying vec3 vWorldPosition;

void main() {
  // 固定方向光（西北偏高方位，强调青藏—东海地势梯度，SPEC §3.4）。世界空间方向，与场景光源解耦——
  // 氛围 TASK 会引入真正的场景光源，届时由片元重新接管；本处仅作最小可读着色。
  vec3 lightDir = normalize(vec3(-0.5, 0.8, -0.4));
  float diffuse = clamp(dot(normalize(vWorldNormal), lightDir), 0.0, 1.0);

  // 极淡的坡度倾向色：低地暖灰、高地冷灰。**不**按高程做精确分层设色（后续 TASK 交付），
  // 仅以海拔归一化在两端的灰阶间插值，避免位移几何在纯平涂下立体感不足。
  float elevationT = clamp((vElevationMeters - 0.0) / 6000.0, 0.0, 1.0);
  vec3 lowColor = vec3(0.22, 0.26, 0.20);
  vec3 highColor = vec3(0.62, 0.66, 0.70);
  vec3 baseColor = mix(lowColor, highColor, elevationT);

  // 环境光 + 漫反射，保留背光面细节（不致死黑），使起伏明暗可辨。
  vec3 color = baseColor * (0.35 + 0.65 * diffuse);

  gl_FragColor = vec4(color, 1.0);
}
`
