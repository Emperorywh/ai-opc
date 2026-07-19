/**
 * 政治边界补充要素（十段线 + 岛礁点位）的主图呈现数据准备（领域层，TASK-015）。
 *
 * 角色与依赖方向：
 * - 本模块属于运行时访问层（src/lib），与 province-borders.ts / elevation.ts / projection.ts 同层。它把
 *   「政治边界补充契约（PoliticalBoundaryContract，TASK-006 共享事实源）+ 共享双线性高程查询
 *   （ElevationProvider）+ 夸张系数 k + densify / 海平面贴合 epsilon 配置」确定性地变换为「十段线各段的
 *   densify 贴地子段端点 + 岛礁点位的世界坐标」，供渲染层（src/three/PoliticalFeatures）**只消费、不再
 *   计算**。本模块是 SPEC §5.3「九段线作为独立 LineString 渲染（贴地 / 海面）」+ §6「南海诸岛 / 钓鱼岛 /
 *   赤尾屿等必需点位」的主图呈现的领域实现。
 * - 单向依赖：本模块只依赖契约层 src/geo-contracts（PoliticalBoundaryContract / NineDashLineSegmentFeature /
 *   IslandOrReefPointFeature / LonLatCoordinate 类型、SPEC §6 红线点名领域真值 political-catalog 的
 *   REQUIRED_NINE_DASH_SEGMENT_INDICES / TAIWAN_EAST_SEGMENT_INDEX / EXPECTED_NINE_DASH_SEGMENT_COUNT /
 *   REQUIRED_ISLAND_NAMES）、同层坐标权威 src/lib/projection（projectToWorld —— lon/lat→世界 x,z 的唯一入口）、
 *   同层高程权威 src/lib/elevation（ElevationProvider.queryAtWorld —— 世界点→真实米制海拔的唯一入口）。
 *   **禁止**依赖 React / R3F / Three.js / DOM / hover 状态 / src/config（与省界准备层同构的分层约束）。
 *
 * 唯一事实源（TASK-015 实现约束「不得复制、手改或在组件内补写十段线 / 岛礁坐标；唯一事实源来自 TASK-006」）：
 * - 十段线段序号、岛礁规范名称与坐标全部来自入参 PoliticalBoundaryContract（由 src/lib/political-boundary
 *   从 public/geo/china-political-boundary.json 加载、经契约校验）。本模块**不**内置任何坐标，**不**补写
 *   任何段或点，**不**从别处读取九段线 / 岛礁数据。后续 2D 南海附图（TASK-019）复用同一契约。
 *
 * 红线完整性（SPEC §6、TASK-015 验证方式 1「十个线段和全部必需点位都被主图渲染模型消费」、验证方式 2
 * 「删除台湾东侧段或一个必需附属岛屿 → 渲染准备失败，不能静默显示残缺地图」、实现约束「不把十段线合并为
 * 不可核查的单条连续折线，不得遗漏台湾东侧段」）：
 * - 准备入口对 SPEC §6 红线点名项做独立锚点断言（与 scripts/verify-assets/political-deep 的资产级深度校验
 *   共用 src/geo-contracts/political-catalog 同一份领域真值，不在本模块手写第二套段数 / 段序号 / 岛礁名）：
 *   · 恰好 EXPECTED_NINE_DASH_SEGMENT_COUNT（10）段，段序号 REQUIRED_NINE_DASH_SEGMENT_INDICES（1..10）全在；
 *   · 台湾东侧段（TAIWAN_EAST_SEGMENT_INDEX = 10）独立硬编码锚点（不经段序号清单间接得出，即便清单被误改
 *     仍要求资产含此段）；
 *   · REQUIRED_ISLAND_NAMES（钓鱼岛 / 赤尾屿 / 曾母暗沙）均在。
 * - 任一缺失 → 抛 PoliticalFeaturePrepError（带稳定 code），整条准备失败，绝不产出「缺段 / 缺点的残缺
 *   十段线」（残缺十段线会把「政治边界不完整」伪装成「成功呈现」，违反 SPEC §6 红线）。
 * - 十段线按段（segmentIndex）独立组织输出（PreparedPoliticalLine[]），不合并为单条连续折线——使每段
 *   可独立审计、台湾东侧段可独立定位，且渲染层每段一个 Line（draw call 可审计）。
 *
 * 海平面贴合（SPEC §3.5 海面 / §5.3 九段线贴地或海面、TASK-015 输出约束「高度由共享高程 / 海平面语义确定，
 * 既不被海面完全吞没，也不使用与地图脱节的固定世界坐标」）：
 * - 十段线绝大部段与岛礁点位落在海域。若照省界公式 world_y = h·k + epsilon 直接贴合地形，海域负高程
 *   （h<0）会把线 / 点压到海面（y=0）之下被半透明海面吞没。故政治要素采用「海平面贴合」语义：
 *     world_y = max(h·k, seaLevelYMeters) + epsilon
 *   陆地（h·k>0）贴合真实地形（与省界一致）；海域（h·k≤0）钳制到海平面之上 epsilon，恒可见。
 * - h 取自共享 ElevationProvider.queryAtWorld（与地形 GPU 位移同一份高程事实源、同一双线性语义）；
 *   seaLevelYMeters 取自 src/config/political-features（= SEA_LEVEL_Y_METERS = 0，与动态海面同一米制海平面）。
 *   二者构成「共享高程 / 海平面语义」，不使用与地图脱节的固定世界坐标。
 * - h·k 与 GPU vertex shader 的 `displaced.y = h * uExaggeration`（src/three/terrain-shaders）、省界准备的
 *   queryTerrainWorldY 是同一公式；此处内联 h·k 以避免 src/lib 反向依赖 src/config（被禁止的是复制 heightmap
 *   解码 / 投影公式，本模块全部复用 projection / elevation 的唯一入口）。
 *
 * densify 间距（SPEC §3.6 / §5.3，与省界同口径）：
 * - 十段线原始折线顶点稀疏（每段仅 2–3 顶点），若直接抬升后用直线跨越，跨岛礁 / 跨陆海交界处会穿地形或
 *   悬空。故先沿世界弧长 densify（间距 ≈ 主图宽度 / 4096，与 heightmap 纹素、与省界 densify 三者一致），
 *   每个 densify 顶点独立投影并查询高程（海平面贴合），使十段线逐顶点贴合地形或海面。
 * - 十段线绝大部段在海域（海面平坦），densify 主要保证跨岛礁 / 跨陆海交界处逐顶点贴合，而非追随海底起伏。
 *
 * 异常语义（与省界准备同构，TASK-015 输出约束「无效输入或查询失败时整条准备明确失败」）：
 * - 输入非法（exaggeration 非有限 / spacing 非法 / epsilon 非有限 / seaLevelY 非有限 / 契约 features 为空）→
 *   抛 PoliticalFeaturePrepError，整条准备失败。红线缺项（见上）同样抛错。
 * - 任一顶点投影失败（projectToWorld 失败——越出主图范围）、任一高程查询失败（queryAtWorld 失败——越出
 *   元数据范围 / provider 已释放）→ 抛 PoliticalFeaturePrepError，绝不产出部分线 / 点。
 */

