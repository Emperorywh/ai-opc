/**
 * 统一米制投影与世界坐标转换（TASK-007）。
 *
 * 角色与依赖方向：
 * - 本模块属于运行时访问层（src/lib），是全仓「经纬度 ↔ EPSG:3857 ↔ 主图世界坐标」的
 *   唯一投影权威。渲染层（地形 mesh、省界描边、标签光点、南海附图 overlay、hover 反查）
 *   只能通过本模块完成坐标变换，禁止各自重写墨卡托公式或按图层微调坐标（SPEC §3.3、§13）。
 * - 单向依赖：本模块只依赖契约层 src/geo-contracts（复用主图范围常量与经纬度类型）和
 *   已确认依赖 d3-geo（geoMercator，SPEC §3.3、§10），不依赖 React、R3F、Three.js 场景
 *   对象或任何 UI 状态。渲染/交互层单向依赖本模块，反向依赖即违规。
 *
 * 坐标系与单位（全仓唯一契约，SPEC §3.2、§3.3）：
 * - 源坐标基准：EPSG:4326（WGS84 经纬度，单位度）。所有 GeoJSON 边界、地点、政治边界
 *   补充数据的原始坐标都以该基准存储（见 src/geo-contracts）。
 * - 平面投影：EPSG:3857（Web 墨卡托，单位米）。球体半长轴 R = 6378137 米（EPSG:3857
 *   定义常数），与 d3-geo geoMercator、离线 DEM 重投影（scripts/dem/mercator.ts）一致。
 * - d3-geo 的 geoMercator 按屏幕坐标惯例输出（y 向下为正），即 d3_y = −真实北距；
 *   本模块在领域能力边界统一取负，对外只暴露「北距向北递增」的工程语义 EPSG:3857 (Mx, My)，
 *   使消费者无需感知 d3 的 y 翻转。
 *
 * 主图世界坐标约定（SPEC §3.3「地图中心置于世界原点附近」）：
 * - 地图中心 = 地理中心 (经度 104°E、纬度 28.5°N)，即主图四至经纬度的中点；投影到墨卡托
 *   (Mxc, Myc)，对应世界原点 (0, 0, 0)。
 * - 世界 x（米）= Mx − Mxc，+X 指向正东。
 * - 世界 z（米）= Myc − My，+Z 指向正南（故 −Z 指向正北）。该轴向使 SPEC §4.1 的
 *   「相机置于地图东南上方看向中心」自然成立：相机位于 (+X, +Y, +Z) 即东—南—上方，俯瞰西北，
 *   青藏高原（西、高）落在画面左上，东部平原（东、低）落在右下，凸显西高东低。
 * - 世界 y（米）专用于真实高程；垂直夸张系数 k（SPEC §3.2，y = h·k）由地形顶点着色器应用，
 *   本模块只输出平面 (x, z)，不产出也不消费 y。禁止用 x/z 承载高程语义，也禁止把夸张后的
 *   world-y 当作真实海拔用于分层设色（SPEC §3.1）。
 *
 * 反向查询不变量（hover 反查）：
 * - invertMercator / invertWorld 分别是 projectToMercator / projectToWorld 在「有限且合法」
 *   输入上的数值逆运算。任一前向合法点经对应反变换后，经纬度误差落在浮点量化容差内
 *   （自动化测试以 1e-9 度级声明）。hover 命中地形后用 invertWorld 把世界坐标还原成经纬度，
 *   再由上游拾取逻辑判定所属省份——反查只忠实还原坐标，不做范围/省份裁剪。
 *
 * 已接受的墨卡托特性（不修形，SPEC §3.3、§13）：
 * - 高纬放大：54°N 处墨卡托放大因子 ≈1.66，北方（黑龙江 / 内蒙古北部）视觉偏胖。这是
 *   SPEC 明确接受的特性，本模块不引入任何按纬度的形状修形、不切换阿尔伯斯投影、不做近似补偿。
 * - 有效纬度上限 ≈85.0511°N/S（y 趋向无穷）；|lat| 超过该值的输入视为不可投影，显式失败。
 *   主图范围 [3°N, 54°N] 远离奇异点，正常运行路径永不触及该限制。
 */

