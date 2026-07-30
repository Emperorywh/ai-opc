/**
 * 大屏页面骨架（SPEC §3.4 / §11）。
 *
 * 当前装配：全视口深蓝黑容器 + 标题区 + 3D 地形画布（TASK-006 GPU 位移地形 + TASK-007 动态海面
 * + TASK-008 场景氛围与受约束相机 + TASK-009 贴地省界与 hover 拾取 + TASK-011 十段线与南海岛礁
 * 政治要素）。海拔色阶图例、合规角标、南海附图、入场编排等由后续任务按 SPEC §11 目录结构挂载
 * （TASK-016 做最终总装）。
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
 * ProvinceBordersLayer 在二者均就绪时由共享 ElevationProvider 调领域纯函数
 * prepareProvinceBorders 完成「弧长 densify → 逐点贴地 y=h·k+epsilon → 按省分组」，交
 * ProvinceBorders 渲染（浅青白 additive 发光、NDC 深度偏移抗 z-fighting、每省一个 draw call
 * 共 34 个）。ProvinceHoverPicker 挂载与地形同包围盒的不可见拾取面，把指针命中经
 * invertWorld 反查 + findProvinceAtLonLat 裁决为 adminId | null，写入 ProvinceHoverProvider
 * 保管的共享焦点状态——省界据此加亮加粗焦点省、压暗非焦点省、移出还原（无 click 行为）。
 * 省界几何加载失败按政治红线（SPEC §6「边界错误是事故级问题」）显式暴露为整页错误，不带病
 * 渲染一张缺省界的地图；准备期异常（理论不发生，资产已过契约 + 深度校验）捕获后
 * console.error 并跳过省界层，不崩溃场景其余有效层。
 *
 * 标签（TASK-010，SPEC §3.7 / §7.5 / §4.2）：地点目录与字体清单并行取数；字体清单先经结构
 * 校验、再对「渲染层将绘制的全部字符串」（省名 + 省会名，collectRenderedPlaceLabelStrings
 * 从同一地点契约提取）做覆盖校验——缺字 / 载入失败按政治红线（台湾 / 港澳标注齐全，SPEC §6）
 * 显式暴露为整页错误，绝不静默显示空白或回退在线字体。PlaceLabelsLayer 在资产就绪时由同一份
 * 共享 ElevationProvider 调领域纯函数 preparePlaceLabels 完成「锚点投影 → 贴地 h·k → 浮高」，
 * 交 PlaceLabels 渲染（34 省名 Billboard + troika Text 始终面向相机、34 省会发光光点贴地、
 * hover 省标签放大置顶 + 省会名小字呈现）；标签→相机射线遮挡判定由 PlaceLabels 内的统一帧
 * 循环降频执行（每 6 帧一次，采样器从共享 provider + k 构造），被前方地形遮挡的标签透明度
 * 阻尼降低、视角转开后恢复。TerrainSceneLayers 统一构造共享 ElevationProvider（heightmap.meta
 * + pixels，与 GPU 位移同一份高程事实源，零额外取数 / 解码 / 内存），省界层与标签层共用
 * 同一实例——全页面只包装一份。
 *
 * 政治要素（TASK-011，SPEC §5.3 / §6 红线）：政治边界补充契约（TASK-004 共享事实源）与其余资产
 * 并行取数；PoliticalFeaturesLayer 在契约就绪时由同一份共享 ElevationProvider 调领域纯函数
 * preparePoliticalFeatures 完成「红线完整性断言（恰好十段含台湾东侧段 + 钓鱼岛 / 赤尾屿 / 曾母暗沙
 * 等点名岛礁均在）→ 统一投影 → 弧长 densify → 海平面贴合 y=max(h·k, seaLevel)+epsilon」，交
 * PoliticalFeatures 渲染——十段线按段独立成线（暖琥珀 additive 发光虚线，与省界浅青白实线视觉
 * 明确区分，不被半透明海面吞没），岛礁点位为同色系更亮发光光点，NDC 深度偏移抗 z-fighting。
 * 契约加载失败与准备期红线断言失败（缺段 / 缺点）均按 SPEC §6 红线显式暴露为整页错误，绝不静默
 * 渲染一张缺十段线 / 岛礁的地图。本 TASK 不宣称取得审图号，内部展示状态下验收（政治边界补充数据
 * 为非官方审图数据，见 docs/political-review-record.md）。
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
import { PLACE_LABELS_CONFIG } from './config/place-labels'
import { POLITICAL_FEATURES_CONFIG } from './config/political-features'
import { ChinaTerrainMesh } from './three/ChinaTerrainMesh'
import { SeaSurface } from './three/SeaSurface'
import { SceneAtmosphere } from './three/SceneAtmosphere'
import { MapOrbitControls } from './three/MapOrbitControls'
import { ProvinceHoverProvider } from './three/ProvinceHoverProvider'
import { ProvinceBorders } from './three/ProvinceBorders'
import { ProvinceHoverPicker } from './three/ProvinceHoverPicker'
import { PlaceLabels } from './three/PlaceLabels'
import { PoliticalFeatures } from './three/PoliticalFeatures'
import { DEFAULT_CAMERA_POSE, MAP_CAMERA_CONSTRAINTS } from './three/camera-constraints'
import {
  loadHeightmapTexture,
  type HeightmapTextureLoadResult,
} from './three/load-heightmap-texture'
import { createElevationProvider } from './lib/elevation'
import type { ElevationProvider } from './lib/elevation'
import { loadProvinceGeometry } from './lib/province-geometry'
import { prepareProvinceBorders } from './lib/province-borders'
import { loadPlaceDirectory } from './lib/place-directory'
import { preparePlaceLabels, collectRenderedPlaceLabelStrings } from './lib/place-labels'
import { loadPoliticalBoundary } from './lib/political-boundary'
import { preparePoliticalFeatures } from './lib/political-features'
import type { PreparedPoliticalFeatures } from './lib/political-features'
import {
  LabelFontLoadError,
  loadLabelFontManifest,
  validateLabelFontCoverage,
} from './lib/label-font'
import type { TerrainWorldYSampler } from './lib/label-occlusion'
import type {
  AdministrativeGeometryContract,
  LabelFontManifestContract,
  PlaceDirectoryContract,
  PoliticalBoundaryContract,
} from './geo-contracts'

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
 * 标签资产（地点目录 + 字体清单）加载状态：加载中 / 就绪 / 失败。
 * 字体清单在就绪前已过结构校验与「实际渲染字符串」覆盖校验；失败按政治红线（SPEC §6 台湾 /
 * 港澳标注齐全）显式暴露为整页错误，绝不静默显示空白或回退在线字体。
 */
