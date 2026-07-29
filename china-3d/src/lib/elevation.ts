/**
 * 共享运行时高程查询（TASK-006）。
 *
 * 角色与依赖方向：
 * - 本模块属于运行时访问层（src/lib），与 projection.ts 同层。它把 TASK-003 交付的 16 位
 *   heightmap 资产在运行时解码为「唯一一份」CPU 侧只读高程事实源，向省界贴地（TASK-009）、
 *   标签定位与遮挡判断（TASK-010，SPEC §7.5）、海陆判断 / 海面以下判定（TASK-007，SPEC §3.5）
 *   等所有领域消费者提供「真实米制海拔 + 双线性采样」的统一查询能力（SPEC §3.6 的 CPU 端
 *   heightmap、§7.5 的遮挡判定共用同一份数据）。
 * - 单向依赖：本模块只依赖契约层 src/geo-contracts（复用 16 位编解码的唯一源
 *   decodeUint16ToElevation 与元数据校验 validateTerrainMeta）和同层坐标权威 src/lib/projection
 *   （世界坐标 / 经纬度 → UV 的唯一投影入口）。严禁依赖 React、R3F、Three.js 场景对象、标签或
 *   省界渲染——本层只回答「某个位置有多高」，绝不参与绘制，也不为 4096² 网格在 CPU 逐顶点写入
 *   位移或法线（SPEC §7.1 红线）。
 *
 * 16 位解码语义（与 GPU 一致，SPEC §5.1、§7.1）：
 * - heightmap 资产是行主序、行 0=北、列 0=西、每像元 2 字节小端 uint16 的 .r16（见
 *   scripts/dem/build-heightmap.ts 的 writeHeightmapAssets：view.setUint16(i*2, code, true)）。
 *   运行时只解码一次：把小端字节解释为 Uint16Array（小端主机走零拷贝视图；大端或未对齐回退到
 *   DataView 逐像元小端读取），全程绝不经过 8 位浏览器图像解码——8 位会丢失高程精度
 *   （SPEC §5.1、TASK-003 实现约束），故本层只接受 16 位输入。
 * - 解码后的 Uint16Array 是本层持有的唯一高开销表示（4096²×2B ≈ 32MB，SPEC §7.2）。绝不复制成
 *   多份 JS 数组，也绝不在 CPU 端逐顶点写入位移/法线——本层只提供按需查询。
 *
 * 双线性采样（与 GPU 纹理采样等价）：
 * - UV 约定（与 projection.ts 末段「heightmap 行 0=北、列 0=西；u 随 +X/东增，纹理 v 对应北→南
 *   行序」严格一致）：u∈[0,1] 随经度向东递增（u=0 西界列 0、u=1 东界列 width−1）；v∈[0,1] 随
 *   「北→南」行序递增（v=0 北界行 0、v=1 南界行 height−1），即标准纹理原点在西北角。像元中心
 *   (col,row) 位于 u=(col+0.5)/width、v=(row+0.5)/height；故列分数坐标 fx=u·width−0.5、行分数
 *   坐标 fy=v·height−0.5（与 scripts/dem/build-heightmap.ts 的 sampleBilinear、
 *   scripts/verify-assets/terrain-deep.ts 的 lonLatToRasterFraction 严格互逆）。
 * - 先取四角 uint16 编码、各自经 decodeUint16ToElevation 还原成真实米制，再对四个米值做双线性。
 *   由于「decode(c) = c/65535·(max−min) + min」是仿射，双线性(米) = decode(双线性(编码)) ——这与
 *   GPU 在归一化纹理上做硬件双线性、再在着色器里线性解码到米的结果在浮点精度内一致；CPU 与 GPU
 *   共用同一高程事实源且解码语义相同。此处刻意「先解码四角再双线性米值」、不把编码四舍五入成整数
 *   （terrain-deep 的 bilinearSampleCode 会 round，那是资产统计口径），以保证运行时查询与 GPU 片元
 *   采样在亚米级一致。边缘像元（u=0/1、v=0/1）收敛到边界像元值，不外推。
 *
 * 共享生命周期（单份事实源）：
 * - getSharedElevationProvider(meta, bytes) 以「源字节引用」为键缓存 provider：同一份 bytes 多次
 *   传入只解码一次、返回同一 provider 实例；不同 bytes 引用各自独立（重新取数即重新解码，符合
 *   引用语义）。缓存用 WeakMap 键控源字节，调用方释放源字节后 provider 随之可被回收，不遗留
 *   32MB 大数组（SPEC §7.4 长时运行内存稳定）。
 * - provider.release() 显式释放：清空内部 Uint16Array 引用、从缓存摘除自身，此后任何查询返回
 *   'elevation.released' 失败（绝不返回伪造海拔）。createElevationProvider(meta, pixels) 不介入
 *   缓存，供已自行解码（如测试、或 heightmap 纹理加载器已解码出 pixels）的调用方直接包装一份
 *   只读 provider。
 *
 * 异常语义（不以魔法 0 混淆异常与海平面）：
 * - 加载期失败（元数据不通过契约、栅格像元数与分辨率不符、解码字节长度不符、地理范围超出墨卡托
 *   有效域）抛 ElevationProviderError（带稳定 code），调用方可定位根因；加载失败时绝不静默落到
 *   平地 fallback（SPEC 红线）。
 * - 查询期问题（输入非有限、UV 越界、经纬度越出元数据范围、世界坐标反投影失败、provider 已释放）
 *   返回判别联合的失败分支 { ok:false, code, message }，绝不把异常 / 越界伪装成 meters:0 的成功
 *   结果——海平面 0m 是合法读数，错误必须显式区分。
 * - 成功分支携带 meters（真实海拔，米）与按符号划分的 kind（below-sea-level 合法负高程 /
 *   sea-level 海平面 / above-sea-level 正高程），供海陆判断、遮挡阈值等消费者按需取用。
 */

