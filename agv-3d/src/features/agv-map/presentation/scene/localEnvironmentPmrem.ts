import { PMREMGenerator } from 'three'
import type { Texture, WebGLRenderer, WebGLRenderTarget } from 'three'
import type { PmremGradientTheme } from '../../config/visualTheme'
import { buildEnvironmentScene, type EnvironmentSceneHandle } from './localEnvironmentScene'

/**
 * 本地程序化 PMREM 烘焙会话（SPEC §8.3 本地程序化环境，TASK-012）。
 *
 * 职责：把 PMREMGenerator 构造、程序化场景构建与 fromScene 烘焙收拢为单一会话对象——成功时
 * 返回 { texture, dispose }，烘焙失败时显式释放已分配的生成器与程序化场景后重抛错误。调用方
 * 只需在成功路径把 texture 赋给 scene.environment，并在卸载时调用 dispose。
 *
 * 为什么抽出为独立函数：
 * - 可测试性：PMREM 释放链（target.dispose → envScene.dispose → generator.dispose）与失败清理
 *   不依赖 React hooks 与真实 WebGLRenderer，可在 Node 环境用 mock 生成器直接断言释放顺序、
 *   幂等性与失败路径的资源回收（SPEC §5.4 释放路径自动化验证；TASK-012 输出"覆盖卸载释放的
 *   自动化验证"，补齐 LocalEnvironment effect 内释放链此前缺失的直接覆盖）。
 * - 资源安全：fromScene 抛错前 generator 与 envScene 已分配；本函数在 catch 中显式释放二者后
 *   重抛，避免半开放资源泄漏。重抛的错误由 LocalEnvironment effect 冒泡到 SceneErrorBoundary，
 *   经 notifySceneCreateFailed 进入统一 error 状态（SPEC §1 不静默降级、§10.2 GPU 创建错误）。
 *
 * 不变量：
 * - 失败不留尾巴：fromScene 抛错时 generator 与 envScene 必然在重抛前 dispose，target 尚未创建不释放。
 * - dispose 幂等：重复调用安全，内部 target 只释放一次。
 * - 纯资源编排：不访问 React/R3F 对象，不写 scene.environment（由调用方决定写入时机）。
 *
 * 该模块位于展示层（创建 Three.js PMREMGenerator），不属 domain/geometry 纯数据层（SPEC §5.1）。
 */

/** PMREM 烘焙输入参数（自 environmentConfig / visualTheme 汇集，单位见字段名后缀）。 */
export interface PmremBakeOptions {
  /** 程序化球面渐变（顶/底色，取自 visualTheme.ENVIRONMENT_THEME.pmremGradient）。 */
  readonly gradient: PmremGradientTheme
  /** 程序化球面半径，单位米。 */
  readonly sceneRadiusM: number
  /** fromScene 高斯模糊半径（弧度）；0 表示不二次模糊。 */
  readonly blurSigma: number
  /** fromScene 内部相机近面，单位米。 */
  readonly nearM: number
  /** fromScene 内部相机远面，单位米。 */
  readonly farM: number
  /** PMREM 立方体贴图单面分辨率（像素）。 */
  readonly resolution: number
}

/** PMREM 会话句柄：持有环境纹理并提供显式释放（SPEC §5.4）。 */
export interface PmremSession {
  /** 烘焙得到的 PMREM 纹理，由调用方赋给 scene.environment 提供环境光照。 */
  readonly texture: Texture
  /** 释放 RenderTarget、程序化场景与生成器；幂等。 */
  dispose(): void
}

/**
 * 烘焙本地程序化 PMREM 环境光照会话（SPEC §8.3）。
 *
 * @param gl WebGLRenderer（PMREMGenerator 依赖其 WebGL 上下文烘焙立方体贴图）。
 * @param options 烘焙参数（渐变、球面半径、分辨率、内部相机近远面）。
 * @throws 当 fromScene 烘焙失败时，释放已分配的生成器与程序化场景后重抛（GPU 资源创建失败）。
 */
export function bakeLocalPmremSession(gl: WebGLRenderer, options: PmremBakeOptions): PmremSession {
  const generator = new PMREMGenerator(gl)
  const envScene: EnvironmentSceneHandle = buildEnvironmentScene(
    options.gradient,
    options.sceneRadiusM,
  )
  let target: WebGLRenderTarget
  try {
    target = generator.fromScene(envScene.scene, options.blurSigma, options.nearM, options.farM, {
      size: options.resolution,
    })
  } catch (error) {
    // 烘焙失败：显式释放已分配的生成器与程序化场景几何/材质，避免半开放资源泄漏后重抛
    // （SPEC §5.4）；重抛的错误由调用方 effect 冒泡到场景错误边界进入统一 error 状态（§1、§10.2）。
    envScene.dispose()
    generator.dispose()
    throw error
  }

  let disposed = false
  return {
    texture: target.texture,
    dispose(): void {
      if (disposed) return
      disposed = true
      // 释放顺序：RenderTarget（含其纹理）→ 程序化场景几何/材质 → 生成器内部资源。
      target.dispose()
      envScene.dispose()
      generator.dispose()
    },
  }
}
