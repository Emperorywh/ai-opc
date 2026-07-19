/**
 * 中国 3D 地势大屏场景装配（TASK-009 资产 / 配置 / 渲染分层；TASK-011 受约束相机；
 * TASK-012 深色氛围照明与背景层次；TASK-013 动态海面；TASK-014 省级贴地边界；
 * TASK-015 十段线与岛礁点位；TASK-016 省名 / 省会光点 / 岛礁名称标注 + 离线字体子集；
 * TASK-017 标签地形遮挡淡化——由 PlaceLabelsLayer 构造地形世界 y 采样器注入 PlaceLabels）。
 *
 * 角色与依赖方向（清晰的场景装配边界，TASK-009 输出约束「资产访问、领域计算、渲染和 DOM overlay
 * 不能混成巨型组件」）：
 * - 资产访问：loadHeightmapTexture（src/three/load-heightmap-texture）—— 唯一的 heightmap 取数入口，
 *   返回经契约校验的元数据 + 16 位精度 GPU 纹理 + 共享 CPU 高程像素（pixels）。本场景只在 ChinaMapScreen
 *   内调用它**一次**，把同一份产物同时供给 Canvas 内的 mesh、Canvas 外的 overlay 状态文本、以及省界贴地
 *   的高程 provider，杜绝重复取数 / 双份纹理 / 双份解码。
 * - 领域 / 配置：resolveTerrainConfigOrThrow（src/config/terrain-config）—— 唯一的夸张系数与分段预算
 *   权威，非法配置在挂载期即抛错。本场景把 DOM 控件改的 k 经它校验后注入 mesh 与省界准备。
 * - 渲染：ChinaTerrainMesh（src/three/ChinaTerrainMesh）—— 唯一的 GPU 位移地形装配；本场景只传 props。
 *   氛围照明（光向 / 光色 / 环境光 / 雾）由 ChinaTerrainMesh 内部从 SCENE_ATMOSPHERE_CONFIG 注入着色器
 *   uniform，本场景不重复传氛围 props（单一事实源，TASK-012 实现约束「视觉参数集中管理」）。
 * - 海面（TASK-013）：SeaSurface（src/three/SeaSurface）—— 唯一的动态半透明海面装配；位于 y=0（与
 *   地形同米制海平面）、覆盖主图世界包围盒、双层流动、半透明透视水下大陆架。本场景把它作为独立
 *   渲染层挂在 Canvas 内，不与 TerrainLayer 耦合（海面不读取 heightmap、不承担加载状态职责）。
 * - 省界（TASK-014）：ProvinceBorders（src/three/ProvinceBorders）—— 唯一的省级贴地边界渲染；消费
 *   领域层 prepareProvinceBorders 的产物（已 densify + 贴地 + 按行政区分组），按行政区渲染浅青白发光线、
 *   NDC 深度偏移抗 z-fighting、与海面透明共存。本场景负责装配其依赖（heightmap pixels→ElevationProvider、
 *   province geometry→features、k、配置）并在依赖变化时确定性重算，不在场景内复制 densify / 高程 / 投影。
 * - 相机 / 控制（TASK-011）：MAP_CAMERA_CONSTRAINTS / DEFAULT_CAMERA_POSE（src/three/camera-constraints）
 *   —— 受约束东南斜俯视相机的纯计算契约（距离 / 极角 / target 边界 / FOV / near / far 全部由主图世界
 *   包围盒派生，无魔法坐标）；MapOrbitControls（src/three/MapOrbitControls）把它装配到 drei OrbitControls。
 *   本场景只把「是否启用交互」显式传入，不在场景内复制约束常量、不持有隐式相机状态。
 * - 氛围（TASK-012）：SceneAtmosphere（src/three/SceneAtmosphere）—— 把 SCENE_ATMOSPHERE_CONFIG
 *   装配成背景色 / 雾 / 半球环境光 / 单盏方向主光；阴影图总开关 SCENE_SHADOWS_ENABLED（结构性 false）
 *   显式注入 Canvas。本场景不复制氛围常量、不读取行政区 / 地点 / hover。
 * - 场景装配（本文件）：负责 Canvas / 受约束相机 / 深色氛围 / 动态海面 / 省级贴地边界 / 加载编排 /
 *   极简 DOM overlay（k 切换 + 状态）。不在此处复制 densify / 高程 / 投影，不维护 hover、不做颜色分层。
 *
 * 相机交互启停契约（TASK-011 实现约束「相机状态可被后续入场状态机统一启停，没有隐式组件状态」）：
 * - 是否启用轨道交互由本场景以单一布尔 `interactionEnabled` 显式决定，当前 = 「heightmap 已就绪」。
 *   该布尔是后续入场状态机（升起动画期间锁定相机）可统一接管的状态入口：届时把
 *   「就绪 && 升起完成」合并即可，无需改 MapOrbitControls。MapOrbitControls 不自持交互开关，
 *   故本场景不存在「组件内部猜测 DOM 状态」的第二套启停路径。
 *
 * 海面分层独立性（TASK-013 输出约束「海面作为独立渲染层，不承担地表分层设色、相机、边界或加载状态
 * 职责」）：SeaSurface 不接收任何 props、不读取 heightmap 加载状态——它在 Canvas 内始终渲染（其几何
 * 覆盖与时间动画均不依赖地形资产是否就绪）。回退本 TASK 仅移除该层，水下负高程地形、色阶、相机、
 * 氛围完整保留。
 *
 * 省界分层独立性（TASK-014 输出约束「视图层只消费准备好的线数据」「回退本 TASK 只会移除省级边界数据
 * 准备和渲染；地形、海面及全部静态行政区资产仍保持有效」）：ProvinceBordersLayer 只在 heightmap（含
 * pixels）与 province geometry 均就绪时计算并渲染；准备期任一异常被捕获、console.error 记录并跳过省界
 * （不崩溃场景——地形 / 海面 / 相机 / 氛围继续有效，符合回退边界）。省界准备层（src/lib/province-borders）
 * 单向依赖行政区几何 / 投影 / 高程查询，不依赖 React hover 状态（hover 由 TASK-018 交付）。
 *
 * 十段线 / 岛礁点位分层独立性（TASK-015 输出约束「回退本 TASK 只会移除主图十段线和岛礁点位渲染」
 * 「此前省界与海面无回归」）：PoliticalFeaturesLayer 只在 heightmap（含 pixels）与政治边界补充契约均就绪时
 * 计算并渲染；准备期任一异常（红线缺段 / 缺点、投影 / 高程查询失败、退化）被捕获、console.error 记录并
 * 跳过政治要素（不崩溃场景——地形 / 海面 / 省界 / 相机 / 氛围继续有效，符合回退边界）。政治要素准备层
 * （src/lib/political-features）单向依赖政治边界契约（TASK-006 共享事实源）/ 投影 / 高程查询 / SPEC §6
 * 红线点名领域真值（src/geo-contracts/political-catalog），不依赖 React 交互状态、不复制坐标。
 * 十段线按段独立渲染（暖琥珀虚线，与省界浅青白实线视觉明确区分）；岛礁点位以发光光点标记（规范名称
 * 文本由 TASK-016 的统一标签系统呈现）。本 TASK 不宣称取得审图号，正式发布仍被 TASK-006 的待审图状态
 * 禁止（政治边界补充数据为非官方审图数据，见 docs/political-review-record.md）。
 *
 * 阴影预算（TASK-012 实现约束「地形不投递高分辨率阴影贴图」）：Canvas shadows 显式取
 * SCENE_SHADOWS_ENABLED（结构性 false）——本 TASK 不启用任何 shadow map，地势方向感由方向光 Lambert
 * + 半球环境光体现（详见 terrain-shaders.ts / scene-atmosphere.ts）。DOM overlay 仅一个 k 切换控件 +
 * 加载 / 错误状态文本，完整 UI 由后续 TASK 接管。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode, RefObject } from 'react'
import { Canvas } from '@react-three/fiber'
import type { TerrainRenderConfig } from '../config/terrain-config'
import {
  PRODUCTION_TERRAIN_CONFIG,
  TERRAIN_EXAGGERATION_DEFAULT,
  TERRAIN_EXAGGERATION_MAX,
  TERRAIN_EXAGGERATION_MIN,
  resolveTerrainConfigOrThrow,
} from '../config/terrain-config'
import { PROVINCE_BORDERS_CONFIG } from '../config/province-borders'
import { POLITICAL_FEATURES_CONFIG } from '../config/political-features'
import { PLACE_LABELS_CONFIG } from '../config/place-labels'
import { RENDER_BUDGET_CONFIG } from '../config/render-budget'
import { ChinaTerrainMesh } from '../three/ChinaTerrainMesh'
import { loadHeightmapTexture } from '../three/load-heightmap-texture'
import type { HeightmapTextureLoadResult } from '../three/load-heightmap-texture'
import { SeaSurface } from '../three/SeaSurface'
import { ProvinceBorders } from '../three/ProvinceBorders'
import { PoliticalFeatures } from '../three/PoliticalFeatures'
import { PlaceLabels } from '../three/PlaceLabels'
import { ProvinceHoverPicker } from '../three/ProvinceHoverPicker'
import { MapOrbitControls } from '../three/MapOrbitControls'
import { SceneAtmosphere } from '../three/SceneAtmosphere'
import { EntranceController } from '../three/EntranceController'
import { RuntimeLifecycleController } from '../three/RuntimeLifecycleController'
import { SouthChinaSeaInset } from '../components/SouthChinaSeaInset'
import { Loader } from '../components/ui/Loader'
import { ElevationLegend } from '../components/ui/ElevationLegend'
import { ComplianceBadge } from '../components/ui/ComplianceBadge'
import { RuntimeStatusOverlay } from '../components/ui/RuntimeStatusOverlay'
import { DEFAULT_CAMERA_POSE, MAP_CAMERA_CONSTRAINTS } from '../three/camera-constraints'
import { SCENE_SHADOWS_ENABLED } from '../config/scene-atmosphere'
import { createElevationProvider } from '../lib/elevation'
import { loadProvinceGeometry } from '../lib/province-geometry'
import { loadPoliticalBoundary } from '../lib/political-boundary'
import { loadPlaceDirectory } from '../lib/place-directory'
import { loadDataSourceRegistry } from '../lib/data-source-registry'
import {
  loadLabelFontManifest,
  validateLabelFontCoverage,
} from '../lib/label-font'
import type { LabelFontManifest } from '../lib/label-font'
import {
  prepareProvinceBorders,
  type ProvinceBorderPrepConfig,
} from '../lib/province-borders'
import {
  preparePoliticalFeatures,
  type PoliticalFeaturePrepConfig,
} from '../lib/political-features'
import {
  collectAllLabelDomainStrings,
  preparePlaceLabels,
  type PlaceLabelPrepConfig,
} from '../lib/place-labels'
import type { TerrainWorldYSampler } from '../lib/label-occlusion'
import {
  computeAssetReadiness,
  isEntranceInteractive,
  type EntranceFrame,
  type EntrancePhase,
  type TrackedAssetState,
} from '../lib/entrance-state'
import type {
  RuntimeFrame,
  RuntimeLifecyclePhase,
} from '../lib/runtime-lifecycle'
import type {
  AdministrativeGeometryContract,
  DataSourceRegistryContract,
  PlaceDirectoryContract,
  PoliticalBoundaryContract,
} from '../geo-contracts'

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
 * entranceFrame（TASK-020）透传给 ChinaTerrainMesh 驱动「地形从平面升起」动画（复用 GPU 位移 uniform）。
 */