import { geoMercator } from 'd3-geo'
import { CHINA_MAIN_MAP_EXTENT } from '../geo-contracts'
import type { LonLatCoordinate } from '../geo-contracts'

/** EPSG:3857 球面墨卡托定义半长轴（米）；d3-geo geoMercator 的 scale 即取该值。 */
export const WEB_MERCATOR_RADIUS = 6378137

/** Web 墨卡托有效纬度上限（度）；|lat| 超过该值视为不可投影，显式失败而非钳制。 */
export const WEB_MERCATOR_MAX_LATITUDE_DEGREES = 85.05112878

/**
 * 主图地理范围（SPEC §3.3；与契约层 CHINA_MAIN_MAP_EXTENT 同一来源，运行时消费者共用）。
 * 经度 72°E–136°E、纬度 3°N–54°N（含端点），南端覆盖到曾母暗沙 ≈3.58°N。
 */
export const MAIN_MAP_EXTENT = CHINA_MAIN_MAP_EXTENT

/**
 * 主图地理中心（经度 104°E、纬度 28.5°N），取自主图四至经纬度的中点。
 * 投影后对应世界原点；文档性常量，便于消费者与文档对照。
 */
export const MAIN_MAP_CENTER: LonLatCoordinate = {
  lon: (MAIN_MAP_EXTENT.west + MAIN_MAP_EXTENT.east) / 2,
  lat: (MAIN_MAP_EXTENT.south + MAIN_MAP_EXTENT.north) / 2,
}

/**
 * d3-geo geoMercator 实例（确定性单例，兼作投影缓存）。
 * 配置 scale = WEB_MERCATOR_RADIUS、translate = [0,0]（rotate / center 取默认 [0,0,0] / [0,0]），
 * 使 forward([lon, lat]) 直接产出以「米」为单位的 EPSG:3857 平面坐标。
 *
 * 注意：d3 的 y 轴按屏幕惯例向下为正，故 d3 输出 y = −真实北距；本模块不对外暴露该实例，
 * 在下方前向 / 反向原语内统一取负，对外只给「北距向北递增」的语义。
 */
const MERCATOR = geoMercator().scale(WEB_MERCATOR_RADIUS).translate([0, 0])

/**
 * d3 墨卡托前向（私有）：[lon, lat]（度）→ EPSG:3857 (Mx, My)（米，北距向北递增）。
 * 在 d3 输出上对 y 取负，消除屏幕坐标的 y 翻转。返回 null 表示 d3 判定不可投影。
 */
function forwardMercatorRaw(lon: number, lat: number): { x: number; y: number } | null {
  const out = MERCATOR([lon, lat])
  if (out === null) return null
  return { x: out[0], y: -out[1] }
}

/**
 * d3 墨卡托反向（私有）：EPSG:3857 (Mx, My)（米）→ [lon, lat]（度）。
 * 输入时对 y 取负还原成 d3 的屏幕坐标再调用 d3.invert。返回 null 表示不可逆。
 *
 * d3-geo 的 GeoProjection.invert 在类型上是可选的（个别投影不可逆）；geoMercator 实际可逆，
 * 但为满足类型与防御性，先取出 invert 并判空——若不可逆则返回 null，交由上层报 output-not-finite。
 */
function invertMercatorRaw(x: number, y: number): { lon: number; lat: number } | null {
  const invert = MERCATOR.invert
  if (invert === undefined) return null
  const out = invert([x, -y])
  if (out === null) return null
  return { lon: out[0], lat: out[1] }
}

