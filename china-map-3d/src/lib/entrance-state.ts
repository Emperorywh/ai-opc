/**
 * 加载与入场编排的确定性状态机（领域层，TASK-020）。
 *
 * 角色与依赖方向：
 * - 本模块属于领域层（src/lib），把「受跟踪资产就绪状态 + 单一入场 elapsed（由 R3F 共享 clock 派生）」
 *   确定性地变换为「当前入场阶段 + 各渲染层应取的 rise / 透明度」。它是纯函数，不依赖 React / R3F /
 *   Three.js / DOM / 计时器，故自动化测试可在 Node 环境完整覆盖「阶段顺序固定、每阶段只进一次、交互只在
 *   最终态启用」「资产乱序完成」「StrictMode 重挂载」「加载失败终态」「永不卡 99%」等场景（TASK-020
 *   验证方式 1、2），无需启动浏览器 / WebGL（人工视觉验收留给 TASK-020 验证方式 4）。
 *
 * 状态迁移（单一显式状态流，TASK-020 实现约束「入场必须由单一显式状态流编排」）：
 * - 阶段顺序固定：loading →（全部资产就绪）→ terrain-rise → labels-fade-in → scene-layers-fade-in →
 *   interactive。任一资产失败 → error（终态）。阶段由「入场总 elapsed」经 deriveEntrancePhase 单调派生，
 *   故 elapsed 单调递增时每阶段只进一次、不会回退（除非显式把 elapsed 归零，而该值只由「资产就绪」幂等
 *   捕获的起始时刻派生，一旦进入入场就不再归零——见 EntranceController 的幂等起始捕获）。
 * - 失败终态：deriveEntrancePhase 在 failed=true 时恒返回 error，无论 elapsed 多大——加载失败显式终止
 *   状态机、保留诊断，绝不自动回退到低清 / 平面 / 旧资产 / 远程请求（TASK-020 实现约束「加载失败必须显式
 *   终止状态机并保留诊断」）。error 态下各渲染层 rise=0 / 透明度=0（elapsed 冻结为 0），入场动画不继续。
 *
 * 统一时间源（TASK-020 实现约束「所有动画使用统一 R3F 帧循环 / 时钟，禁止多 Clock 漂移」）：
 * - 本模块不持有任何 clock / 计时器：所有派生函数以「入场总 elapsed（秒）」为唯一时间输入。该 elapsed
 *   由 EntranceController 从 R3F 共享 clock 的 getElapsedTime() 幂等派生（入场开始时刻捕获一次，之后
 *   elapsed = clock − 起始，单调）。各渲染层 useFrame 读取 EntranceController 写入的共享入场帧（含该
 *   elapsed）后，调用本模块的纯函数派生各自 rise / 透明度——同一 elapsed、同一组函数 = 同一时间源，
 *   不存在逐层私设计时器（TASK-020 实现约束「不由组件私自计时」）。
 *
 * 不伪造进度（TASK-020 输出约束「DOM 加载进度反馈只反映真实受跟踪资产，不伪造计时进度」）：
 * - computeAssetReadiness 只统计各资产的真实就绪 / 失败状态产出 loadedCount / totalCount。DOM 进度 =
 *   loadedCount / totalCount，资产未就绪时进度停在真实值（如 3/5），绝不用计时器把进度虚假推到 99%
 *   （TASK-020 验证方式 2「永远 99%」须不可达）。资产全部就绪即进度=1、进入 terrain-rise。
 */

/**
 * 入场受跟踪的静态资产键（与 ChinaMapScreen 的五个资产一一对应）。
 *
 * 进度统计与失败诊断按这些键产出，使 DOM 加载反馈与日志能指明「哪个资产未就绪 / 失败」。
 */
export type TrackedAssetKey =
  | 'heightmap'
  | 'provinceGeometry'
  | 'politicalBoundary'
  | 'placeDirectory'
  | 'labelFontManifest'

/** 单个受跟踪资产的三态：加载中 / 就绪 / 失败（失败绝不静默退化为就绪）。 */
export type TrackedAssetPhase = 'loading' | 'ready' | 'error'

/** 单个受跟踪资产的状态（computeAssetReadiness 的输入单元）。 */
export interface TrackedAssetState {
  /** 资产键（用于诊断「哪个资产失败」）。 */
  readonly key: TrackedAssetKey
  /** 资产阶段：loading / ready / error。 */
  readonly phase: TrackedAssetPhase
  /** 失败时的诊断信息（phase='error' 时为非空串，供 DOM 错误反馈；其余态为 null）。 */
  readonly errorMessage: string | null
}

