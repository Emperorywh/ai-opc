/**
 * 中国 3D 地势大屏场景装配（TASK-009）。
 *
 * 角色与依赖方向（清晰的场景装配边界，TASK-009 输出约束「资产访问、领域计算、渲染和 DOM overlay
 * 不能混成巨型组件」）：
 * - 资产访问：loadHeightmapTexture（src/three/load-heightmap-texture）—— 唯一的 heightmap 取数入口，
 *   返回经契约校验的元数据 + 16 位精度 GPU 纹理。本场景只在 ChinaMapScreen 内调用它**一次**，
 *   把同一份产物同时供给 Canvas 内的 mesh 与 Canvas 外的 overlay 状态文本，杜绝重复取数 / 双份纹理。
 * - 领域 / 配置：resolveTerrainConfigOrThrow（src/config/terrain-config）—— 唯一的夸张系数与分段预算
 *   权威，非法配置在挂载期即抛错。本场景把 DOM 控件改的 k 经它校验后注入 mesh。
 * - 渲染：ChinaTerrainMesh（src/three/ChinaTerrainMesh）—— 唯一的 GPU 位移地形装配；本场景只传 props。
 * - 场景装配（本文件）：负责 Canvas / 相机机位 / 加载编排 / 极简 DOM overlay（k 切换 + 状态）。
 *   不在此处读取 GeoJSON、不维护 hover、不做颜色分层、不加载外网（后续 TASK 接管）。
 *
 * 本 TASK 的场景最小化（仅满足「可观察真实起伏」与验证步骤）：
 * - 相机：固定东南斜俯视机位，lookAt 主图中心。OrbitControls / 极角限制 / 平移限制由后续相机 TASK 接管。
 * - 光照 / 背景 / 雾：不做（片元着色器内置一盏固定方向光做最小可读着色，见 terrain-shaders.ts）；
 *   完整氛围由后续 TASK 接管。故本场景不挂 ambient/directional/hemisphere 灯，不设场景背景色与雾。
 * - DOM overlay：仅一个 k 切换控件（验证步骤 4「人工切换 1.5/2.0/3.0」）与加载/错误状态文本。
 *   完整进度条 + 升起 + 标签淡入由后续入场 TASK 接管。
 */

import { useEffect, useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import { Canvas, useThree } from '@react-three/fiber'
import type { TerrainRenderConfig } from '../config/terrain-config'
import {
  PRODUCTION_TERRAIN_CONFIG,
  TERRAIN_EXAGGERATION_DEFAULT,
  TERRAIN_EXAGGERATION_MAX,
  TERRAIN_EXAGGERATION_MIN,
  resolveTerrainConfigOrThrow,
} from '../config/terrain-config'
import { ChinaTerrainMesh } from '../three/ChinaTerrainMesh'
import { TERRAIN_PLANE_LAYOUT } from '../three/terrain-layout'
import { loadHeightmapTexture } from '../three/load-heightmap-texture'
import type { HeightmapTextureLoadResult } from '../three/load-heightmap-texture'

/**
 * 相机机位（米，世界坐标）。东南斜俯视：+X（东）、+Y（上）、+Z（南），凸显西高东低（SPEC §4.1）。
 * 距离与 FOV 配合使整张主图（跨度约 7e6 米）落入画面；near/far 覆盖大尺度世界且控制深度精度。
 */
const CAMERA_POSITION: Readonly<[number, number, number]> = [6_500_000, 5_000_000, 6_500_000]
const CAMERA_TARGET: Readonly<[number, number, number]> = [0, 0, TERRAIN_PLANE_LAYOUT.centerZ]
const CAMERA_FOV_DEGREES = 42
const CAMERA_NEAR = 1000
const CAMERA_FAR = 4e7

/**
 * 相机 rig：在 Canvas 内用 useThree 拿到相机并 lookAt 主图中心。
 * 相机位置由 Canvas 的 camera prop 给出；本组件只补 lookAt（R3F 默认相机看向 -Z，需校正到主图中心）。
 */
function CameraRig(): null {
  const camera = useThree((state) => state.camera)
  useEffect(() => {
    camera.position.set(CAMERA_POSITION[0], CAMERA_POSITION[1], CAMERA_POSITION[2])
    camera.lookAt(CAMERA_TARGET[0], CAMERA_TARGET[1], CAMERA_TARGET[2])
    camera.updateProjectionMatrix()
  }, [camera])
  return null
}

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
 * 管理 k 切换状态（验证步骤 4），把校验后的配置注入 TerrainLayer；同时渲染极简 DOM overlay。
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

  return (
    <div className="china-map-screen">
      <Canvas
        camera={{ fov: CAMERA_FOV_DEGREES, near: CAMERA_NEAR, far: CAMERA_FAR, position: CAMERA_POSITION }}
        dpr={[1, 2]}
      >
        <CameraRig />
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
