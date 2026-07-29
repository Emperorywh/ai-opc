/**
 * 大屏页面骨架（SPEC §3.4 / §11）。
 *
 * 当前装配：全视口深蓝黑容器 + 标题区 + 3D 地形画布（TASK-006 GPU 位移地形 + TASK-007 动态海面
 * + TASK-008 场景氛围与受约束相机 + TASK-009 贴地省界与 hover 拾取）。海拔色阶图例、合规角标、
 * 标签、附图、入场编排等由后续任务按 SPEC §11 目录结构挂载（TASK-016 做最终总装）。
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
 *
 * 省界与 hover（TASK-009，SPEC §3.6 / §4.2）：省级行政区几何与 heightmap 并行取数；
 * ProvinceBordersLayer 在二者均就绪时由 heightmap.meta + pixels 构造共享 CPU ElevationProvider
 * （与 GPU 位移同一份高程事实源，零额外取数 / 解码 / 内存），调领域纯函数 prepareProvinceBorders
 * 完成「弧长 densify → 逐点贴地 y=h·k+epsilon → 按省分组」，交 ProvinceBorders 渲染（浅青白
 * additive 发光、NDC 深度偏移抗 z-fighting、每省一个 draw call 共 34 个）。ProvinceHoverPicker
 * 挂载与地形同包围盒的不可见拾取面，把指针命中经 invertWorld 反查 + findProvinceAtLonLat 裁决为
 * adminId | null，写入 ProvinceHoverProvider 保管的共享焦点状态——省界据此加亮加粗焦点省、
 * 压暗非焦点省、移出还原（无 click 行为）；该状态对 TASK-010 标签模块同源可见。
 * 省界几何加载失败按政治红线（SPEC §6「边界错误是事故级问题」）显式暴露为整页错误，不带病渲染
 * 一张缺省界的地图；准备期异常（理论不发生，资产已过契约 + 深度校验）捕获后 console.error 并
 * 跳过省界层，不崩溃场景其余有效层。
 */