/**
 * 全部受跟踪资产的聚合就绪状态（computeAssetReadiness 的产物）。
 *
 * - ready：全部资产就绪（loadedCount === totalCount 且无失败）——进入入场动画的门槛。
 * - failed：任一资产失败——进入 error 终态、保留诊断。
 * - loadedCount / totalCount：真实进度（DOM 进度 = loadedCount / totalCount，不伪造）。
 */
export interface AssetReadiness {
  /** 全部资产就绪（无失败且全部 ready）。 */
  readonly ready: boolean
  /** 任一资产失败。 */
  readonly failed: boolean
  /** 已就绪资产数（真实进度分子）。 */
  readonly loadedCount: number
  /** 受跟踪资产总数（真实进度分母）。 */
  readonly totalCount: number
  /** 首个失败资产的诊断信息（failed=true 时非空，供 DOM 错误反馈）。 */
  readonly failureMessage: string | null
}

/**
 * 入场阶段（确定性状态机的状态空间，TASK-020 输出约束「至少区分加载中、加载失败、地形升起、标签淡入、
 * 边界 / 水面淡入和可交互状态」）。
 *
 * 顺序固定：loading → terrain-rise → labels-fade-in → scene-layers-fade-in → interactive；
 * 任一资产失败 → error（终态）。loading / error / interactive 为终态性质（loading 是起点、error 与
 * interactive 是终点），中间三态为动画阶段。interactive 是唯一启用相机交互的阶段。
 */
export type EntrancePhase =
  | 'loading'
  | 'error'
  | 'terrain-rise'
  | 'labels-fade-in'
  | 'scene-layers-fade-in'
  | 'interactive'

/**
 * 入场时序参数（由 src/config/entrance 的冻结 ENTRANCE_DURATIONS 提供生产值）。
 *
 * 各字段语义见 deriveEntrancePhase / computeTerrainRise 等函数内的逐行注释。
 */
export interface EntranceDurations {
  /** 地形从平面升至夸张后真实高度的时长（秒）。 */
  readonly terrainRiseSeconds: number
  /** 省名标签错峰淡入总时长（秒）。 */
  readonly labelsFadeSeconds: number
  /** 水面 / 边界淡入时长（秒）。 */
  readonly sceneLayersFadeSeconds: number
  /** 省名标签错峰窗口占省名淡入总时长的分数（(0,1)）。 */
  readonly labelStaggerWindowFraction: number
}

/**
 * 单帧共享入场帧（EntranceController 每帧写入、各渲染层 useFrame 只读消费）。
 *
 * 这是「同一时间源」的运行时载体：phase + elapsed（入场总秒数）。各渲染层据此调用本模块的纯函数派生
 * 各自 rise / 透明度，不由组件私自计时（TASK-020 实现约束「相同阶段输入由各渲染层消费，不由组件私自
 * 计时」）。elapsed 在资产全部就绪前恒为 0（loading 态），就绪后由 EntranceController 幂等捕获的起始
 * 时刻单调派生。
 *
 * 字段刻意**非 readonly**（TASK-020 实现约束「禁止逐帧对象分配」+ SPEC §7.4「无运行时分配循环」）：
 * EntranceController 的单一 useFrame 每帧「原地改写」entranceFrame.current 的两个标量字段，而非整对象替换。
 * 若字段声明为 readonly，生产者只能 `entranceFrame.current = { phase, elapsedSeconds }` 每帧分配一个新对象
 * （60fps × 24h ≈ 千万级短命对象，GC 抖动），故此处显式可变，与仓库其余 useFrame 热循环（SeaSurface /
 * ChinaTerrainMesh / ProvinceBorders / PoliticalFeatures / PlaceLabels 均只写标量到稳定 ref / uniform）一致。
 * 对象本身由 ChinaMapScreen 的 useRef 一次性创建、同 fiber 跨重渲染保持同一引用，故原地改写零分配。
 */
export interface EntranceFrame {
  /** 当前入场阶段（由 EntranceController 每帧原地改写；非 readonly 以允许原地写、避免逐帧整对象替换）。 */
  phase: EntrancePhase
  /** 入场总 elapsed（秒；loading / error 态为 0，入场期间单调递增；由 EntranceController 每帧原地改写）。 */
  elapsedSeconds: number
}

/**
 * 入场动画总时长（秒）= 地形升起 + 省名淡入 + 水面边界淡入。
 *
 * elapsed ≥ 总时长即进入 interactive 终态。提取为纯函数使自动化可断言「总时长 = 各阶段之和」、
 * 「elapsed=总时长时 phase=interactive」。
 */
