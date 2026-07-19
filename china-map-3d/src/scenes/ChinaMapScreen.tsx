/**
 * 中国 3D 地势大屏场景装配（TASK-009 资产 / 配置 / 渲染分层；TASK-011 受约束相机；
 * TASK-012 深色氛围照明与背景层次；TASK-013 动态海面；TASK-014 省级贴地边界；
 * TASK-015 十段线与岛礁点位；TASK-016 省名 / 省会光点 / 岛礁名称标注 + 离线字体子集）。
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
import { PROVINCE_BORDERS_CONFIG } from '../config/province-borders'
import { POLITICAL_FEATURES_CONFIG } from '../config/political-features'
import { PLACE_LABELS_CONFIG } from '../config/place-labels'
import { ChinaTerrainMesh } from '../three/ChinaTerrainMesh'
import { loadHeightmapTexture } from '../three/load-heightmap-texture'
import type { HeightmapTextureLoadResult } from '../three/load-heightmap-texture'
import { SeaSurface } from '../three/SeaSurface'
import { ProvinceBorders } from '../three/ProvinceBorders'
import { PoliticalFeatures } from '../three/PoliticalFeatures'
import { PlaceLabels } from '../three/PlaceLabels'
import { MapOrbitControls } from '../three/MapOrbitControls'
import { SceneAtmosphere } from '../three/SceneAtmosphere'
import { DEFAULT_CAMERA_POSE, MAP_CAMERA_CONSTRAINTS } from '../three/camera-constraints'
import { SCENE_SHADOWS_ENABLED } from '../config/scene-atmosphere'
import { createElevationProvider } from '../lib/elevation'
import { loadProvinceGeometry } from '../lib/province-geometry'
import { loadPoliticalBoundary } from '../lib/political-boundary'
import { loadPlaceDirectory } from '../lib/place-directory'
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
import type {
  AdministrativeGeometryContract,
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
}: {
  readonly heightmap: HeightmapState
  readonly geometry: ProvinceGeometryState
  readonly exaggeration: number
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
  return <ProvinceBorders borders={result.borders} />
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
}: {
  readonly heightmap: HeightmapState
  readonly political: PoliticalBoundaryState
  readonly exaggeration: number
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
  return <PoliticalFeatures features={result.features} />
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
 * 5. 覆盖校验通过则交 PlaceLabels 渲染（Billboard Text + 发光光点，始终面向相机）。
 *
 * 准备 / 覆盖期异常（角色-配对失衡 / 点名岛礁缺项 / 投影 / 高程查询失败 / 字体缺字）被捕获并 console.error
 * 记录后跳过标签——不崩溃场景（地形 / 海面 / 省界 / 十段线 / 相机 / 氛围继续有效，符合 TASK-016 回退边界）。
 *
 * memo 边界：provider 仅依赖 heightmap；labels 依赖 place + political + provider + k + prepConfig；
 * coverage 依赖 labels + manifest。k 切换时 labels 确定性重算（浮高 / 贴地随 k 变化）——离散切换一次性开销。
 */
function PlaceLabelsLayer({
  heightmap,
  places,
  political,
  fontManifest,
  exaggeration,
}: {
  readonly heightmap: HeightmapState
  readonly places: PlaceDirectoryState
  readonly political: PoliticalBoundaryState
  readonly fontManifest: LabelFontManifestState
  readonly exaggeration: number
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
  return <PlaceLabels labels={result.labels} />
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

  // 受约束相机的交互启停（TASK-011）：单一显式布尔，当前 = heightmap 就绪。后续入场状态机
  // （升起动画）在此合并「就绪 && 升起完成」即可统一接管，无需改 MapOrbitControls。
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
        {/*
          动态海面（TASK-013）：独立渲染层，位于 y=0、覆盖主图海域、双层流动、半透明透视水下大陆架。
          不接收 props、不读取 heightmap 加载状态——始终渲染，回退本 TASK 仅移除该层（水下负高程地形、
          色阶、相机、氛围完整保留）。透明 + 不写深度，使水下地形透过海面可见、陆地遮挡海面（无穿插）。
        */}
        <SeaSurface />
        {/*
          省级贴地边界（TASK-014）：heightmap（含 pixels，构造共享 ElevationProvider）与 province geometry 均
          就绪时 densify + 贴地 + 按行政区分组渲染。准备期异常被捕获、跳过省界不崩溃场景（回退边界）。
          浅青白发光线、NDC 深度偏移抗 z-fighting、与半透明海面共存；按行政区分组供后续 hover 寻址。
        */}
        <ProvinceBordersLayer
          heightmap={heightmap}
          geometry={geometry}
          exaggeration={config.exaggeration}
        />
        {/*
          十段线与岛礁点位（TASK-015）：heightmap（含 pixels，构造共享 ElevationProvider）与政治边界补充契约
          均就绪时红线完整性校验 + densify + 海平面贴合 + 按段分组渲染。准备期异常（缺段 / 缺点 / 查询失败 /
          退化）被捕获、跳过政治要素不崩溃场景（回退边界）。暖琥珀虚线（与省界浅青白实线视觉明确区分）+
          岛礁发光光点；NDC 深度偏移抗 z-fighting、与半透明海面 / 省界透明共存。本 TASK 不宣称取得审图号，
          内部展示状态下验收（政治边界补充数据为非官方审图数据，见 docs/political-review-record.md）。
        */}
        <PoliticalFeaturesLayer
          heightmap={heightmap}
          political={political}
          exaggeration={config.exaggeration}
        />
        {/*
          省名 / 省会光点 / 岛礁名称标注（TASK-016）：heightmap（含 pixels，构造共享 ElevationProvider）+ 地点
          目录 + 政治边界契约 + 离线字体清单均就绪时投影 + 贴地 / 浮高 + 字体覆盖校验后渲染。准备 / 覆盖期异常
          （角色-配对失衡 / 点名岛礁缺项 / 投影 / 高程查询失败 / 字体缺字）被捕获、跳过标签不崩溃场景（回退边界）。
          Billboard Text（始终面向相机）+ 暖琥珀省会发光光点；字体取本地子集（无在线请求）。本 TASK 不宣称取得
          审图号，内部展示状态下验收（坐标为非官方审图数据，见 docs/political-review-record.md）。
        */}
        <PlaceLabelsLayer
          heightmap={heightmap}
          places={places}
          political={political}
          fontManifest={fontManifest}
          exaggeration={config.exaggeration}
        />
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
        {places.phase === 'error' && (
          <div className="china-map-status china-map-error">地点目录加载失败：{places.message}</div>
        )}
        {fontManifest.phase === 'error' && (
          <div className="china-map-status china-map-error">字体清单加载失败：{fontManifest.message}</div>
        )}
      </div>
    </div>
  )
}
