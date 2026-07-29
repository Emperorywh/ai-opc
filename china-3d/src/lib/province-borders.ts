/**
 * 省级贴地边界的数据准备（领域层，TASK-009，SPEC §3.6）。
 *
 * 角色与依赖方向：
 * - 本模块属于运行时访问层（src/lib），与 projection.ts / elevation.ts 同层。它把「34 省行政区几何
 *   （EPSG:4326 lon/lat）+ 共享双线性高程查询（ElevationProvider）+ 夸张系数 k + densify/epsilon
 *   配置」确定性地变换为「按行政区分组、已投影到主图世界 (x,y,z)、沿真实地形连续起伏的线段端点
 *   列表」，供渲染层（src/three/ProvinceBorders）**只消费、不再计算**。本模块是 SPEC §3.6「贴地
 *   描边」的领域实现：先沿世界弧长 densify 到接近 heightmap 纹理分辨率，再对每个 densify 顶点查询
 *   共享高程、应用夸张系数、加最小 epsilon，使省界跨山脊 / 盆地 / 岛屿时连续起伏、不穿山、不悬空、
 *   不 z-fighting。
 * - 单向依赖：本模块只依赖契约层 src/geo-contracts（AdministrativeGeometryFeature / LonLatRing /
 *   AdministrativeGeometry 类型）、同层坐标权威 src/lib/projection（projectToWorld——lon/lat→世界
 *   x,z 的唯一入口）、同层高程权威 src/lib/elevation（ElevationProvider.queryAtWorld——世界点→真实
 *   米制海拔的唯一入口）。**禁止**依赖 React / R3F / Three.js / DOM / hover 状态 / src/config——
 *   也不得复制 heightmap 解码或投影公式（全部复用 projection / elevation 的唯一入口）。
 *
 * densify 间距（SPEC §3.6「DataV 原始折线顶点稀疏，跨山脊的直线段会穿山或悬空，必须先沿弧长
 * densify……采样间距接近 heightmap 分辨率，如每 1–2 km 或约 plane 宽 / 4096 一个点」）：
 * - DataV 原始省界折线顶点稀疏（一条省界可能只有几十 / 几百个顶点跨越数百公里），若直接抬升这些
 *   稀疏顶点、用直线段连接，线段会从山脊的直线弦上穿过——在山脊两侧表现为「穿山」（线段从山体
 *   内部穿过）或「悬空」（线段从山体上方跨过）。故必须先沿弧长 densify：把每条边按「世界米制
 *   弧长 / 间距」切成足够多的子段，每个子段端点独立查询高程，使折线逐顶点贴合地形。
 * - densify 在**世界米制空间**（投影后的世界 XZ 平面）做弧长均分，而非在经纬度空间：墨卡托在高纬
 *   放大，同样的经纬度跨度在北方对应更长的世界弧长；按世界弧长度量才能保证全境 densify 密度一致
 *   （SPEC §3.6 的「1–2 km」是世界米制，不是度）。
 * - 间距默认 = 主图世界宽度 / 4096 ≈ 1742 m（由 src/config/province-borders 提供，本模块作为入参
 *   接收），与 heightmap 纹素分辨率一一对应：每个 densify 子段约一个纹素宽，既不漏纹理级起伏，
 *   也不过密。
 *
 * 高程贴地（SPEC §3.6「对每个 densified 顶点投影到世界 (x,z)、采样 CPU 端解码的 heightmap 高度
 * 作为 y（+ epsilon 避免 z-fighting）」）：
 * - 每个 densify 顶点用共享 ElevationProvider.queryAtWorld(x, z) 查询真实米制海拔 h（与地形 vertex
 *   shader 的 GPU 位移同一份高程事实源、同一双线性语义），再令 world_y = h·k + epsilon。
 * - h·k 与 GPU vertex shader 内的 `displaced.z += h * uExaggeration * uRise`（src/three/terrain-shaders）
 *   以及 src/config/terrain-config 的 displaceElevationToWorldY 是同一公式。此处内联 h·k 而非 import
 *   该 helper：src/lib 不得反向依赖 src/config（配置层在访问层之上），且 h·k 是平凡乘法、属本层
 *   「应用夸张系数」的本职，注释标明镜像关系即可，不构成「复制公式」。
 * - epsilon 把省界顶点放到地表外侧（上方），补偿 CPU/GPU 高程采样的亚米级浮点差异（z-fighting 的
 *   主防线是渲染层的 NDC 深度偏移，epsilon 是辅助）。epsilon 由 src/config 提供、本模块作为入参接收。
 *
 * 异常语义（无效几何或高程查询失败时整条资产准备明确失败，不产生平地边界）：
 * - 任何顶点投影失败（projectToWorld 返回失败——越出主图范围）、任何高程查询失败（queryAtWorld
 *   返回失败——越出元数据范围 / provider 已释放）、输入 exaggeration 非有限 / spacing 非法 /
 *   epsilon 非有限 / features 为空 / 全体退化（零线段）→ 抛 ProvinceBorderPrepError（带稳定 code），
 *   整条资产准备失败，绝不产出部分省份的平地边界。平地边界会把「省界未贴地」伪装成「成功」。
 * - 不为个别省份写魔法高度修补：所有省份走同一 densify + 查询 + h·k+epsilon 流水线，省份差异只
 *   来自各自几何与所在地形。
 *
 * 分组与按行政区寻址（draw call 优化不能破坏按行政区寻址的能力，SPEC §3.6「按省分组」+ §4.2 hover）：
 * - 输出按 adminId 分组：每个 PreparedProvinceBorder 对应一个行政区，携带其全部环（外环 + 内环/洞 +
 *   多多边形的岛屿）densify 后的线段端点平铺数组。渲染层据此每个行政区建一个 Line（34 个 draw
 *   call——「尽量少的 draw call」在保留按省寻址前提下的落点），hover 通过更新单一行政区的材质参数
 *   即可加亮加粗，不影响其他省份。本模块不在输出中混入 hover 状态（hover 由渲染层经 context 消费）。
 */