import { useEffect, useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import { Canvas } from '@react-three/fiber'
import { PAGE_SUBTITLE, PAGE_TITLE } from './lib/static-copy'
import {
  resolveTerrainConfigOrThrow,
  type TerrainRenderConfig,
} from './config/terrain-config'
import { SCENE_ATMOSPHERE_CONFIG } from './config/scene-atmosphere'
import { PROVINCE_BORDERS_CONFIG } from './config/province-borders'
import { ChinaTerrainMesh } from './three/ChinaTerrainMesh'
import { SeaSurface } from './three/SeaSurface'
import { SceneAtmosphere } from './three/SceneAtmosphere'
import { MapOrbitControls } from './three/MapOrbitControls'
import { ProvinceHoverProvider } from './three/ProvinceHoverProvider'
import { ProvinceBorders } from './three/ProvinceBorders'
import { ProvinceHoverPicker } from './three/ProvinceHoverPicker'
import { DEFAULT_CAMERA_POSE, MAP_CAMERA_CONSTRAINTS } from './three/camera-constraints'
import {
  loadHeightmapTexture,
  type HeightmapTextureLoadResult,
} from './three/load-heightmap-texture'
import { createElevationProvider } from './lib/elevation'
import { loadProvinceGeometry } from './lib/province-geometry'
import { prepareProvinceBorders } from './lib/province-borders'
import type { AdministrativeGeometryContract } from './geo-contracts'

/** heightmap 加载状态：加载中 / 就绪 / 失败（失败绝不静默退化为平面 fallback）。 */
type HeightmapState =
  | { readonly phase: 'loading' }
  | { readonly phase: 'ready'; readonly heightmap: HeightmapTextureLoadResult }
  | { readonly phase: 'error'; readonly message: string }

/** 省级行政区几何加载状态：加载中 / 就绪 / 失败（失败按政治红线显式暴露，不带病渲染缺省界的地图）。 */
type ProvinceGeometryState =
  | { readonly phase: 'loading' }
  | { readonly phase: 'ready'; readonly contract: AdministrativeGeometryContract }
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

/**
 * 模块级省级行政区几何加载 Promise（单例）：与 heightmap 同一去重语义（StrictMode 双挂载安全），
 * 全页面只取数 / 校验一次。
 */
let provinceGeometryPromise: Promise<AdministrativeGeometryContract> | null = null
function loadProvinceGeometryOnce(): Promise<AdministrativeGeometryContract> {
  provinceGeometryPromise ??= loadProvinceGeometry()
  return provinceGeometryPromise
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

/** 加载省级行政区几何（资产访问层 loadProvinceGeometry），就绪后返回经契约校验的 contract。 */
function useProvinceGeometry(): ProvinceGeometryState {
  const [state, setState] = useState<ProvinceGeometryState>({ phase: 'loading' })
  useEffect(() => {
    let cancelled = false
    loadProvinceGeometryOnce()
      .then((contract) => {
        if (!cancelled) setState({ phase: 'ready', contract })
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
 * 省级贴地边界准备 + 渲染层（TASK-009，SPEC §3.6）。
 *
 * 依赖两个就绪输入：heightmap（含 pixels，用于构造共享 ElevationProvider）、province geometry
 * （features）。geometry 未就绪时返回 null（不渲染）；二者齐备时：
 * 1. 由 heightmap.meta + pixels 构造共享 ElevationProvider（createElevationProvider，不介入共享
 *    缓存——本页面持有一份即可；pixels 即取数时已解码的那份，零额外内存； exaggeration 变化时
 *    provider 不变、仅 borders 重算）。
 * 2. 调领域纯函数 prepareProvinceBorders（densify + 贴地 + 按省分组）产出 PreparedProvinceBorders。
 * 3. 交 ProvinceBorders 渲染（浅青白 additive 发光、NDC 深度偏移、每省一个 draw call；hover 焦点
 *    经共享 context 消费）。
 *
 * 准备期异常（无效几何 / 高程查询失败 / 退化——理论不发生：资产已过 TASK-004 契约 + 深度校验，
 * 且集成测试用生产资产 + 生产高程跑通过全量准备）被捕获并 console.error 记录后跳过省界层——
 * 不崩溃场景（地形 / 海面 / 相机 / 氛围继续有效），也绝不产出平地边界（领域层已先行抛错）。
 *
 * memo 边界：provider 仅依赖 heightmap（pixels / meta 引用稳定）；borders 依赖 features + provider +
 * k + prep 配置（配置取 PROVINCE_BORDERS_CONFIG 冻结值）。k 切换时 borders 确定性重算
 * （y = h·k + epsilon 随 k 变化，必须重算以保持贴地）——离散切换的一次性开销，非每帧。
 */
function ProvinceBordersLayer({
  heightmap,
  geometry,
  exaggeration,
}: {
  readonly heightmap: HeightmapTextureLoadResult
  readonly geometry: AdministrativeGeometryContract
  readonly exaggeration: number
}): ReactNode {
  // 由 heightmap 的 meta + pixels 构造共享 CPU ElevationProvider（与 GPU 位移同一份高程事实源）。
  const provider = useMemo(
    () => createElevationProvider(heightmap.meta, heightmap.pixels),
    [heightmap],
  )
  const prepared = useMemo(() => {
    try {
      return prepareProvinceBorders(geometry.features, provider, exaggeration, {
        densifySpacingMeters: PROVINCE_BORDERS_CONFIG.densifySpacingMeters,
        terrainEpsilonMeters: PROVINCE_BORDERS_CONFIG.terrainEpsilonMeters,
      })
    } catch (cause) {
      // 准备失败：console 记录便于排查，跳过省界层（不崩溃场景）；正常合法资产下不触发。
      // eslint-disable-next-line no-console
      console.error(`[ProvinceBorders] 贴地边界准备失败：${cause instanceof Error ? cause.message : String(cause)}`)
      return null
    }
  }, [geometry, provider, exaggeration])

  if (prepared === null) return null
  return <ProvinceBorders borders={prepared} />
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
  const geometry = useProvinceGeometry()

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
          geometry.phase === 'error' ? (
            // 省界几何加载失败按政治红线（SPEC §6）显式暴露：不渲染一张缺省界的地图。
            <p className="screen-status" role="alert">省界数据加载失败：{geometry.message}</p>
          ) : (
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
            {/*
              省级贴地边界与 hover 拾取（TASK-009，SPEC §3.6 / §4.2）：hover 焦点状态由
              ProvinceHoverProvider 保管（Canvas 子树内共享，TASK-010 标签模块同源消费）；
              几何就绪时挂载边界层与唯一拾取点。无 click 行为。
            */}
            <ProvinceHoverProvider>
              {geometry.phase === 'ready' && (
                <>
                  <ProvinceBordersLayer
                    heightmap={heightmap.heightmap}
                    geometry={geometry.contract}
                    exaggeration={RUNTIME_TERRAIN_CONFIG.exaggeration}
                  />
                  <ProvinceHoverPicker features={geometry.contract.features} />
                </>
              )}
            </ProvinceHoverProvider>
          </Canvas>
          )
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