/** 投影失败码（稳定标识，供自动化测试精确断言）。 */
export type ProjectionFailureCode =
  | 'projection.input-not-finite'
  | 'projection.longitude-out-of-domain'
  | 'projection.latitude-out-of-mercator-domain'
  | 'projection.longitude-out-of-extent'
  | 'projection.latitude-out-of-extent'
  | 'projection.extent-malformed'
  | 'projection.output-not-finite'

/** 投影失败结果：携带稳定 code 与简体中文说明，供调用方确定性处理而非静默吞掉。 */
export interface ProjectionFailure {
  readonly ok: false
  readonly code: ProjectionFailureCode
  readonly message: string
}

/** 投影成功结果。 */
export interface ProjectionSuccess<T> {
  readonly ok: true
  readonly value: T
}

/** 投影能力的统一结果类型：成功带 value，失败带 code / message；二者判别联合。 */
export type ProjectionResult<T> = ProjectionSuccess<T> | ProjectionFailure

function ok<T>(value: T): ProjectionSuccess<T> {
  return { ok: true, value }
}

function fail(code: ProjectionFailureCode, message: string): ProjectionFailure {
  return { ok: false, code, message }
}

/** EPSG:3857 平面坐标（米）：x 东距、y 北距（向北递增）。 */
export interface MercatorPoint {
  readonly x: number
  readonly y: number
}

/** 主图世界平面坐标（米）：x 东距、z 南距（+Z = 南，−Z = 北），均以地图中心为原点。 */
export interface WorldPlanarPoint {
  readonly x: number
  readonly z: number
}

/** 南海附图等 2D 子范围的地理四至（EPSG:4326 度）。 */
export interface InsetExtent {
  readonly west: number
  readonly south: number
  readonly east: number
  readonly north: number
}

/** 附图归一化视口坐标：u 随经度向东递增（左→右），v 随纬度向北递增（下→上）。 */
export interface InsetViewportPoint {
  readonly u: number
  readonly v: number
}

/**
 * 校验单个经纬度是否有限且落在墨卡托可投影域。
 * |lon| > 180 视为非法经度；|lat| > 85.05112878° 视为墨卡托不可投影（y 趋向无穷）。
 * 任一不满足返回对应失败码，否则返回 null。本函数只管「可投影性」，不校验主图/附图范围。
 */
function collectInputFailures(lon: number, lat: number): ProjectionFailure | null {
  if (!Number.isFinite(lon) || !Number.isFinite(lat)) {
    return fail('projection.input-not-finite', `经纬度必须为有限数值，实际 lon=${lon} / lat=${lat}。`)
  }
  if (lon < -180 || lon > 180) {
    return fail('projection.longitude-out-of-domain', `经度必须落在 [-180, 180]，实际为 ${lon}。`)
  }
  if (lat < -WEB_MERCATOR_MAX_LATITUDE_DEGREES || lat > WEB_MERCATOR_MAX_LATITUDE_DEGREES) {
    return fail(
      'projection.latitude-out-of-mercator-domain',
      `纬度 |lat| 不得超过墨卡托有效上限 ${WEB_MERCATOR_MAX_LATITUDE_DEGREES}°，实际为 ${lat}。`,
    )
  }
  return null
}

/** 校验附图四至是否自洽（有限、west < east、south < north、落在经纬度合法区间）。 */
function collectInsetExtentFailures(extent: InsetExtent): ProjectionFailure | null {
  const { west, south, east, north } = extent
  if (![west, south, east, north].every(Number.isFinite)) {
    return fail('projection.extent-malformed', '附图四至必须全部为有限数值。')
  }
  if (!(west < east) || !(south < north)) {
    return fail('projection.extent-malformed', `附图四至需满足 west<east 且 south<north，实际 ${west}/${south}/${east}/${north}。`)
  }
  if (west < -180 || east > 180 || south < -WEB_MERCATOR_MAX_LATITUDE_DEGREES || north > WEB_MERCATOR_MAX_LATITUDE_DEGREES) {
    return fail('projection.extent-malformed', `附图四至超出墨卡托可表达区间。`)
  }
  return null
}