import type {
  IslandOrReefPointFeature,
  LonLatCoordinate,
  NineDashLineSegmentFeature,
  PoliticalBoundaryContract,
} from '../geo-contracts'
import { EXPECTED_NINE_DASH_SEGMENT_COUNT, TAIWAN_EAST_SEGMENT_INDEX } from '../geo-contracts/political-catalog'
import type { ElevationProvider } from './elevation'
import { collectPoliticalRedLineGaps } from './political-red-line'
import { projectToWorld } from './projection'

/**
 * 政治要素准备的入参配置（领域层声明的「我需要什么」，由 src/config/political-features 提供具体值）。
 *
 * 与省界 ProvinceBorderPrepConfig 同构（densify 间距 + epsilon），额外携带 seaLevelYMeters——海平面贴合
 * 语义 world_y = max(h·k, seaLevelYMeters) + epsilon 的「海平面」锚点（与动态海面同一米制海平面）。
 * 本接口不承载渲染参数（颜色 / 线宽 / 虚线 / 深度偏移属渲染层，不进领域层）。
 */
export interface PoliticalFeaturePrepConfig {
  /** densify 间距（米，世界弧长）。每个子段端点弧长间距 ≤ 此值。 */
  readonly densifySpacingMeters: number
  /** 海平面贴合 epsilon（米，世界 y 偏移）。world_y = max(h·k, seaLevelYMeters) + 此值。 */
  readonly terrainEpsilonMeters: number
  /** 海平面世界 y（米），与动态海面同一米制海平面（= 0）。 */
  readonly seaLevelYMeters: number
}

