/**
 * GPU 地形位移 + 分层设色着色器源码（TASK-006）。
 *
 * 角色与依赖方向：
 * - 本模块属于渲染层（src/three），只导出两段 GLSL 字符串（顶点 / 片元），供 ChinaTerrainMesh 装配
 *   shaderMaterial。本模块不依赖 React / R3F，只被 ChinaTerrainMesh.tsx 单向消费；不自行读取任何
 *   GeoJSON、不维护 hover、不加载外网。所有数据（heightmap 纹理、色阶 ramp 纹理、min/max、夸张系数、
 *   网格尺寸、照明参数）都以 uniform 形式由组件注入。
 *
 * GPU 顶点位移（SPEC §7.1 核心策略）：
 * - PlaneGeometry 的顶点位置是平面（local z=0），UV 覆盖 [0,1]²。vertex shader 按顶点 UV 采样
 *   heightmap 纹理得到「归一化高程码」（FloatType 存储，保留 16 位精度，见 load-heightmap-texture.ts），
 *   再按与 src/geo-contracts decodeUint16ToElevation 同一的仿射解码成真实米制 h，令
 *   displaced.z += h · k · uRise。经模型矩阵（含绕 X 轴 −90° 旋转）变换后，local z 映射到世界 y，
 *   即世界 y = h · k（SPEC §3.2）。位移完全在 GPU 完成——绝不在 CPU 为 2048²/4096² 逐顶点写位置。
 *
 * 纹理精度与 UV 对齐（SPEC §5.1、§7.1）：
 * - heightmap 纹理以 RedFormat + FloatType 存储归一化码（code/65535）。FloatType 23 位尾数远超 16 位，
 *   故端到端无 8 位降级；硬件 LinearFilter 双线性采样归一化值，再在 shader 内仿射解码——由于
 *   decode 是仿射，双线性(decode) == decode(双线性)，与 CPU 高程查询层（src/lib/elevation）的
 *   「先解码四角再双线性米值」在浮点精度内一致。
 * - UV 对齐：heightmap 行 0=北、列 0=西、u 随东增、v 随南增（见 src/lib/elevation.ts）；PlaneGeometry
 *   经 −90° X 旋转后，其 uv.y=1 落到世界北（−Z），与 heightmap v=0（北）相反，故采样时翻转 v：
 *   heightmapUV = vec2(uv.x, 1.0 − uv.y)。u 方向一致（uv.x=0 西 → heightmap u=0 西），不翻转。
 *   顶点着色器把这份翻转后的 heightmapUV 经 varying 透传给片元，使片元「按像素重新采样真实高程」
 *   与顶点位移用同一份 UV（方位一致）。
 *
 * 法线（使起伏在斜俯视下可观察）：
 * - 平面几何的法线原本恒为 local +z（世界 +y），无法体现位移后的山体明暗。vertex shader 内对
 *   heightmap 做有限差分（采样 ±1 texel），结合 plane 的 local 像素间距构造两条切线，叉乘得位移后
 *   法线，经 mat3(modelMatrix) 变到世界空间。法线只用于方向光明暗（Lambert 漫反射），**不**用于
 *   决定颜色本身——颜色由真实高程查 ramp 决定，法线只调制其明暗，体现地势方向感（SPEC §3.1
 *   「叠加方向光产生的法线明暗」）。
 *
 * 分层设色（SPEC §3.1）：
 * - **必须用真实海拔 h 查色，不要用位移后的 world-y**：world-y = h·k 已被垂直夸张系数 k 放大，
 *   用它查色会让整图颜色偏移 k 倍（SPEC §3.1、§7.1）。片元着色器按像素 UV 重新采样 heightmap 得
 *   真实 h（不使用顶点透传的离散高程，使 2048² 网格也能呈现 4096² 纹理级的色阶细节），再按
 *   u = (h − minH)/(maxH − minH) 归一化（minH/maxH 取自经契约校验的元数据，由
 *   resolveElevationColorConfig 保证与 SPEC §5.1 色阶域一致），采样 256×1 ramp 纹理得到基线色。
 *   ramp 纹理与 CPU 侧色阶事实源（src/config/elevation-color-ramp）共用同一控制点表 + 分段线性
 *   插值策略，断点 / 基线色 / ramp 描述不在着色器内复制。
 *
 * 深色地势照明（SPEC §3.1「叠加方向光产生的法线明暗」、§3.4）：
 * - 法线明暗的光向 / 光色 / 光强 / 半球环境光全部来自地形明暗照明配置
 *   （src/config/terrain-shading 的 TERRAIN_SHADING_CONFIG），由 ChinaTerrainMesh 注入 uniform——
 *   本片元不硬编码光向。地形不投递阴影贴图（SPEC §3.4「4096² 级阴影图成本过高」）：地势方向感由
 *   「方向光 Lambert 漫反射 + 半球环境光」体现，背光面保留环境补光可辨认（不致死黑）。
 * - 场景级氛围（背景、场景灯、可选轻雾）由 TASK-008 装配；本片元当前不含雾计算，雾若启用由
 *   TASK-008 以同一 FogExp2 公式补充。
 */

