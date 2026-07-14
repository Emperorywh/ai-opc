import { useCallback, useEffect, useRef, useSyncExternalStore } from 'react'
import { LoadSessionController } from '../application/loadSession'
import { startBackgroundMapLoad } from '../application/loadMapUseCase'
import { MapCompilerClient } from '../infrastructure/mapCompilerWorker'
import { MAP_ASSET_URL } from '../infrastructure/mapAssetUrl'
import type { MapSceneState } from '../application/loadState'
// 注：handle 类型由 startBackgroundMapLoad 返回值自动推断，无需显式导入。

/**
 * 后台地图加载 React 绑定（SPEC §5.4、§10.1、TASK-007）。
 *
 * 该 Hook 在组件首次提交后立即发起后台地图编译，并通过 useSyncExternalStore
 * 把 LoadSessionController 的状态暴露为 React 状态。卸载时取消会话并终止 Worker，
 * 保证不遗留多个有效后台加载或未处理异步拒绝。
 *
 * 不变量：
 * - 单控制器单 Worker：控制器实例经 useRef 在多次渲染间稳定；effect 内创建并终止
 *   Worker，StrictMode 重复挂载时旧 effect 清理（取消+终止）后再创建新会话，
 *   由控制器 requestId 隔离旧会话结果（SPEC §5.4）。
 * - 外壳优先：加载在 useEffect（首帧提交后）启动，不阻塞界面首次呈现（TASK-007）。
 * - 只读状态：getSnapshot 直接返回控制器状态引用，状态以不可变替换更新，
 *   契合 useSyncExternalStore 的快照稳定性要求。
 */

/** useMapLoad 返回值：当前状态与用于驱动生命周期的会话控制器。 */
export interface UseMapLoadResult {
  readonly state: MapSceneState | null
  /**
   * 加载会话控制器。场景视图在首帧渲染后经它推进 creating-scene → fading → ready（SPEC §10.1）。
   * 暴露控制器而非窄接口，使展示层能直接复用应用层的纯状态机命令，避免重复抽象。
   */
  readonly controller: LoadSessionController
}

/**
 * 在组件挂载后启动后台地图加载，返回当前加载状态与会话控制器。
 *
 * 场景渲染、加载/错误界面等后续展示由消费方根据 state 自行实现；本 Hook 只负责
 * 接通后台编译与状态暴露（TASK-007 边界）。controller 供场景视图驱动场景准备生命周期
 * （TASK-009：creating-scene → fading → ready），调用方应在卸载时随组件清理取消会话。
 */
export function useMapLoad(): UseMapLoadResult {
  // 控制器在渲染间稳定：useRef 惰性初始化一次，StrictMode 重复挂载复用同一实例，
  // 使 start() 的 requestId 在卸载/重挂过程中单调递增，旧会话结果被自然隔离。
  const controllerRef = useRef<LoadSessionController | null>(null)
  if (controllerRef.current === null) {
    controllerRef.current = new LoadSessionController()
  }
  const controller = controllerRef.current

  const subscribe = useCallback(
    (onChange: () => void) => {
      // 监听器忽略状态参数，仅通知 React 检查快照是否变化。
      return controller.subscribe(() => {
        onChange()
      })
    },
    [controller],
  )

  const getSnapshot = useCallback(() => controller.getState(), [controller])

  const state = useSyncExternalStore(subscribe, getSnapshot, getSnapshot)

  useEffect(() => {
    // 首帧提交后启动：外壳已呈现，再在后台下载、校验、编译（TASK-007）。
    // handle 在 effect 闭包内捕获，清理时直接 dispose，无需额外 ref。
    const client = new MapCompilerClient()
    const handle = startBackgroundMapLoad(controller, client, MAP_ASSET_URL)
    return () => {
      // 卸载或重挂：取消会话、终止 Worker，后台执行单元归零（SPEC §5.4）。
      handle.dispose()
    }
  }, [controller])

  return { state, controller }
}