export function totalEntranceSeconds(durations: EntranceDurations): number {
  return durations.terrainRiseSeconds + durations.labelsFadeSeconds + durations.sceneLayersFadeSeconds
}

/**
 * 把受跟踪资产状态列表聚合成 AssetReadiness（纯函数，可在 Node 直接断言）。
 *
 * 统计真实就绪数（loadedCount）与失败标志（failed）；ready = 无失败且全部就绪。失败诊断取首个失败资产
 * 的 errorMessage（确定性：按输入顺序的首个，使 DOM 错误反馈稳定可复现）。资产列表为空时 ready=false
 * （无法证明就绪）、totalCount=0（DOM 进度分母为 0，渲染层应据此显示「无受跟踪资产」而非除零）。
 */
export function computeAssetReadiness(assets: readonly TrackedAssetState[]): AssetReadiness {
  const totalCount = assets.length
  let loadedCount = 0
  let failed = false
  let failureMessage: string | null = null
  // 单次遍历：统计就绪数 + 捕获首个失败诊断（确定性，按输入顺序）。
  for (const asset of assets) {
    if (asset.phase === 'ready') {
      loadedCount += 1
    } else if (asset.phase === 'error') {
      failed = true
      // 首个失败资产的诊断优先（一旦写入不再覆盖，保证稳定可复现）。
      if (failureMessage === null && asset.errorMessage !== null && asset.errorMessage.length > 0) {
        failureMessage = asset.errorMessage
      }
    }
  }
  return {
    // 全部就绪且无失败（totalCount=0 时不算就绪——无可证明的资产）。
    ready: !failed && totalCount > 0 && loadedCount === totalCount,
    failed,
    loadedCount,
    totalCount,
    failureMessage,
  }
}

/**
 * 由「入场总 elapsed + 资产就绪 / 失败」确定性派生当前阶段（纯函数，单调）。
 *
 * 顺序固定（TASK-020 验证方式 1「阶段顺序固定、每阶段只进一次」）：
 * - failed=true → error（终态；无论 elapsed，加载失败显式终止）。
 * - 未就绪（!ready）→ loading（起点；elapsed 在此态恒为 0）。
 * - 就绪后按 elapsed 切分：[0, terrainRise) → terrain-rise；[terrainRise, terrainRise+labelsFade) →
 *   labels-fade-in；[terrainRise+labelsFade, total) → scene-layers-fade-in；≥ total → interactive。
 *
 * 单调性：ready / failed 单调（资产不会由就绪退回加载中、失败不会消除），elapsed 单调递增，故阶段只前进
 * 不回退——每阶段只进一次。interactive / error 为终态，elapsed 继续增长也不会离开它们。
 */
export function deriveEntrancePhase(
  elapsedSeconds: number,
  ready: boolean,
  failed: boolean,
  durations: EntranceDurations,
): EntrancePhase {
  // 加载失败：显式终态，优先于一切（保留诊断、不回退）。
  if (failed) return 'error'
  // 资产未全部就绪：停留在 loading（elapsed 在此态由控制器保持为 0）。
  if (!ready) return 'loading'
  // 资产就绪后按 elapsed 切分阶段（边界用 ≥ 使「恰在边界」归入后段，terrainRise 边界处 rise 已=1）。
  const total = totalEntranceSeconds(durations)
  if (elapsedSeconds >= total) return 'interactive'
  const labelsStart = durations.terrainRiseSeconds
  if (elapsedSeconds >= labelsStart + durations.labelsFadeSeconds) return 'scene-layers-fade-in'
  if (elapsedSeconds >= labelsStart) return 'labels-fade-in'
  return 'terrain-rise'
}

/**
 * 地形 uRise（[0,1]）= smoothstep(elapsed / terrainRiseSeconds)。
 *
 * elapsed=0 → 0（平面）；elapsed=terrainRiseSeconds → 1（升毕，夸张后真实高度）；其后恒 1。smoothstep
 * 使首末两端变化平缓、中段加速，升起观感自然（SPEC §4.3「约 1.2 秒从平面升至最终夸张高度」）。地形升起
 * 复用 GPU 位移 uniform（uRise），不建第二套几何——本函数只产出 [0,1] 标量供渲染层写入 uRise.value。
 */
export function computeTerrainRise(elapsedSeconds: number, durations: EntranceDurations): number {
  return smoothstep(elapsedSeconds / durations.terrainRiseSeconds)
}