function TerrainLayer({
  heightmap,
  config,
  entranceFrame,
}: {
  readonly heightmap: HeightmapState
  readonly config: TerrainRenderConfig
  readonly entranceFrame: RefObject<EntranceFrame>
}): null | ReactNode {
  if (heightmap.phase !== 'ready') return null
  return <ChinaTerrainMesh heightmap={heightmap.heightmap} config={config} entranceFrame={entranceFrame} />
}

/** 省级行政区几何加载状态：加载中 / 就绪 / 失败（失败绝不静默退化为空几何）。 */
type ProvinceGeometryState =
  | { readonly phase: 'loading' }
  | { readonly phase: 'ready'; readonly contract: AdministrativeGeometryContract }
  | { readonly phase: 'error'; readonly message: string }

/**
 * 加载省级行政区几何（资产访问层 loadProvinceGeometry），就绪后返回经契约校验的 contract。
 * 与 heightmap 并行取数；省界层只在二者均就绪时计算。失败绝不退化为空几何。
 */
function useProvinceGeometry(): ProvinceGeometryState {
  const [state, setState] = useState<ProvinceGeometryState>({ phase: 'loading' })
  useEffect(() => {
    let cancelled = false
    loadProvinceGeometry()
      .then((contract) => {
        if (!cancelled) setState({ phase: 'ready', contract })
      })
      .catch((cause: unknown) => {
        if (!cancelled) {
          setState({
            phase: 'error',
            message: cause instanceof Error ? cause.message : String(cause),
          })
        }
      })
    return () => {
      cancelled = true
    }
  }, [])
  return state
}

/**
 * 省级贴地边界准备 + 渲染层（TASK-014）。
 *
 * 依赖三个就绪输入：heightmap（含 pixels，用于构造共享 ElevationProvider）、province geometry（features）、
 * 夸张系数 k。任一未就绪时返回 null（不渲染）。三者齐备时：
 * 1. 由 heightmap.meta + pixels 构造唯一的共享 ElevationProvider（createElevationProvider，不介入共享缓存——
 *    本场景持有一份即可；pixels 即取数时已解码的那份，零额外内存）。
 * 2. 调领域纯函数 prepareProvinceBorders（densify + 贴地 + 分组）产出 PreparedProvinceBorders。
 * 3. 交 ProvinceBorders 渲染（浅青白发光、NDC 深度偏移、按行政区分组）。
 *
 * 准备期异常（无效几何 / 高程查询失败 / 退化）被捕获并 console.error 记录后跳过省界——不崩溃场景
 * （地形 / 海面 / 相机 / 氛围继续有效，符合 TASK-014 回退边界）。正常合法资产下不触发。
 *
 * memo 边界：provider 仅依赖 heightmap（pixels/meta 引用稳定）；borders 依赖 features + provider + k +
 * prepConfig（prepConfig 由冻结配置派生、引用稳定）。k 切换时 borders 确定性重算（y = h·k + epsilon 随 k
 * 变化，必须重算以保持贴地）——这是离散切换的一次性开销（~毫秒级），非每帧。
 */