import { decodeUint16ToElevation, validateTerrainMeta } from '../geo-contracts'
import type { TerrainMetaContract } from '../geo-contracts'
import { invertWorld, projectToMercator } from './projection'
import type { MercatorPoint } from './projection'

/**
 * 宿主机是否小端。.r16 按小端落盘；小端主机可用 Uint16Array 直接零拷贝视图解释字节，
 * 大端主机必须逐像元素值翻转。运行时探测一次，避免在每份资产解码路径上重复判断。
 */
const HOST_LITTLE_ENDIAN: boolean = (() => {
  const probe = new Uint8Array(2)
  // 以小端写入 0x0102；若主机 uint16 视图也读出 0x0102，则主机即小端。
  new DataView(probe.buffer).setUint16(0, 0x0102, true)
  return new Uint16Array(probe.buffer)[0] === 0x0102
})()

/** 加载期（构造 / 解码）失败的稳定错误码，供调用方确定性处理与自动化测试精确断言。 */
export type ElevationLoadFailureCode =
  | 'elevation.meta-invalid'
  | 'elevation.raster-size-mismatch'
  | 'elevation.decode-byte-length-mismatch'

/**
 * 加载期错误：携带稳定 code 与简体中文说明。
 * 加载失败一律抛出本错误（而非静默平地 fallback），使调用方在取得 provider 之前就能确定性地
 * 发现坏元数据 / 坏栅格 / 字节长度不符等根因。
 */
export class ElevationProviderError extends Error {
  readonly code: ElevationLoadFailureCode
  constructor(code: ElevationLoadFailureCode, message: string) {
    super(message)
    this.name = 'ElevationProviderError'
    this.code = code
  }
}

/** 查询期失败的稳定错误码（查询不抛异常，返回判别联合的失败分支）。 */
export type ElevationQueryFailureCode =
  | 'elevation.input-not-finite'
  | 'elevation.uv-out-of-range'
  | 'elevation.lonlat-out-of-extent'
  | 'elevation.projection-failed'
  | 'elevation.released'