import type {
  AdministrativeGeometry,
  AdministrativeGeometryFeature,
  LonLatRing,
} from '../geo-contracts'
import type { ElevationProvider } from './elevation'
import { projectToWorld } from './projection'

/**
 * 省界准备的入参配置（领域层声明的「我需要什么」，由 src/config/province-borders 提供具体值）。
 *
 * 把 spacing / epsilon 打包为对象而非散参：prepareProvinceBorders 的签名稳定、可读，且测试可直接
 * 构造字面量而不必依赖配置层。本接口不承载渲染参数（颜色 / 线宽 / 深度偏移属渲染层，不进领域层）。
 */
export interface ProvinceBorderPrepConfig {
  /** densify 间距（米，世界弧长）。每个子段端点弧长间距 ≤ 此值。 */
  readonly densifySpacingMeters: number
  /** 贴地 epsilon（米，世界 y 偏移）。world_y = h·k + 此值。 */
  readonly terrainEpsilonMeters: number
}

/** 主图世界平面坐标（米，可变以减少分配）：x 东距、z 南距。仅本模块内部使用。 */
interface WorldXZ {
  x: number
  z: number
}

/** 准备好的单个行政区边界。 */
export interface PreparedProvinceBorder {
  /** 行政区稳定标识（CN- 前缀），渲染层据此分组、hover 据此寻址。 */
  readonly adminId: string
  /**
   * 线段端点平铺数组 [x0,y0,z0, x1,y1,z1, x2,y2,z2, ...]：每连续 6 个数 = 一条线段（起点+终点）。
   * 该形态直接喂给 drei Line 的 segments 模式（按 [a,b] 对解释），无需再次重组。
   * 含该行政区全部环（外环 + 内环 + 多多边形岛屿）densify 后的全部子段。
   */
  readonly segmentEndpointsFlat: ReadonlyArray<number>
  /** 线段条数 = segmentEndpointsFlat.length / 6（审计与断言用）。 */
  readonly segmentCount: number
}