/**
 * 水面 / 边界透明度（[0,1]）。
 *
 * 在省名淡入完成后（elapsed ≥ terrainRise + labelsFade）开始，经 sceneLayersFadeSeconds 平滑 0→1；
 * 其后恒 1。loading / terrain-rise / labels-fade-in 期间为 0（海面 + 边界不可见，符合 SPEC §4.3「水面、
 * 边界线随后淡入」）。供 SeaSurface / ProvinceBorders / PoliticalFeatures 各自乘到其透明度通道。
 */
export function computeSceneLayerOpacity(elapsedSeconds: number, durations: EntranceDurations): number {
  const start = durations.terrainRiseSeconds + durations.labelsFadeSeconds
  return smoothstep((elapsedSeconds - start) / durations.sceneLayersFadeSeconds)
}

/**
 * 单个省名标签的入场透明度（[0,1]），按自西向东错峰（SPEC §4.3「按地理顺序错峰，如自西向东」）。
 *
 * 错峰模型：省名淡入阶段起点 = terrainRiseSeconds；首个标签（staggerIndex=0）在该起点开始（delay=0），
 * 末个标签（staggerIndex=staggerCount−1）在「错峰窗口」末尾开始（delay = 错峰窗口），每个标签经
 * 「总时长 − 错峰窗口」秒完成 0→1；末个恰在阶段结束完成（delay + perLabel = 总时长）。
 * - staggerIndex 越小（西部，世界 x 越小）→ delay 越小 → 越早淡入（自西向东）。
 * - staggerCount ≤ 1 时无错峰（单标签直接整体淡入）。
 *
 * 阶段前（elapsed < terrainRise）→ 0；阶段后（elapsed 大）→ smoothstep 钳到 1，标签恒可见。
 */
export function computeProvinceLabelOpacity(
  elapsedSeconds: number,
  durations: EntranceDurations,
  staggerIndex: number,
  staggerCount: number,
): number {
  const phaseStart = durations.terrainRiseSeconds
  const t = elapsedSeconds - phaseStart
  // 阶段未开始（地形升起中）→ 标签不可见。
  if (t <= 0) return 0
  // 错峰窗口（首个到末个的起始时间跨度）= 总时长 × 窗口分数；每标签淡入时长 = 总时长 − 窗口。
  const window = durations.labelsFadeSeconds * durations.labelStaggerWindowFraction
  const perLabel = durations.labelsFadeSeconds - window
  // 末个标签 delay = 窗口（staggerIndex / (staggerCount−1) ∈ [0,1]）；staggerCount≤1 时 delay=0。
  const delay = staggerCount <= 1 ? 0 : (staggerIndex / (staggerCount - 1)) * window
  return smoothstep((t - delay) / perLabel)
}

/**
 * 省会光点 / 岛礁名称标签的入场透明度（[0,1]，整体淡入非错峰）。
 *
 * 在省名淡入阶段随整体进度 0→1（smoothstep((elapsed − terrainRise) / labelsFadeSeconds)）；阶段前为 0、
 * 阶段后恒 1。省会光点与岛礁名称不参与省名的自西向东错峰（它们是次要标注），随省名淡入同阶段整体显现。
 */
export function computeAncillaryLabelOpacity(elapsedSeconds: number, durations: EntranceDurations): number {
  const phaseStart = durations.terrainRiseSeconds
  return smoothstep((elapsedSeconds - phaseStart) / durations.labelsFadeSeconds)
}

/**
 * 是否处于可交互态（唯一启用相机交互的阶段，TASK-020 输出约束「状态到达可交互后释放 OrbitControls」）。
 *
 * 仅 phase === 'interactive' 时为 true；loading / error / 三个动画阶段均锁定相机（无意义旋转 / 探索未就绪
 * 或正在入场的场景）。由 ChinaMapScreen 据此单一显式布尔驱动 MapOrbitControls.enabled（启停契约，
 * TASK-011），不存在第二套交互开关。
 */
export function isEntranceInteractive(phase: EntrancePhase): boolean {
  return phase === 'interactive'
}

/**
 * 钳到 [0,1]（非有限值归 0，防御 NaN / Infinity 进入透明度 / rise）。
 */
function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0
  if (value < 0) return 0
  if (value > 1) return 1
  return value
}

/**
 * smoothstep 缓动（C¹ 连续，首末两端变化平缓、中段加速）。
 *
 * 入场各通道（rise / 透明度）用它插值，避免线性插值的机械感（SPEC §4.3「过程顺滑」）。纯函数、无分配。
 */
function smoothstep(value: number): number {
  const t = clamp01(value)
  return t * t * (3 - 2 * t)
}
