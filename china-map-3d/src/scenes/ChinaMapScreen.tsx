/**
 * 中国 3D 地势大屏场景装配（TASK-009 资产 / 配置 / 渲染分层；TASK-011 受约束相机；
 * TASK-012 深色氛围照明与背景层次）。
 *
 * 角色与依赖方向（清晰的场景装配边界，TASK-009 输出约束「资产访问、领域计算、渲染和 DOM overlay
 * 不能混成巨型组件」）：
 * - 资产访问：loadHeightmapTexture（src/three/load-heightmap-texture）—— 唯一的 heightmap 取数入口，
 *   返回经契约校验的元数据 + 16 位精度 GPU 纹理。本场景只在 ChinaMapScreen 内调用它**一次**，
 *   把同一份产物同时供给 Canvas 内的 mesh 与 Canvas 外的 overlay 状态文本，杜绝重复取数 / 双份纹理。
 * - 领域 / 配置：resolveTerrainConfigOrThrow（src/config/terrain-config）—— 唯一的夸张系数与分段预算
 *   权威，非法配置在挂载期即抛错。本场景把 DOM 控件改的 k 经它校验后注入 mesh。
 * - 渲染：ChinaTerrainMesh（src/three/ChinaTerrainMesh）—— 唯一的 GPU 位移地形装配；本场景只传 props。
 *   氛围照明（光向 / 光色 / 环境光 / 雾）由 ChinaTerrainMesh 内部从 SCENE_ATMOSPHERE_CONFIG 注入着色器
 *   uniform，本场景不重复传氛围 props（单一事实源，TASK-012 实现约束「视觉参数集中管理」）。
 * - 相机 / 控制（TASK-011）：MAP_CAMERA_CONSTRAINTS / DEFAULT_CAMERA_POSE（src/three/camera-constraints）
 *   —— 受约束东南斜俯视相机的纯计算契约（距离 / 极角 / target 边界 / FOV / near / far 全部由主图世界
 *   包围盒派生，无魔法坐标）；MapOrbitControls（src/three/MapOrbitControls）把它装配到 drei OrbitControls。
 *   本场景只把「是否启用交互」显式传入，不在场景内复制约束常量、不持有隐式相机状态。
 * - 氛围（TASK-012）：SceneAtmosphere（src/three/SceneAtmosphere）—— 把 SCENE_ATMOSPHERE_CONFIG
 *   装配成背景色 / 雾 / 半球环境光 / 单盏方向主光；阴影图总开关 SCENE_SHADOWS_ENABLED（结构性 false）
 *   显式注入 Canvas。本场景不复制氛围常量、不读取行政区 / 地点 / hover。
 * - 场景装配（本文件）：负责 Canvas / 受约束相机 / 深色氛围 / 加载编排 / 极简 DOM overlay（k 切换 + 状态）。
 *   不在此处读取 GeoJSON、不维护 hover、不做颜色分层、不加载外网（后续 TASK 接管）。
 *
 * 相机交互启停契约（TASK-011 实现约束「相机状态可被后续入场状态机统一启停，没有隐式组件状态」）：
 * - 是否启用轨道交互由本场景以单一布尔 `interactionEnabled` 显式决定，当前 = 「heightmap 已就绪」。
 *   该布尔是后续入场状态机（TASK-013：升起动画期间锁定相机）可统一接管的状态入口：届时把
 *   「就绪 && 升起完成」合并即可，无需改 MapOrbitControls。MapOrbitControls 不自持交互开关，
 *   故本场景不存在「组件内部猜测 DOM 状态」的第二套启停路径。
 *
 * 阴影预算（TASK-012 实现约束「地形不投递高分辨率阴影贴图」）：Canvas shadows 显式取
 * SCENE_SHADOWS_ENABLED（结构性 false）——本 TASK 不启用任何 shadow map，地势方向感由方向光 Lambert
 * + 半球环境光体现（详见 terrain-shaders.ts / scene-atmosphere.ts）。DOM overlay 仅一个 k 切换控件 +
 * 加载 / 错误状态文本，完整 UI 由后续 TASK 接管。
 */