/** 主图世界平面坐标（米，可变以减少分配）：x 东距、z 南距。仅本模块内部使用。 */
interface WorldXZ {
  x: number
  z: number
}

/**
 * 准备好的单段十段线（一个 nineDashLineSegment）。
 *
 * 按 segmentIndex 独立组织（不与其他段合并为连续折线），使每段可独立审计、台湾东侧段（segmentIndex=10）
 * 可独立定位，且渲染层每段一个 Line（draw call 可审计）。TASK-015 实现约束「不把十段线合并为不可核查的
 * 单条连续折线」。
 */
export interface PreparedPoliticalLine {
  /** 段序号（1..10），与源契约 segmentIndex 一一对应；台湾东侧段 segmentIndex=10。 */
  readonly segmentIndex: number
  /**
   * 该段 densify 子段端点平铺数组 [x0,y0,z0, x1,y1,z1, ...]：每连续 6 个数 = 一条子段（起点+终点）。
   * 该形态直接喂给 LineSegmentsGeometry.setPositions（segments 模式按 [a,b] 对解释），无需再次重组。
   * y 已海平面贴合（world_y = max(h·k, seaLevelYMeters) + epsilon）。
   */
  readonly segmentEndpointsFlat: ReadonlyArray<number>
  /** 子段条数 = segmentEndpointsFlat.length / 6（审计与断言用）。 */
  readonly segmentCount: number
}

/** 准备好的单个岛礁 / 附属岛屿点位（主图真实位置有可见标记）。 */
export interface PreparedPoliticalPoint {
  /** 规范名称（钓鱼岛 / 赤尾屿 / 曾母暗沙等），与源契约 name 一一对应。 */
  readonly name: string
  /** 世界坐标 [x, y, z]；y 已海平面贴合（world_y = max(h·k, seaLevelYMeters) + epsilon）。 */
  readonly position: readonly [number, number, number]
}

/** 准备好的全部政治要素（渲染层消费的稳定产物）。 */
export interface PreparedPoliticalFeatures {
  /** 十段线各段（按 segmentIndex 升序，台湾东侧段 segmentIndex=10 在内）。 */
  readonly lines: readonly PreparedPoliticalLine[]
  /** 岛礁 / 附属岛屿点位（按源契约出现顺序）。 */
  readonly points: readonly PreparedPoliticalPoint[]
  /** 十段线总线段数（draw call / 顶点预算审计用）。 */
  readonly totalLineSegmentCount: number
}

/** 准备失败的稳定错误码（供自动化测试精确断言「缺段 / 缺点 / 无效输入时整条准备失败」）。 */
export type PoliticalFeaturePrepFailureCode =
  | 'political-features.exaggeration-not-finite'
  | 'political-features.spacing-invalid'
  | 'political-features.epsilon-not-finite'
  | 'political-features.sea-level-not-finite'
  | 'political-features.empty-features'
  | 'political-features.segment-count-mismatch'
  | 'political-features.segment-missing'
  | 'political-features.taiwan-east-segment-missing'
  | 'political-features.required-island-missing'
  | 'political-features.projection-failed'
  | 'political-features.elevation-query-failed'
  | 'political-features.no-line-segments-produced'

/**
 * 政治要素准备错误：携带稳定 code 与简体中文说明。
 * 红线缺项（段 / 点）、输入非法、任一投影 / 高程查询失败或全体退化时抛出，使整条准备明确失败、
 * 不产出残缺十段线 / 缺失岛礁（TASK-015 验证方式 2）。
 */
export class PoliticalFeaturePrepError extends Error {
  readonly code: PoliticalFeaturePrepFailureCode
  constructor(code: PoliticalFeaturePrepFailureCode, message: string) {
    super(message)
    this.name = 'PoliticalFeaturePrepError'
    this.code = code
  }
}