/** 查询失败结果：携带稳定 code 与简体中文说明，绝不携带伪造海拔。 */
export interface ElevationQueryFailure {
  readonly ok: false
  readonly code: ElevationQueryFailureCode
  readonly message: string
}

/**
 * 按真实米制海拔符号划分的类别，供海陆判断（§3.5）、遮挡阈值（§7.5）等消费者按需取用。
 * - below-sea-level：合法负高程（浅水大陆架等，SPEC §3.5 / §5.1 保留的负值）。
 * - sea-level：恰好 0m 海平面（编码量化步长约 0.16m，精确 0 罕见；消费者做阈值比较时应直接用 meters）。
 * - above-sea-level：正高程（陆地）。
 */
export type ElevationKind = 'below-sea-level' | 'sea-level' | 'above-sea-level'

/** 查询成功结果：真实米制海拔 + 按符号划分的类别。 */
export interface ElevationQuerySuccess {
  readonly ok: true
  readonly meters: number
  readonly kind: ElevationKind
}

/** 高程查询的统一结果类型：成功带 meters/kind，失败带 code/message；二者判别联合，互不混淆。 */
export type ElevationQueryResult = ElevationQuerySuccess | ElevationQueryFailure

/**
 * 共享 CPU 高程查询能力。所有领域消费者持有一份 provider 实例即可获得与 GPU 同语义的真实米制
 * 双线性采样；内部只保留一份 16 位 Uint16Array，release 后清空引用。
 */
export interface ElevationProvider {
  /** 已通过契约校验的元数据（含编码区间、分辨率、地理范围）。 */
  readonly meta: TerrainMetaContract
  readonly width: number
  readonly height: number
  /** 是否已显式释放；释放后任何查询返回 'elevation.released'。 */
  readonly released: boolean
  /**
   * 按纹理 UV 查询真实米制海拔。u/v 须落在 [0,1]（含端点），否则返回 uv-out-of-range 失败。
   * 这是与 GPU 顶点 / 片元采样直接对齐的入口；省界贴地等已知 UV 的消费者应优先使用本接口。
   */
  queryAtUV(u: number, v: number): ElevationQueryResult
  /**
   * 按经纬度查询真实米制海拔。经纬度须落在元数据 geographicExtent（含端点）内，否则返回
   * lonlat-out-of-extent 失败。内部把经纬度经同一墨卡托映射到 UV 后复用 queryAtUV，保证与
   * UV 路径、与离线生产布局（mercator 均匀网格）完全一致。
   */
  queryAtLonLat(lon: number, lat: number): ElevationQueryResult
  /**
   * 按主图世界平面坐标 (x, z) 查询真实米制海拔（hover 反查、遮挡射线落点等用）。
   * 先经 projection.invertWorld 反算经纬度，再走 queryAtLonLat；反投影失败或落点越出元数据范围
   * 时返回 projection-failed / lonlat-out-of-extent，不产出伪造海拔。
   */
  queryAtWorld(x: number, z: number): ElevationQueryResult
  /**
   * 显式释放：清空内部 16 位 Uint16Array 引用，并从共享缓存摘除自身（若由 getShared 创建）。
   * 释放是幂等的；此后任何查询返回 'elevation.released'。
   */
  release(): void
}

/**
 * 把真实米制海拔按符号分类。负高程（含浅水大陆架）归 below-sea-level；精确 0 归 sea-level；
 * 正高程归 above-sea-level。本函数只做符号判定，不做任何阈值或魔法值，保证「异常 ≠ 海平面」。
 */
function classifyElevation(meters: number): ElevationKind {
  if (meters < 0) return 'below-sea-level'
  if (meters > 0) return 'above-sea-level'
  return 'sea-level'
}

/** 构造查询成功结果。 */
function elevationOk(meters: number): ElevationQuerySuccess {
  return { ok: true, meters, kind: classifyElevation(meters) }
}

