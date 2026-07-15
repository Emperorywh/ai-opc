import { useCallback, useEffect, useRef, useSyncExternalStore } from 'react'
import {
  createMapLoadCoordinator,
  type MapLoadCoordinator,
  type SceneLifecyclePort,
} from '../application/mapLoadCoordinator'
import type { MapSceneState } from '../application/loadState'
import { MapCompilerClient } from '../infrastructure/mapCompilerWorker'
import { MAP_ASSET_URL } from '../infrastructure/mapAssetUrl'

/**
 * 后台地图加载 React 绑定（SPEC §5.4、§10.1、TASK-006/007）。
 *
 * 该 Hook 把应用层加载协调器接通到 React：在组件首次提交后注入编译端口并启动后台编译，
 * 通过 useSyncExternalStore 把协调器的只读状态暴露为 React 状态；卸载时取消会话并终止端口。
 * 展示层只拿到只读状态与场景生命周期窄边界（SceneLifecyclePort），不接触会话控制器内部对象。
 *
 * 不变量：
 * - 单协调器：协调器实例经 useRef 在多次渲染间稳定；effect 内注入端口并启动，StrictMode 重复
 *   挂载时旧 effect 清理（取消+终止）后再注入新端口开启新会话，由协调器 requestId 隔离旧结果
 *   （SPEC §5.4）。
 * - 外壳优先：加载在 useEffect（首帧提交后）启动，不阻塞界面首次呈现（TASK-007）。
 * - 只读状态：getSnapshot 直接返回协调器状态引用，状态以不可变替换更新，
 *   契合 useSyncExternalStore 的快照稳定性要求。
 *
 * 组合根说明（SPEC §5.1 例外）：useMapLoad 是展示层组合根——唯一导入具体 infrastructure
 * 适配器（MapCompilerClient）的位置，仅用于构造并注入到应用层协调器。应用层用例只依赖
 * MapCompilerPort 抽象，不反向依赖该具体实现；除此之外展示层不引用 infrastructure。
 */

/** useMapLoad 返回值：只读加载状态与场景生命周期窄边界。 */
export interface UseMapLoadResult {
  readonly state: MapSceneState | null
  /**
   * 场景生命周期窄边界。场景视图在首帧渲染与淡入完成后经它提交外部事实，
   * 由应用层协调器决定 creating-scene → fading → ready 的状态转换（SPEC §10.1、TASK-006）。
   */
  readonly scene: SceneLifecyclePort
}

/**
 * 在组件挂载后启动后台地图加载，返回当前加载状态与场景生命周期窄边界。
 *
 * 场景渲染、加载/错误界面等后续展示由消费方根据 state 自行实现；本 Hook 只负责
 * 接通协调器与状态暴露。scene 供场景视图驱动场景准备生命周期（TASK-009）。
 */
export function useMapLoad(): UseMapLoadResult {
  // 协调器在渲染间稳定：useRef 惰性初始化一次，StrictMode 重复挂载复用同一实例，
  // 使 start() 的 requestId 在卸载/重挂过程中单调递增，旧会话结果被自然隔离。
  const coordinatorRef = useRef<MapLoadCoordinator | null>(null)
  if (coordinatorRef.current === null) {
    coordinatorRef.current = createMapLoadCoordinator()
  }
  const coordinator = coordinatorRef.current

  const subscribe = useCallback(
    (onChange: () => void) => coordinator.subscribe(onChange),
    [coordinator],
  )

  const getSnapshot = useCallback(() => coordinator.getState(), [coordinator])

  const state = useSyncExternalStore(subscribe, getSnapshot, getSnapshot)

  useEffect(() => {
    // 组合根：构造具体编译适配器并注入应用层协调器；首帧提交后启动后台下载、校验、编译。
    // stop 在清理时取消会话、终止端口，后台执行单元归零（SPEC §5.4）。
    const client = new MapCompilerClient()
    const stop = coordinator.start(client, MAP_ASSET_URL)
    return stop
  }, [coordinator])

  return { state, scene: coordinator.scene }
}