/**
 * 顶点着色器：按顶点 UV 采样 heightmap → 解码真实米制 → 位移 local z → 有限差分法线 → 透传 heightmap UV。
 *
 * uniform 语义（由 ChinaTerrainMesh 注入，全部来自受控路径，不在此硬编码领域常量）：
 * - uHeightmap：归一化高程码纹理（RedFormat/FloatType，LinearFilter）。
 * - uHeightmapSize：纹理像素尺寸（vec2，用于有限差分的 1-texel 步长）。
 * - uMinElevationMeters / uMaxElevationMeters：解码区间（来自经契约校验的 heightmap 元数据；
 *   由 resolveElevationColorConfig 复核与 SPEC §5.1 色阶域一致）。
 * - uExaggeration：垂直夸张系数 k（来自 resolveTerrainConfig，合法范围 [1.5, 3.0]）。
 * - uRise：入场升起进度 [0,1]（默认 1.0，TASK-013 入场编排驱动它做 0→1 插值；0 时地形为平面）。
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
varying vec2 vHeightmapUV;

// 把归一化高程码（code/65535）仿射解码为真实米制海拔。
// 与 src/geo-contracts decodeUint16ToElevation 同一公式：h = normalized·(max−min) + min。
float decodeElevationMeters(float normalized) {
  return normalized * (uMaxElevationMeters - uMinElevationMeters) + uMinElevationMeters;
}

// 按 heightmap UV 采样归一化高程码。v 翻转以对齐 PlaneGeometry 旋转后的南北方位（见文件头）。
vec2 heightmapUVFromPlane(vec2 planeUV) {
  return vec2(planeUV.x, 1.0 - planeUV.y);
}

float sampleNormalizedCode(vec2 planeUV) {
  return texture2D(uHeightmap, heightmapUVFromPlane(planeUV)).r;
}

void main() {
  // 真实米制海拔 h（顶点 UV → heightmap 采样 → 仿射解码）。
  float normalizedCenter = sampleNormalizedCode(uv);
  float hCenter = decodeElevationMeters(normalizedCenter);

  // 位移 local z（plane 法线方向），经模型矩阵旋转后成为世界 y：世界 y = h · k · uRise（SPEC §3.2）。
  // uRise=1 时即真实夸张后的高程；uRise<1 用于入场「升起」动画（TASK-013 驱动 0→1 插值）。
  vec3 displaced = position;
  displaced.z += hCenter * uExaggeration * uRise;

  // 有限差分法线：在 plane 的 local x / local y 方向各采样一次邻接高程，结合 plane 的米制水平
  // 跨度构造切线，叉乘得到位移后法线（local 空间），再经 mat3(modelMatrix) 变到世界空间。
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

  // 把翻转后的 heightmap UV 透传给片元：片元按像素重新采样真实高程做分层设色，
  // 必须与顶点位移用同一方位的 UV，否则色阶与起伏会错位。
  vHeightmapUV = heightmapUVFromPlane(uv);

  // 注意：**不**把 world-y 透传给片元查色——world-y 已含 k，用它查色会偏移 k 倍；
  // 片元自行重采样 heightmap 取真实 h（SPEC §3.1）。
  vec4 worldPosition = modelMatrix * vec4(displaced, 1.0);
  gl_Position = projectionMatrix * viewMatrix * worldPosition;
}
`

/**
 * 片元着色器：真实海拔分层设色 + 方向光法线明暗（Lambert 漫反射 + 半球环境光）（TASK-006）。
 *
 * 颜色完全由「真实米制海拔 h」决定，与垂直夸张系数 k 无关——片元按像素 UV 重新采样 heightmap 得 h，
 * 按 u = (h − minH)/(maxH − minH) 归一化（minH/maxH 来自经校验的元数据，与 SPEC §5.1 色阶域一致），
 * 采样 256×1 ramp 纹理得基线色。ramp 由 src/config/elevation-color-ramp 唯一事实源派生（控制点 +
 * 分段线性插值），着色器内不复制断点 / 颜色。法线只调制基线色的明暗（Lambert 漫反射 + 半球环境光），
 * 体现地势方向感；地形本身不投递阴影贴图（SPEC §3.4）。颜色不映射任何业务数据（纯地理语义）。
 *
 * 照明参数全部来自地形明暗照明配置（TERRAIN_SHADING_CONFIG），由 ChinaTerrainMesh 注入 uniform——
 * 本片元不硬编码光向 / 光色。地形是自定义 ShaderMaterial，不自动消费 three.js 场景灯，故照明参数
 * 需经 uniform 显式注入。
 *
 * uniform 语义：
 * - uHeightmap：归一化高程码纹理（与顶点位移共用同一份，片元按像素重采样得真实 h）。
 * - uElevationRamp：256×1 色阶 ramp 纹理（RGBA / UnsignedByteType，来自 elevation-color-ramp，
 *   GPU 上传格式适配见 elevation-ramp-texture.ts）。
 * - uMinElevationMeters / uMaxElevationMeters：色阶归一化上下限（来自元数据，与色阶域一致）。
 * - uMainLightDirection：主光方向（surface-to-light，世界坐标，单位向量；西北偏高 → x<0、y>0、z<0）。
 *   来自 TERRAIN_SHADING_CONFIG.mainLight.direction。
 * - uMainLightColor：主光颜色（[0,1]³，sRGB 字节 / 255，与 ramp 同一颜色空间约定）。
 * - uMainLightIntensity：主光强度（地势明暗的主要来源）。
 * - uHemisphereSkyColor / uHemisphereGroundColor：半球环境光天 / 地色（[0,1]³）。
 * - uHemisphereIntensity：半球环境光强度（低强度，保证背光面不死黑又不冲淡色阶）。
 */