/** 构造查询失败结果。 */
function elevationFail(code: ElevationQueryFailureCode, message: string): ElevationQueryFailure {
  return { ok: false, code, message }
}

/**
 * 在 16 位像素缓冲上做双线性采样，返回真实米制海拔（米）。
 *
 * 行 0=北、列 0=西；fx/fy 为列 / 行的分数坐标（像元中心位于 col+0.5 / row+0.5）。边缘处把整数
 * 索引夹到 [0, dim−1]、把小数权重夹到 [0,1]，使边缘像元收敛到边界值而不外推——这与
 * scripts/dem/build-heightmap.ts 的 sampleBilinear、scripts/verify-assets/terrain-deep.ts 的
 * bilinearSampleCode 同构，但本函数「先解码四角到米再双线性米值」且不把编码 round 成整数，
 * 以匹配 GPU 在归一化纹理上的硬件双线性 + 着色器线性解码（仿射等价，见文件头说明）。
 */
function bilinearMeters(
  pixels: Uint16Array,
  width: number,
  height: number,
  minValueMeters: number,
  maxValueMeters: number,
  fx: number,
  fy: number,
): number {
  const maxCol = width - 1
  const maxRow = height - 1
  // 整数索引夹到合法像元范围，保证任意 fx/fy（含边缘 -0.5 / dim-0.5）都能取到值。
  const x0 = Math.min(Math.max(Math.floor(fx), 0), maxCol)
  const x1 = Math.min(x0 + 1, maxCol)
  const y0 = Math.min(Math.max(Math.floor(fy), 0), maxRow)
  const y1 = Math.min(y0 + 1, maxRow)
  // 小数权重夹到 [0,1]：边缘外的分数部分被吸收，采样收敛到边界像元。
  const tx = Math.min(Math.max(fx - x0, 0), 1)
  const ty = Math.min(Math.max(fy - y0, 0), 1)

  // 四角各自经契约层唯一解码源还原成真实米制（min/max 来自已校验元数据，保证 min < max）。
  const m00 = decodeUint16ToElevation(pixels[y0 * width + x0], minValueMeters, maxValueMeters)
  const m10 = decodeUint16ToElevation(pixels[y0 * width + x1], minValueMeters, maxValueMeters)
  const m01 = decodeUint16ToElevation(pixels[y1 * width + x0], minValueMeters, maxValueMeters)
  const m11 = decodeUint16ToElevation(pixels[y1 * width + x1], minValueMeters, maxValueMeters)

  // 先在行方向插值，再在列方向插值——标准双线性。
  const top = m00 + (m10 - m00) * tx
  const bottom = m01 + (m11 - m01) * tx
  return top + (bottom - top) * ty
}

/**
 * 解码 .r16 小端字节为 Uint16Array（16 位高程数据的「唯一解码入口」）。
 *
 * 字节布局与 writeHeightmapAssets 严格互逆：行主序、行 0=北、列 0=西、每像元 2 字节小端 uint16。
 * 字节长度必须等于 expectedPixelCount*2，否则抛 decode-byte-length-mismatch（加载期确定性失败）。
 *
 * 内存策略（保持约 32MB 单份表示）：
 * - 小端主机 + 偶数字节偏移：直接构造 Uint16Array 视图，零拷贝共享源字节底层缓冲——此时本层
 *   持有的「解码表示」即源字节缓冲本身，不产生第二份 32MB 副本。调用方在此之后不应再修改源字节。
 * - 大端主机或奇数字节偏移（Uint16Array 视图要求偶数对齐）：经 DataView 逐像元按小端读出到新
 *   Uint16Array；源字节可由调用方释放，最终仍只剩一份 32MB 表示。
 *
 * 全程不经过 8 位浏览器图像解码：本函数接受的是已经按 16 位落盘的原始字节，杜绝 8 位降级冒充。
 */
