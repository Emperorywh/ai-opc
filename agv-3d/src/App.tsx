import { MAP_ASSET_URL } from './features/agv-map/infrastructure/mapAssetUrl'
import { useMapLoad } from './features/agv-map/presentation/useMapLoad'
import './App.css'

/**
 * AGV 地图应用根组件。
 *
 * 外壳首次呈现后立即在后台启动地图编译（下载、完整性校验、解析、严格校验、规范化与
 * 几何编译），由 useMapLoad 经 Worker 异步完成，不阻塞界面（TASK-007）。
 * 加载状态经 data 属性暴露，供人工与门禁观察；场景渲染、加载/错误界面由后续任务消费。
 */
function App() {
  const state = useMapLoad()
  const status = state?.status ?? 'idle'
  const stage = state && 'stage' in state ? state.stage : undefined
  const progress = state && 'progress' in state ? state.progress : undefined

  return (
    <div
      className="agv-map-root"
      data-map-asset-url={MAP_ASSET_URL}
      data-load-status={status}
      data-load-stage={stage ?? ''}
      data-load-progress={progress !== undefined ? Math.round(progress * 100) : ''}
    >
      <main className="agv-map-stage" />
    </div>
  )
}

export default App