import { useEffect, useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import { Canvas } from '@react-three/fiber'
import type { TerrainRenderConfig } from '../config/terrain-config'
import {
  PRODUCTION_TERRAIN_CONFIG,
  TERRAIN_EXAGGERATION_DEFAULT,
  TERRAIN_EXAGGERATION_MAX,
  TERRAIN_EXAGGERATION_MIN,
  resolveTerrainConfigOrThrow,
} from '../config/terrain-config'
import { ChinaTerrainMesh } from '../three/ChinaTerrainMesh'
import { loadHeightmapTexture } from '../three/load-heightmap-texture'
import type { HeightmapTextureLoadResult } from '../three/load-heightmap-texture'
import { MapOrbitControls } from '../three/MapOrbitControls'
import { SceneAtmosphere } from '../three/SceneAtmosphere'
import { DEFAULT_CAMERA_POSE, MAP_CAMERA_CONSTRAINTS } from '../three/camera-constraints'
import { SCENE_SHADOWS_ENABLED } from '../config/scene-atmosphere'

/** heightmap 加载状态：加载中 / 就绪 / 失败（失败绝不静默退化为平面 fallback）。 */
export type HeightmapState =
  | { readonly phase: 'loading' }
  | { readonly phase: 'ready'; readonly heightmap: HeightmapTextureLoadResult }
  | { readonly phase: 'error'; readonly message: string }

/**
 * 加载生产 heightmap（资产访问层唯一入口），就绪后返回产物。全场景仅此一处取数，
 * 同一份产物供给 Canvas 内 mesh 与 Canvas 外 overlay，杜绝重复取数与双份 GPU 纹理。
 */
function useHeightmap(): HeightmapState {
  const [state, setState] = useState<HeightmapState>({ phase: 'loading' })
  useEffect(() => {
    let cancelled = false
    loadHeightmapTexture()
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
 * 地形层：接收上层（唯一）加载好的 heightmap 与受控配置，就绪时渲染 GPU 位移 mesh。
 * 组件本身不取数、不自决配置——纯渲染边界。heightmap 未就绪时返回 null（不渲染平地 fallback）。
 */
function TerrainLayer({
  heightmap,
  config,
}: {
  readonly heightmap: HeightmapState
  readonly config: TerrainRenderConfig
}): null | ReactNode {
  if (heightmap.phase !== 'ready') return null
  return <ChinaTerrainMesh heightmap={heightmap.heightmap} config={config} />
}

/** ChinaMapScreen 的 props：允许注入配置（默认生产配置），便于低资源环境改用测试配置。 */
export interface ChinaMapScreenProps {
  /** 初始地形渲染配置（默认 PRODUCTION_TERRAIN_CONFIG：k=2.0、分段 2048²）。 */
  readonly initialConfig?: TerrainRenderConfig
}

/**
 * 中国 3D 地势大屏页面根场景。
 * 管理 k 切换状态（验证步骤 4），把校验后的配置注入 TerrainLayer；同时渲染极简 DOM overlay，
 * 并以单一显式布尔驱动受约束相机的交互启停（TASK-011 启停契约）。
 */
export function ChinaMapScreen({ initialConfig = PRODUCTION_TERRAIN_CONFIG }: ChinaMapScreenProps): ReactNode {
  const [exaggeration, setExaggeration] = useState<number>(
    initialConfig.exaggeration ?? TERRAIN_EXAGGERATION_DEFAULT,
  )
  // k 变化时重新经配置层校验（非法值在挂载/切换期即暴露，绝不静默夹回默认）。分段沿用初始配置。
  const config = useMemo<TerrainRenderConfig>(
    () => resolveTerrainConfigOrThrow({ exaggeration, meshSegments: initialConfig.meshSegments }),
    [exaggeration, initialConfig.meshSegments],
  )
  const heightmap = useHeightmap()

  // 受约束相机的交互启停（TASK-011）：单一显式布尔，当前 = heightmap 就绪。后续入场状态机
  // （TASK-013 升起动画）在此合并「就绪 && 升起完成」即可统一接管，无需改 MapOrbitControls。
  // 加载 / 错误期置 false——尚无可探索地形时锁定相机，避免空场景下的无意义旋转。
  const interactionEnabled = heightmap.phase === 'ready'

  return (
    <div className="china-map-screen">
      <Canvas
        camera={{
          fov: MAP_CAMERA_CONSTRAINTS.fovDegrees,
          near: MAP_CAMERA_CONSTRAINTS.near,
          far: MAP_CAMERA_CONSTRAINTS.far,
          position: [DEFAULT_CAMERA_POSE.position.x, DEFAULT_CAMERA_POSE.position.y, DEFAULT_CAMERA_POSE.position.z],
        }}
        dpr={[1, 2]}
        shadows={SCENE_SHADOWS_ENABLED}
      >
        <SceneAtmosphere />
        <MapOrbitControls enabled={interactionEnabled} />
        <TerrainLayer heightmap={heightmap} config={config} />
      </Canvas>

      {/* 极简 DOM overlay：k 切换（验证步骤 4）+ 状态文本。完整 UI 由后续 TASK 接管。 */}
      <div className="china-map-overlay">
        <div className="china-map-kcontrol">
          <span>垂直夸张 k = {config.exaggeration.toFixed(1)}</span>
          <button type="button" onClick={() => setExaggeration(TERRAIN_EXAGGERATION_MIN)}>
            1.5
          </button>
          <button type="button" onClick={() => setExaggeration(TERRAIN_EXAGGERATION_DEFAULT)}>
            2.0
          </button>
          <button type="button" onClick={() => setExaggeration(TERRAIN_EXAGGERATION_MAX)}>
            3.0
          </button>
          <span className="china-map-segments">分段 {config.meshSegments}²（GPU 位移）</span>
        </div>
        {heightmap.phase === 'loading' && <div className="china-map-status">地形高程加载中…</div>}
        {heightmap.phase === 'error' && (
          <div className="china-map-status china-map-error">加载失败：{heightmap.message}</div>
        )}
      </div>
    </div>
  )
}