/**
 * 把九段线段的经纬度顶点序列投影到主图世界 (x, z) 平面。
 *
 * 任一顶点 projectToWorld 失败（越出主图范围 [72°E,136°E]×[3°N,54°N]）→ 抛 projection-failed。
 * 九段线 / 岛礁坐标天然在境内（资产级 coordinate-out-of-extent 已把关），正常运行路径不触发。
 */
function projectSegmentToWorld(
  coordinates: readonly LonLatCoordinate[],
  segmentIndex: number,
): WorldXZ[] {
  const world: WorldXZ[] = []
  for (let i = 0; i < coordinates.length; i++) {
    const coord = coordinates[i]
    const result = projectToWorld(coord.lon, coord.lat)
    if (!result.ok) {
      throw new PoliticalFeaturePrepError(
        'political-features.projection-failed',
        `九段线第 ${segmentIndex} 段的第 ${i} 个顶点投影失败 lon=${coord.lon} lat=${coord.lat}：${result.code}。`,
      )
    }
    world.push({ x: result.value.x, z: result.value.z })
  }
  return world
}

/**
 * 对世界 (x, z) 点查询「海平面贴合」世界 y：共享高程查询得真实米制 h，
 * world_y = max(h·k, seaLevelYMeters) + epsilon。
 *
 * 海平面贴合语义（见文件头）：陆地（h·k>0）贴合地形；海域（h·k≤0）钳制到海平面之上 epsilon，
 * 使十段线 / 岛礁点位不被半透明海面吞没（TASK-015 输出约束「不被海面完全吞没」）。
 *
 * queryAtWorld 内部先 invertWorld 反算经纬度、再 queryAtLonLat（含元数据范围校验 + 双线性采样）。
 * 任一步失败（越出元数据范围 / provider 已释放 / 反投影失败）→ 抛 elevation-query-failed。
 *
 * h·k 与 GPU vertex shader 的 `displaced.y = h * uExaggeration`（src/three/terrain-shaders）、省界准备的
 * queryTerrainWorldY 是同一公式；此处内联以避免 src/lib 反向依赖 src/config。
 */
function querySeaLevelConformantWorldY(
  x: number,
  z: number,
  provider: ElevationProvider,
  exaggeration: number,
  epsilon: number,
  seaLevelYMeters: number,
  context: string,
): number {
  const query = provider.queryAtWorld(x, z)
  if (!query.ok) {
    throw new PoliticalFeaturePrepError(
      'political-features.elevation-query-failed',
      `${context} 海平面贴合高程查询失败 x=${x} z=${z}：${query.code}。`,
    )
  }
  // 真实海拔 h × 夸张系数 k；与 GPU 位移同一公式。query 经 !ok 收窄为 ElevationQuerySuccess。
  const terrainWorldY = query.meters * exaggeration
  // 海平面贴合：陆地贴合地形（terrainWorldY > seaLevel），海域钳制到海平面（seaLevel）之上 epsilon。
  return Math.max(terrainWorldY, seaLevelYMeters) + epsilon
}

/**
 * 对一条世界 (x,z) 边做弧长 densify，把每个子段（起点+终点，均已海平面贴合）的 6 个数追加到 out。
 *
 * densify 策略（SPEC §3.6「沿弧长」，与省界 appendDensifiedEdgeSegments 同构）：
 * - 子段数 steps = ceil(边长 / 间距)，保证每个子段弧长 ≤ 间距。
 * - 对每个子段的起、终点独立查询海平面贴合 y。相邻子段共享的端点会被查询两次：高程查询是确定性的纯函数，
 *   两次结果完全一致，共享端点 (x,y,z) 逐分量相等 → 渲染时线段严丝合缝无缝隙。
 * - 零长度边（len=0）→ 不产出任何子段，不报错。
 *
 * @param out 追加目标（平铺 [x,y,z, x,y,z, ...] 对）。
 */