/** 准备好的全部行政区边界（渲染层消费的稳定产物）。 */
export interface PreparedProvinceBorders {
  /** 按行政区分组的边界列表（顺序与输入 features 一致）。 */
  readonly borders: readonly PreparedProvinceBorder[]
  /** 全部线段总条数（draw call / 顶点预算审计用）；为 0 表示输入退化，准备期已显式失败。 */
  readonly totalSegmentCount: number
}

/** 准备失败的稳定错误码（供自动化测试精确断言「无效几何 / 查询失败时整条准备失败」）。 */
export type ProvinceBorderPrepFailureCode =
  | 'province-borders.exaggeration-not-finite'
  | 'province-borders.spacing-invalid'
  | 'province-borders.epsilon-not-finite'
  | 'province-borders.empty-features'
  | 'province-borders.projection-failed'
  | 'province-borders.elevation-query-failed'
  | 'province-borders.no-segments-produced'

/**
 * 省界准备错误：携带稳定 code 与简体中文说明。
 * 任一顶点投影 / 高程查询失败、输入非法或全体退化时抛出，使整条资产准备明确失败、不产出平地边界。
 */
export class ProvinceBorderPrepError extends Error {
  readonly code: ProvinceBorderPrepFailureCode
  constructor(code: ProvinceBorderPrepFailureCode, message: string) {
    super(message)
    this.name = 'ProvinceBorderPrepError'
    this.code = code
  }
}

/**
 * 把行政区的几何统一展开为「环的列表」：Polygon 取 rings，MultiPolygon 取所有 polygon 的 rings。
 *
 * Polygon 与 MultiPolygon 在「环列表」层级统一：本模块对每个环（外环 / 内环 / 多多边形岛屿环）做
 * 相同的 densify + 贴地处理，不区分环的角色——内环（洞 / 飞地）与外环一样是省界的一部分，岛屿环
 * （海南、台湾等多多边形省份）同样完整保留。
 */
function collectRings(geometry: AdministrativeGeometry): readonly LonLatRing[] {
  if (geometry.type === 'Polygon') {
    return geometry.rings
  }
  // MultiPolygon：把每个 polygon 的 rings 摊平到一个列表，统一处理。
  const allRings: LonLatRing[] = []
  for (const polygon of geometry.polygons) {
    for (const ring of polygon.rings) {
      allRings.push(ring)
    }
  }
  return allRings
}

/**
 * 把一个经纬度环投影到主图世界 (x, z) 平面（densify 的前置：弧长度量必须在投影后的世界空间做）。
 *
 * 任一顶点 projectToWorld 失败（越出主图范围 [72°E,136°E]×[3°N,54°N]）→ 抛 projection-failed，
 * 整条准备失败。省界数据天然在境内，正常运行路径不触发；失败分支由自动化测试用越界点覆盖。
 */
function projectRingToWorld(ring: LonLatRing, adminId: string, ringIndex: number): WorldXZ[] {
  const world: WorldXZ[] = []
  for (let i = 0; i < ring.length; i++) {
    const coord = ring[i]
    const result = projectToWorld(coord.lon, coord.lat)
    if (!result.ok) {
      throw new ProvinceBorderPrepError(
        'province-borders.projection-failed',
        `行政区 ${adminId} 第 ${ringIndex} 个环的第 ${i} 个顶点投影失败 lon=${coord.lon} lat=${coord.lat}：${result.code}。`,
      )
    }
    world.push({ x: result.value.x, z: result.value.z })
  }
  return world
}

/**
 * 对世界 (x, z) 点查询贴地世界 y：共享高程查询得真实米制 h，world_y = h·k + epsilon。
 *
 * queryAtWorld 内部先 invertWorld 反算经纬度、再 queryAtLonLat（含元数据范围校验 + 双线性采样）。
 * 任一步失败（越出元数据范围 / provider 已释放 / 反投影失败）→ 抛 elevation-query-failed，整条
 * 准备失败，绝不回退到 y=0 平地。
 *
 * h·k 与 GPU vertex shader 的 `displaced.z += h * uExaggeration * uRise`（src/three/terrain-shaders）、
 * src/config/terrain-config 的 displaceElevationToWorldY 是同一公式；此处内联以避免 src/lib 反向
 * 依赖 src/config。
 */