export function decodeHeightmapBytes(bytes: Uint8Array, expectedPixelCount: number): Uint16Array {
  if (!Number.isInteger(expectedPixelCount) || expectedPixelCount <= 0) {
    throw new ElevationProviderError(
      'elevation.decode-byte-length-mismatch',
      `expectedPixelCount 必须为正整数，实际为 ${expectedPixelCount}。`,
    )
  }
  if (bytes.byteLength !== expectedPixelCount * 2) {
    throw new ElevationProviderError(
      'elevation.decode-byte-length-mismatch',
      `字节长度 ${bytes.byteLength} 与期望像元数 ${expectedPixelCount}（需 ${expectedPixelCount * 2} 字节，16 位小端）不符。`,
    )
  }
  // 小端主机且字节偏移偶数对齐：零拷贝视图。byteOffset 必须为 2 的倍数，否则 Uint16Array 构造抛错。
  if (HOST_LITTLE_ENDIAN && bytes.byteOffset % 2 === 0) {
    return new Uint16Array(bytes.buffer, bytes.byteOffset, expectedPixelCount)
  }
  // 大端 / 未对齐回退：DataView 按小端逐像元读出到独立 Uint16Array（仍是单份 32MB 表示）。
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const out = new Uint16Array(expectedPixelCount)
  for (let i = 0; i < expectedPixelCount; i++) {
    out[i] = view.getUint16(i * 2, true)
  }
  return out
}

/**
 * 校验元数据并提取分辨率；失败抛 elevation.meta-invalid（加载期确定性失败，绝不静默放过）。
 * 各公共入口（createElevationProvider / getSharedElevationProvider）在解码 / 包装前先过此关，
 * 保证进入查询路径的 meta 一定满足 terrain-meta 契约（位深 16、CRS、编码区间自洽等）。
 */
function validateMetaOrThrow(metaInput: unknown): TerrainMetaContract {
  const outcome = validateTerrainMeta(metaInput)
  if (!outcome.ok) {
    throw new ElevationProviderError(
      'elevation.meta-invalid',
      `元数据未通过 terrain-meta 契约校验：${outcome.errors.map((e) => `${e.code}@${e.path}`).join('; ')}。`,
    )
  }
  return metaInput as TerrainMetaContract
}

/**
 * 内部构造器：假定 meta 已校验、pixels.length 已与分辨率一致。组装闭包状态的只读 provider。
 * onRelease 由 getSharedElevationProvider 注入，用于在 release 时把自身从共享缓存摘除；
 * createElevationProvider 路径不传，release 仅清空内部数组引用。
 */
