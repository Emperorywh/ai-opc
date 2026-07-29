/**
 * 大屏页面骨架（SPEC §3.4 / §11）。
 *
 * 当前装配：全视口深蓝黑容器 + 标题区 + 3D 地形画布（TASK-006 GPU 位移地形 + TASK-007 动态海面）。
 * 海拔色阶图例、合规角标、省界、标签、附图、入场编排、相机限位等由后续任务
 * 按 SPEC §11 目录结构挂载（TASK-016 做最终总装）。
 *
 * 标题区文案来自页面静态文案唯一事实源（src/lib/static-copy.ts），
 * 字体子集覆盖校验以同一事实源断言所需汉字无缺失（SPEC §3.7）。
 *
 * 相机（临时静态机位）：按 SPEC §4.1「东南方向斜俯视」置于地图东南上方看向主图中心，
 * 使青藏高原在画面左上隆起、东部平原在右下，凸显西高东低。OrbitControls 与俯仰 / 缩放 /
 * 平移限位由 TASK-008 正式装配并替换本静态机位；FOV / 距离系数 / 方位角在此为一次性
 * 派生（与 TASK-008 将登记的相机约束同源决策：方位角 45°、仰角 30°、距离 = 半对角线 ×2.1、
 * FOV 42°），不在别处复制第二套机位。
 */
import { useEffect, useState } from 'react'
import { Canvas } from '@react-three/fiber'
import { PAGE_SUBTITLE, PAGE_TITLE } from './lib/static-copy'
import { MAIN_MAP_WORLD_BOUNDS } from './lib/projection'
import {
  resolveTerrainConfigOrThrow,
  type TerrainRenderConfig,
} from './config/terrain-config'
import { ChinaTerrainMesh } from './three/ChinaTerrainMesh'
import { SeaSurface } from './three/SeaSurface'
import {
  loadHeightmapTexture,
  type HeightmapTextureLoadResult,
} from './three/load-heightmap-texture'
import { TERRAIN_PLANE_LAYOUT } from './three/terrain-layout'

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

/** 主图世界半对角线（米）：相机距离 / 视锥的统一尺度（与 plane 布局同源，均自主图世界包围盒派生）。 */
const MAP_HALF_DIAGONAL_METERS =
  Math.hypot(
    MAIN_MAP_WORLD_BOUNDS.maxX - MAIN_MAP_WORLD_BOUNDS.minX,
    MAIN_MAP_WORLD_BOUNDS.maxZ - MAIN_MAP_WORLD_BOUNDS.minZ,
  ) / 2

/** 相机 FOV（度）：42° 兼顾整张版图入画与地势起伏可读性。 */
const CAMERA_FOV_DEGREES = 42
/**
 * 相机 near（米）：尽量大以保留深度缓冲精度（near/far 比远好于极端比例）。
 *
 * TASK-007 起海面与近零高程陆地共面（y≈0）：24 位深度缓冲的精度 ≈ z²/(near·2²⁴)，相机距图心
 * ≈ 半对角线 ×2.1 ≈ 10.4Mm，near=1000 时图心精度 ≈ 6.4km——远大于沿岸低地的世界高度（h≈0–100m
 * → y≈0–200m），海面（y=0）与低地落入同一深度桶，透明海面会经 LessEqualDepth 盖过陆地着色。
 * 取 near = 半对角线 ×0.5（≈2.47Mm，仍远小于最近图角 ≈5.4Mm，>2 倍余量）后全图精度 0.7–5.7m，
 * 低地与海面干净分离（h≈0 的水线像素本就是海岸交界）。
 * 注意：TASK-008 装配 OrbitControls 缩放限位时，minDistance 须与本 near 协同设计（拉近时 near
 * 应随动或收紧），避免近裁剪切入版图。
 */
const CAMERA_NEAR_METERS = MAP_HALF_DIAGONAL_METERS * 0.5
/** 相机 far（米）：整张版图（含地形起伏与远角）都落在视锥内不被远裁剪。 */
const CAMERA_FAR_METERS = MAP_HALF_DIAGONAL_METERS * 8

/**
 * 默认静态机位（SPEC §4.1 东南斜俯视；TASK-008 将以受约束 OrbitControls 正式接管）。
 * 方位角 45°（从 +Z 南向 +X 东量起 → 东南）、仰角 30°、距离 = 半对角线 ×2.1；
 * 注视点 = 主图世界中心 (0, 0, centerZ)（与 plane 定位共用同一份 centerZ 派生）。
 */
const DEFAULT_CAMERA_POSITION: readonly [number, number, number] = (() => {
  const azimuthRad = (45 * Math.PI) / 180
  const elevationRad = (30 * Math.PI) / 180
  const distance = MAP_HALF_DIAGONAL_METERS * 2.1
  return [
    Math.cos(elevationRad) * Math.sin(azimuthRad) * distance,
    Math.sin(elevationRad) * distance,
    TERRAIN_PLANE_LAYOUT.centerZ + Math.cos(elevationRad) * Math.cos(azimuthRad) * distance,
  ]
})()

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
              fov: CAMERA_FOV_DEGREES,
              near: CAMERA_NEAR_METERS,
              far: CAMERA_FAR_METERS,
              position: [...DEFAULT_CAMERA_POSITION],
            }}
            // DPR 上限 2（SPEC §7.3，防 4K 屏 ×高 DPR 爆显存）；预算正式配置由 TASK-015 登记。
            dpr={[1, 2]}
            onCreated={({ camera }) => {
              // 静态机位看向主图世界中心（target 与 plane 定位共用同一份 centerZ 派生）。
              camera.lookAt(0, 0, TERRAIN_PLANE_LAYOUT.centerZ)
            }}
          >
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