function ProvinceBordersLayer({
  heightmap,
  geometry,
  exaggeration,
  hoveredAdminId,
  entranceFrame,
}: {
  readonly heightmap: HeightmapState
  readonly geometry: ProvinceGeometryState
  readonly exaggeration: number
  readonly hoveredAdminId: string | null
  readonly entranceFrame: RefObject<EntranceFrame>
}): null | ReactNode {
  // 所有 Hook 必须无条件调用（react-hooks/rules-of-hooks）：就绪判定移入 Hook 内部，不在 Hook 前 early return。
  // 由 heightmap 的 meta + pixels 构造共享 ElevationProvider（pixels 即取数时已解码的 Uint16Array，零额外内存）。
  // heightmap 未就绪时 provider=null（不构造），下游 result useMemo 据此跳过准备。
  const provider = useMemo(() => {
    if (heightmap.phase !== 'ready') return null
    return createElevationProvider(heightmap.heightmap.meta, heightmap.heightmap.pixels)
  }, [heightmap])

  // 省界准备配置由冻结的 PROVINCE_BORDERS_CONFIG 派生（densify 间距 + epsilon），引用稳定。
  const prepConfig = useMemo<ProvinceBorderPrepConfig>(
    () => ({
      densifySpacingMeters: PROVINCE_BORDERS_CONFIG.densifySpacingMeters,
      terrainEpsilonMeters: PROVINCE_BORDERS_CONFIG.terrainEpsilonMeters,
    }),
    [],
  )

  // 准备期可能抛 ProvinceBorderPrepError（无效几何 / 查询失败 / 退化）——捕获并记录，跳过省界不崩溃场景。
  // 未就绪（heightmap / geometry / provider 任缺）时返回 notReady，渲染 null。
  const result = useMemo(() => {
    if (heightmap.phase !== 'ready' || geometry.phase !== 'ready' || provider === null) {
      return { ok: false as const, notReady: true }
    }
    try {
      return {
        ok: true as const,
        borders: prepareProvinceBorders(geometry.contract.features, provider, exaggeration, prepConfig),
      }
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause)
      // 准备失败：console 记录便于排查，但不抛出（不崩溃场景）；合法资产下正常路径不触发。
      // eslint-disable-next-line no-console
      console.error(`[ProvinceBorders] 贴地边界准备失败：${message}`)
      return { ok: false as const, notReady: false }
    }
  }, [heightmap, geometry, provider, exaggeration, prepConfig])

  if (!result.ok) return null
  return (
    <ProvinceBorders
      borders={result.borders}
      hoveredAdminId={hoveredAdminId}
      entranceFrame={entranceFrame}
    />
  )
}

/** 政治边界补充契约加载状态：加载中 / 就绪 / 失败（失败绝不静默退化为空契约——红线完整性）。 */
type PoliticalBoundaryState =
  | { readonly phase: 'loading' }
  | { readonly phase: 'ready'; readonly contract: PoliticalBoundaryContract }
  | { readonly phase: 'error'; readonly message: string }

/**
 * 加载政治边界补充契约（资产访问层 loadPoliticalBoundary），就绪后返回经契约校验的 contract。
 * 与 heightmap / province geometry 并行取数；政治要素层只在 heightmap 与 contract 均就绪时计算。
 * 失败绝不退化为空 / 伪造契约（TASK-015 红线：政治边界完整性）。
 */
function usePoliticalBoundary(): PoliticalBoundaryState {
  const [state, setState] = useState<PoliticalBoundaryState>({ phase: 'loading' })
  useEffect(() => {
    let cancelled = false
    loadPoliticalBoundary()
      .then((contract) => {
        if (!cancelled) setState({ phase: 'ready', contract })
      })
      .catch((cause: unknown) => {
        if (!cancelled) {
          setState({
            phase: 'error',
            message: cause instanceof Error ? cause.message : String(cause),
          })
        }
      })
    return () => {
      cancelled = true
    }
  }, [])
  return state
}

/**
 * 十段线 / 岛礁点位准备 + 渲染层（TASK-015）。
 *
 * 依赖两个就绪输入：heightmap（含 pixels，构造共享 ElevationProvider）与政治边界补充契约（features）。
 * 任一未就绪时返回 null（不渲染）。二者齐备时：
 * 1. 由 heightmap.meta + pixels 构造 ElevationProvider（与省界层各自构造、共享同一份 pixels，零额外内存）。
 * 2. 调领域纯函数 preparePoliticalFeatures（红线完整性校验 + densify + 海平面贴合 + 按段分组）产出
 *    PreparedPoliticalFeatures。
 * 3. 交 PoliticalFeatures 渲染（暖琥珀虚线 + 岛礁光点、NDC 深度偏移、与海面 / 省界透明共存）。
 *
 * 准备期异常（红线缺段 / 缺点、投影 / 高程查询失败、退化）被捕获并 console.error 记录后跳过政治要素——
 * 不崩溃场景（地形 / 海面 / 省界 / 相机 / 氛围继续有效，符合 TASK-015 回退边界）。正常合法资产下不触发。
 *
 * memo 边界：provider 仅依赖 heightmap（pixels/meta 引用稳定）；features 依赖 contract + provider + k +
 * prepConfig（prepConfig 由冻结配置派生、引用稳定）。k 切换时 features 确定性重算（海平面贴合 y 随 k
 * 变化，必须重算以保持贴合）——与省界同构的离散切换一次性开销（~毫秒级），非每帧。
 */
