/**
 * Task 20 · 前端国家边界二进制解码器（M6，与 pipeline 单一格式契约）。
 *
 * 与 `scripts/data-pipeline/lib/boundary-pack.mjs` 的 `decodeBoundaries` **等价**的 TS 实现：
 *   pipeline（pack）  →  public/data/boundaries.bin  →  前端（本文件 decode）
 *
 * 为何「TS 复刻」而非 import pipeline：pipeline 是 Node .mjs（imports earcut 等打包进 vite bundle
 * 不洁；且 pipeline 含打包逻辑前端不需要），故前端独立维护**解码侧**（只读 DataView，无 earcut）。
 * 布局常量与 pipeline **逐字节对齐**——任何布局变更须同步两处（+ round-trip 单测守契约）。
 *
 * 投影对齐（R2）：二进制存**地理 lon,lat**（顶点交错 [lon0,lat0,...]）；渲染层用 `project()` 投影
 *   （与地形顶点 / 标签锚点同源）。三角化在 lon,lat 2D 空间烘焙，equirect 线性投影保持有效。
 *
 * ─── boundaries.bin 布局（Little-Endian，与 pipeline LAYOUT 逐字节一致）──────────────
 *   HEADER (28B):
 *     0   magic            4B   "BDRT"
 *     4   version          u32  =1
 *     8   vertexCount      u32  全局顶点数
 *     12  countryCount     u32
 *     16  fillIndexCount   u32  填充三角形索引总数（= 三角形 ×3）
 *     20  borderIndexCount u32  描边线段索引总数（= 线段 ×2）
 *     24  continentCount   u32  大洲名表条目数
 *   CONTINENT_NAMES: continentCount × 16B（UTF-8，零填充，≤15 字符）
 *   VERTICES:      vertexCount × 2 × f32   (lon, lat 交错)
 *   FILL_INDICES:  fillIndexCount × u32    (三角形顶点全局索引)
 *   BORDER_INDICES:borderIndexCount × u32  (线段顶点全局索引，成对)
 *   COUNTRIES:     countryCount × 36B:
 *     0  id               u32   拾取稳定 id（= 记录序号）
 *     4  isoA3            4B    ASCII（3 大写字母，零填充）
 *     8  continentIndex   u8    → CONTINENT_NAMES
 *     9  (pad)            3B    零
 *     12 vertexOffset     u32
 *     16 vertexCount      u32
 *     20 fillIndexOffset  u32
 *     24 fillIndexCount   u32
 *     28 borderIndexOffset u32
 *     32 borderIndexCount u32
 *
 * 争议边界 disputed.bin 的解码留 Task 21（DisputedLines 渲染时随格式契约补 decodeDisputed）。
 */
import type { BoundaryCountry, BoundaryData } from './types'

/** 文件魔数 / 版本（与 pipeline 同步；变更须同步两处）。 */
export const BOUNDARIES_MAGIC = 'BDRT'
export const BOUNDARIES_VERSION = 1

/** 布局常量（字节，与 pipeline LAYOUT 子集逐字节一致）。 */
export const BOUNDARIES_LAYOUT = {
  HEADER: 28,
  CONTINENT_NAME: 16,
  ISO_A3: 4,
  COUNTRY_RECORD: 36,
} as const

/**
 * 解码 `boundaries.bin` → 结构化 `BoundaryData`（与 pipeline decodeBoundaries 等价）。
 *
 * 严格校验 magic/version；非法抛错（运行时坏数据不静默渲染）。返回 typed arrays 直接供
 * `BufferAttribute` / `setIndex` 上传 GPU（无拷贝、无 earcut，纯 DataView 读）。
 *
 * @param input boundaries.bin 原始字节（ArrayBuffer 或 Uint8Array / 其 view）
 */
