import { BufferAttribute, Mesh, MeshBasicMaterial, Scene, SphereGeometry, BackSide } from 'three'
import type { Color } from 'three'
import type { PmremGradientTheme } from '../../config/visualTheme'
import { hslToLinearColor } from './colorConvert'

/**
 * 程序化 PMREM 环境场景构建（SPEC §8.3 本地程序化环境，TASK-012）。
 *
 * 职责：构建一个完全本地、程序化生成的渐变球面场景，供 PMREMGenerator.fromScene 烘焙为环境
 * 贴图（scene.environment）。不下载任何远程 HDR、纹理或 CDN 资源（SPEC §8.3、TASK-012 实现约束）。
 *
 * 设计：一个大半径内表面（BackSide）球面，按顶点 Y 在底部色与顶部色之间线性插值写入顶点色。
 * MeshBasicMaterial 不经光照、直接以顶点色输出，PMREM 烘焙后为节点与地面标准材质提供柔和的
 * 暗色科技环境光照（底部近背景深色、顶部略亮冷蓝模拟顶光）。
 *
 * 与 LocalEnvironment 组件的分工：本模块只构建可烘焙的程序化场景对象（geometry + material），
 * 不创建 PMREMGenerator、不访问 WebGLRenderer，因此可在 Node 环境直接验证场景结构与释放路径。
 * 组件层负责 PMREMGenerator 生命周期与 scene.environment 写入/释放（SPEC §5.4）。
 *
 * 不变量：
 * - 纯函数：相同梯度与半径产生几何等价的场景对象；不读取系统时间或随机源。
 * - 颜色经 hslToLinearColor 线性化（§8.5）；顶点色按 three.js 约定以工作线性空间直接写入。
 * - 显式释放：返回 dispose，释放 geometry 与 material，避免组件卸载后泄漏（§5.4、§11.3）。
 *
 * 该模块位于展示层（创建 Three.js 场景对象），不属 domain/geometry 纯数据层（SPEC §5.1）。
 */

/** 程序化环境场景句柄：持有场景对象并提供显式释放（SPEC §5.4）。 */
export interface EnvironmentSceneHandle {
  /** 烘焙用的程序化场景（含渐变球面网格）。 */
  readonly scene: Scene
  /** 释放 geometry 与 material；幂等。 */
  dispose(): void
}

/** 把 [0,1] 的 t 在两线性色之间线性插值（分量级，输出可直接写入顶点色缓冲）。 */
function lerpColor(a: Color, b: Color, t: number, out: Float32Array, offset: number): void {
  out[offset + 0] = a.r + (b.r - a.r) * t
  out[offset + 1] = a.g + (b.g - a.g) * t
  out[offset + 2] = a.b + (b.b - a.b) * t
}

/**
 * 构建程序化渐变球面环境场景（SPEC §8.3）。
 *
 * @param gradient 渐变主题（底部色、顶部色，取自 ENVIRONMENT_THEME.pmremGradient）。
 * @param radiusM 球面半径，单位米；仅需包围 PMREMGenerator.fromScene 的内部相机，与主场景尺度无关。
 */
export function buildEnvironmentScene(
  gradient: PmremGradientTheme,
  radiusM: number,
): EnvironmentSceneHandle {
  // 球面以原点为中心、Y 为竖直轴；32×16 段足够平滑渐变，控制顶点数。
  const geometry = new SphereGeometry(radiusM, 32, 16)
  const positionAttr = geometry.attributes.position as BufferAttribute
  const colors = new Float32Array(positionAttr.count * 3)
  const bottom = hslToLinearColor(gradient.bottom)
  const top = hslToLinearColor(gradient.top)
  // 按 Y 归一化为 0(底)~1(顶) 的渐变系数；球面 Y 范围 [−radius, +radius]。
  for (let i = 0; i < positionAttr.count; i += 1) {
    const y = positionAttr.getY(i)
    const t = (y + radiusM) / (2 * radiusM)
    lerpColor(bottom, top, t, colors, i * 3)
  }
  geometry.setAttribute('color', new BufferAttribute(colors, 3))

  // BackSide：渲染球面内表面，使 fromScene 内部相机捕获到环绕的渐变环境（§8.3）。
  const material = new MeshBasicMaterial({
    vertexColors: true,
    side: BackSide,
  })

  const mesh = new Mesh(geometry, material)
  const scene = new Scene()
  scene.add(mesh)

  let disposed = false
  const dispose = (): void => {
    if (disposed) return
    disposed = true
    geometry.dispose()
    material.dispose()
  }

  return { scene, dispose }
}