function appendDensifiedEdgeSegments(
  ax: number,
  az: number,
  bx: number,
  bz: number,
  spacing: number,
  provider: ElevationProvider,
  exaggeration: number,
  epsilon: number,
  seaLevelYMeters: number,
  segmentIndex: number,
  out: number[],
): void {
  const dx = bx - ax
  const dz = bz - az
  const edgeLength = Math.hypot(dx, dz)
  // 零长度边：跳过（不产出子段）。
  if (edgeLength === 0) {
    return
  }
  // steps ≥ 1：即使边短于间距也至少 1 段。
  const steps = Math.max(1, Math.ceil(edgeLength / spacing))
  for (let s = 0; s < steps; s++) {
    const t0 = s / steps
    const t1 = (s + 1) / steps
    const x0 = ax + dx * t0
    const z0 = az + dz * t0
    const x1 = ax + dx * t1
    const z1 = az + dz * t1
    const y0 = querySeaLevelConformantWorldY(
      x0,
      z0,
      provider,
      exaggeration,
      epsilon,
      seaLevelYMeters,
      `九段线第 ${segmentIndex} 段`,
    )
    const y1 = querySeaLevelConformantWorldY(
      x1,
      z1,
      provider,
      exaggeration,
      epsilon,
      seaLevelYMeters,
      `九段线第 ${segmentIndex} 段`,
    )
    out.push(x0, y0, z0, x1, y1, z1)
  }
}

/**
 * 对单段九段线做 densify + 海平面贴合，把所有子段端点追加到 out。
 *
 * 九段线段是开放折线（非闭合环，不像省界那样首尾相接），只对相邻顶点间的边 densify，不追加闭合边。
 */
function appendLineSegmentEdges(
  segment: NineDashLineSegmentFeature,
  spacing: number,
  provider: ElevationProvider,
  exaggeration: number,
  epsilon: number,
  seaLevelYMeters: number,
  out: number[],
): void {
  const world = projectSegmentToWorld(segment.coordinates, segment.segmentIndex)
  // 开放折线：只对相邻顶点间的边 densify（i → i+1），不闭合。
  for (let i = 0; i + 1 < world.length; i++) {
    const a = world[i]
    const b = world[i + 1]
    appendDensifiedEdgeSegments(
      a.x,
      a.z,
      b.x,
      b.z,
      spacing,
      provider,
      exaggeration,
      epsilon,
      seaLevelYMeters,
      segment.segmentIndex,
      out,
    )
  }
}

/**
 * 对政治边界契约做红线完整性断言（SPEC §6，与资产级深度校验、与 2D 南海附图准备共用同一份领域真值）。
 *
 * 任一红线缺项 → 抛 PoliticalFeaturePrepError（稳定 code），整条准备失败、不产出残缺十段线 / 缺失岛礁。
 * 断言项（TASK-015 验证方式 1「十个线段和全部必需点位都被消费」、验证方式 2「缺段 / 缺点 → 失败」）：
 * - 恰好 EXPECTED_NINE_DASH_SEGMENT_COUNT（10）段，段序号 REQUIRED_NINE_DASH_SEGMENT_INDICES（1..10）全在；
 * - 台湾东侧段（TAIWAN_EAST_SEGMENT_INDEX = 10）独立硬编码锚点；
 * - REQUIRED_ISLAND_NAMES（钓鱼岛 / 赤尾屿 / 曾母暗沙）均在。
 *
 * 数据复用（TASK-019 实现约束「主图和附图必须共享 TASK-006 数据...禁止复制一份专用十段线、岛礁或
 * 名称数组」）：红线「目录」唯一来自 political-catalog，「扫描逻辑」唯一来自共享单源
 * collectPoliticalRedLineGaps（src/lib/political-red-line，TASK-019 抽取）。本函数只据缺项事实按
 * 既定顺序抛本层稳定错误码（political-features.*），不再各自遍历 features / 对照目录常量——
 * 2D 南海附图准备（src/lib/south-china-sea-inset）走同一扫描结果、抛各自错误码（south-china-sea-inset.*），
 * 二者不存在第二套段数 / 段序号 / 岛礁名清单或扫描代码。错误码与抛出顺序与重构前逐项一致。
 */