function PoliticalFeaturesLayer({
  heightmap,
  political,
  exaggeration,
  entranceFrame,
}: {
  readonly heightmap: HeightmapState
  readonly political: PoliticalBoundaryState
  readonly exaggeration: number
  readonly entranceFrame: RefObject<EntranceFrame>
}): null | ReactNode {
  // 所有 Hook 必须无条件调用（react-hooks/rules-of-hooks）：就绪判定移入 Hook 内部。
  // 由 heightmap 的 meta + pixels 构造 ElevationProvider（与省界层各自构造、共享同一份 pixels，零额外内存）。
  const provider = useMemo(() => {
    if (heightmap.phase !== 'ready') return null
    return createElevationProvider(heightmap.heightmap.meta, heightmap.heightmap.pixels)
  }, [heightmap])

  // 政治要素准备配置由冻结的 POLITICAL_FEATURES_CONFIG 派生（densify 间距 + epsilon + 海平面 y），引用稳定。
  const prepConfig = useMemo<PoliticalFeaturePrepConfig>(
    () => ({
      densifySpacingMeters: POLITICAL_FEATURES_CONFIG.densifySpacingMeters,
      terrainEpsilonMeters: POLITICAL_FEATURES_CONFIG.terrainEpsilonMeters,
      seaLevelYMeters: POLITICAL_FEATURES_CONFIG.seaLevelYMeters,
    }),
    [],
  )

  // 准备期可能抛 PoliticalFeaturePrepError（红线缺项 / 查询失败 / 退化）——捕获并记录，跳过政治要素不崩溃场景。
  // 未就绪（heightmap / political / provider 任缺）时返回 notReady，渲染 null。
  const result = useMemo(() => {
    if (heightmap.phase !== 'ready' || political.phase !== 'ready' || provider === null) {
      return { ok: false as const, notReady: true }
    }
    try {
      return {
        ok: true as const,
        features: preparePoliticalFeatures(
          political.contract,
          provider,
          exaggeration,
          prepConfig,
        ),
      }
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause)
      // 准备失败：console 记录便于排查，但不抛出（不崩溃场景）；合法资产下正常路径不触发。
      // eslint-disable-next-line no-console
      console.error(`[PoliticalFeatures] 十段线 / 岛礁点位准备失败：${message}`)
      return { ok: false as const, notReady: false }
    }
  }, [heightmap, political, provider, exaggeration, prepConfig])

  if (!result.ok) return null
  return <PoliticalFeatures features={result.features} entranceFrame={entranceFrame} />
}

/** 地点目录加载状态：加载中 / 就绪 / 失败（失败绝不静默退化为空目录——标签完整性）。 */
type PlaceDirectoryState =
  | { readonly phase: 'loading' }
  | { readonly phase: 'ready'; readonly contract: PlaceDirectoryContract }
  | { readonly phase: 'error'; readonly message: string }

/**
 * 加载地点目录（资产访问层 loadPlaceDirectory），就绪后返回经契约校验的 contract。
 * 与 heightmap / province geometry / political boundary 并行取数；标签层只在 heightmap + 地点目录 + 政治边界
 * 均就绪时计算（TASK-016）。失败绝不退化为空目录（标签会基于残缺数据产出缺省标签）。
 */
function usePlaceDirectory(): PlaceDirectoryState {
  const [state, setState] = useState<PlaceDirectoryState>({ phase: 'loading' })
  useEffect(() => {
    let cancelled = false
    loadPlaceDirectory()
      .then((contract) => {
        if (!cancelled) setState({ phase: 'ready', contract })
      })
      .catch((cause: unknown) => {
        if (!cancelled) {
          setState({
            phase: 'error',
            message: cause instanceof Error ? cause.message : String(cause),
          })
        }
      })
    return () => {
      cancelled = true
    }
  }, [])
  return state
}

/** 离线字体清单加载状态：加载中 / 就绪 / 失败（失败绝不静默退化——缺字需明确状态）。 */
type LabelFontManifestState =
  | { readonly phase: 'loading' }
  | { readonly phase: 'ready'; readonly manifest: LabelFontManifest }
  | { readonly phase: 'error'; readonly message: string }

/**
 * 加载离线字体清单（资产访问层 loadLabelFontManifest），就绪后返回经结构校验的清单。
 * 清单记录字体实际包含的字符集合，供标签层在渲染前做覆盖校验（缺字即不渲染标签 + 错误状态，
 * 不静默显示空白 / fallback 网络字体）。失败绝不退化为空清单。
 */
function useLabelFontManifest(): LabelFontManifestState {
  const [state, setState] = useState<LabelFontManifestState>({ phase: 'loading' })
  useEffect(() => {
    let cancelled = false
    loadLabelFontManifest(PLACE_LABELS_CONFIG.fontManifestPath)
      .then((manifest) => {
        if (!cancelled) setState({ phase: 'ready', manifest })
      })
      .catch((cause: unknown) => {
        if (!cancelled) {
          setState({
            phase: 'error',
            message: cause instanceof Error ? cause.message : String(cause),
          })
        }
      })
    return () => {
      cancelled = true
    }
  }, [])
  return state
}

/** 数据来源注册表加载状态：加载中 / 就绪 / 失败（失败绝不静默退化为空注册表——合规署名完整性）。 */
type DataSourceRegistryState =
  | { readonly phase: 'loading' }
  | { readonly phase: 'ready'; readonly contract: DataSourceRegistryContract }
  | { readonly phase: 'error'; readonly message: string }

/**
 * 加载数据来源注册表（资产访问层 loadDataSourceRegistry，TASK-021）。
 *
 * 该注册表（public/geo/data-sources.json）是 TASK-001 来源声明契约的生产事实源，承载 DEM / 边界 / 政治补充
 * 等全部来源声明（含非官方审图免责声明）。合规角标（ComplianceBadge）从中派生三类必备署名，不复制来源
 * 名称字面量。
 *
 * 独立性（TASK-021 实现约束「合规角标只消费来源 / 审图状态，不得反向控制资产、场景或交互」）：本 hook
 * **不**计入 trackedAssets（不参与入场资产就绪判定、不阻塞相机解锁 / 升起动画）——合规角标是静态 overlay，
 * 其加载状态只决定角标何时呈现，不影响 3D 场景与入场编排。回退本 TASK 仅移除图例 + 角标，来源注册表
 * 资产仍保留（各资产 provenance 引用它）。
 */
function useDataSourceRegistry(): DataSourceRegistryState {
  const [state, setState] = useState<DataSourceRegistryState>({ phase: 'loading' })
  useEffect(() => {
    let cancelled = false
    loadDataSourceRegistry()
      .then((contract) => {
        if (!cancelled) setState({ phase: 'ready', contract })
      })
      .catch((cause: unknown) => {
        if (!cancelled) {
          setState({
            phase: 'error',
            message: cause instanceof Error ? cause.message : String(cause),
          })
        }
      })
    return () => {
      cancelled = true
    }
  }, [])
  return state
}

