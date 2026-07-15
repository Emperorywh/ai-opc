import { Component } from 'react'
import type { ErrorInfo, ReactNode } from 'react'
import type { SceneLifecyclePort } from '../../application/mapLoadCoordinator'

/**
 * 场景错误边界（SPEC §10.2、TASK-009 异常路径）。
 *
 * 职责：捕获 Canvas 子树（节点/路径等数据驱动 GPU 图层）在渲染期抛出的错误——如节点实例包
 * count 与 matrices 长度不一致（assertNodeInstancePacket）、GPU 几何/材质创建失败等——
 * 经场景生命周期窄边界 notifySceneCreateFailed 接入既有统一错误链（WEBGL_RESOURCE_FAILED
 * → error 状态 → MapErrorView），而非静默展示半批节点或崩溃白屏（SPEC §10.2 "不显示半张地图，
 * 不跳过坏记录"）。
 *
 * 为什么必须放在 Canvas 内部：
 * R3F <Canvas> 使用独立 React reconciler 渲染其 children；Canvas 外层的错误边界无法捕获
 * Canvas 子树内部的渲染错误。因此本边界作为 Canvas 的 children 挂载，捕获同 reconciler 树内
 * NodeLayer / PathLayer 等子树的错误。
 *
 * 不变量：
 * - 只做错误归集与转发：不自行决定状态机命令，只提交"场景 GPU 资源创建失败"这一外部事实，
 *   由应用层协调器决定 preparing → error 的转换（SPEC §5.3 状态转换只由应用层采纳）。
 * - 捕获后渲染 null：错误发生时不展示半成品场景；协调器随后把状态推到 error，App 不再渲染
 *   渲染数据包，MapSceneView 与本边界随之卸载。
 * - 不重置 hasError：本边界是错误路径的安全网，编译层保证正常数据自洽；一旦捕获，整个场景
 *   视图将随状态进入 error 而卸载，不存在"同一坏数据下重试"的合法路径。
 */

interface SceneErrorBoundaryProps {
  /** 场景生命周期窄边界：把捕获的错误提交为 WEBGL_RESOURCE_FAILED 外部事实。 */
  readonly scene: SceneLifecyclePort
  readonly children: ReactNode
}

interface SceneErrorBoundaryState {
  readonly hasError: boolean
}

export class SceneErrorBoundary extends Component<
  SceneErrorBoundaryProps,
  SceneErrorBoundaryState
> {
  override state: SceneErrorBoundaryState = { hasError: false }

  static getDerivedStateFromError(): SceneErrorBoundaryState {
    return { hasError: true }
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    // 把错误名、消息与组件栈作为定位信息提交；协调器在 error 状态保留结构化细节（SPEC §10.2）。
    const details = [error.name, info.componentStack?.trim()].filter(
      (s): s is string => typeof s === 'string' && s.length > 0,
    )
    this.props.scene.notifySceneCreateFailed({
      message: error.message,
      details,
    })
  }

  override render(): ReactNode {
    if (this.state.hasError) return null
    return this.props.children
  }
}