function instantiateProvider(
  meta: TerrainMetaContract,
  pixels: Uint16Array,
  onRelease: (() => void) | null,
): ElevationProvider {
  const width = meta.resolution.widthPixels
  const height = meta.resolution.heightPixels
  const { minValueMeters, maxValueMeters } = meta.elevationEncoding
  const ext = meta.geographicExtent

  // 预计算元数据地理范围四角在统一墨卡托下的平面坐标（queryAtLonLat 把任意经纬度映射到 UV 用）。
  // 范围已通过契约校验（west/east∈[-180,180]、south/north∈[-90,90]）；若纬度超出墨卡托有效上限，
  // projectToMercator 在此失败 → 视为元数据不可用于高程查询，加载期抛 meta-invalid。
  const swResult = projectToMercator(ext.west, ext.south)
  const neResult = projectToMercator(ext.east, ext.north)
  if (!swResult.ok || !neResult.ok) {
    throw new ElevationProviderError(
      'elevation.meta-invalid',
      `地理范围 [${ext.west}, ${ext.south}, ${ext.east}, ${ext.north}] 无法投影到 Web 墨卡托（纬度超出有效上限 ≈85.05°）。`,
    )
  }
  const sw: MercatorPoint = swResult.value
  const ne: MercatorPoint = neResult.value
  const mercatorWidth = ne.x - sw.x
  const mercatorHeight = ne.y - sw.y

  // 闭包状态：pixelsRef 在 release 时置 null 以释放大数组；released 标记生命周期。
  let pixelsRef: Uint16Array | null = pixels
  let released = false

  const queryAtUV = (u: number, v: number): ElevationQueryResult => {
    if (released) {
      return elevationFail('elevation.released', '高程 provider 已释放，查询不可用。')
    }
    // 先有限性：非有限输入一律 input-not-finite，避免 NaN 因比较恒为 false 而漏过范围检查。
    if (!Number.isFinite(u) || !Number.isFinite(v)) {
      return elevationFail(
        'elevation.input-not-finite',
        `UV 必须为有限数值，实际 u=${u} / v=${v}。`,
      )
    }
    if (u < 0 || u > 1 || v < 0 || v > 1) {
      return elevationFail(
        'elevation.uv-out-of-range',
        `UV 必须落在 [0,1]，实际 u=${u} / v=${v}。`,
      )
    }
    const px = pixelsRef
    if (px === null) {
      // 防御：理论上 released 已拦截；保留以避免对已清空数组采样。
      return elevationFail('elevation.released', '高程 provider 已释放，查询不可用。')
    }
    const fx = u * width - 0.5
    const fy = v * height - 0.5
    const meters = bilinearMeters(px, width, height, minValueMeters, maxValueMeters, fx, fy)
    return elevationOk(meters)
  }

  const queryAtLonLat = (lon: number, lat: number): ElevationQueryResult => {
    if (released) {
      return elevationFail('elevation.released', '高程 provider 已释放，查询不可用。')
    }
    if (!Number.isFinite(lon) || !Number.isFinite(lat)) {
      return elevationFail(
        'elevation.input-not-finite',
        `经纬度必须为有限数值，实际 lon=${lon} / lat=${lat}。`,
      )
    }
    // 范围检查（含端点）：越出元数据 geographicExtent 的点视为越界，不静默夹到边界采样。
    if (lon < ext.west || lon > ext.east || lat < ext.south || lat > ext.north) {
      return elevationFail(
        'elevation.lonlat-out-of-extent',
        `经纬度 [${lon}, ${lat}] 越出元数据范围 [${ext.west}, ${ext.south}, ${ext.east}, ${ext.north}]。`,
      )
    }
    // 经同一墨卡托把经纬度映射到 UV：u 随东距增、v 随北距减（行 0=北）。
    // 墨卡托 x 对经度线性、y 对纬度单调，故落在范围端点上的输入恰好映射到 u/v=0 或 1（无浮点漂移）。
    const target = projectToMercator(lon, lat)
    if (!target.ok) {
      return elevationFail(
        'elevation.projection-failed',
        `经纬度 [${lon}, ${lat}] 投影失败：${target.code}。`,
      )
    }
    const u = (target.value.x - sw.x) / mercatorWidth
    const v = (ne.y - target.value.y) / mercatorHeight
    // u/v 已由范围检查保证落在 [0,1]；复用 queryAtUV 完成双线性采样（其内部 released/有限性检查幂等）。
    return queryAtUV(u, v)
  }

  const queryAtWorld = (x: number, z: number): ElevationQueryResult => {
    if (released) {
      return elevationFail('elevation.released', '高程 provider 已释放，查询不可用。')
    }
    if (!Number.isFinite(x) || !Number.isFinite(z)) {
      return elevationFail(
        'elevation.input-not-finite',
        `世界坐标必须为有限数值，实际 x=${x} / z=${z}。`,
      )
    }
    // 世界 → 经纬度走统一反投影（projection.invertWorld）；失败则透传为 projection-failed。
    const inverted = invertWorld(x, z)
    if (!inverted.ok) {
      return elevationFail(
        'elevation.projection-failed',
        `世界坐标 [${x}, ${z}] 反投影失败：${inverted.code}。`,
      )
    }
    // 反算得到的经纬度可能落在元数据范围之外（世界点本身越界），由 queryAtLonLat 的范围检查兜底。
    return queryAtLonLat(inverted.value.lon, inverted.value.lat)
  }

  const release = (): void => {
    if (released) return
    released = true
    // 清空 32MB 大数组引用，使 GC 可回收；后续查询由 released 标记拦截。
    pixelsRef = null
    if (onRelease !== null) onRelease()
  }

  return {
    get meta() {
      return meta
    },
    get width() {
      return width
    },
    get height() {
      return height
    },
    get released() {
      return released
    },
    queryAtUV,
    queryAtLonLat,
    queryAtWorld,
    release,
  }
}