function queryTerrainWorldY(
  x: number,
  z: number,
  provider: ElevationProvider,
  exaggeration: number,
  epsilon: number,
  adminId: string,
): number {
  const query = provider.queryAtWorld(x, z)
  if (!query.ok) {
    throw new ProvinceBorderPrepError(
      'province-borders.elevation-query-failed',
      `行政区 ${adminId} 贴地高程查询失败 x=${x} z=${z}：${query.code}。`,
    )
  }
  // world_y = 真实海拔 h × 夸张系数 k + epsilon（与 GPU 位移同一公式 + 可解释小偏移）。
  // query 经 !ok 收窄为 ElevationQuerySuccess，meters 即真实米制海拔 h。
  return query.meters * exaggeration + epsilon
}

/**
 * 对一条世界 (x,z) 边做弧长 densify，把每个子段（起点+终点，均已贴地）的 6 个数追加到 out。
 *
 * densify 策略（SPEC §3.6「沿弧长 densify」）：
 * - 子段数 steps = ceil(边长 / 间距)，保证每个子段弧长 ≤ 间距；间距约 1742 m（≈ heightmap 纹素宽），
 *   故每个子段约一个纹素，既不漏纹理级起伏，也不过密。
 * - 对每个子段的起、终点独立查询贴地 y（queryTerrainWorldY）。相邻子段共享的端点会被查询两次：
 *   高程查询是确定性的纯函数（同输入同输出），两次结果完全一致，共享端点 (x,y,z) 逐分量相等 →
 *   渲染时线段严丝合缝无缝隙。查询两次换实现简洁（无需全局点缓存），十万量级 densify 点的总查询
 *   耗时仍在百毫秒级（每次查询是闭式墨卡托反算 + 4 角双线性，无迭代）。
 * - 零长度边（len=0，如显式闭合环的首尾重复点）→ 不产出任何子段，不报错：相邻的非零边自然衔接。
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
  adminId: string,
  out: number[],
): void {
  const dx = bx - ax
  const dz = bz - az
  const edgeLength = Math.hypot(dx, dz)
  // 零长度边：跳过（不产出子段）。显式闭合环（首尾点重复）的接缝边常为零长度，跳过即可。
  if (edgeLength === 0) {
    return
  }
  // steps ≥ 1：即使边短于间距也至少 1 段（整条边作为一个子段，端点各查一次高程）。
  const steps = Math.max(1, Math.ceil(edgeLength / spacing))
  for (let s = 0; s < steps; s++) {
    const t0 = s / steps
    const t1 = (s + 1) / steps
    const x0 = ax + dx * t0
    const z0 = az + dz * t0
    const x1 = ax + dx * t1
    const z1 = az + dz * t1
    const y0 = queryTerrainWorldY(x0, z0, provider, exaggeration, epsilon, adminId)
    const y1 = queryTerrainWorldY(x1, z1, provider, exaggeration, epsilon, adminId)
    out.push(x0, y0, z0, x1, y1, z1)
  }
}

/**
 * 对单个行政区的全部环做 densify + 贴地，把所有子段端点追加到 out。
 *
 * 闭合环处理：环视为闭合——边 i 的终点 = 边 (i+1)%n 的起点，最后一条边从 ring[n-1] 回到 ring[0]
 * 闭合。无论源环是否显式首尾重合（契约不强制），都按闭合环处理：显式重合时接缝边为零长度、被
 * 跳过；不重合时接缝边正常 densify 闭合。
 */
function appendFeatureSegments(
  feature: AdministrativeGeometryFeature,
  spacing: number,
  provider: ElevationProvider,
  exaggeration: number,
  epsilon: number,
  out: number[],
): void {
  const rings = collectRings(feature.geometry)
  for (let ringIndex = 0; ringIndex < rings.length; ringIndex++) {
    const ring = rings[ringIndex]
    // 契约保证每个环 ≥ 3 个顶点；< 2 视为退化、跳过（防御，正常运行路径不触发）。
    if (ring.length < 2) {
      continue
    }
    const world = projectRingToWorld(ring, feature.adminId, ringIndex)
    const n = world.length
    // 闭合环：边 i → 边 (i+1)%n，最后一条边闭合回起点。
    for (let i = 0; i < n; i++) {
      const a = world[i]
      const b = world[(i + 1) % n]
      appendDensifiedEdgeSegments(
        a.x,
        a.z,
        b.x,
        b.z,
        spacing,
        provider,
        exaggeration,
        epsilon,
        feature.adminId,
        out,
      )
    }
  }
}