function assertRedLineCompleteness(contract: PoliticalBoundaryContract): void {
  const gaps = collectPoliticalRedLineGaps(contract)

  // 段数：恰好 10 段（十段画法，SPEC §6）。
  if (gaps.segmentCount !== EXPECTED_NINE_DASH_SEGMENT_COUNT) {
    throw new PoliticalFeaturePrepError(
      'political-features.segment-count-mismatch',
      `九段线必须恰好含 ${EXPECTED_NINE_DASH_SEGMENT_COUNT} 段（十段画法），实际为 ${gaps.segmentCount} 段——拒绝准备残缺十段线。`,
    )
  }

  // 段序号 1..10 全在（逐段核对，缺哪段就指明哪段）。
  if (gaps.missingSegmentIndices.length > 0) {
    throw new PoliticalFeaturePrepError(
      'political-features.segment-missing',
      `九段线缺少段序号：[${gaps.missingSegmentIndices.join(', ')}]（十段画法需 1..10 全在）——拒绝准备残缺十段线。`,
    )
  }

  // 台湾东侧段（segmentIndex===10）独立硬编码锚点（SPEC §6 红线）。
  if (!gaps.taiwanEastSegmentPresent) {
    throw new PoliticalFeaturePrepError(
      'political-features.taiwan-east-segment-missing',
      `九段线缺少台湾东侧段（segmentIndex=${TAIWAN_EAST_SEGMENT_INDEX}），SPEC §6 红线要求十段画法含台湾东侧那段——拒绝准备残缺十段线。`,
    )
  }

  // SPEC §6 点名岛礁（钓鱼岛 / 赤尾屿 / 曾母暗沙）均在。
  if (gaps.missingIslandNames.length > 0) {
    throw new PoliticalFeaturePrepError(
      'political-features.required-island-missing',
      `缺少 SPEC §6 点名岛礁 / 附属岛屿：[${gaps.missingIslandNames.join('、')}]——拒绝准备缺失岛礁点位的残缺主图。`,
    )
  }
}

/**
 * 把政治边界补充契约确定性地准备为主图呈现要素（十段线 densify 海平面贴合子段 + 岛礁点位世界坐标）。
 *
 * 流水线：
 * 1. 入参校验：exaggeration 有限、spacing 合法（有限且 > 0）、epsilon 有限、seaLevelY 有限、features 非空。
 * 2. 红线完整性断言（assertRedLineCompleteness）：十段含台湾东侧段、点名岛礁均在，缺任一项即抛错。
 * 3. 逐段九段线：投影到世界 (x,z) → 沿世界弧长 densify → 逐 densify 顶点海平面贴合 → 输出子段端点平铺数组。
 * 4. 逐岛礁点位：投影到世界 (x,z) → 海平面贴合 → 输出世界坐标 [x,y,z]。
 * 5. 全体审计：十段线总线段数为 0（全体退化）→ 抛 no-line-segments-produced。
 *
 * 争议区修正（disputedBoundaryCorrection）不被本模块消费——TASK-015 主图只呈现十段线与岛礁点位，
 * 争议区按中国主张画法的修正影响省级边界表达，由 TASK-014 省界层承载。争议区完整性的运行时把关
 * 由资产校验管线（scripts/verify-assets/political-deep）承担。
 *
 * @param contract 政治边界补充契约（TASK-006 共享事实源，已通过 political-boundary 契约校验）。
 * @param provider 共享双线性高程查询（TASK-008），与 GPU 位移同一份高程事实源。
 * @param exaggeration 垂直夸张系数 k（来自配置层，合法范围由配置层保证）。
 * @param config densify 间距 + 海平面贴合 epsilon + 海平面 y（来自 src/config/political-features）。
 * @returns 十段线各段 densify 海平面贴合子段 + 岛礁点位世界坐标（渲染层直接消费）。
 * @throws {PoliticalFeaturePrepError} 红线缺项、输入非法、任一投影 / 高程查询失败、或全体退化时。
 */
