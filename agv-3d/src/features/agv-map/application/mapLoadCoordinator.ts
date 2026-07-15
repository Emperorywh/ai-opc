import type { MapSceneState } from './loadState'
import { LoadSessionController } from './loadSession'
import { startBackgroundMapLoad } from './loadMapUseCase'
import type { MapCompilerPort } from './mapCompilerPort'

/**
 * 加载协调器：面向展示层的窄应用边界（SPEC §5.1、§5.3、§5.4、§10.1、TASK-006）。
 *
 * 该模块是 application 层的"取消与生命周期协调"聚合点：把会话控制器（LoadSessionController）、
 * 后台加载用例（startBackgroundMapLoad）与场景准备生命周期收拢为单一对象，对展示层只暴露
 * 只读状态与一个提交外部事实的窄边界（SceneLifecyclePort）。会话控制器本身从不离开应用层，
 * 展示层无法绕过状态规则直接修改会话内部状态。
 *
 * 不变量：
 * - 状态转换只由应用层采纳：场景准备命令（advance→fading、complete、fail）由协调器在收到
 *   展示层外部事实后翻译为状态机命令，展示层不持有也不直接调用会话控制器（SPEC §5.3、TASK-006）。
 * - 会话隔离沿用控制器：场景事实始终以当前会话 requestId 提交；会话被取代或取消后，
 *   controller.apply 返回 'stale'/'rejected'，状态不变（SPEC §5.4）。
 * - 无隐式全局：协调器实例自持控制器，可被多实例独立驱动与回收，满足 React StrictMode
 *   重复挂载不产生重复监听或状态串扰的要求（SPEC §5.4）。
 *
 * 依赖方向（SPEC §5.1、TASK-006）：只依赖 application（状态机、会话、用例、端口）与 domain
 * （经状态机间接引用 RenderPacket）。展示层依赖本模块的协调器与端口类型；基础设施适配器
 * 由展示层组合根在 start 时注入——这是唯一接触具体 infrastructure 的点。
 */

/**
 * 场景资源创建失败的定位信息（SPEC §10.2 WEBGL_RESOURCE_FAILED）。
 * message 与 details 均可选；未提供时由状态机取错误码默认中文说明。
 */
export interface SceneCreateFailure {
  readonly message?: string
  readonly details?: readonly string[]
}

/**
 * 场景生命周期窄边界：展示层经此提交"外部事实"，由协调器翻译为状态机命令（SPEC §10.1、TASK-006）。
 *
 * 展示层只报告客观发生的场景事件，不构造状态机命令、不感知 requestId：
 * - notifyFirstFrameRendered：Canvas 场景资源已创建且首帧成功提交（creating-scene → fading）。
 * - notifyFadeComplete：场景淡入动画完成（fading → ready）。
 * - notifySceneCreateFailed：场景 GPU 资源创建失败（当前 preparing 阶段 → error）。
 */
export interface SceneLifecyclePort {
  /** 场景资源已创建且首帧成功提交：creating-scene → fading（SPEC §10.1）。 */
  notifyFirstFrameRendered(): void
  /** 场景淡入完成：fading → ready（SPEC §10.1）。 */
  notifyFadeComplete(): void
  /** 场景 GPU 资源创建失败：当前 preparing 阶段 → error(WEBGL_RESOURCE_FAILED)（SPEC §10.2）。 */
  notifySceneCreateFailed(error?: SceneCreateFailure): void
}

/**
 * 加载协调器：展示层与应用层状态流之间的唯一窄边界。
 *
 * - subscribe/getState：供 useSyncExternalStore 观察只读状态（subscribe 只注册，不立即回调）。
 * - scene：场景生命周期窄边界，供场景视图提交外部事实。
 * - start：在组件首帧提交后注入编译端口并启动后台加载，返回停止函数（取消会话 + 终止端口）。
 */
export interface MapLoadCoordinator {
  /** 订阅状态变化；返回取消订阅函数。不立即回调当前状态（契合 useSyncExternalStore 语义）。 */
  subscribe(listener: () => void): () => void
  /** 当前状态快照；null 表示尚未启动任何会话。 */
  getState(): MapSceneState | null
  /** 场景生命周期窄边界。 */
  readonly scene: SceneLifecyclePort
  /**
   * 注入编译端口并启动一次后台加载，返回停止函数。
   * 停止函数取消当前会话并终止端口；幂等，多次调用安全。
   * 调用方应在组件卸载或重挂时调用，保证后台执行单元归零（SPEC §5.4）。
   */
  start(port: MapCompilerPort, assetUrl: string): () => void
}

/**
 * 创建加载协调器。控制器在内部创建，永不对外暴露；展示层只能通过返回的窄边界交互。
 */
export function createMapLoadCoordinator(): MapLoadCoordinator {
  // 控制器为协调器私有，跨多次 start 复用：每次 start 经 controller.start() 递增 requestId
  // 并重置状态，使新会话自然取代旧会话；StrictMode 重挂复用同一协调器实例，避免重复控制器。
  const controller = new LoadSessionController()

  // 场景事实始终以当前会话提交；会话失效时状态机拒绝写入，状态不变。
  const scene: SceneLifecyclePort = {
    notifyFirstFrameRendered() {
      controller.apply(
        { type: 'advance', to: 'fading' },
        controller.getCurrentRequestId(),
      )
    },
    notifyFadeComplete() {
      controller.apply({ type: 'complete' }, controller.getCurrentRequestId())
    },
    notifySceneCreateFailed(error?: SceneCreateFailure) {
      controller.apply(
        {
          type: 'fail',
          code: 'WEBGL_RESOURCE_FAILED',
          message: error?.message,
          details: error?.details,
        },
        controller.getCurrentRequestId(),
      )
    },
  }

  return {
    subscribe(listener) {
      // 包装监听器：丢弃状态参数，只通知 React 检查快照是否变化。
      return controller.subscribe(() => listener())
    },
    getState() {
      return controller.getState()
    },
    scene,
    start(port, assetUrl) {
      const handle = startBackgroundMapLoad(controller, port, assetUrl)
      let stopped = false
      return () => {
        // 幂等：StrictMode 重挂的清理与新停止可能交错，重复调用不应二次终止端口。
        if (stopped) return
        stopped = true
        handle.dispose()
      }
    },
  }
}
