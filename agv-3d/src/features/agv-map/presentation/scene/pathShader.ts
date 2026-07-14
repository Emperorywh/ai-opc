import { Color, ShaderMaterial, UniformsLib, UniformsUtils } from 'three'
import type { PathFlowConfig, PathColorTheme } from '../../config/visualTheme'

/**
 * 路径扁带着色器（SPEC §7.5、§7.6、§8.3，TASK-010）。
 *
 * 职责：定义合并路径 Mesh 使用的唯一 ShaderMaterial——基础扁带色叠加沿源→目标方向
 * 流动的高亮脉冲，通过统一 attribute（aPathU / aFlowDirection）实现，不创建逐边材质
 * （§8.3）。材质同时声明 fog:true 并内联 fog 着色器块，使 TASK-012 接入线性雾时无需
 * 修改本图层（§8.1 图层互不查询内部对象）。
 *
 * 不变量：
 * - 单一材质：全部 3045 条有向边共享一个 ShaderMaterial 实例（§8.3、§11.1 路径材质 1）。
 * - 方向由 attribute 表达：流向完全由 aFlowDirection 决定，与 isBackEdge 无关（§7.6）；
 *   规范方向车道 +1、反方向车道 −1、单向边 +1，由几何编译写入顶点。
 * - 每帧单 uniform：运行期只更新 uFlowOffsetM（流光偏移，米）；颜色、重复距离、强度等
 *   均在材质创建时设置一次，帧循环不重建材质或临时对象（§7.6、§11.1）。
 * - 色彩管线正确：颜色以线性空间输入（Color.setStyle 按 sRGB 解析并转换），
 *   输出经 tonemapping_fragment（ACES）与 colorspace_fragment（sRGB）块处理，
 *   与 R3F 默认色调映射/输出色彩空间一致（§8.5）。
 *
 * 该模块位于展示层（创建 Three.js 场景对象），不属 domain/geometry 纯数据层（§5.1）。
 */

/** 2π 常量，供余弦脉冲使用。 */
const TWO_PI = 6.283185307179586

/**
 * 顶点着色器。
 *
 * - 透传每顶点弧长 aPathU 与流向 aFlowDirection（varying）。
 * - 复用 Three.js 标准块：begin_vertex 声明 transformed、project_vertex 计算 mvPosition
 *   与 gl_Position、fog_vertex 写入 vFogDepth（USE_FOG 保护，无场景雾时为空）。
 */
const PATH_VERTEX_SHADER = /* glsl */ `
#include <common>
#include <fog_pars_vertex>

attribute float aPathU;
attribute float aFlowDirection;

varying float vPathU;
varying float vFlowDirection;

void main() {
  vPathU = aPathU;
  vFlowDirection = aFlowDirection;

  #include <begin_vertex>
  #include <project_vertex>
  #include <fog_vertex>
}
`

/**
 * 片元着色器。
 *
 * 流光算法（SPEC §7.6）：
 * - flowCoord = aPathU − offset × flowDirection。offset 随时间增大，脉冲的等相位面
 *   沿 flowDirection 方向推进：规范车道（+1）从源（低弧长）流向目标（高弧长），
 *   反方向车道（−1）从其源（高弧长）流向其目标（低弧长），二者均表达 source→target。
 * - pattern = fract(flowCoord / repeat)，把弧长归一化到一个重复周期 [0,1)，保证
 *   大弧长下余弦参数始终落在 [0, 2π)，避免浮点精度退化（§11.3 长时间运行）。
 * - pulse = pow(0.5 + 0.5·cos(pattern·2π), 6)，形成窄而平滑的彗尾脉冲。
 *
 * 色彩输出：基础扁带色（线性，低于 Bloom 阈值）叠加流光色×脉冲×强度（峰值高于阈值）。
 * 随后按 meshbasic 同序应用色调映射、输出色彩空间与雾（§8.5、§8.3）。
 */
