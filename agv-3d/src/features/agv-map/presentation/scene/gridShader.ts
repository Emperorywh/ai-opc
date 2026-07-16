import { ShaderMaterial } from 'three'
import type { GridTheme } from '../../config/visualTheme'
import { hslToLinearColor } from './colorConvert'

/**
 * 网格着色器与材质（SPEC §8.4 独立网格图层，TASK-012）。
 *
 * 职责：定义单一 ShaderMaterial，在世界 XZ 地面上绘制细/粗双层网格线，并按"距地图中心的世界
 * 水平距离"做径向透明度衰减（SPEC §8.4：透明度随距地图中心距离衰减，不依赖相机）。径向衰减中心
 * 与半径由 environmentLayout 推导，不写死世界坐标。
 *
 * 为什么自研而非使用 drei <Grid>：
 * drei Grid 的 fade 按 fragment 到相机的距离衰减，会随用户 orbit 改变；SPEC §8.4 明确要求
 * 随"距地图中心"衰减且"不依赖相机"。自研 ShaderMaterial 以世界 XZ 坐标到中心的世界距离为
 * 衰减自变量，满足规格并保持网格在交互下稳定。
 *
 * 不变量：
 * - 单一材质：网格图层共享一个 ShaderMaterial（§8.1 独立图层、§11.1 资源受控）。
 * - 透明且不写深度：网格为地面之上的半透明叠加，transparent:true、depthWrite:false，
 *   避免遮挡路径扁带（扁带离地 0.015 m，网格位于更低 y，§16.2 不遮蔽拓扑）。
 * - 不投射/不接收阴影：SPEC §8.3 仅节点 castShadow；网格材质不参与阴影（§11.1）。
 * - 颜色经 hslToLinearColor 线性化，输出接入 tonemapping/colorspace（§8.5）。
 * - 不接入场景雾：SPEC §8.4 仅要求路径与节点材质参与雾效；网格自有径向衰减，不重复雾化。
 *
 * 该模块位于展示层（创建 Three.js 场景对象），不属 domain/geometry 纯数据层（SPEC §5.1）。
 */

/**
 * 顶点着色器。
 *
 * 透传世界 XZ 坐标（vWorldXZ）供片元绘制网格与径向衰减。world 计算用 modelMatrix 把本地
 * 顶点（PlaneGeometry 默认 XY、由 mesh 的 rotation-x 置为 XZ）映射到世界空间后取 xz 分量。
 */
const GRID_VERTEX_SHADER = /* glsl */ `
#include <common>

varying vec2 vWorldXZ;

void main() {
  vec4 world = modelMatrix * vec4(position, 1.0);
  vWorldXZ = world.xz;

  #include <begin_vertex>
  #include <project_vertex>
}
`

/**
 * 片元着色器。
 *
 * 网格算法：
 * - 以世界 XZ 到中心的偏移 q = vWorldXZ − uCenter 计算网格坐标，使粗线穿过地图中心。
 * - lineIntensity(coord, size)：经典 fract + fwidth 抗锯齿线，返回 [0,1]，线中央为 1。
 *   grid = abs(fract(coord/size − 0.5) − 0.5) / fwidth(coord/size)；取 min(x,y) 后 1−clamp。
 * - 细线 dim（×0.5）、粗线亮；mask = max(细线×0.5, 粗线)，粗线覆盖细线交点。
 *
 * 径向衰减（SPEC §8.4）：
 * - dist = distance(vWorldXZ, uCenter)；fade = 1 − smoothstep(uFadeInner, uFadeOuter, dist)。
 * - alpha = mask × uBaseOpacity × fade；接近 0 时 discard 减少透明过度绘制。
 *
 * 色彩：线性空间细/粗色按粗线贡献混合，输出经 tonemapping/colorspace（§8.5）。
 */