/**
 * 前向投影（通用）：EPSG:4326 经纬度（度）→ EPSG:3857 平面米坐标。
 *
 * 这是全仓唯一的墨卡托前向入口：主图世界坐标（projectToWorld）与南海附图映射（projectToInset）
 * 都在内部复用本函数，确保不同渲染层不会因各自重写投影而产生位置漂移。本函数只校验
 * 「可投影性」（有限、经度合法、纬度在墨卡托域内），不强制主图范围——主图范围校验由
 * projectToWorld 承担，附图范围校验由 projectToInset 承担。
 *
 * 失败语义：输入非有限、经度越界或纬度超出墨卡托有效上限时显式返回失败，绝不静默映射到
 * 原点或钳制；输出非有限（理论不应发生）同样作为防御性 backstop 失败。
 */
export function projectToMercator(lon: number, lat: number): ProjectionResult<MercatorPoint> {
  const inputFailure = collectInputFailures(lon, lat)
  if (inputFailure !== null) return inputFailure
  const raw = forwardMercatorRaw(lon, lat)
  if (raw === null) {
    return fail('projection.output-not-finite', `d3-geo 拒绝投影该坐标 lon=${lon} / lat=${lat}。`)
  }
  if (!Number.isFinite(raw.x) || !Number.isFinite(raw.y)) {
    return fail('projection.output-not-finite', `投影结果非有限：x=${raw.x} / y=${raw.y}。`)
  }
  return ok({ x: raw.x, y: raw.y })
}

/**
 * 主图中心的 EPSG:3857 坐标（米），作为世界坐标原点的墨卡托锚点。
 * 模块加载时一次性投影并缓存；所有 projectToWorld / invertWorld / 世界包围盒都复用同一锚点，
 * 保证中心化在消费者之间完全一致（不存在第二份中心常量）。
 */
const MAIN_MAP_CENTER_MERCATOR: MercatorPoint = (() => {
  const result = projectToMercator(MAIN_MAP_CENTER.lon, MAIN_MAP_CENTER.lat)
  // 中心点在主图范围内、远离墨卡托奇异点，projectToMercator 必然成功；
  // 若失败说明 MAIN_MAP_CENTER 常量与投影实现漂移，立即抛错暴露而非吞掉。
  if (!result.ok) {
    throw new Error(`主图中心投影失败：${result.code} — ${result.message}`)
  }
  return result.value
})()

/**
 * 前向投影（主图）：EPSG:4326 经纬度 → 主图中心化世界 (x, z)（米）。
 *
 * 在 projectToMercator 的可投影性校验之上，额外强制坐标落在主图契约范围
 * [72°E, 136°E] × [3°N, 54°N]（含端点）。超出主图范围的坐标视为越界，显式返回失败——
 * 主图渲染层（地形、省界、标签、光点）只处理境内点，越界输入不得静默落到世界原点。
 *
 * 世界坐标推导（唯一公式，无第二套）：x = Mx − Mxc，z = Myc − My。+X = 东，+Z = 南。
 *
 * 校验顺序：先有限性（非有限输入一律 input-not-finite，避免 NaN 因比较恒为 false 而漏过范围
 * 检查、Infinity 因越界比较而误报 out-of-extent 的不一致），再主图范围，最后走 projectToMercator。
 */
export function projectToWorld(lon: number, lat: number): ProjectionResult<WorldPlanarPoint> {
  if (!Number.isFinite(lon) || !Number.isFinite(lat)) {
    return fail('projection.input-not-finite', `经纬度必须为有限数值，实际 lon=${lon} / lat=${lat}。`)
  }
  if (lon < MAIN_MAP_EXTENT.west || lon > MAIN_MAP_EXTENT.east) {
    return fail(
      'projection.longitude-out-of-extent',
      `主图经度必须落在 [${MAIN_MAP_EXTENT.west}, ${MAIN_MAP_EXTENT.east}]，实际为 ${lon}。`,
    )
  }
  if (lat < MAIN_MAP_EXTENT.south || lat > MAIN_MAP_EXTENT.north) {
    return fail(
      'projection.latitude-out-of-extent',
      `主图纬度必须落在 [${MAIN_MAP_EXTENT.south}, ${MAIN_MAP_EXTENT.north}]，实际为 ${lat}。`,
    )
  }
  const mercator = projectToMercator(lon, lat)
  if (!mercator.ok) return mercator
  const { x: mx, y: my } = mercator.value
  return ok({
    x: mx - MAIN_MAP_CENTER_MERCATOR.x,
    z: MAIN_MAP_CENTER_MERCATOR.y - my,
  })
}

