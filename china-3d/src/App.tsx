/**
 * 大屏页面骨架（SPEC §3.4 / §11）。
 *
 * 当前装配：全视口深蓝黑容器 + 标题区 + 3D 地形画布（TASK-006 GPU 位移地形 + TASK-007 动态海面
 * + TASK-008 场景氛围与受约束相机）。海拔色阶图例、合规角标、省界、标签、附图、入场编排等由后续
 * 任务按 SPEC §11 目录结构挂载（TASK-016 做最终总装）。
 *
 * 标题区文案来自页面静态文案唯一事实源（src/lib/static-copy.ts），字体子集覆盖校验以同一事实源
 * 断言所需汉字无缺失（SPEC §3.7）。
 *
 * 场景氛围（TASK-008，SPEC §3.4）：SceneAtmosphere 把 SCENE_ATMOSPHERE_CONFIG 装配成深蓝黑纯色
 * 背景 + 可选极轻指数雾 + 低强度半球环境光 + 单盏西北偏高方向主光（地形 / 海面的自定义着色器经
 * uniform 消费同一份配置，场景雾与片元雾同源）；渲染器阴影图按配置显式关闭（地形不投阴影贴图）。
 *
 * 相机（TASK-008，SPEC §4.1）：MapOrbitControls 装配受约束的东南斜俯视 OrbitControls——默认机位
 * （方位角 45°、仰角 30°、距离 = 半对角线 ×2.1）使青藏高原在画面左上隆起、东部平原在右下；
 * 距离 / 极角 / target 三道边界由纯计算契约（src/three/camera-constraints）强制，近裁剪面随相机
 * 高度动态跟随（与 TASK-007 深度精度修复协同）。Canvas camera prop 的 FOV / near 初值 / far /
 * 初始位置全部取自 MAP_CAMERA_CONSTRAINTS 与 DEFAULT_CAMERA_POSE（同一事实源，无第二套机位常量）。
 */
import { useEffect, useState } from 'react'
import { Canvas } from '@react-three/fiber'
import { PAGE_SUBTITLE, PAGE_TITLE } from './lib/static-copy'
import {
  resolveTerrainConfigOrThrow,
  type TerrainRenderConfig,
} from './config/terrain-config'
import { SCENE_ATMOSPHERE_CONFIG } from './config/scene-atmosphere'
import { ChinaTerrainMesh } from './three/ChinaTerrainMesh'
import { SeaSurface } from './three/SeaSurface'
import { SceneAtmosphere } from './three/SceneAtmosphere'
import { MapOrbitControls } from './three/MapOrbitControls'
import { DEFAULT_CAMERA_POSE, MAP_CAMERA_CONSTRAINTS } from './three/camera-constraints'
import {
  loadHeightmapTexture,
  type HeightmapTextureLoadResult,
} from './three/load-heightmap-texture'

/** heightmap 加载状态：加载中 / 就绪 / 失败（失败绝不静默退化为平面 fallback）。 */
type HeightmapState =
  | { readonly phase: 'loading' }
  | { readonly phase: 'ready'; readonly heightmap: HeightmapTextureLoadResult }
  | { readonly phase: 'error'; readonly message: string }

/**
 * 模块级 heightmap 加载 Promise（单例）：全页面只取数 / 解码 / 建纹理一次。
 * React StrictMode 的开发期双挂载会让 effect 触发两次——以模块级 Promise 去重，
 * 杜绝 32MB 资产被重复 fetch / 解码、GPU 纹理被建两份。
 */
let heightmapPromise: Promise<HeightmapTextureLoadResult> | null = null
function loadHeightmapOnce(): Promise<HeightmapTextureLoadResult> {
  heightmapPromise ??= loadHeightmapTexture()
  return heightmapPromise
}

/** 加载生产 heightmap（资产访问层唯一入口），就绪后返回产物。 */
function useHeightmap(): HeightmapState {
  const [state, setState] = useState<HeightmapState>({ phase: 'loading' })
  useEffect(() => {
    let cancelled = false
    loadHeightmapOnce()
      .then((heightmap) => {
        if (!cancelled) setState({ phase: 'ready', heightmap })
      })
      .catch((cause: unknown) => {
        if (!cancelled) {
          setState({ phase: 'error', message: cause instanceof Error ? cause.message : String(cause) })
        }
      })
    return () => {
      cancelled = true
    }
  }, [])
  return state
}

