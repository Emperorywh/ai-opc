import { MAP_ASSET_URL } from './features/agv-map/infrastructure/mapAssetUrl'
import { useMapLoad } from './features/agv-map/presentation/useMapLoad'
import { MapLoadOverlay } from './features/agv-map/presentation/MapLoadOverlay'
import { MapSceneView } from './features/agv-map/presentation/scene/MapSceneView'
import './App.css'

/**
 * AGV 地图应用根组件。
 *
 * 外壳首次呈现后立即在后台启动地图编译（下载、完整性校验、解析、严格校验、规范化与
 * 几何编译），由 useMapLoad 经 Worker 异步完成，不阻塞界面（TASK-007）。
 *
 * 场景与生命周期（TASK-006/009）：渲染数据包就绪（preparing/ready）后挂载 MapSceneView，
 * 呈现四类节点 InstancedMesh；场景视图在首帧渲染与淡入完成后，经场景生命周期窄边界
 * （SceneLifecyclePort）提交外部事实，由应用层协调器决定 creating-scene → fading → ready，
 * 完成淡入后覆盖层卸载，露出完整场景。展示层不直接持有或调用会话控制器。
 *
 * 加载与错误界面（TASK-008）：加载期间持续展示真实阶段与整数百分比；任一失败切换到
 * 统一错误界面。加载中或失败时覆盖层遮挡整个视口，不展示节点、路径或半成品场景。
 *
 * 加载状态经 data 属性额外暴露，供人工与门禁在不解析 DOM 文本的前提下观察。
 */
function App() {
  const { state, scene } = useMapLoad()
  const status = state?.status ?? 'idle'
  const stage = state && 'stage' in state ? state.stage : undefined
  const progress = state && 'progress' in state ? state.progress : undefined

  // preparing 与 ready 均持有渲染数据包；场景在 preparing 时以 opacity:0 挂载并完成淡入，
  // 进入 ready 后覆盖层卸载露出场景。组件在两状态间保持挂载，避免重复创建 GPU 资源。
  const packet = state !== null && (state.status === 'preparing' || state.status === 'ready')
    ? state.packet
    : null

  return (
    <div
      className="agv-map-root"
      data-map-asset-url={MAP_ASSET_URL}
      data-load-status={status}
      data-load-stage={stage ?? ''}
      data-load-progress={progress !== undefined ? Math.round(progress * 100) : ''}
    >
      <main className="agv-map-stage">
        {packet !== null && (
          <MapSceneView
            packet={packet}
            scene={scene}
            initiallyReady={state?.status === 'ready'}
          />
        )}
      </main>
      <MapLoadOverlay state={state} />
    </div>
  )
}

export default App