export function preparePoliticalFeatures(
  contract: PoliticalBoundaryContract,
  provider: ElevationProvider,
  exaggeration: number,
  config: PoliticalFeaturePrepConfig,
): PreparedPoliticalFeatures {
  // 入参校验（任一非法 → 显式失败，绝不静默产出残缺要素）。
  if (!Number.isFinite(exaggeration)) {
    throw new PoliticalFeaturePrepError(
      'political-features.exaggeration-not-finite',
      `夸张系数必须为有限数值，实际为 ${exaggeration}。`,
    )
  }
  if (
    !Number.isFinite(config.densifySpacingMeters) ||
    config.densifySpacingMeters <= 0
  ) {
    throw new PoliticalFeaturePrepError(
      'political-features.spacing-invalid',
      `densify 间距必须为正的有限数值，实际为 ${config.densifySpacingMeters}。`,
    )
  }
  if (!Number.isFinite(config.terrainEpsilonMeters)) {
    throw new PoliticalFeaturePrepError(
      'political-features.epsilon-not-finite',
      `海平面贴合 epsilon 必须为有限数值，实际为 ${config.terrainEpsilonMeters}。`,
    )
  }
  if (!Number.isFinite(config.seaLevelYMeters)) {
    throw new PoliticalFeaturePrepError(
      'political-features.sea-level-not-finite',
      `海平面世界 y 必须为有限数值，实际为 ${config.seaLevelYMeters}。`,
    )
  }
  if (contract.features.length === 0) {
    throw new PoliticalFeaturePrepError(
      'political-features.empty-features',
      '政治要素准备需要至少一个要素，实际 contract.features 为空。',
    )
  }

  // 红线完整性断言（SPEC §6：十段含台湾东侧段、点名岛礁均在）。
  assertRedLineCompleteness(contract)

  const lines: PreparedPoliticalLine[] = []
  let totalLineSegmentCount = 0
  const points: PreparedPoliticalPoint[] = []

  for (const feature of contract.features) {
    if (feature.type === 'nineDashLineSegment') {
      const endpoints: number[] = []
      appendLineSegmentEdges(
        feature,
        config.densifySpacingMeters,
        provider,
        exaggeration,
        config.terrainEpsilonMeters,
        config.seaLevelYMeters,
        endpoints,
      )
      const segmentCount = endpoints.length / 6
      lines.push({
        segmentIndex: feature.segmentIndex,
        segmentEndpointsFlat: endpoints,
        segmentCount,
      })
      totalLineSegmentCount += segmentCount
    } else if (feature.type === 'islandOrReefPoint') {
      points.push(prepareIslandPoint(feature, provider, exaggeration, config))
    }
    // disputedBoundaryCorrection 不被本模块消费（见函数注释）。
  }

  // 十段线全体退化（所有段都产出零线段）→ 显式失败：合法十段线（每段 ≥ 2 顶点）必有非零边。
  if (totalLineSegmentCount === 0) {
    throw new PoliticalFeaturePrepError(
      'political-features.no-line-segments-produced',
      '十段线全部段均未产出线段（全体退化），无法生成主图十段线。',
    )
  }

  // 按段序号升序输出，使台湾东侧段（segmentIndex=10）位置确定、可审计。
  lines.sort((a, b) => a.segmentIndex - b.segmentIndex)

  return { lines, points, totalLineSegmentCount }
}

/**
 * 把单个岛礁 / 附属岛屿点位准备为主图世界坐标（海平面贴合）。
 *
 * 投影到世界 (x,z) → 海平面贴合得 y → 输出 [x, y, z]。投影 / 高程查询失败时抛对应 code。
 */
function prepareIslandPoint(
  feature: IslandOrReefPointFeature,
  provider: ElevationProvider,
  exaggeration: number,
  config: PoliticalFeaturePrepConfig,
): PreparedPoliticalPoint {
  const { lon, lat } = feature.coordinate
  const projected = projectToWorld(lon, lat)
  if (!projected.ok) {
    throw new PoliticalFeaturePrepError(
      'political-features.projection-failed',
      `岛礁点位「${feature.name}」投影失败 lon=${lon} lat=${lat}：${projected.code}。`,
    )
  }
  const { x, z } = projected.value
  const y = querySeaLevelConformantWorldY(
    x,
    z,
    provider,
    exaggeration,
    config.terrainEpsilonMeters,
    config.seaLevelYMeters,
    `岛礁点位「${feature.name}」`,
  )
  return {
    name: feature.name,
    position: [x, y, z] as readonly [number, number, number],
  }
}