type PlaceLabelAssetsState =
  | { readonly phase: 'loading' }
  | {
      readonly phase: 'ready'
      readonly places: PlaceDirectoryContract
      readonly fontManifest: LabelFontManifestContract
    }
  | { readonly phase: 'error'; readonly message: string }

/**
 * 政治边界补充契约加载状态：加载中 / 就绪 / 失败。
 * 失败按政治红线（SPEC §6：十段线含台湾东侧段、南海诸岛 / 钓鱼岛 / 赤尾屿点位完整）显式暴露为
 * 整页错误，绝不静默退化为空契约、不带病渲染一张缺十段线 / 岛礁的地图。
 */
type PoliticalBoundaryState =
  | { readonly phase: 'loading' }
  | { readonly phase: 'ready'; readonly contract: PoliticalBoundaryContract }
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

/**
 * 模块级政治边界补充契约加载 Promise（单例）：与 heightmap 同一去重语义（StrictMode 双挂载安全），
 * 全页面只取数 / 校验一次。主图政治要素与后续 2D 南海附图（TASK-012）复用同一份契约（SPEC §5.4）。
 */
let politicalBoundaryPromise: Promise<PoliticalBoundaryContract> | null = null
function loadPoliticalBoundaryOnce(): Promise<PoliticalBoundaryContract> {
  politicalBoundaryPromise ??= loadPoliticalBoundary()
  return politicalBoundaryPromise
}

/** 标签资产就绪产物：地点目录 + 已过结构与覆盖校验的字体清单。 */
interface PlaceLabelAssets {
  readonly places: PlaceDirectoryContract
  readonly fontManifest: LabelFontManifestContract
}

/**
 * 模块级标签资产加载 Promise（单例）：地点目录与字体清单并行取数（URL 唯一事实源为
 * PLACE_LABELS_CONFIG.fontManifestPath），字体清单先过契约结构校验，再对「渲染层将绘制的
 * 全部字符串」（省名 + 省会名，从同一地点契约确定性提取）做覆盖校验——缺字即抛
 * LabelFontLoadError（coverage-incomplete），绝不把缺字字体交给 troika 渲染（不静默显示
 * 空白 / fallback 网络字体）。与 heightmap 同一去重语义（StrictMode 双挂载安全）。
 */