export function decodeBoundaries(input: ArrayBuffer | Uint8Array): BoundaryData {
  const buf =
    input instanceof Uint8Array
      ? input.buffer.slice(input.byteOffset, input.byteOffset + input.byteLength)
      : input
  const dv = new DataView(buf)
  let p = 0

  const magic = readAscii(dv, p, 4)
  if (magic !== BOUNDARIES_MAGIC) throw new Error(`boundaries.bin 魔数不匹配：${magic}`)
  p += 4
  const version = dv.getUint32(p, true)
  if (version !== BOUNDARIES_VERSION) throw new Error(`boundaries.bin 版本不支持：${version}`)
  p += 4
  const vertexCount = dv.getUint32(p, true)
  p += 4
  const countryCount = dv.getUint32(p, true)
  p += 4
  const fillIndexCount = dv.getUint32(p, true)
  p += 4
  const borderIndexCount = dv.getUint32(p, true)
  p += 4
  const continentCount = dv.getUint32(p, true)
  p += 4

  // CONTINENT_NAMES
  const continents: string[] = []
  for (let i = 0; i < continentCount; i++) {
    continents.push(readUtf8Fixed(dv, p, BOUNDARIES_LAYOUT.CONTINENT_NAME))
    p += BOUNDARIES_LAYOUT.CONTINENT_NAME
  }

  // VERTICES（Float32 lon,lat 交错）
  const vertices = new Float32Array(vertexCount * 2)
  for (let i = 0; i < vertices.length; i++) {
    vertices[i] = dv.getFloat32(p, true)
    p += 4
  }

  // FILL_INDICES
  const fillIndices = new Uint32Array(fillIndexCount)
  for (let i = 0; i < fillIndexCount; i++) {
    fillIndices[i] = dv.getUint32(p, true)
    p += 4
  }

  // BORDER_INDICES
  const borderIndices = new Uint32Array(borderIndexCount)
  for (let i = 0; i < borderIndexCount; i++) {
    borderIndices[i] = dv.getUint32(p, true)
    p += 4
  }

  // COUNTRIES
  const countries: BoundaryCountry[] = []
  for (let i = 0; i < countryCount; i++) {
    const id = dv.getUint32(p, true)
    const isoA3 = readAscii(dv, p + 4, 3)
    const continentIndex = dv.getUint8(p + 8)
    const vertexOffset = dv.getUint32(p + 12, true)
    const vertexCountC = dv.getUint32(p + 16, true)
    const fillIndexOffset = dv.getUint32(p + 20, true)
    const fillIndexCountC = dv.getUint32(p + 24, true)
    const borderIndexOffset = dv.getUint32(p + 28, true)
    const borderIndexCountC = dv.getUint32(p + 32, true)
    p += BOUNDARIES_LAYOUT.COUNTRY_RECORD
    countries.push({
      id,
      isoA3,
      continentIndex,
      continent: continents[continentIndex] ?? '',
      vertexOffset,
      vertexCount: vertexCountC,
      fillIndexOffset,
      fillIndexCount: fillIndexCountC,
      borderIndexOffset,
      borderIndexCount: borderIndexCountC,
    })
  }

  return { vertices, fillIndices, borderIndices, continents, countries }
}

// ---------------------------------------------------------------------------
// DataView 读取助手（ASCII / 定长 UTF-8，与 pipeline 实现对称）
// ---------------------------------------------------------------------------

/** 读 ASCII（到首个 0 或 maxLen）。 */
function readAscii(dv: DataView, offset: number, maxLen: number): string {
  const bytes: number[] = []
  for (let i = 0; i < maxLen; i++) {
    const b = dv.getUint8(offset + i)
    if (b === 0) break
    bytes.push(b)
  }
  return new TextDecoder().decode(new Uint8Array(bytes))
}

/** 读定长 UTF-8（到首个 0 或 maxLen）。 */
function readUtf8Fixed(dv: DataView, offset: number, maxLen: number): string {
  const bytes: number[] = []
  for (let i = 0; i < maxLen; i++) {
    const b = dv.getUint8(offset + i)
    if (b === 0) break
    bytes.push(b)
  }
  return new TextDecoder().decode(new Uint8Array(bytes))
}
