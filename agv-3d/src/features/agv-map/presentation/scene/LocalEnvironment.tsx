import { useEffect } from 'react'
import { useThree } from '@react-three/fiber'
import { PMREMGenerator } from 'three'
import type { WebGLRenderTarget } from 'three'
import { ENVIRONMENT_THEME } from '../../config/visualTheme'
import {
  PMREM_BLUR_SIGMA,
  PMREM_FAR_M,
  PMREM_NEAR_M,
  PMREM_RESOLUTION,
  PMREM_SCENE_RADIUS_M,
} from '../../config/environmentConfig'
import { buildEnvironmentScene } from './localEnvironmentScene'

/**
 * 本地程序化环境光照组件（SPEC §8.3 本地程序化环境 + PMREM，TASK-012）。
 *
 * 职责：在挂载时用 PMREMGenerator 把程序化渐变球面场景（buildEnvironmentScene）烘焙为 PMREM
 * 纹理并写入 scene.environment，为节点与地面标准材质提供 IBL 环境光照；卸载时确定性释放
 * PMREM 纹理、RenderTarget 与生成器（SPEC §5.4、§11.3）。
 *
 * 为什么手写而非使用 drei <Environment>：
 * - SPEC §8.3 要求"不请求远程 HDR 资源"；drei <Environment preset> 会从 CDN 拉取。本组件用
 *   PMREMGenerator.fromScene 烘焙纯内存几何，零网络请求。
 * - SPEC §5.4 要求显式释放路径：本组件在 effect 清理中显式 dispose 纹理、RenderTarget、
 *   生成器与程序化场景几何/材质，释放路径可自动化验证，不依赖第三方组件内部实现。
 *
 * 不变量：
 * - 零远程资源：不加载 HDR / 纹理 / CDN，纯程序化几何 + 顶点色烘焙（§8.3、TASK-012 静态检查）。
 * - 显式释放：scene.environment 在卸载时置 null，PMREM RenderTarget 与纹理 dispose、
 *   PMREMGenerator dispose、程序化场景 dispose；StrictMode 重复挂载不泄漏（§5.4）。
 * - 不渲染可见对象：返回 null，仅作为 scene.environment 的副作用挂载点（独立于其他图层，§8.1）。
 * - 分辨率受性能预算约束：PMREM_RESOLUTION 取自 environmentConfig（§11.1 精神）。
 */

/**
 * 挂载本地程序化 PMREM 环境光照。
 *
 * 不渲染可见内容，返回 null。scene.environment 在清理时被置回 null，避免卸载后残留引用。
 */
export function LocalEnvironment(): null {
  const gl = useThree((state) => state.gl)
  const scene = useThree((state) => state.scene)

  useEffect(() => {
    const generator = new PMREMGenerator(gl)
    const envScene = buildEnvironmentScene(
      ENVIRONMENT_THEME.pmremGradient,
      PMREM_SCENE_RADIUS_M,
    )
    let target: WebGLRenderTarget | null = null
    try {
      target = generator.fromScene(envScene.scene, PMREM_BLUR_SIGMA, PMREM_NEAR_M, PMREM_FAR_M, {
        size: PMREM_RESOLUTION,
      })
      scene.environment = target.texture
    } catch {
      // 烘焙失败不抛入错误状态：环境光照为可选塑形层，缺失时节点仍由方向光+环境光可见；
      // 显式释放已分配资源，避免半开放生成器/场景泄漏（SPEC §5.4、§11.3）。
      target?.dispose()
      envScene.dispose()
      generator.dispose()
      return
    }

    return () => {
      // 卸载释放：先解除引用，再释放纹理/RenderTarget/生成器/程序化场景（SPEC §5.4）。
      scene.environment = null
      target?.dispose()
      envScene.dispose()
      generator.dispose()
    }
  }, [gl, scene])

  return null
}