/**
 * 省名 / 省会光点 / 岛礁名称标注准备 + 渲染层（TASK-016）。
 *
 * 依赖五个就绪输入：heightmap（含 pixels，构造共享 ElevationProvider）、地点目录（省名锚点 + 省级行政中心）、
 * 政治边界补充契约（岛礁名称 + 坐标）、夸张系数 k、离线字体清单。任一未就绪时返回 null（不渲染）。
 * 全部齐备时：
 * 1. 由 heightmap.meta + pixels 构造 ElevationProvider（与省界 / 政治要素层各自构造、共享同一份 pixels）。
 * 2. 调领域纯函数 preparePlaceLabels（投影 + 贴地 / 浮高 + 红线断言）产出 PreparedPlaceLabels。
 * 3. collectAllLabelDomainStrings 从地点 / 政治契约提取字体必须覆盖的全部领域字符串。
 * 4. validateLabelFontCoverage 断言字体清单 ⊇ 领域字符串（缺字即 coverage-incomplete）。
 * 5. 由 provider + k 构造 terrainQuery（TASK-017 地形世界 y 采样器，遮挡判定用）。
 * 6. 覆盖校验通过则交 PlaceLabels 渲染（Billboard Text + 发光光点，始终面向相机）+ 注入 terrainQuery
 *    使省名 / 岛礁名标签按地形遮挡淡化（TASK-017）。
 *
 * 准备 / 覆盖期异常（角色-配对失衡 / 点名岛礁缺项 / 投影 / 高程查询失败 / 字体缺字）被捕获并 console.error
 * 记录后跳过标签——不崩溃场景（地形 / 海面 / 省界 / 十段线 / 相机 / 氛围继续有效，符合 TASK-016 回退边界）。
 *
 * memo 边界：provider 仅依赖 heightmap；labels 依赖 place + political + provider + k + prepConfig；
 * coverage 依赖 labels + manifest；terrainQuery（TASK-017 遮挡采样器）依赖 provider + k。k 切换时 labels
 * 与 terrainQuery 确定性重算（浮高 / 贴地 / 地形世界 y 随 k 变化）——离散切换一次性开销。
 */
