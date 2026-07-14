import type { MapSceneState } from '../application/loadState'
import { getOverlayDisplay } from './loadDisplay'
import { MapLoadingView } from './MapLoadingView'
import { MapErrorView } from './MapErrorView'
import './mapLoadOverlay.css'

/**
 * 地图加载覆盖层（SPEC §10、TASK-008）。
 *
 * 根据当前加载状态派生展示模型并选择渲染加载界面或错误界面：
 * - loading / preparing / null（未启动）：渲染加载界面，覆盖整个视口，画布区域无拓扑。
 * - error：渲染错误界面，覆盖整个视口，不展示半成品场景。
 * - ready：返回 null，覆盖层卸载，露出后续任务接入的场景画布。
 *
 * 展示模型派生集中在 getOverlayDisplay（纯函数，单独验证）；本组件只做选择与渲染，
 * 不在组件内散落阶段名或百分比计算，保证展示层无隐式状态。
 */
export interface MapLoadOverlayProps {
  readonly state: MapSceneState | null
}

export function MapLoadOverlay({ state }: MapLoadOverlayProps) {
  const display = getOverlayDisplay(state)
  if (display === null) return null
  if (display.kind === 'error') {
    return (
      <div className="agv-map-overlay agv-map-overlay--error">
        <MapErrorView display={display} />
      </div>
    )
  }
  return (
    <div className="agv-map-overlay agv-map-overlay--loading">
      <MapLoadingView display={display} />
    </div>
  )
}