/**
 * 把 34 省行政区几何确定性地准备为贴地边界线段（领域纯函数，无 React / three / DOM 依赖）。
 *
 * 流水线（每省相同，无个省差异）：
 * 1. 入参校验：exaggeration 有限、spacing 合法（有限且 > 0）、epsilon 有限、features 非空。
 * 2. 逐省、逐环：投影到世界 (x,z) → 沿世界弧长 densify（间距 = spacing）→ 逐 densify 顶点
 *    queryAtWorld 得真实 h → world_y = h·k + epsilon → 输出子段端点平铺数组。
 * 3. 全体审计：总线段数为 0（全体退化）→ 抛 no-segments-produced（不产出空 / 平地边界）。
 *
 * @param features 34 省行政区几何（已通过 administrative-geometry 契约校验）。
 * @param provider 共享双线性高程查询（TASK-006 交付的 CPU 高程层），与 GPU 位移同一份高程事实源。
 * @param exaggeration 垂直夸张系数 k（来自配置层，合法范围由配置层保证）。
 * @param config densify 间距 + 贴地 epsilon（来自 src/config/province-borders）。
 * @returns 按行政区分组的贴地边界（渲染层直接消费）。
 * @throws {ProvinceBorderPrepError} 输入非法、任一投影 / 高程查询失败、或全体退化时。
 */
export function prepareProvinceBorders(
  features: readonly AdministrativeGeometryFeature[],
  provider: ElevationProvider,
  exaggeration: number,
  config: ProvinceBorderPrepConfig,
): PreparedProvinceBorders {
  // 入参校验（任一非法 → 显式失败，绝不静默产出平地边界）。
  if (!Number.isFinite(exaggeration)) {
    throw new ProvinceBorderPrepError(
      'province-borders.exaggeration-not-finite',
      `夸张系数必须为有限数值，实际为 ${exaggeration}。`,
    )
  }
  if (
    !Number.isFinite(config.densifySpacingMeters) ||
    config.densifySpacingMeters <= 0
  ) {
    throw new ProvinceBorderPrepError(
      'province-borders.spacing-invalid',
      `densify 间距必须为正的有限数值，实际为 ${config.densifySpacingMeters}。`,
    )
  }
  if (!Number.isFinite(config.terrainEpsilonMeters)) {
    throw new ProvinceBorderPrepError(
      'province-borders.epsilon-not-finite',
      `贴地 epsilon 必须为有限数值，实际为 ${config.terrainEpsilonMeters}。`,
    )
  }
  if (features.length === 0) {
    throw new ProvinceBorderPrepError(
      'province-borders.empty-features',
      '省界准备需要至少一个行政区几何，实际 features 为空。',
    )
  }

  const borders: PreparedProvinceBorder[] = []
  let totalSegmentCount = 0
  for (const feature of features) {
    const endpoints: number[] = []
    appendFeatureSegments(
      feature,
      config.densifySpacingMeters,
      provider,
      exaggeration,
      config.terrainEpsilonMeters,
      endpoints,
    )
    const segmentCount = endpoints.length / 6
    borders.push({
      adminId: feature.adminId,
      segmentEndpointsFlat: endpoints,
      segmentCount,
    })
    totalSegmentCount += segmentCount
  }

  // 全体退化（所有省所有环都产出零线段）→ 显式失败：合法省界（契约保证每环 ≥ 3 顶点）必有非零边，
  // 零线段意味着输入整体退化或异常，不产出空 / 平地边界。
  if (totalSegmentCount === 0) {
    throw new ProvinceBorderPrepError(
      'province-borders.no-segments-produced',
      '全体行政区几何均未产出线段（所有环退化），无法生成贴地边界。',
    )
  }

  return { borders, totalSegmentCount }
}
