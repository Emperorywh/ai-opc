/**
 * 动态海面着色器源码（TASK-007，SPEC §3.5）。
 *
 * 角色与依赖方向：
 * - 本模块属于渲染层（src/three），只导出两段 GLSL 字符串（顶点 / 片元），供 SeaSurface 组件装配
 *   shaderMaterial。本模块不依赖 React / R3F / three.js，只被 SeaSurface.tsx 单向消费；不自行读取
 *   GeoJSON / heightmap / hover / 加载状态。所有数据（时间、基线色、透明度、波动参数）都以 uniform
 *   形式由组件注入。
 *
 * 海平面 = y=0（同一米制，不得用视觉偏移掩盖坐标不一致）：
 * - 顶点着色器不位移：plane 经组件绕 X 轴 −90° 旋转 + position.y=0 后，所有顶点世界 y 恒为 0
 *   （= SEA_LEVEL_Y_METERS）。这是「海面落在地形海平面」的着色器侧保证——不靠任何视觉偏移，
 *   顶点位置原样经 modelMatrix 变换到世界（平面 → y=0）。
 *
 * 统一时钟（SPEC §7.4「动画时钟：用统一的 THREE.Clock / R3F useFrame，水面/入场共用，避免多时钟
 * 漂移」）：
 * - 片元着色器只声明**一个** uniform float uTime，由 SeaSurface 组件用 R3F 共享 clock 的
 *   getElapsedTime() 每帧赋值（不 new THREE.Clock()）。两层流动波动的时间项都是 uTime·speed——
 *   speed 只控制两层相对快慢，不引入第二个时间源。这是「单一时间输入」的结构性保证。
 *
 * 无运行时纹理下载（波动全部由 shader 计算完成）：
 * - 片元着色器**不**声明任何 sampler2D（不采样法线贴图 / 高程纹理 / 噪声纹理）。微波由两层正弦
 *   纯算法叠加产生（SPEC §3.5「双层流动 noise / gerstner 概念简化」），零外部纹理、零运行时下载。
 *
 * 时间驱动的法线扰动微波（SPEC §3.5）：
 * - 每层正弦的空间导数即海面微法线倾斜；两层不同频率 / 方向 / 相位叠加成的扰动量对基线色做
 *   (1 + 扰动) 亮度调制，是该法线扰动的简化呈色（gerstner 概念简化）——视觉上即流动的微波涟漪。
 *   幅度 < 0.1（来自配置），「细微、不喧宾夺主」。
 *
 * 半透明混合（SPEC §3.5「半透明（opacity ≈ 0.55–0.7）」）：
 * - 片元输出 alpha = uOpacity（基线 0.6，来自配置）。配合组件 transparent=true + depthWrite=false：
 *   海面在透明通道绘制、不写深度，使水下地形（不透明、已写深度）透过海面可见；陆地 world-y>0 在
 *   海面之上，深度测试使海面片元在陆地区域被丢弃——海面只覆盖海域、不遮陆地。
 *
 * 大陆架透视不由海面着色（SPEC §3.5「海面不参与分层设色」）：
 * - 海面片元颜色恒为深蓝青基线色 uColor ×(1 + 双层扰动)；**不**读取 heightmap、**不**查色阶。
 *   透视看到的「近岸浅、远海深」梯度来自水下地形按高程色阶着色（深海近黑→近岸偏亮，见
 *   src/config/elevation-color-ramp）透过半透明海面，海面只是其上的恒定基线色 + 细微涟漪。
 *
 * 极轻微指数雾（SPEC §3.4，TASK-008 装配）：
 * - 海面是自定义 ShaderMaterial，three.js 的 scene.fog 不会自动作用于本片元，故与地形片元同一做法：
 *   在片元内手动复算 FogExp2 公式（fogFactor = 1 − exp(−density²·depth²)），把波动调制后的颜色
 *   淡入雾色（= 背景色）。雾深取相机到世界片元的距离（distance(cameraPosition, vWorldPosition)）。
 *   只调制 RGB，不动 alpha——半透明透视语义不变。
 * - 雾色 / 雾密度经 uniform（uFogColor / uFogDensity）由 SeaSurface 注入，与 SceneAtmosphere 的
 *   场景雾、地形片元雾同读 SCENE_ATMOSPHERE_CONFIG——三处密度同源、永不漂移；uFogDensity=0
 *   （配置 FOG_ENABLED=false）时 fogFactor 恒为 0，片元零开销。若海面不雾化而地形雾化，远缘会在
 *   海陆交界出现一条「海面更亮」的接缝——故雾必须同时补进两类片元（src/config/sea-surface 文件头
 *   与 TASK-008 的边界约定即此）。
 */

/**
 * 顶点着色器：把 plane 顶点原样变换到世界空间（无位移），透传 UV。
 *
 * plane 经组件 rotation-x = −90° + position.y = SEA_LEVEL_Y_METERS(=0) 后，顶点世界 y 恒为 0
 * （海平面）。无位移 = 海面严格落在 y=0，与地形海平面同米制。
 *
 * varying：
 * - vUv：plane 的 UV（[0,1]²），供片元在分辨率无关的 UV 空间计算波动。
 * - vWorldPosition：顶点世界坐标，供片元做 FogExp2 雾深计算（相机到片元距离；只用于雾）。
 */