function PlaceLabelsLayer({
  heightmap,
  places,
  political,
  fontManifest,
  exaggeration,
  hoveredAdminId,
  entranceFrame,
}: {
  readonly heightmap: HeightmapState
  readonly places: PlaceDirectoryState
  readonly political: PoliticalBoundaryState
  readonly fontManifest: LabelFontManifestState
  readonly exaggeration: number
  readonly hoveredAdminId: string | null
  readonly entranceFrame: RefObject<EntranceFrame>
}): null | ReactNode {
  // 所有 Hook 必须无条件调用（rules-of-hooks）：就绪判定移入 Hook 内部。
  // 由 heightmap 的 meta + pixels 构造 ElevationProvider（与省界 / 政治要素层各自构造、共享同一份 pixels）。
  const provider = useMemo(() => {
    if (heightmap.phase !== 'ready') return null
    return createElevationProvider(heightmap.heightmap.meta, heightmap.heightmap.pixels)
  }, [heightmap])

  // 标签准备配置由冻结的 PLACE_LABELS_CONFIG 派生（省名 / 岛礁浮高 + epsilon + 海平面 y），引用稳定。
  const prepConfig = useMemo<PlaceLabelPrepConfig>(
    () => ({
      provinceLabelHeightOffsetMeters: PLACE_LABELS_CONFIG.provinceLabelHeightOffsetMeters,
      islandLabelHeightOffsetMeters: PLACE_LABELS_CONFIG.islandLabelHeightOffsetMeters,
      terrainEpsilonMeters: PLACE_LABELS_CONFIG.terrainEpsilonMeters,
      seaLevelYMeters: PLACE_LABELS_CONFIG.seaLevelYMeters,
    }),
    [],
  )

  // 地形世界 y 采样器（TASK-017 标签遮挡判定用）：把共享 ElevationProvider 的真实米制高程经夸张系数 k
  // 还原为世界地形 y = h·k（与 GPU 位移同一公式），供 PlaceLabels 的遮挡层沿「标签→相机」射线采样。
  // provider 未就绪时返回 null（遮挡层据此不发射线、标签保持默认可见——生命周期守护）。闭包不分配大
  // 对象：每次调用只走 provider.queryAtWorld（返回判别联合，失败即 null）。provider / k 变化时重建闭包。
  const terrainQuery = useMemo<TerrainWorldYSampler | null>(() => {
    if (provider === null) return null
    const k = exaggeration
    return (worldX: number, worldZ: number): number | null => {
      const query = provider.queryAtWorld(worldX, worldZ)
      if (!query.ok) return null
      return query.meters * k
    }
  }, [provider, exaggeration])

  // 准备 + 覆盖校验：任一输入未就绪返回 notReady；准备 / 覆盖异常捕获、记录、跳过标签不崩溃场景。
  const result = useMemo(() => {
    if (
      heightmap.phase !== 'ready' ||
      places.phase !== 'ready' ||
      political.phase !== 'ready' ||
      fontManifest.phase !== 'ready' ||
      provider === null
    ) {
      return { ok: false as const, notReady: true }
    }
    try {
      // 1. 准备标签（投影 + 贴地 / 浮高 + 红线断言）。
      const labels = preparePlaceLabels(
        places.contract,
        political.contract,
        provider,
        exaggeration,
        prepConfig,
      )
      // 2. 字体覆盖校验：从契约提取领域字符串，断言字体清单 ⊇ 领域字符串。缺字即抛 coverage-incomplete。
      const domainStrings = collectAllLabelDomainStrings(places.contract, political.contract)
      const coverage = validateLabelFontCoverage(fontManifest.manifest, domainStrings)
      if (!coverage.ok) {
        throw new Error(
          `${coverage.message}${coverage.missingCharacters !== undefined ? `（缺失：[${coverage.missingCharacters.join('、')}]）` : ''}`,
        )
      }
      return { ok: true as const, labels }
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause)
      // 准备 / 覆盖失败：console 记录便于排查，但不抛出（不崩溃场景）；合法资产下正常路径不触发。
      // eslint-disable-next-line no-console
      console.error(`[PlaceLabels] 省名 / 省会光点 / 岛礁名称标签准备或字体覆盖校验失败：${message}`)
      return { ok: false as const, notReady: false }
    }
  }, [heightmap, places, political, fontManifest, provider, exaggeration, prepConfig])

  if (!result.ok) return null
  return (
    <PlaceLabels
      labels={result.labels}
      terrainQuery={terrainQuery}
      hoveredAdminId={hoveredAdminId}
      entranceFrame={entranceFrame}
    />
  )
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
  // 省级行政区几何并行取数（与 heightmap 独立）；省界层只在二者均就绪时计算（TASK-014）。
  const geometry = useProvinceGeometry()
  // 政治边界补充契约并行取数（与 heightmap / province geometry 独立）；政治要素层只在 heightmap 与 contract
  // 均就绪时计算（TASK-015）。
  const political = usePoliticalBoundary()
  // 地点目录并行取数（TASK-016）：省名锚点 + 省级行政中心；标签层只在 heightmap + 地点 + 政治边界均就绪时计算。
  const places = usePlaceDirectory()
  // 离线字体清单并行取数（TASK-016）：标签层渲染前据此做字体覆盖校验，缺字即不渲染 + 错误状态。
  const fontManifest = useLabelFontManifest()
  // 数据来源注册表并行取数（TASK-021）：合规角标从中派生三类必备署名。不计入 trackedAssets（独立 overlay，
  // 不影响入场 / 相机 / 场景）。失败时角标不渲染（不静默显示缺来源的角标），主图 / 附图不受影响。
  const dataSources = useDataSourceRegistry()

  // 省级悬停焦点状态（TASK-018 单一焦点源）：稳定 adminId（CN- 前缀）或 null（无焦点）。这是边界样式与
  // 标签样式的**唯一**交互输入——ProvinceHoverPicker 把指针命中翻译成 adminId | null 并回调本 setter，
  // ProvinceBordersLayer / PlaceLabelsLayer 只消费该状态派生各自样式，不再各自拾取。状态以稳定标识表达，
  // 不保存 Three.js 对象引用 / 中文名匹配 / 多组件布尔组合（TASK-018 实现约束）。
  const [hoveredAdminId, setHoveredAdminId] = useState<string | null>(null)
  // 恢复不变量（TASK-018）：geometry 失效（未就绪 / 错误 / 卸载）时显式复位焦点为 null——ProvinceHoverPicker
  // 在 geometry 未就绪时不渲染（无拾取面），不再回调；若此时焦点残留为某 adminId，会指向已失效的几何，
  // 故在此复位。仅在 phase 变化时触发（依赖 geometry.phase），非每帧。
  useEffect(() => {
    if (geometry.phase !== 'ready') {
      setHoveredAdminId(null)
    }
  }, [geometry.phase])

  // 入场编排（TASK-020 单一显式状态流）：把五个资产 hook 的真实状态映射为受跟踪资产状态列表，
  // 由 computeAssetReadiness（纯函数）聚合为 ready / failed / loadedCount / totalCount——DOM 进度只反映真实
  // 资产，不伪造计时。entranceFrame 是 Canvas 内外共享的「同一时间源」ref：EntranceController 每帧写入
  // phase + elapsed，各渲染层 useFrame 只读消费派生各自 rise / 透明度（不由组件私自计时）。phase 是 React
  // state（仅阶段切换时更新，约 4 次），驱动 DOM 加载反馈与相机交互锁——非每帧 setState。
  const trackedAssets = useMemo<readonly TrackedAssetState[]>(
    () => [
      { key: 'heightmap', phase: heightmap.phase, errorMessage: heightmap.phase === 'error' ? heightmap.message : null },
      { key: 'provinceGeometry', phase: geometry.phase, errorMessage: geometry.phase === 'error' ? geometry.message : null },
      { key: 'politicalBoundary', phase: political.phase, errorMessage: political.phase === 'error' ? political.message : null },
      { key: 'placeDirectory', phase: places.phase, errorMessage: places.phase === 'error' ? places.message : null },
      { key: 'labelFontManifest', phase: fontManifest.phase, errorMessage: fontManifest.phase === 'error' ? fontManifest.message : null },
    ],
    [heightmap, geometry, political, places, fontManifest],
  )
  const readiness = useMemo(() => computeAssetReadiness(trackedAssets), [trackedAssets])
  // 入场帧 ref：初值 loading / elapsed=0；EntranceController（Canvas 内）每帧覆盖。useRef 在 StrictMode 重挂载
  // 下保持同一对象（同 fiber），与 EntranceController 的起始时刻幂等捕获共同保证「动画只启动一次」。
  const entranceFrameRef = useRef<EntranceFrame>({ phase: 'loading', elapsedSeconds: 0 })
  // 入场阶段（React state，仅阶段切换更新）：初值 = 资产失败即 error、否则 loading。EntranceController 在阶段
  // 切换帧回调 setEntrancePhase，驱动 DOM 加载反馈与相机交互锁。非每帧 setState（逐帧视觉值走 entranceFrameRef）。
  const [entrancePhase, setEntrancePhase] = useState<EntrancePhase>(
    readiness.failed ? 'error' : 'loading',
  )

  // 运行时生命周期（TASK-022 集中编排）：runtimeFrameRef 是 Canvas 内外共享的「集中编排 → 各消费者」信号载体，
  // RuntimeLifecycleController 在 context 阶段切换时原地写其 phase + paused，EntranceController / SeaSurface 各自
  // useFrame 只读 paused 决定是否冻结视觉推进（不各自监听 context 事件——集中编排契约）。runtimePhase 是 React
  // state（仅阶段切换更新，约 0–数次：正常 24h 运行可能从不切换），驱动 DOM 诊断（RuntimeStatusOverlay）与
  // 相机交互锁。committedSize 是 resize 防抖提交后的最终尺寸（= 最后一次输入），可供 overlay 派生尺寸消费。
  const runtimeFrameRef = useRef<RuntimeFrame>({ phase: 'running', paused: false })
  const [runtimePhase, setRuntimePhase] = useState<RuntimeLifecyclePhase>('running')
  const [runtimeFailureMessage, setRuntimeFailureMessage] = useState<string | null>(null)
  // 阶段切换回调（仅切换时调用——RuntimeLifecycleController 内部已去重）：写 React state 驱动 DOM 诊断。
  // 用 useCallback 固定身份，避免下游因回调身份变化重渲染 / 重注册（集中编排的回调边界稳定）。
  const handleRuntimePhaseChange = useCallback(
    (phase: RuntimeLifecyclePhase, failureMessage: string | null) => {
      setRuntimePhase(phase)
      setRuntimeFailureMessage(failureMessage)
    },
    [],
  )
  // resize 提交回调（防抖窗口结束后调用）：记录最终尺寸，可供 overlay 派生消费。用 useCallback 固定身份。
  const handleCommittedSize = useCallback((width: number, height: number) => {
    // 当前 overlay 均用 CSS 响应式布局（不依赖 JS 尺寸），此处记录以备后续需要；零开销（无 overlay 消费时不触发重渲染）。
    void width
    void height
  }, [])

  // 受约束相机的交互启停（TASK-011 启停契约 + TASK-020 交互锁 + TASK-022 运行时锁）：单一显式布尔 =
  // 入场到达 interactive **且** 运行时处于 running。loading / error / 三个动画阶段锁定相机（无意义旋转）；
  // context-lost / restoring / restore-failed 亦锁定（场景冻结 / 损坏，无意义交互）。两条件均单调到达，
  // 故交互只在「入场完成 && 运行正常」时解锁（不会提前 / 重复解锁）。
  const interactionEnabled = isEntranceInteractive(entrancePhase) && runtimePhase === 'running'

  /*
   * 生产渲染性能预算（TASK-023 性能预算固化，SPEC §7.3 / §7.4、TASK-023 输出与实现约束）：
   *
   * DPR 上限：Canvas dpr 取自 RENDER_BUDGET_CONFIG.dprMin / dprMax（= [1, 2]，src/config/render-budget
   * 唯一事实源）。DPR 上限 2 是结构性决定：4K × DPR 2 的绘制缓冲是大屏独显的合理上限，DPR 大于 2 会把
   * 绘制缓冲与显存带宽推到边际收益递减区间，故硬性钳制。R3F 在此 [min, max] 区间内按 devicePixelRatio
   * 自动取值，4K 屏 DPR 2 即触顶。
   *
   * 网格档位（不自动升级）：生产默认 2048²（PRODUCTION_TERRAIN_CONFIG，由 terrain-config 校验），
   * 4096² 仅在上层显式以 initialConfig.meshSegments=4096 注入时启用——场景装配无「检测 GPU / 帧率后
   * 自动升级」路径（UPPER_TIER_AUTO_UPGRADE_ENABLED=false）。是否启用 4096² 只由人工实测帧率 / 显存
   * 决定（docs/performance-measurement-record.md），绝不自动升降档伪造通过。
   *
   * 缓存所有权（单次离线加载、常驻复用）：heightmap 纹理 + CPU 高程像素在 useHeightmap hook 内一次性
   * 加载，经 props 下发各渲染层共享（同一份 GPU 纹理、同一份 pixels 包装出的 ElevationProvider）。
   * 无运行时流式网络（RUNTIME_STREAMING_ENABLED=false）、无自动低清 fallback
   * （AUTO_LOW_RES_FALLBACK_ENABLED=false）。context 丢失 / 恢复时由 restoreSceneGpuResources 从同一份
   * CPU 源重新上传 GPU，绝不重新 fetch / 重新解码（TASK-022，本 TASK 不回归）。
   *
   * 逐帧分配不变量（PER_FRAME_ALLOCATION_FORBIDDEN=true）：全部 useFrame 回调只写既有 uniform / 材质
   * 标量字段（.value / .opacity / .fillOpacity），不逐帧创建几何 / 纹理 / 大数组 / 新 Clock（视觉时钟
   * 统一由 R3F 共享 clock 承载）。
   *
   * 测量边界：1080p / 4K 持续 60fps 是目标独显设备上的人工性能验收项，由用户在目标环境手动执行并
   * 记录（docs/performance-measurement-record.md）。本场景不自动启动浏览器、不自动测量、不自动降级。
   * 性能预算不变量（DPR 上限 ≤ 2、默认档 2048²、不自动升级、无流式 / fallback、显存 / draw call 预算
   * 有限）由 tests/render-budget.test.ts 在 Node 环境断言。
   */
  return (
    <div className="china-map-screen">
      <Canvas
        camera={{
          fov: MAP_CAMERA_CONSTRAINTS.fovDegrees,
          near: MAP_CAMERA_CONSTRAINTS.near,
          far: MAP_CAMERA_CONSTRAINTS.far,
          position: [DEFAULT_CAMERA_POSE.position.x, DEFAULT_CAMERA_POSE.position.y, DEFAULT_CAMERA_POSE.position.z],
        }}
        dpr={[RENDER_BUDGET_CONFIG.dprMin, RENDER_BUDGET_CONFIG.dprMax]}
        shadows={SCENE_SHADOWS_ENABLED}
      >
        <SceneAtmosphere />
        {/*
          运行时生命周期集中编排器（TASK-022，SPEC §7.4）：Canvas 内唯一监听 webglcontextlost /
          webglcontextrestored 的组件 + 唯一 resize 防抖提交点。把 context 事件 / GPU 重建结果 / 防抖后尺寸
          翻译为集中信号——阶段切换时原地写共享 runtimeFrameRef（EntranceController / SeaSurface 各自 useFrame
          只读 paused 决定冻结视觉推进，不各自监听 context）+ 回调上层驱动 DOM 诊断；resize 防抖后提交最终尺寸
          同步渲染器 / 相机 / overlay。context 丢失时 preventDefault（阻止默认不可恢复行为）+ 暂停视觉推进；
          恢复时遍历场景重建 GPU 纹理 / 材质（复用同一份 CPU 高程像素，绝不重新解码 .r16）；重建抛错 / 恢复
          超时 → restore-failed（显式终态 + 诊断，不回退旧实现 / 远程 fallback）。无几何 / 无 DOM 输出。
          监听器挂载期注册一次、卸载移除一次（无重复监听）；不新建 THREE.Clock（视觉时钟仍由 R3F 共享 clock
          承载，本组件的 setTimeout 仅用于 context 恢复超时与 resize 防抖，非动画时钟）。
        */}
        <RuntimeLifecycleController
          onPhaseChange={handleRuntimePhaseChange}
          runtimeFrame={runtimeFrameRef}
          onCommittedSize={handleCommittedSize}
        />
        {/*
          入场编排驱动器（TASK-020 单一显式状态流 / 单一时间源）：Canvas 内每帧从 R3F 共享 clock 派生入场
          elapsed、deriveEntrancePhase 得当前阶段，写入共享 entranceFrameRef（各渲染层 useFrame 只读消费派生
          rise / 透明度），阶段切换时回调 setEntrancePhase 驱动 DOM 加载反馈与相机交互锁。无几何 / 无 DOM 输出。
          重复渲染 / StrictMode 重挂载 / 资产完成顺序变化下，起始时刻幂等捕获 + 单调 elapsed 保证动画只启动
          一次、阶段顺序固定、交互只在 interactive 启用。
        */}
        <EntranceController
          readiness={readiness}
          onPhaseChange={setEntrancePhase}
          entranceFrame={entranceFrameRef}
          runtimeFrame={runtimeFrameRef}
        />
        <MapOrbitControls enabled={interactionEnabled} />
        <TerrainLayer heightmap={heightmap} config={config} entranceFrame={entranceFrameRef} />
        {/*
          动态海面（TASK-013）：独立渲染层，位于 y=0、覆盖主图海域、双层流动、半透明透视水下大陆架。
          entranceFrame（TASK-020）透传驱动「水面随后淡入」——uOpacity = 配置基线透明度 × 入场场景层透明度，
          使海面在省名标签淡入后随水面 / 边界阶段平滑淡入。透明 + 不写深度，使水下地形透过海面可见、陆地
          遮挡海面（无穿插）。回退 TASK-013 仅移除该层；回退 TASK-020 仅移除 entranceFrame 透传（海面直接可见）。
        */}
        <SeaSurface entranceFrame={entranceFrameRef} runtimeFrame={runtimeFrameRef} />
        {/*
          省级贴地边界（TASK-014）：heightmap（含 pixels，构造共享 ElevationProvider）与 province geometry 均
          就绪时 densify + 贴地 + 按行政区分组渲染。准备期异常被捕获、跳过省界不崩溃场景（回退边界）。
          浅青白发光线、NDC 深度偏移抗 z-fighting、与半透明海面共存；按行政区分组，hoveredAdminId（TASK-018）
          命中省份加亮加粗、非焦点压暗、无焦点基线。entranceFrame（TASK-020）驱动「边界随后淡入」。
        */}
        <ProvinceBordersLayer
          heightmap={heightmap}
          geometry={geometry}
          exaggeration={config.exaggeration}
          hoveredAdminId={hoveredAdminId}
          entranceFrame={entranceFrameRef}
        />
        {/*
          省级悬停拾取（TASK-018）：geometry 就绪时挂载不可见拾取面，把指针命中的世界 (x,z) 经 invertWorld
          反算成 (lon,lat)、再经 findProvinceAtLonLat 裁决所属省份，回调更新单一 hoveredAdminId 状态。该状态是
          边界 / 标签样式的唯一焦点源——二者只消费，不各自拾取。无 click 行为（只注册 move / out / leave）。
          geometry 未就绪时不渲染（无几何无法裁决，避免错误焦点）。回退本 TASK 仅移除该拾取面与焦点状态，
          静态省界 / 标签保持 TASK-017 完成时的行为（TASK-018 回退边界）。
        */}
        {geometry.phase === 'ready' && (
          <ProvinceHoverPicker
            features={geometry.contract.features}
            onHoveredProvinceChange={setHoveredAdminId}
          />
        )}
        {/*
          十段线与岛礁点位（TASK-015）：heightmap（含 pixels，构造共享 ElevationProvider）与政治边界补充契约
          均就绪时红线完整性校验 + densify + 海平面贴合 + 按段分组渲染。准备期异常（缺段 / 缺点 / 查询失败 /
          退化）被捕获、跳过政治要素不崩溃场景（回退边界）。暖琥珀虚线（与省界浅青白实线视觉明确区分）+
          岛礁发光光点；NDC 深度偏移抗 z-fighting、与半透明海面 / 省界透明共存。entranceFrame（TASK-020）驱动
          「水面 / 边界随后淡入」。本 TASK 不宣称取得审图号，内部展示状态下验收（政治边界补充数据为非官方
          审图数据，见 docs/political-review-record.md）。
        */}
        <PoliticalFeaturesLayer
          heightmap={heightmap}
          political={political}
          exaggeration={config.exaggeration}
          entranceFrame={entranceFrameRef}
        />
        {/*
          省名 / 省会光点 / 岛礁名称标注（TASK-016）：heightmap（含 pixels，构造共享 ElevationProvider）+ 地点
          目录 + 政治边界契约 + 离线字体清单均就绪时投影 + 贴地 / 浮高 + 字体覆盖校验后渲染。准备 / 覆盖期异常
          （角色-配对失衡 / 点名岛礁缺项 / 投影 / 高程查询失败 / 字体缺字）被捕获、跳过标签不崩溃场景（回退边界）。
          Billboard Text（始终面向相机）+ 暖琥珀省会发光光点；字体取本地子集（无在线请求）。entranceFrame
          （TASK-020）驱动「省名标签自西向东错峰淡入 + 省会 / 岛礁名随省名阶段整体淡入」，与遮挡透明度乘法合成。
          本 TASK 不宣称取得审图号，内部展示状态下验收（坐标为非官方审图数据，见 docs/political-review-record.md）。
        */}
        <PlaceLabelsLayer
          heightmap={heightmap}
          places={places}
          political={political}
          fontManifest={fontManifest}
          exaggeration={config.exaggeration}
          hoveredAdminId={hoveredAdminId}
          entranceFrame={entranceFrameRef}
        />
      </Canvas>

      {/*
        DOM overlay（TASK-020 起含加载 / 入场反馈）：k 切换（验证步骤 4）+ 加载进度 / 错误 / 入场阶段提示
        （Loader，只反映真实受跟踪资产状态，不伪造计时进度）。完整外围 UI（海拔色阶图例、审图号 / 署名角标）
        由后续 TASK 接管。
      */}
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
        {/*
          海拔色阶图例（TASK-021，SPEC §9）：左侧竖向贴边 DOM overlay，独立于 3D 画布。色条渐变与关键刻度的
          颜色 / 位置全部从 TASK-010 色阶唯一事实源派生（prepareElevationLegend → sampleElevationColor /
          normalizeElevationToRampU，与地表片元着色器同一采样器与归一化），不复制断点 / 颜色。关键刻度
          0 / 1000 / 2000 / 3500 / 5000 / 8848m 齐全，0m 标注「海平面」使水下色段有读图含义。无 props——呈现
          常量全部来自配置层冻结常量，挂载即稳定呈现、不依赖 3D 资产加载。布局：左侧纵向居中，不遮挡主图核心
          （中央地形）、不与左上 k 控件 / 右下南海附图 / 左下合规角标重叠。回退本 TASK 仅移除该图例。
          图例置于 Loader 之前（DOM 序）：加载全屏 Loader 覆盖于其上，加载完成后自然显露。
        */}
        <ElevationLegend />
        {/*
          合规角标（TASK-021，SPEC §8 / §6）：左下角低调半透明 DOM overlay，独立于 3D 画布。审图号占位为
          未送审形态（字面 GS(202x)xxxx 号 + 状态「未取得审图号 · 仅内部展示」，不伪造已批复号码）；三类必备
          来源署名（DEM / 行政区边界 / 政治边界补充）从来源注册表派生，不复制来源名称字面量；完整免责声明
          （非官方 / 仅内部 / 不得正式发布）至取得真实审图号前不得删除。dataSources 就绪时挂载；不计入
          trackedAssets（独立 overlay，不影响入场 / 相机 / 场景）。回退本 TASK 仅移除该角标。
        */}
        {dataSources.phase === 'ready' && <ComplianceBadge registry={dataSources.contract} />}
        {/*
          加载 / 入场 DOM 反馈（TASK-020）：loading 显示真实进度条（loadedCount / totalCount，不伪造计时）、
          error 显示可诊断错误信息（保持交互关闭、不退化为 fallback）、动画阶段显示极简阶段提示（不遮画布）、
          interactive 无输出。进度只来自真实资产状态 + 单一时间源 elapsed。
        */}
        <Loader readiness={readiness} phase={entrancePhase} />
        {/*
          运行时恢复状态诊断（TASK-022 输出约束「恢复失败时显示可诊断状态」）：context-lost / restoring /
          restore-failed 期间的全屏半透明覆盖。阶段来自集中编排器（RuntimeLifecycleController），本 overlay 只
          消费——不监听 context 事件（集中编排契约）。running 无输出（不干扰画布）；restore-failed 显示可诊断
          错误 + 刷新指引，不自动降级 / 重试 / 远程 fallback。
        */}
        <RuntimeStatusOverlay phase={runtimePhase} failureMessage={runtimeFailureMessage} />
        {/*
          南海诸岛 2D 标准附图（TASK-019）：右下角 SVG DOM overlay，独立于 3D 场景（SPEC §3.8「DOM overlay，
          非 3D」）。复用上层已加载的同一份 PoliticalBoundaryContract（与主图 PoliticalFeaturesLayer fetch 同一份
          public/geo/china-political-boundary.json，TASK-006 共享事实源），不重复取数、不复制十段线 / 岛礁坐标；
          坐标经 projectToInset（TASK-007 同一墨卡托投影）映射到附图 2D 子范围，与主图共享同一墨卡托结果、
          仅视口映射不同。political 未就绪时不渲染（回退边界：回退本 TASK 只会移除右下 2D 附图，主 3D 图的省界、
          十段线、岛礁、标签和 hover 全部保持不变）。附图不参与省级 hover（独立展示层），不反向修改 3D 相机 /
          地形 / hover / 领域资产。本 TASK 不声称取得审图号，附图如实标注「非官方审图数据，仅供内部展示」。
        */}
        {political.phase === 'ready' && <SouthChinaSeaInset contract={political.contract} />}
      </div>
    </div>
  )
}