export const TERRAIN_FRAGMENT_SHADER = /* glsl */ `
uniform sampler2D uHeightmap;
uniform sampler2D uElevationRamp;
uniform float uMinElevationMeters;
uniform float uMaxElevationMeters;
uniform vec3 uMainLightDirection;
uniform vec3 uMainLightColor;
uniform float uMainLightIntensity;
uniform vec3 uHemisphereSkyColor;
uniform vec3 uHemisphereGroundColor;
uniform float uHemisphereIntensity;

varying vec3 vWorldNormal;
varying vec2 vHeightmapUV;

// 把归一化高程码仿射解码为真实米制海拔（与顶点着色器同一公式，与 decodeUint16ToElevation 同源）。
float decodeElevationMeters(float normalized) {
  return normalized * (uMaxElevationMeters - uMinElevationMeters) + uMinElevationMeters;
}

void main() {
  // 真实海拔查色（SPEC §3.1）：按像素 UV 重新采样 heightmap 得真实 h——不使用 world-y（含 k，
  // 会偏色）、不使用顶点透传的离散高程（2048² 网格上会丢失 4096² 纹理级色阶细节）。
  float normalizedCode = texture2D(uHeightmap, vHeightmapUV).r;
  float elevationMeters = decodeElevationMeters(normalizedCode);

  // 用元数据真实上下限归一化到 ramp 纹理坐标（不是 world-y、不是网格包围盒、不是视觉调参值）。
  // minH/maxH 经 resolveElevationColorConfig 保证等于 SPEC §5.1 色阶域，使断点颜色落在正确纹素。
  float rampU = clamp(
    (elevationMeters - uMinElevationMeters) / (uMaxElevationMeters - uMinElevationMeters),
    0.0,
    1.0
  );
  vec3 baseColor = texture2D(uElevationRamp, vec2(rampU, 0.5)).rgb;

  // 主光 Lambert 漫反射（SPEC §3.4「西北偏高方位单盏主光」）：光向 / 光色 / 光强全部来自照明配置
  // uniform。地形不投递阴影贴图——明暗完全由 dot(N, L) 决定。
  vec3 N = normalize(vWorldNormal);
  float diffuse = clamp(dot(N, normalize(uMainLightDirection)), 0.0, 1.0);
  vec3 mainContribution = uMainLightColor * (uMainLightIntensity * diffuse);

  // 半球环境光（SPEC §3.4「低强度半球光，天 / 地双色，保证背光面不死黑」）：按法线 +Y 在天 / 地色间
  // 插值——朝上表面（+Y）偏天色、朝下表面偏地色。强度 < 1（低强度），不冲淡分层设色。背光面
  // （diffuse=0）仍有环境补光，可辨认不死黑。
  float skyWeight = N.y * 0.5 + 0.5;
  vec3 ambient = mix(uHemisphereGroundColor, uHemisphereSkyColor, skyWeight) * uHemisphereIntensity;

  // 颜色由真实海拔决定（baseColor），明暗由法线 ×照明决定（ambient + main）；二者解耦。
  vec3 color = baseColor * (ambient + mainContribution);

  gl_FragColor = vec4(color, 1.0);
}
`