export const SEA_SURFACE_VERTEX_SHADER = /* glsl */ `
varying vec2 vUv;
varying vec3 vWorldPosition;

void main() {
  // 透传 UV：波动在 UV 空间计算，与 plane 分辨率无关（1 段 plane 也能呈现细密涟漪）。
  vUv = uv;
  // 顶点原样变换到世界空间（无位移）。plane 经模型矩阵（绕 X 轴 −90° + position.y=0）后世界 y 恒为 0。
  vec4 worldPosition = modelMatrix * vec4(position, 1.0);
  vWorldPosition = worldPosition.xyz;
  gl_Position = projectionMatrix * viewMatrix * worldPosition;
}
`

/**
 * 片元着色器：双层流动正弦扰动 → 深蓝青基线色亮度调制 → 半透明输出。
 *
 * uniform 语义（由 SeaSurface 组件注入，全部来自 src/config/sea-surface 与 src/config/scene-atmosphere
 * 唯一事实源，不在此硬编码领域常量）：
 * - uTime：统一时间输入（秒，来自 R3F 共享 clock）。**唯一**的时间 uniform——两层波动都消费它。
 * - uColor：深蓝青基线色（[0,1]³，来自 SEA_SURFACE_HEX 经 hexToShaderFloat3）。
 * - uOpacity：基线透明度（0.6，来自 SEA_SURFACE_OPACITY）；直接成为输出 alpha。
 * - uLayer{1,2}{FrequencyU,FrequencyV,Speed,Amplitude,Phase}：双层波动参数（来自 SEA_WAVE_LAYER_{1,2}，
 *   挂载期一次设置，运行循环不更新）。
 * - uFogColor / uFogDensity：雾色 / 雾密度（来自 SCENE_ATMOSPHERE_CONFIG，与地形片元、场景雾同源）。
 *   uFogDensity=0（配置关闭雾）时 fogFactor 恒为 0，零开销。
 */
export const SEA_SURFACE_FRAGMENT_SHADER = /* glsl */ `
uniform float uTime;
uniform vec3 uColor;
uniform float uOpacity;
uniform float uLayer1FrequencyU;
uniform float uLayer1FrequencyV;
uniform float uLayer1Speed;
uniform float uLayer1Amplitude;
uniform float uLayer1Phase;
uniform float uLayer2FrequencyU;
uniform float uLayer2FrequencyV;
uniform float uLayer2Speed;
uniform float uLayer2Amplitude;
uniform float uLayer2Phase;
uniform vec3 uFogColor;
uniform float uFogDensity;

varying vec2 vUv;
varying vec3 vWorldPosition;

void main() {
  // 双层流动正弦扰动（SPEC §3.5「双层流动」）：两层都乘同一个 uTime（统一时钟，无第二时间源）。
  // 第一层 +V 方向、第二层 −V 方向（交叉流动），相位不同使叠加呈非周期涟漪而非驻波。
  // 每层正弦的空间导数即微法线倾斜，叠加扰动量对基线色的亮度调制是法线扰动的简化呈色（微波）。
  float wave1 = sin(
    vUv.x * uLayer1FrequencyU + vUv.y * uLayer1FrequencyV + uTime * uLayer1Speed + uLayer1Phase
  );
  float wave2 = sin(
    vUv.x * uLayer2FrequencyU - vUv.y * uLayer2FrequencyV + uTime * uLayer2Speed + uLayer2Phase
  );
  float perturb = wave1 * uLayer1Amplitude + wave2 * uLayer2Amplitude;

  // 细微亮度调制：基线色 ×(1 + 扰动)。幅度 < 0.1（来自配置），「细微、不喧宾夺主」。
  // 颜色恒为深蓝青基线——不读 heightmap、不查色阶；大陆架透视梯度来自水下地形透过半透明海面。
  vec3 color = uColor * (1.0 + perturb);

  // 极轻微指数雾（SPEC §3.4）：与地形片元同一 FogExp2 公式，把调制后颜色淡入雾色（= 背景色），
  // 柔化地图远缘衔接；只调制 RGB，不动 alpha（半透明透视语义不变）。cameraPosition 是 ShaderMaterial
  // 内建 uniform（世界相机坐标）。uFogDensity=0（配置关闭雾）时零开销。
  float fogDepth = distance(cameraPosition, vWorldPosition);
  float fogFactor = 1.0 - exp(-uFogDensity * uFogDensity * fogDepth * fogDepth);
  fogFactor = clamp(fogFactor, 0.0, 1.0);
  color = mix(color, uFogColor, fogFactor);

  // 半透明输出：alpha = uOpacity（基线 0.6）。配合组件 depthWrite=false，水下地形透过海面可见。
  gl_FragColor = vec4(color, uOpacity);
}
`
