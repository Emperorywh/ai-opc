/**
 * 大屏页面骨架（SPEC §3.4 / §11）。
 *
 * 当前装配：全视口深蓝黑容器 + 标题区 + 3D 地形画布（TASK-006 GPU 位移地形 + TASK-007 动态海面
 * + TASK-008 场景氛围与受约束相机 + TASK-009 贴地省界与 hover 拾取 + TASK-011 十段线与南海岛礁
 * 政治要素）+ 右下角南海诸岛 2D 附图 DOM overlay（TASK-012）+ 加载进度与入场动画编排（TASK-013）
 * + 左侧海拔色阶图例与左下合规角标 DOM overlay（TASK-014）。性能预算登记与最终总装由后续任务
 * 按 SPEC §11 目录结构承载（TASK-015 / TASK-016）。
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
 *
 * 南海诸岛 2D 附图（TASK-012，SPEC §3.8 / §5.4 / §6 红线）：右下角矩形 SVG DOM overlay，挂在 3D
 * Canvas 之外（不进入 3D 渲染循环，纯静态，pointer-events: none 使相机交互穿透）。与主图政治要素层
 * 复用同一份 PoliticalBoundaryContract（模块级单例 Promise 去重，SPEC §5.4 单一事实源），经领域纯函数
 * prepareSouthChinaSeaInset 完成「红线完整性断言（与主图同一共享扫描单源）→ projectToInset 同一墨卡托
 * 投影的 2D 子范围映射 → 岛礁标注确定性摆放（右 / 左 / 上 / 下候选序，框内不互叠）」，交
 * SouthChinaSeaInset 渲染十段虚线 + 岛礁光点 + 规范名称标注。准备失败（红线缺段 / 缺点、投影失败）
 * 与主图政治要素同一通道按 SPEC §6 红线暴露为整页错误，绝不静默显示残缺附图。
 *
 * 加载与入场编排（TASK-013，SPEC §4.3 / §12.8）：四个资产加载状态机（heightmap / 省界几何 / 政治
 * 边界 / 标签资产）的真实阶段经 computeAssetReadiness（领域纯函数，src/lib/entrance-state）聚合为
 * ready / failed / loadedCount / totalCount——Loader 的 DOM 进度条只反映真实资产进度，不伪造计时。
 * Canvas 内的 EntranceController 是单一帧循环驱动器：全部资产就绪的首帧幂等捕获 R3F 共享 clock 起始
 * 时刻（动画只启动一次），每帧派生 elapsed 与当前阶段原地写入共享 entranceFrameRef（零分配）；各
 * 渲染层（ChinaTerrainMesh 的 uRise 升起 ≈1.2s、PlaceLabels 省名自西向东错峰淡入、SeaSurface /
 * ProvinceBorders / PoliticalFeatures 随后同步淡入）useFrame 只读该帧、调用同一组领域纯函数派生
 * 各自标量写入材质——单一时间源，无第二份 clock / 计时器。阶段切换（约 4 次）经 setEntrancePhase
 * 驱动 Loader 阶段提示与 MapOrbitControls enabled（loading / 动画期间锁定相机，到达 interactive
 * 一次性释放）。资产失败 → error 终态：入场不启动，红线整页错误通道展示诊断、相机保持锁定。
 *
 * 外围 UI（TASK-014，SPEC §8 / §9）：左侧竖向贴边海拔色阶图例（ElevationLegend，色条渐变与
 * 六个关键刻度 0/1000/2000/3500/5000/8848m 的颜色 / 位置全部经 prepareElevationLegend 从
 * TASK-006 色阶唯一事实源派生——sampleElevationColor 与 normalizeElevationToRampU 和地表片元
 * 着色器同源，图例不复制断点 / 颜色）+ 左下角低调合规角标（ComplianceBadge，审图号占位
 * GS(202x)xxxx 号（待取得）+ 从来源注册表派生的必备来源署名 + SPEC §8 完整免责声明）。
 * 数据来源注册表（public/geo/data-sources.json）经 loadDataSourceRegistryOnce 单例加载（与
 * heightmap 同一去重语义）——**不**计入 trackedAssets：合规角标是纯 DOM overlay，不参与入场
 * 资产就绪判定、不阻塞相机解锁 / 升起动画；但其加载 / 契约失败**不**静默省略角标（缺免责声明
 * 的页面违反 SPEC §8），按本页统一「绝不静默退化」原则进入整页错误通道显式暴露。
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode, RefObject } from 'react'
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
import { EntranceController } from './three/EntranceController'
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
  computeAssetReadiness,
  isEntranceInteractive,
  type EntranceFrame,
  type EntrancePhase,
  type TrackedAssetState,
} from './lib/entrance-state'
import { SouthChinaSeaInset } from './components/SouthChinaSeaInset'
import { Loader } from './components/ui/Loader'
import { ElevationLegend } from './components/ui/ElevationLegend'
import { ComplianceBadge } from './components/ui/ComplianceBadge'
import { loadDataSourceRegistry } from './lib/data-source-registry'
import {
  LabelFontLoadError,
  loadLabelFontManifest,
  validateLabelFontCoverage,
} from './lib/label-font'
import type { TerrainWorldYSampler } from './lib/label-occlusion'
import type {
  AdministrativeGeometryContract,
  DataSourceRegistryContract,
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
 * 数据来源注册表加载状态：加载中 / 就绪 / 失败。
 * 失败不静默省略合规角标（缺 SPEC §8 免责声明的页面看似正常实则不合规），按本页统一
 * 「绝不静默退化」原则进入整页错误通道显式暴露。
 */