/**
 * 反向投影（通用）：EPSG:3857 平面米坐标 → EPSG:4326 经纬度（度）。
 * projectToMercator 的数值逆运算；输入非有限或 d3 不可逆时显式失败，不产出伪坐标。
 */
export function invertMercator(x: number, y: number): ProjectionResult<LonLatCoordinate> {
  if (!Number.isFinite(x) || !Number.isFinite(y)) {
    return fail('projection.input-not-finite', `墨卡托坐标必须为有限数值，实际 x=${x} / y=${y}。`)
  }
  const raw = invertMercatorRaw(x, y)
  if (raw === null || !Number.isFinite(raw.lon) || !Number.isFinite(raw.lat)) {
    return fail('projection.output-not-finite', `无法把墨卡托坐标反算为经纬度：x=${x} / y=${y}。`)
  }
  return ok({ lon: raw.lon, lat: raw.lat })
}

/**
 * 反向投影（主图 · hover 反查）：主图世界 (x, z)（米）→ EPSG:4326 经纬度（度）。
 *
 * 先反中心化还原成 EPSG:3857（Mx = x + Mxc，My = Myc − z），再走统一的 invertMercator。
 * 本函数是 projectToWorld 在「有限且境内」输入上的数值逆运算；hover 命中地形后用本函数把
 * 世界坐标还原成经纬度。本函数不再次校验经纬度是否落在主图范围——反查的职责是「忠实还原坐标」，
 * 是否属于某省由上游拾取逻辑判定；范围越界不应让反查静默失败或钳制。
 */
export function invertWorld(x: number, z: number): ProjectionResult<LonLatCoordinate> {
  if (!Number.isFinite(x) || !Number.isFinite(z)) {
    return fail('projection.input-not-finite', `世界坐标必须为有限数值，实际 x=${x} / z=${z}。`)
  }
  const mx = x + MAIN_MAP_CENTER_MERCATOR.x
  const my = MAIN_MAP_CENTER_MERCATOR.y - z
  return invertMercator(mx, my)
}

/**
 * 主图四至的世界平面包围盒（米，模块加载时一次性投影并缓存）。
 *
 * 由于墨卡托纬度非线性，地理中心 (104°E, 28.5°N) 并非墨卡托 Y 范围的中点，故 z 方向相对
 * 原点不对称（北侧 −Z 量级大于南侧 +Z）——这是墨卡托的固有特性，不修形。x 方向墨卡托是
 * 线性的（Mx = R·lon），且 72°/136° 关于中心 104° 对称，故 minX/maxX 关于原点对称。
 *
 * 地形网格 TASK（TASK-008）用本包围盒确定 PlaneGeometry 的世界尺寸与定位，使 mesh 覆盖
 * 范围与统一投影完全一致；heightmap 的行 0=北、列 0=西（见 scripts/dem/build-heightmap.ts）
 * 由地形 mesh 据本契约对齐 UV（u 随 +X/东增，纹理 v 对应北→南行序）。
 *
 * 字段：minX = 西界 x（负），maxX = 东界 x（正），minZ = 北侧 z（负），maxZ = 南侧 z（正）。
 */