/**
 * 包装一份「已自行解码」的 Uint16Array 为只读高程 provider（不介入共享缓存）。
 *
 * 适用：测试夹具、或自带解码管线的调用方（如 src/three/load-heightmap-texture 在构造 GPU 纹理时
 * 已解码出 pixels，可直接包装，使 CPU 消费者与 GPU 纹理共用同一份高程事实源，零额外取数 / 解码 /
 * 内存）。meta 先经契约校验；pixels.length 必须 = width*height，否则抛 raster-size-mismatch
 * （加载期确定性失败）。不会复制 pixels：provider 直接持有调用方传入的数组引用，调用方在此之后
 * 不应再修改它。
 */
export function createElevationProvider(metaInput: unknown, pixels: Uint16Array): ElevationProvider {
  const meta = validateMetaOrThrow(metaInput)
  const expected = meta.resolution.widthPixels * meta.resolution.heightPixels
  if (pixels.length !== expected) {
    throw new ElevationProviderError(
      'elevation.raster-size-mismatch',
      `栅格像元数 ${pixels.length} 与元数据分辨率 ${meta.resolution.widthPixels}x${meta.resolution.heightPixels}=${expected} 不一致。`,
    )
  }
  return instantiateProvider(meta, pixels, null)
}

/**
 * 共享缓存：以「源字节 Uint8Array 引用」为弱键。同一份 bytes 多次传入只解码一次、返回同一
 * provider；调用方释放 bytes 引用后，WeakMap 条目随之可被 GC，provider 及其 32MB 数组一同回收，
 * 不遗留大数组（SPEC §7.4）。不同 bytes 引用各自独立缓存（重新取数即重新解码，符合引用语义）。
 */
const sharedProviderCache = new WeakMap<Uint8Array, ElevationProvider>()

/**
 * 取得（必要时解码并缓存）共享高程 provider。
 *
 * - 同一 bytes 引用重复调用：命中缓存，底层 16 位数据只解码一次，返回 === 同一 provider 实例。
 * - 不同 bytes 引用：各自独立解码（即便内容相同），因为「引用不同」即视为不同来源。
 * - meta 非法、字节长度与分辨率不符：加载期抛 ElevationProviderError（meta-invalid /
 *   decode-byte-length-mismatch），不静默平地 fallback。
 * - 返回的 provider.release() 会清空内部数组并从本缓存摘除自身；之后再以同一 bytes 调用会重新解码。
 */
export function getSharedElevationProvider(
  metaInput: unknown,
  bytes: Uint8Array,
): ElevationProvider {
  const cached = sharedProviderCache.get(bytes)
  if (cached !== undefined) return cached

  // 先校验元数据以取得分辨率，再用它约束解码字节长度；任一失败在「写入缓存之前」抛出，
  // 保证缓存里只会出现完整可用 provider，不会留下半成品。
  const meta = validateMetaOrThrow(metaInput)
  const expectedPixelCount = meta.resolution.widthPixels * meta.resolution.heightPixels
  const pixels = decodeHeightmapBytes(bytes, expectedPixelCount)
  const provider = instantiateProvider(meta, pixels, () => {
    sharedProviderCache.delete(bytes)
  })
  sharedProviderCache.set(bytes, provider)
  return provider
}