type DataSourceRegistryState =
  | { readonly phase: 'loading' }
  | { readonly phase: 'ready'; readonly contract: DataSourceRegistryContract }
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

/**
 * 模块级数据来源注册表加载 Promise（单例）：与 heightmap 同一去重语义（StrictMode 双挂载安全），
 * 全页面只取数 / 校验一次。该注册表是 TASK-004 来源声明契约的生产事实源，合规角标
 * （ComplianceBadge）从中派生必备来源署名，不复制来源名称字面量。
 */
let dataSourceRegistryPromise: Promise<DataSourceRegistryContract> | null = null
function loadDataSourceRegistryOnce(): Promise<DataSourceRegistryContract> {
  dataSourceRegistryPromise ??= loadDataSourceRegistry()
  return dataSourceRegistryPromise
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
 * 加载数据来源注册表（资产访问层 loadDataSourceRegistry），就绪后返回经契约校验的 contract。
 *
 * 独立性：本 hook **不**计入 trackedAssets（不参与入场资产就绪判定、不阻塞相机解锁 / 升起
 * 动画）——合规角标是纯 DOM overlay，其加载只决定角标何时呈现；但失败经 assetErrorMessage
 * 整页暴露（不静默省略角标，见 DataSourceRegistryState 注释）。
 */
function useDataSourceRegistry(): DataSourceRegistryState {
  const [state, setState] = useState<DataSourceRegistryState>({ phase: 'loading' })
  useEffect(() => {
    let cancelled = false
    loadDataSourceRegistryOnce()
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
  entranceFrame,
}: {
  readonly geometry: AdministrativeGeometryContract
  readonly provider: ElevationProvider
  readonly exaggeration: number
  readonly entranceFrame: RefObject<EntranceFrame>
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
  return <ProvinceBorders borders={prepared} entranceFrame={entranceFrame} />
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
  entranceFrame,
}: {
  readonly assets: { readonly places: PlaceDirectoryContract; readonly fontManifest: LabelFontManifestContract }
  readonly provider: ElevationProvider
  readonly exaggeration: number
  readonly entranceFrame: RefObject<EntranceFrame>
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
  return <PlaceLabels labels={prepared} terrainQuery={terrainQuery} entranceFrame={entranceFrame} />
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
  entranceFrame,
  onPrepError,
}: {
  readonly contract: PoliticalBoundaryContract
  readonly provider: ElevationProvider
  readonly exaggeration: number
  readonly entranceFrame: RefObject<EntranceFrame>
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
  return <PoliticalFeatures features={prepared.features} entranceFrame={entranceFrame} />
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
  entranceFrame,
  onPoliticalPrepError,
}: {
  readonly heightmap: HeightmapTextureLoadResult
  readonly geometry: ProvinceGeometryState
  readonly labelAssets: PlaceLabelAssetsState
  readonly political: PoliticalBoundaryState
  readonly exaggeration: number
  readonly entranceFrame: RefObject<EntranceFrame>
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
            entranceFrame={entranceFrame}
          />
          <ProvinceHoverPicker features={geometry.contract.features} />
        </>
      )}
      {labelAssets.phase === 'ready' && (
        <PlaceLabelsLayer
          assets={labelAssets}
          provider={provider}
          exaggeration={exaggeration}
          entranceFrame={entranceFrame}
        />
      )}
      {political.phase === 'ready' && (
        <PoliticalFeaturesLayer
          contract={political.contract}
          provider={provider}
          exaggeration={exaggeration}
          entranceFrame={entranceFrame}
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
  const dataSources = useDataSourceRegistry()
  // 政治要素准备期错误（红线缺段 / 缺点、投影 / 高程查询失败）：由 PoliticalFeaturesLayer 上报，
  // 按 SPEC §6 红线显式暴露为整页错误（见 assetErrorMessage）。
  const [politicalPrepError, setPoliticalPrepError] = useState<string | null>(null)
  // 南海附图准备期错误（TASK-012，红线缺段 / 缺点、附图子范围投影失败）：由 SouthChinaSeaInset 上报，
  // 与主图政治要素同一通道按 SPEC §6 红线显式暴露为整页错误（不静默显示残缺附图）。
  const [insetPrepError, setInsetPrepError] = useState<string | null>(null)

  // 入场编排（TASK-013 单一显式状态流，SPEC §4.3）：把四个资产 hook 的真实状态映射为受跟踪资产
  // 状态列表，由 computeAssetReadiness（纯函数）聚合为 ready / failed / loadedCount / totalCount——
  // DOM 进度只反映真实资产（loadedCount / totalCount），不伪造计时进度。entranceFrameRef 是 Canvas
  // 内外共享的「同一时间源」ref：EntranceController 每帧原地写入 phase + elapsed，各渲染层 useFrame
  // 只读消费派生各自 rise / 透明度（不由组件私自计时）。entrancePhase 是 React state（仅阶段切换时
  // 更新，约 4 次），驱动 DOM 加载反馈与相机交互锁——非每帧 setState。
  const trackedAssets = useMemo<readonly TrackedAssetState[]>(
    () => [
      {
        key: 'heightmap',
        phase: heightmap.phase,
        errorMessage: heightmap.phase === 'error' ? heightmap.message : null,
      },
      {
        key: 'provinceGeometry',
        phase: geometry.phase,
        errorMessage: geometry.phase === 'error' ? geometry.message : null,
      },
      {
        key: 'politicalBoundary',
        phase: political.phase,
        errorMessage: political.phase === 'error' ? political.message : null,
      },
      {
        key: 'placeLabelAssets',
        phase: labelAssets.phase,
        errorMessage: labelAssets.phase === 'error' ? labelAssets.message : null,
      },
    ],
    [heightmap, geometry, political, labelAssets],
  )
  const readiness = useMemo(() => computeAssetReadiness(trackedAssets), [trackedAssets])
  // 入场帧 ref：初值 loading / elapsed=0；EntranceController（Canvas 内）每帧原地覆盖。useRef 在
  // StrictMode 重挂载下保持同一对象（同 fiber），与 EntranceController 的起始时刻幂等捕获共同保证
  // 「动画只启动一次」。
  const entranceFrameRef = useRef<EntranceFrame>({ phase: 'loading', elapsedSeconds: 0 })
  // 入场阶段（React state，仅阶段切换更新）：初值 = 资产失败即 error、否则 loading。EntranceController
  // 在阶段切换帧回调 setEntrancePhase，驱动 Loader 与相机交互锁。非每帧 setState（逐帧视觉值走
  // entranceFrameRef）。
  const [entrancePhase, setEntrancePhase] = useState<EntrancePhase>(
    readiness.failed ? 'error' : 'loading',
  )

  // 受约束相机的交互启停（TASK-008 启停契约 + TASK-013 入场交互锁，SPEC §4.3「动画期间锁相机交互，
  // 结束后释放 OrbitControls」）：单一显式布尔 = 入场到达 interactive。loading / error / 三个动画阶段
  // 锁定相机（无意义旋转 / 探索未就绪或正在入场的场景）。该阶段单调到达，故交互只在入场完成后解锁
  // （不会提前 / 重复解锁）；enabled 是受控 prop，不存在第二套交互开关。
  const interactionEnabled = isEntranceInteractive(entrancePhase)

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

  // 省界几何 / 标签资产（地点目录 / 字体清单）/ 政治边界契约 / 数据来源注册表的加载失败、政治
  // 要素与南海附图的准备失败，均按政治红线（SPEC §6：边界完整、台湾 / 港澳标注齐全、十段线含
  // 台湾东侧段与岛礁点位完整、右下 2D 附图作为合规惯例存在，是事故级问题）或合规底线（SPEC §8：
  // 缺来源注册表即缺必备署名与免责声明）显式暴露为整页错误：不渲染一张缺省界、缺标注、缺
  // 十段线 / 岛礁、缺附图或缺合规署名的地图。任一错误出现即整页暴露（不等其他资产就绪）。
  const assetErrorMessage =
    heightmap.phase === 'error'
      ? `地形数据加载失败：${heightmap.message}`
      : geometry.phase === 'error'
        ? `省界数据加载失败：${geometry.message}`
        : labelAssets.phase === 'error'
          ? `标签数据加载失败：${labelAssets.message}`
          : political.phase === 'error'
            ? `政治边界数据加载失败：${political.message}`
            : dataSources.phase === 'error'
              ? `数据来源注册表加载失败：${dataSources.message}`
              : politicalPrepError !== null
                ? `政治要素准备失败：${politicalPrepError}`
                : insetPrepError !== null
                  ? `南海附图准备失败：${insetPrepError}`
                  : null

  return (
    <main className="screen">
      <header className="screen-header">
        <h1 className="screen-title">{PAGE_TITLE}</h1>
        <p className="screen-subtitle">{PAGE_SUBTITLE}</p>
      </header>
      <section className="screen-stage" aria-label="3D 地形画布挂载区">
        {assetErrorMessage !== null ? (
          <p className="screen-status" role="alert">{assetErrorMessage}</p>
        ) : heightmap.phase === 'ready' ? (
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
              入场编排驱动器（TASK-013 单一显式状态流 / 单一时间源，SPEC §4.3）：Canvas 内每帧从
              R3F 共享 clock 派生入场 elapsed、deriveEntrancePhase 得当前阶段，原地写入共享
              entranceFrameRef（各渲染层 useFrame 只读消费派生 rise / 透明度），阶段切换时回调
              setEntrancePhase 驱动 Loader 与相机交互锁。置于其余 useFrame 消费者之前挂载，使同帧
              内先写入场帧、后被各层读取（订阅顺序 = 挂载顺序）。无几何 / 无 DOM 输出。
            */}
            <EntranceController
              readiness={readiness}
              onPhaseChange={setEntrancePhase}
              entranceFrame={entranceFrameRef}
            />
            {/*
              受约束东南斜俯视轨道相机（SPEC §4.1）：距离 / 极角 / target 三道边界 + 动态 near。
              交互启停由入场状态机显式驱动（TASK-013，SPEC §4.3）：loading / error / 升起 / 标签
              淡入 / 水面边界淡入期间 enabled=false 锁定相机，到达 interactive 一次性释放——
              enabled 是受控 prop，无第二套交互开关。
            */}
            <MapOrbitControls enabled={interactionEnabled} />
            {/*
              GPU 位移地形（TASK-006）+ 入场升起（TASK-013）：共享入场帧注入后 uRise 由
              computeTerrainRise(elapsed) 逐帧驱动 0→1，地形从平面升起 ≈1.2s（复用 GPU 位移，
              零额外几何开销）。
            */}
            <ChinaTerrainMesh
              heightmap={heightmap.heightmap}
              config={RUNTIME_TERRAIN_CONFIG}
              entranceFrame={entranceFrameRef}
            />
            {/* 动态海面（TASK-007）+ 入场淡入（TASK-013）：水面随水面 / 边界阶段平滑淡入。 */}
            <SeaSurface entranceFrame={entranceFrameRef} />
            {/*
              省级贴地边界、hover 拾取与省名标签 / 省会光点（TASK-009 / TASK-010，SPEC §3.6 /
              §3.7 / §4.2 / §7.5）：共享 hover 焦点状态由 ProvinceHoverProvider 保管（Canvas
              子树内共享，省界与标签同源消费）；共享 ElevationProvider 由场景内容层统一构造，
              省界层与标签层共用同一实例。无 click 行为。共享入场帧透传驱动「省名标签自西向东
              错峰淡入 + 省界 / 十段线随水面边界阶段淡入」（TASK-013）。
            */}
            <TerrainSceneLayers
              heightmap={heightmap.heightmap}
              geometry={geometry}
              labelAssets={labelAssets}
              political={political}
              exaggeration={RUNTIME_TERRAIN_CONFIG.exaggeration}
              entranceFrame={entranceFrameRef}
              onPoliticalPrepError={setPoliticalPrepError}
            />
          </Canvas>
        ) : null}
      </section>
      {/*
        加载 / 入场 DOM 反馈（TASK-013，SPEC §4.3）：loading 显示真实进度条（loadedCount /
        totalCount，不伪造计时，全屏覆盖遮住平面态地形）；动画阶段显示底部极简阶段提示（不遮
        画布，3D 动画本身即进度反馈）；interactive 无输出。资产加载失败 / 准备失败由上方红线
        整页错误通道优先展示（此时不挂载本组件，避免双错误界面）。
      */}
      {heightmap.phase !== 'error' && assetErrorMessage === null && (
        <Loader readiness={readiness} phase={entrancePhase} />
      )}
      {/*
        南海诸岛 2D 标准附图（TASK-012，SPEC §3.8 / §5.4 / §6 红线）：右下角矩形 SVG DOM overlay，
        挂在 3D Canvas 之外（不进入 3D 渲染循环，纯静态，pointer-events: none 使相机交互穿透），
        与主图政治要素复用同一份契约（模块级单例 Promise 去重）。仅在地形就绪、无整页错误且政治
        契约就绪时呈现；准备失败经 onPrepError 进入整页错误通道（届时本组件随整页错误一同卸载，
        不静默显示残缺附图）。
      */}
      {heightmap.phase === 'ready' && assetErrorMessage === null && political.phase === 'ready' && (
        <SouthChinaSeaInset contract={political.contract} onPrepError={setInsetPrepError} />
      )}
      {/*
        海拔色阶图例（TASK-014，SPEC §9）：左侧竖向贴边 DOM overlay，挂在 3D Canvas 之外（不进
        入 3D 渲染循环，纯静态，pointer-events: none 指针穿透）。色条渐变与六个关键刻度
        （0 / 1000 / 2000 / 3500 / 5000 / 8848m）的颜色 / 位置全部经领域层 prepareElevationLegend
        从 TASK-006 色阶唯一事实源派生（sampleElevationColor / normalizeElevationToRampU，与地表
        片元着色器同一采样器与归一化），不复制断点 / 颜色；0m 标注「海平面」使水下色段有读图
        含义。无资产依赖、挂载即稳定呈现；loading 期间由全屏 Loader 覆盖，资产 / 准备失败时随
        整页错误通道一并隐藏（错误页不叠任何外围 UI）。
      */}
      {assetErrorMessage === null && <ElevationLegend />}
      {/*
        合规角标（TASK-014，SPEC §8 / §6）：左下角低调 DOM overlay，挂在 3D Canvas 之外。审图号
        占位为未送审形态（字面 GS(202x)xxxx 号（待取得），不伪造已批复号码）；必备来源署名
        （DEM / 行政区边界 / 政治边界补充）从来源注册表派生，不复制来源名称字面量；完整免责声明
        （非官方 / 仅内部 / 不得正式出版发布）取得真实审图号前不得删除。dataSources 就绪时挂载；
        不计入 trackedAssets（独立 overlay，不影响入场 / 相机 / 场景），其加载失败经上方整页
        错误通道显式暴露（不静默省略角标）。
      */}
      {assetErrorMessage === null && dataSources.phase === 'ready' && (
        <ComplianceBadge registry={dataSources.contract} />
      )}
    </main>
  )
}

export default App
