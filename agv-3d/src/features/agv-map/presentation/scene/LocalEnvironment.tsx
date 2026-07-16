import { useEffect } from 'react'
import { useThree } from '@react-three/fiber'
import { ENVIRONMENT_THEME } from '../../config/visualTheme'
import {
  PMREM_BLUR_SIGMA,
  PMREM_FAR_M,
  PMREM_NEAR_M,
  PMREM_RESOLUTION,
  PMREM_SCENE_RADIUS_M,
} from '../../config/environmentConfig'
import { bakeLocalPmremSession } from './localEnvironmentPmrem'

/**
 * 本地程序化环境光照组件（SPEC §8.3 本地程序化环境 + PMREM，TASK-012）。
 *
 * 职责：在挂载时经 bakeLocalPmremSession 把程序化渐变球面场景烘焙为 PMREM 纹理并写入
 * scene.environment，为节点与地面标准材质提供 IBL 环境光照；卸载时确定性释放会话（PMREM
 * RenderTarget、程序化场景几何/材质、PMREMGenerator）（SPEC §5.4、§11.3）。
 *
 * 为什么手写而非使用 drei <Environment>：
 * - SPEC §8.3 要求"不请求远程 HDR 资源"；drei <Environment preset> 会从 CDN 拉取。本组件用
 *   PMREMGenerator.fromScene 烘焙纯内存几何，零网络请求。
 * - SPEC §5.4 要求显式释放路径：本组件在 effect 清理中解除 scene.environment 引用并调用
 *   session.dispose，释放路径可自动化验证（见 localEnvironmentPmrem.test.ts）。
 *
 * 错误策略（SPEC §1、§10.2，TASK-012 修正）：
 * - PMREM 烘焙属 GPU 资源创建，失败时不静默降级。bakeLocalPmremSession 在 fromScene 失败时
 *   释放内部已分配资源后重抛；错误在本 effect 中冒泡，由外层 SceneErrorBoundary（包裹
 *   EnvironmentLayer）捕获并经 notifySceneCreateFailed 进入统一 error 状态
 *   （WEBGL_RESOURCE_FAILED），不展示缺失环境光照的半成品场景。此前版本在 catch 中只释放资源
 *   并 return，违反 §1"不保留运行时 fallback 或静默降级逻辑"与 §10.2，已修正。
 *
 * 不变量：
 * - 零远程资源：不加载 HDR / 纹理 / CDN，纯程序化几何 + 顶点色烘焙（§8.3、TASK-012 静态检查）。
 * - 显式释放：scene.environment 在卸载时置 null，会话内 RenderTarget/程序化场景/生成器 dispose；
 *   StrictMode 重复挂载不泄漏（§5.4）。
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
    // bakeLocalPmremSession 在 fromScene 失败时已释放内部资源并重抛；错误在此冒泡到
    // SceneErrorBoundary → notifySceneCreateFailed → error 状态（§1、§10.2，不静默降级）。
    const session = bakeLocalPmremSession(gl, {
      gradient: ENVIRONMENT_THEME.pmremGradient,
      sceneRadiusM: PMREM_SCENE_RADIUS_M,
      blurSigma: PMREM_BLUR_SIGMA,
      nearM: PMREM_NEAR_M,
      farM: PMREM_FAR_M,
      resolution: PMREM_RESOLUTION,
    })
    scene.environment = session.texture

    return () => {
      // 卸载释放：先解除引用，再释放会话（RenderTarget/程序化场景/生成器，SPEC §5.4）。
      scene.environment = null
      session.dispose()
    }
  }, [gl, scene])

  return null
}