const PATH_FRAGMENT_SHADER = /* glsl */ `
#include <common>
#include <fog_pars_fragment>

uniform vec3 uBaseColor;
uniform vec3 uFlowColor;
uniform float uFlowOffsetM;
uniform float uFlowRepeatM;
uniform float uFlowIntensity;

varying float vPathU;
varying float vFlowDirection;

void main() {
  // 流光坐标：弧长减去时间偏移并按流向翻转，等相位面沿 source→target 方向移动。
  float flowCoord = vPathU - uFlowOffsetM * vFlowDirection;
  float pattern = fract(flowCoord / uFlowRepeatM);
  // 窄彗尾脉冲：pattern=0 处峰值 1，向两侧平滑衰减。
  float wave = 0.5 + 0.5 * cos(pattern * ${TWO_PI.toFixed(8)});
  float pulse = pow(wave, 6.0);

  // 基础扁带色（低于 Bloom 阈值）+ 流动高亮（峰值高于阈值）。
  vec3 outgoingLight = uBaseColor + uFlowColor * (pulse * uFlowIntensity);

  gl_FragColor = vec4(outgoingLight, 1.0);

  #include <tonemapping_fragment>
  #include <colorspace_fragment>
  #include <fog_fragment>
}
`

/** 路径材质 uniform 名：每帧唯一被更新的流光偏移（米）。 */
export const FLOW_OFFSET_UNIFORM = 'uFlowOffsetM'

/**
 * 把 HSL 颜色转换为线性空间 THREE.Color。
 *
 * 与 NodeLayer 一致地经 CSS hsl() 字符串解析：Color.setStyle 默认按 sRGB 色彩空间解读，
 * 在 ColorManagement 启用（R3F 默认）时自动转换到工作线性空间，保证着色器直接输出即可
 * 进入色调映射/输出色彩空间块。
 */
function hslToLinearColor(hsl: { readonly h: number; readonly s: number; readonly l: number }): Color {
  const css = `hsl(${hsl.h}, ${(hsl.s * 100).toFixed(3)}%, ${(hsl.l * 100).toFixed(3)}%)`
  return new Color().setStyle(css)
}

/**
 * 创建路径扁带 ShaderMaterial（唯一实例）。
 *
 * uniform 组成：
 * - uBaseColor / uFlowColor / uFlowRepeatM / uFlowIntensity：创建时一次设置，运行期不变。
 * - uFlowOffsetM：每帧由 PathLayer 更新，初值 0（未推进时脉冲静止于弧长起点）。
 * - fog 系列：与 UniformsLib.fog 合并，使 refreshFogUniforms 能在场景有雾时写入；
 *   无场景雾时 USE_FOG 未定义，fog 块为空，这些 uniform 不参与渲染。
 *
 * @param color 路径色彩主题（基础色、流光色、强度）。
 * @param flow 流光动画参数（仅取重复距离写入 uniform；周期/速度由 FlowPhaseClock 消费）。
 */
export function createPathMaterial(color: PathColorTheme, flow: PathFlowConfig): ShaderMaterial {
  const uniforms = UniformsUtils.merge([
    UniformsLib.fog,
    {
      uBaseColor: { value: hslToLinearColor(color.baseColor) },
      uFlowColor: { value: hslToLinearColor(color.flowHighlightColor) },
      uFlowOffsetM: { value: 0 },
      uFlowRepeatM: { value: flow.flowRepeatM },
      uFlowIntensity: { value: color.flowHighlightIntensity },
    },
  ])

  return new ShaderMaterial({
    uniforms,
    vertexShader: PATH_VERTEX_SHADER,
    fragmentShader: PATH_FRAGMENT_SHADER,
    // 声明支持场景线性雾；USE_FOG 仅在场景存在 fog 且材质 fog:true 时定义（§8.3、§8.4）。
    fog: true,
    // 透射与深度相关行为按默认；扁带为不透明上表面，无需透明。
    transparent: false,
    // ACES 色调映射默认启用（toneMapped=true），与 §8.5 一致。
  })
}

/** 供测试与 PathLayer 共享的着色器源码，便于断言 attribute/uniform 与 fog 块存在。 */
export const PATH_SHADER_SOURCE = {
  vertex: PATH_VERTEX_SHADER,
  fragment: PATH_FRAGMENT_SHADER,
} as const