export const MAIN_MAP_WORLD_BOUNDS: Readonly<{
  readonly minX: number
  readonly maxX: number
  readonly minZ: number
  readonly maxZ: number
}> = (() => {
  const west = projectToWorld(MAIN_MAP_EXTENT.west, MAIN_MAP_CENTER.lat)
  const east = projectToWorld(MAIN_MAP_EXTENT.east, MAIN_MAP_CENTER.lat)
  const north = projectToWorld(MAIN_MAP_CENTER.lon, MAIN_MAP_EXTENT.north)
  const south = projectToWorld(MAIN_MAP_CENTER.lon, MAIN_MAP_EXTENT.south)
  // 四至都在主图范围含端点上，projectToWorld 必然成功；失败即常量与实现漂移，立即暴露。
  if (!west.ok || !east.ok || !north.ok || !south.ok) {
    throw new Error('主图四至投影失败：MAIN_MAP_EXTENT 与 projectToWorld 漂移。')
  }
  return {
    minX: west.value.x,
    maxX: east.value.x,
    minZ: north.value.z,
    maxZ: south.value.z,
  }
})()

/**
 * 附图子范围映射：EPSG:4326 经纬度 → 附图归一化视口 (u, v) ∈ [0, 1]²。
 *
 * 附图是独立于 3D 主世界的 2D overlay（SVG/Canvas，SPEC §3.8）。其视口沿用标准地图阅读方向：
 * u 随经度向东递增（左→右），v 随纬度向北递增（下→上）。注意这与 3D 世界 z（+Z = 南）不同，
 * 但二者内部都走同一 projectToMercator——同一南海点位在主图与附图来自同一墨卡托结果，仅视口
 * 映射不同（验证方式 3 即以此断言）。SVG overlay 消费时自行把 v 翻转成屏幕 y。
 *
 * 实现：西南角、东北角与目标点都走 projectToMercator 得到 EPSG:3857 米坐标，再在墨卡托平面
 * 线性归一化（u = (Mx−Mx_sw)/(Mx_ne−Mx_sw)，v = (My−My_sw)/(My_ne−My_sw)）。线性归一化等价于
 * 「附图本身也是一张墨卡托子图」，与主图共享同一投影，无第二套公式。
 *
 * 失败语义：坐标非有限、墨卡托域外、或落在 insetExtent 之外，均显式失败；insetExtent 自身
 * 不自洽（west≥east / south≥north / 非有限 / 超出墨卡托域）作为 projection.extent-malformed 失败。
 */
export function projectToInset(
  lon: number,
  lat: number,
  extent: InsetExtent,
): ProjectionResult<InsetViewportPoint> {
  // 先有限性（与 projectToWorld 一致），再附图四至自洽，最后范围——保证非有限输入始终报
  // input-not-finite，不被畸形四至或范围比较掩盖。
  if (!Number.isFinite(lon) || !Number.isFinite(lat)) {
    return fail('projection.input-not-finite', `经纬度必须为有限数值，实际 lon=${lon} / lat=${lat}。`)
  }
  const extentFailure = collectInsetExtentFailures(extent)
  if (extentFailure !== null) return extentFailure
  if (lon < extent.west || lon > extent.east) {
    return fail(
      'projection.longitude-out-of-extent',
      `附图经度必须落在 [${extent.west}, ${extent.east}]，实际为 ${lon}。`,
    )
  }
  if (lat < extent.south || lat > extent.north) {
    return fail(
      'projection.latitude-out-of-extent',
      `附图纬度必须落在 [${extent.south}, ${extent.north}]，实际为 ${lat}。`,
    )
  }
  const sw = projectToMercator(extent.west, extent.south)
  if (!sw.ok) return sw
  const ne = projectToMercator(extent.east, extent.north)
  if (!ne.ok) return ne
  const target = projectToMercator(lon, lat)
  if (!target.ok) return target
  const dx = ne.value.x - sw.value.x
  const dy = ne.value.y - sw.value.y
  return ok({
    u: (target.value.x - sw.value.x) / dx,
    v: (target.value.y - sw.value.y) / dy,
  })
}