const GRID_FRAGMENT_SHADER = /* glsl */ `
#include <common>

uniform vec2 uCenter;
uniform float uCellSize;
uniform float uCoarseCellSize;
uniform vec3 uSectionColor;
uniform vec3 uCenterColor;
uniform float uBaseOpacity;
uniform float uFadeInner;
uniform float uFadeOuter;

varying vec2 vWorldXZ;

// 抗锯齿网格线强度：size 为单元尺寸，返回 [0,1]，线中央为 1。
float lineIntensity(vec2 coord, float size) {
  vec2 r = coord / size - 0.5;
  vec2 grid = abs(fract(r) - 0.5) / fwidth(r);
  float line = min(grid.x, grid.y);
  return 1.0 - min(line, 1.0);
}

void main() {
  vec2 q = vWorldXZ - uCenter;
  float fine = lineIntensity(q, uCellSize);
  float coarse = lineIntensity(q, uCoarseCellSize);
  // 细线减半、粗线满强；max 使粗线在交点覆盖细线。
  float mask = max(fine * 0.5, coarse);
  vec3 outgoingLight = mix(uSectionColor, uCenterColor, coarse);

  // 径向衰减：距地图中心越远越透明（SPEC §8.4，不依赖相机）。
  float dist = distance(vWorldXZ, uCenter);
  float fade = 1.0 - smoothstep(uFadeInner, uFadeOuter, dist);

  float alpha = mask * uBaseOpacity * fade;
  if (alpha <= 0.001) discard;

  gl_FragColor = vec4(outgoingLight, alpha);

  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`

/** 网格 uniform 名集合，供 EnvironmentLayer 写入与测试断言。 */
export const GRID_UNIFORMS = {
  center: 'uCenter',
  cellSize: 'uCellSize',
  coarseCellSize: 'uCoarseCellSize',
  sectionColor: 'uSectionColor',
  centerColor: 'uCenterColor',
  baseOpacity: 'uBaseOpacity',
  fadeInner: 'uFadeInner',
  fadeOuter: 'uFadeOuter',
} as const

/**
 * 创建网格 ShaderMaterial（唯一实例）。
 *
 * @param theme 网格视觉主题（细/粗色、基础透明度，取自 ENVIRONMENT_THEME.grid）。
 * @param cellSizeM 细网格单元尺寸，单位米（来自 environmentConfig.GRID_FINE_CELL_M）。
 * @param coarseCellSizeM 粗网格单元尺寸，单位米（细 × GRID_COARSE_MULTIPLIER）。
 */
export function createGridMaterial(
  theme: GridTheme,
  cellSizeM: number,
  coarseCellSizeM: number,
): ShaderMaterial {
  const uniforms = {
    [GRID_UNIFORMS.center]: { value: [0, 0] as [number, number] },
    [GRID_UNIFORMS.cellSize]: { value: cellSizeM },
    [GRID_UNIFORMS.coarseCellSize]: { value: coarseCellSizeM },
    [GRID_UNIFORMS.sectionColor]: { value: hslToLinearColor(theme.sectionColor) },
    [GRID_UNIFORMS.centerColor]: { value: hslToLinearColor(theme.centerColor) },
    [GRID_UNIFORMS.baseOpacity]: { value: theme.baseOpacity },
    [GRID_UNIFORMS.fadeInner]: { value: 0 },
    [GRID_UNIFORMS.fadeOuter]: { value: 0 },
  }

  return new ShaderMaterial({
    uniforms,
    vertexShader: GRID_VERTEX_SHADER,
    fragmentShader: GRID_FRAGMENT_SHADER,
    transparent: true,
    depthWrite: false,
    // 网格不参与雾（径向衰减已处理边缘），不投射/不接收阴影（§8.3 仅节点 castShadow）。
    fog: false,
  })
}

/** 供测试与 EnvironmentLayer 共享的着色器源码，便于断言 uniform 与衰减逻辑存在。 */
export const GRID_SHADER_SOURCE = {
  vertex: GRID_VERTEX_SHADER,
  fragment: GRID_FRAGMENT_SHADER,
} as const