/**
 * 运行时地形渲染配置（SPEC §7.2「通过配置项暴露」）。
 *
 * 默认 = 生产档（k=2.0、分段 2048²）；允许以大屏幕操作员 URL 查询参数覆盖档位做帧率实测：
 * - ?terrainSegments=4096 切换上限档；?terrainK=2.5 调整垂直夸张。
 * 覆盖值统一走 resolveTerrainConfigOrThrow 校验（k∈[1.5,3.0]、分段∈[1,4096] 整数），
 * 非法值确定性抛错并在页面上显式暴露，绝不静默夹回默认。
 */
function resolveRuntimeTerrainConfig(): TerrainRenderConfig {
  const params = new URLSearchParams(window.location.search)
  const input: { exaggeration?: number; meshSegments?: number } = {}
  const rawSegments = params.get('terrainSegments')
  if (rawSegments !== null) input.meshSegments = Number(rawSegments)
  const rawK = params.get('terrainK')
  if (rawK !== null) input.exaggeration = Number(rawK)
  return resolveTerrainConfigOrThrow(input)
}

/** 运行时地形配置（模块加载时解析一次；非法 URL 覆盖值在此确定性暴露）。 */
const RUNTIME_TERRAIN_CONFIG: TerrainRenderConfig | { readonly error: string } = (() => {
  try {
    return resolveRuntimeTerrainConfig()
  } catch (cause) {
    return { error: cause instanceof Error ? cause.message : String(cause) }
  }
})()

function App() {
  const heightmap = useHeightmap()

  // 配置非法（如 URL 覆盖越界）：确定性失败，显式暴露，不带病渲染。
  if ('error' in RUNTIME_TERRAIN_CONFIG) {
    return (
      <main className="screen">
        <header className="screen-header">
          <h1 className="screen-title">{PAGE_TITLE}</h1>
          <p className="screen-subtitle">{PAGE_SUBTITLE}</p>
        </header>
        <section className="screen-stage">
          <p className="screen-status" role="alert">地形配置非法：{RUNTIME_TERRAIN_CONFIG.error}</p>
        </section>
      </main>
    )
  }

  return (
    <main className="screen">
      <header className="screen-header">
        <h1 className="screen-title">{PAGE_TITLE}</h1>
        <p className="screen-subtitle">{PAGE_SUBTITLE}</p>
      </header>
      <section className="screen-stage" aria-label="3D 地形画布挂载区">
        {heightmap.phase === 'ready' ? (
          <Canvas
            camera={{
              // FOV / near 初值 / far / 初始位置全部来自相机约束纯计算契约（同一事实源）。
              // near 初值 = 默认机位高度处的动态 near；挂载后由 MapOrbitControls 每帧跟随相机高度。
              fov: MAP_CAMERA_CONSTRAINTS.fovDegrees,
              near: MAP_CAMERA_CONSTRAINTS.initialNear,
              far: MAP_CAMERA_CONSTRAINTS.far,
              position: [
                DEFAULT_CAMERA_POSE.position.x,
                DEFAULT_CAMERA_POSE.position.y,
                DEFAULT_CAMERA_POSE.position.z,
              ],
            }}
            // 渲染器阴影图显式关闭（SPEC §3.4：地形不投递阴影贴图；配置层结构性 false）。
            shadows={SCENE_ATMOSPHERE_CONFIG.shadowsEnabled}
            // DPR 上限 2（SPEC §7.3，防 4K 屏 ×高 DPR 爆显存）；预算正式配置由 TASK-015 登记。
            dpr={[1, 2]}
          >
            {/* 深蓝黑背景 + 可选轻雾 + 半球环境光 + 单盏西北偏高主光（SPEC §3.4）。 */}
            <SceneAtmosphere />
            {/*
              受约束东南斜俯视轨道相机（SPEC §4.1）：距离 / 极角 / target 三道边界 + 动态 near。
              当前无入场动画（TASK-013 将接入），交互恒启用——enabled 是受控 prop，入场状态机
              届时以显式状态驱动它，本页不预埋第二套交互开关。
            */}
            <MapOrbitControls enabled />
            <ChinaTerrainMesh heightmap={heightmap.heightmap} config={RUNTIME_TERRAIN_CONFIG} />
            <SeaSurface />
          </Canvas>
        ) : (
          <p className="screen-status" role="status">
            {heightmap.phase === 'loading' ? '地形数据加载中…' : `地形数据加载失败：${heightmap.message}`}
          </p>
        )}
      </section>
    </main>
  )
}

export default App