let placeLabelAssetsPromise: Promise<PlaceLabelAssets> | null = null
function loadPlaceLabelAssetsOnce(): Promise<PlaceLabelAssets> {
  placeLabelAssetsPromise ??= Promise.all([
    loadPlaceDirectory(),
    loadLabelFontManifest(PLACE_LABELS_CONFIG.fontManifestPath),
  ]).then(([places, fontManifest]) => {
    const coverage = validateLabelFontCoverage(fontManifest, collectRenderedPlaceLabelStrings(places))
    if (!coverage.ok) {
      throw new LabelFontLoadError('label-font.coverage-incomplete', coverage.message)
    }
    return { places, fontManifest }
  })
  return placeLabelAssetsPromise
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

/** 加载标签资产（地点目录 + 字体清单，含覆盖校验），就绪后返回经校验的地点目录与清单。 */
function usePlaceLabelAssets(): PlaceLabelAssetsState {
  const [state, setState] = useState<PlaceLabelAssetsState>({ phase: 'loading' })
  useEffect(() => {
    let cancelled = false
    loadPlaceLabelAssetsOnce()
      .then((assets) => {
        if (!cancelled) setState({ phase: 'ready', places: assets.places, fontManifest: assets.fontManifest })
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

/** 加载政治边界补充契约（资产访问层 loadPoliticalBoundary），就绪后返回经契约校验的 contract。 */
function usePoliticalBoundary(): PoliticalBoundaryState {
  const [state, setState] = useState<PoliticalBoundaryState>({ phase: 'loading' })
  useEffect(() => {
    let cancelled = false
    loadPoliticalBoundaryOnce()
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
 * 依赖两个就绪输入：province geometry（features）与共享 ElevationProvider（由
 * TerrainSceneLayers 统一构造，与标签层共用同一实例）。调领域纯函数 prepareProvinceBorders
 * （densify + 贴地 + 按省分组）产出 PreparedProvinceBorders，交 ProvinceBorders 渲染
 * （浅青白 additive 发光、NDC 深度偏移、每省一个 draw call；hover 焦点经共享 context 消费）。
 *
 * 准备期异常（无效几何 / 高程查询失败 / 退化——理论不发生：资产已过 TASK-004 契约 + 深度
 * 校验，且集成测试用生产资产 + 生产高程跑通过全量准备）被捕获并 console.error 记录后跳过
 * 省界层——不崩溃场景（地形 / 海面 / 相机 / 氛围 / 标签继续有效），也绝不产出平地边界
 * （领域层已先行抛错）。
 *
 * memo 边界：borders 依赖 features + provider + k + prep 配置（配置取 PROVINCE_BORDERS_CONFIG
 * 冻结值）。k 切换时 borders 确定性重算（y = h·k + epsilon 随 k 变化，必须重算以保持贴地）
 * ——离散切换的一次性开销，非每帧。
 */
function ProvinceBordersLayer({
  geometry,
  provider,
  exaggeration,
}: {
  readonly geometry: AdministrativeGeometryContract
  readonly provider: ElevationProvider
  readonly exaggeration: number
}): ReactNode {
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
 * 省名标签 / 省会光点准备 + 渲染层（TASK-010，SPEC §3.7 / §7.5 / §4.2）。
 *
 * 依赖两个就绪输入：标签资产（地点目录 + 已过覆盖校验的字体清单）与共享
 * ElevationProvider（与省界层同一实例）。调领域纯函数 preparePlaceLabels（锚点投影 + 贴地
 * h·k + 浮高）产出 PreparedPlaceLabels，交 PlaceLabels 渲染（34 省名 Billboard Text 始终面向
 * 相机 + 34 省会发光光点贴地 + hover 放大置顶与省会名小字）。
 *
 * 遮挡采样器（SPEC §7.5）：从共享 provider + k 构造 TerrainWorldYSampler 闭包——
 * (x, z) → queryAtWorld 成功则 h·k、失败则 null（查询失败不伪造海拔，遮挡判定据此得
 * indeterminate 并保持当前透明度）。采样器与标签数据同 memo（provider / k 变化时确定性
 * 重建），PlaceLabels 内的统一帧循环每 6 帧对每个省名标签做一次「标签→相机」射线判定。
 *
 * 准备期异常（理论不发生，与省界层同理）捕获后 console.error 并跳过标签层，不崩溃场景
 * 其余有效层；地点目录本身的加载 / 契约 / 字体覆盖失败已在加载态机中按红线显式暴露为
 * 整页错误（不会到达本层）。
 */
function PlaceLabelsLayer({
  assets,
  provider,
  exaggeration,
}: {
  readonly assets: { readonly places: PlaceDirectoryContract; readonly fontManifest: LabelFontManifestContract }
  readonly provider: ElevationProvider
  readonly exaggeration: number
}): ReactNode {
  const prepared = useMemo(() => {
    try {
      return preparePlaceLabels(assets.places, provider, exaggeration, {
        provinceLabelHeightOffsetMeters: PLACE_LABELS_CONFIG.provinceLabelHeightOffsetMeters,
        capitalLabelHeightOffsetMeters: PLACE_LABELS_CONFIG.capitalLabelHeightOffsetMeters,
        terrainEpsilonMeters: PLACE_LABELS_CONFIG.terrainEpsilonMeters,
      })
    } catch (cause) {
      // 准备失败：console 记录便于排查，跳过标签层（不崩溃场景）；正常合法资产下不触发。
      // eslint-disable-next-line no-console
      console.error(`[PlaceLabels] 标签准备失败：${cause instanceof Error ? cause.message : String(cause)}`)
      return null
    }
  }, [assets, provider, exaggeration])

  // 遮挡采样器：共享 provider + k → 世界地形 y（h·k）；查询失败返回 null（不伪造海拔）。
  const terrainQuery = useMemo<TerrainWorldYSampler>(
    () => (worldX: number, worldZ: number) => {
      const query = provider.queryAtWorld(worldX, worldZ)
      return query.ok ? query.meters * exaggeration : null
    },
    [provider, exaggeration],
  )

  if (prepared === null) return null
  return <PlaceLabels labels={prepared} terrainQuery={terrainQuery} />
}

/**
 * 十段线 / 岛礁点位准备 + 渲染层（TASK-011，SPEC §5.3 / §6 红线）。
 *
 * 依赖两个就绪输入：政治边界补充契约（TASK-004 共享事实源，已过契约校验）与共享
 * ElevationProvider（与省界层 / 标签层同一实例）。调领域纯函数 preparePoliticalFeatures 完成
 * 「红线完整性断言（恰好十段含台湾东侧段 + 点名岛礁均在）→ 投影 → 弧长 densify → 海平面贴合
 * y=max(h·k, seaLevel)+epsilon」，交 PoliticalFeatures 渲染（每段一条暖琥珀发光虚线，与省界
 * 浅青白实线视觉明确区分；岛礁点位为同色系更亮发光光点；NDC 深度偏移抗 z-fighting）。
 *
 * 准备期异常（红线缺段 / 缺点、投影 / 高程查询失败、退化——理论不发生：资产已过 TASK-004 契约 +
 * 深度校验，且集成测试用生产资产跑通过全量准备）经 onPrepError 上报为整页错误——**不**沿用省界层
 * 的「console.error + 跳过」：政治要素准备层的红线断言是运行时唯一拦截「结构合法但红线残缺」资产
 * 的防线，静默跳过会渲染一张看似正常却缺十段线 / 岛礁的地图，正是 SPEC §6 红线禁止的「静默显示
 * 残缺地图」。
 *
 * memo 边界：prepared 依赖 contract + provider + k（配置取 POLITICAL_FEATURES_CONFIG 冻结值）。
 * k 切换时确定性重算（海平面贴合 y 随 k 变化）——离散切换的一次性开销，非每帧。
 */
function PoliticalFeaturesLayer({
  contract,
  provider,
  exaggeration,
  onPrepError,
}: {
  readonly contract: PoliticalBoundaryContract
  readonly provider: ElevationProvider
  readonly exaggeration: number
  readonly onPrepError: (message: string) => void
}): ReactNode {
  // 显式判别联合：准备成功携带 features，失败携带 error（供 useEffect 上报与渲染分支收窄）。
  const prepared = useMemo<
    | { readonly ok: true; readonly features: PreparedPoliticalFeatures }
    | { readonly ok: false; readonly error: string }
  >(() => {
    try {
      return {
        ok: true,
        features: preparePoliticalFeatures(contract, provider, exaggeration, {
          densifySpacingMeters: POLITICAL_FEATURES_CONFIG.densifySpacingMeters,
          terrainEpsilonMeters: POLITICAL_FEATURES_CONFIG.terrainEpsilonMeters,
          seaLevelYMeters: POLITICAL_FEATURES_CONFIG.seaLevelYMeters,
        }),
      }
    } catch (cause) {
      return { ok: false, error: cause instanceof Error ? cause.message : String(cause) }
    }
  }, [contract, provider, exaggeration])

  // 准备失败 → 上报整页错误（SPEC §6 红线，见层注释）；onPrepError 是 App 的稳定 setState。
  useEffect(() => {
    if (!prepared.ok) onPrepError(prepared.error)
  }, [prepared, onPrepError])

  if (!prepared.ok) return null
  return <PoliticalFeatures features={prepared.features} />
}

/**
 * Canvas 内的场景内容层：统一构造共享 ElevationProvider 并装配 hover 提供器下的各交互 /
 * 标注层（省界、拾取、标签）。
 *
 * 共享 provider（SPEC §3.6「CPU 端 heightmap…供边界 densification / 遮挡射线 / 海面以下
 * 判定共用」）：由 heightmap.meta + pixels 构造唯一一份 CPU ElevationProvider——pixels 即
 * 取数时已解码的那份（小端主机零拷贝视图），省界层与标签层共用同一实例，零额外取数 /
 * 解码 / 内存；exaggeration 变化时 provider 不变（仅各层准备结果重算）。
 */
function TerrainSceneLayers({
  heightmap,
  geometry,
  labelAssets,
  political,
  exaggeration,
  onPoliticalPrepError,
}: {
  readonly heightmap: HeightmapTextureLoadResult
  readonly geometry: ProvinceGeometryState
  readonly labelAssets: PlaceLabelAssetsState
  readonly political: PoliticalBoundaryState
  readonly exaggeration: number
  readonly onPoliticalPrepError: (message: string) => void
}): ReactNode {
  // 由 heightmap 的 meta + pixels 构造共享 CPU ElevationProvider（与 GPU 位移同一份高程
  // 事实源）；仅依赖 heightmap（pixels / meta 引用稳定）。
  const provider = useMemo(
    () => createElevationProvider(heightmap.meta, heightmap.pixels),
    [heightmap],
  )
  return (
    <ProvinceHoverProvider>
      {geometry.phase === 'ready' && (
        <>
          <ProvinceBordersLayer
            geometry={geometry.contract}
            provider={provider}
            exaggeration={exaggeration}
          />
          <ProvinceHoverPicker features={geometry.contract.features} />
        </>
      )}
      {labelAssets.phase === 'ready' && (
        <PlaceLabelsLayer assets={labelAssets} provider={provider} exaggeration={exaggeration} />
      )}
      {political.phase === 'ready' && (
        <PoliticalFeaturesLayer
          contract={political.contract}
          provider={provider}
          exaggeration={exaggeration}
          onPrepError={onPoliticalPrepError}
        />
      )}
    </ProvinceHoverProvider>
  )
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
  const labelAssets = usePlaceLabelAssets()
  const political = usePoliticalBoundary()
  // 政治要素准备期错误（红线缺段 / 缺点、投影 / 高程查询失败）：由 PoliticalFeaturesLayer 上报，
  // 按 SPEC §6 红线显式暴露为整页错误（见 assetErrorMessage）。
  const [politicalPrepError, setPoliticalPrepError] = useState<string | null>(null)

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

  // 省界几何 / 标签资产（地点目录 / 字体清单）/ 政治边界契约的加载失败与政治要素准备失败，
  // 均按政治红线（SPEC §6：边界完整、台湾 / 港澳标注齐全、十段线含台湾东侧段与岛礁点位完整是
  // 事故级问题）显式暴露为整页错误：不渲染一张缺省界、缺标注或缺十段线 / 岛礁的地图。
  const assetErrorMessage =
    geometry.phase === 'error'
      ? `省界数据加载失败：${geometry.message}`
      : labelAssets.phase === 'error'
        ? `标签数据加载失败：${labelAssets.message}`
        : political.phase === 'error'
          ? `政治边界数据加载失败：${political.message}`
          : politicalPrepError !== null
            ? `政治要素准备失败：${politicalPrepError}`
            : null

  return (
    <main className="screen">
      <header className="screen-header">
        <h1 className="screen-title">{PAGE_TITLE}</h1>
        <p className="screen-subtitle">{PAGE_SUBTITLE}</p>
      </header>
      <section className="screen-stage" aria-label="3D 地形画布挂载区">
        {heightmap.phase === 'ready' ? (
          assetErrorMessage !== null ? (
            <p className="screen-status" role="alert">{assetErrorMessage}</p>
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
              省级贴地边界、hover 拾取与省名标签 / 省会光点（TASK-009 / TASK-010，SPEC §3.6 /
              §3.7 / §4.2 / §7.5）：共享 hover 焦点状态由 ProvinceHoverProvider 保管（Canvas
              子树内共享，省界与标签同源消费）；共享 ElevationProvider 由场景内容层统一构造，
              省界层与标签层共用同一实例。无 click 行为。
            */}
            <TerrainSceneLayers
              heightmap={heightmap.heightmap}
              geometry={geometry}
              labelAssets={labelAssets}
              political={political}
              exaggeration={RUNTIME_TERRAIN_CONFIG.exaggeration}
              onPoliticalPrepError={setPoliticalPrepError}
            />
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
