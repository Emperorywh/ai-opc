import { MAP_ASSET_URL } from './features/agv-map/infrastructure/mapAssetUrl'
import './App.css'

/**
 * AGV 地图应用根组件。
 *
 * TASK-001 阶段建立数据契约：通过引用自托管地图资产 URL 确保该资产进入构建产物
 * 与开发态资源图。场景渲染、显式加载状态机与各图层由后续任务在该 stage 容器中接入，
 * 因此当前只提供占据视口的容器，并保留资产 URL 供运行时读取。
 */
function App() {
  return (
    <div className="agv-map-root" data-map-asset-url={MAP_ASSET_URL}>
      <main className="agv-map-stage" />
    </div>
  )
}

export default App
