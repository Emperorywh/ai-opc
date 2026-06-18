/**
 * Task 28 · 前端河流二进制解码器（M10，与 pipeline 单一格式契约）。
 *
 * 与 `scripts/data-pipeline/lib/rivers-pack.mjs` 的 `decodeRivers` **等价**的 TS 实现：
 *   pipeline（pack）  →  public/data/rivers.bin  →  前端（本文件 decode）
 *
 * 为何「TS 复刻」而非 import pipeline：pipeline 是 Node .mjs（不打包进 vite bundle），故前端独立
 * 维护**解码侧**（只读 DataView，纯解码无投影/采样/几何生成）。布局常量与 pipeline **逐字节对齐**
 * ——任何布局变更须同步两处（+ round-trip 单测守契约）。
 *
 * 投影 / 高度对齐（R2 / R3，与边界不同——见 rivers-pack.mjs 顶部说明）：
 *   rivers.bin 存**已投影 worldXY + heightmap 采样高度**（pipeline 烘焙带状几何），故前端 decode
 *   读出的 `vertices` 直接喂 BufferAttribute.position——**前端不再 project() / 不再采样高度**。
 *   pipeline 用 projectRobinson（与前端 `project` 同源）+ sampleHeightAtWorld（与前端 assets.ts 同源），
 *   河流与地形 / 边界 / 标签贴地链路一致。
 *
 * ─── rivers.bin 布局（Little-Endian，与 pipeline LAYOUT 逐字节一致）──────────────────
 *   HEADER (20B):
 *     0  magic        4B   "RIVR"
 *     4  version      u32  =1
 *     8  vertexCount  u32  带状几何总顶点数
 *     12 indexCount   u32  带状三角形索引总数
 *     16 riverCount   u32
 *   VERTICES: vertexCount × 3 × f32   (x, y, z；worldXY + 高度 + ε)
 *   UVS:      vertexCount × 2 × f32   (u=累积弧长, v∈{-1,+1})
 *   INDICES:  indexCount × u32        (带状三角形全局索引)
 *   RIVERS:   riverCount × 48B:
 *     0  id            u32
 *     4  level         u8
 *     5  (pad)         3B
 *     8  name          24B UTF-8
 *     32 vertexOffset  u32
 *     36 vertexCount   u32
 *     40 indexOffset   u32
 *     44 indexCount    u32
 */
import type { River, RiverData } from './types'

/** 文件魔数 / 版本（与 pipeline 同步；变更须同步两处）。 */
export const RIVER_MAGIC = 'RIVR'
export const RIVER_VERSION = 1

/**
 * rivers.bin 布局常量（字节，与 pipeline `LAYOUT` 逐字节一致）。
 *   HEADER (20B)：magic(4) + version(u32) + vertexCount(u32) + indexCount(u32) + riverCount(u32)
 *   VERTICES：vertexCount × 3 × f32
 *   UVS：vertexCount × 2 × f32
 *   INDICES：indexCount × u32
 *   RIVERS：riverCount × 48B → id(u32) + level(u8) + pad(3) + name(24B) + vertexOffset(u32) +
 *     vertexCount(u32) + indexOffset(u32) + indexCount(u32)
 */
export const RIVER_LAYOUT = {
  HEADER: 20,
  RIVER_RECORD: 48,
  RIVER_NAME: 24,
} as const

/**
 * 解码 `rivers.bin` → 结构化 `RiverData`（与 pipeline decodeRivers 等价）。
 *
 * 严格校验 magic/version；非法抛错（运行时坏数据不静默渲染）。返回 typed arrays 直接供
 * `BufferAttribute`（position/uv）/ `setIndex` 上传 GPU——pipeline 已烘焙带状几何，前端零几何逻辑
 * （Task 29 Rivers.tsx 仅 BufferGeometry + riverMaterial）。
 *
 * @param input rivers.bin 原始字节（ArrayBuffer 或 Uint8Array / 其 view）
 */
export function decodeRivers(input: ArrayBuffer | Uint8Array): RiverData {
  const buf =
    input instanceof Uint8Array
      ? input.buffer.slice(input.byteOffset, input.byteOffset + input.byteLength)
      : input
  const dv = new DataView(buf)
  let p = 0

  const magic = readAscii(dv, p, 4)
  if (magic !== RIVER_MAGIC) throw new Error(`rivers.bin 魔数不匹配：${magic}`)
  p += 4
  const version = dv.getUint32(p, true)
  if (version !== RIVER_VERSION) throw new Error(`rivers.bin 版本不支持：${version}`)
  p += 4
  const vertexCount = dv.getUint32(p, true)
  p += 4
  const indexCount = dv.getUint32(p, true)
  p += 4
  const riverCount = dv.getUint32(p, true)
  p += 4

  // VERTICES（Float32 x,y,z 交错，已投影 worldXY + 高度）
  const vertices = new Float32Array(vertexCount * 3)
  for (let i = 0; i < vertices.length; i++) {
    vertices[i] = dv.getFloat32(p, true)
    p += 4
  }

  // UVS（Float32 u,v 交错；u=累积弧长，v∈{-1,+1} 左/右边缘）
  const uvs = new Float32Array(vertexCount * 2)
  for (let i = 0; i < uvs.length; i++) {
    uvs[i] = dv.getFloat32(p, true)
    p += 4
  }

  // INDICES（带状三角形全局索引）
  const indices = new Uint32Array(indexCount)
  for (let i = 0; i < indexCount; i++) {
    indices[i] = dv.getUint32(p, true)
    p += 4
  }

  // RIVERS（每条：id / level / name / 顶点范围 / 索引范围）
  const rivers: River[] = []
  for (let i = 0; i < riverCount; i++) {
    const id = dv.getUint32(p, true)
    const level = dv.getUint8(p + 4)
    const name = readUtf8Fixed(dv, p + 8, RIVER_LAYOUT.RIVER_NAME)
    const vertexOffset = dv.getUint32(p + 32, true)
    const vertexCountR = dv.getUint32(p + 36, true)
    const indexOffset = dv.getUint32(p + 40, true)
    const indexCountR = dv.getUint32(p + 44, true)
    p += RIVER_LAYOUT.RIVER_RECORD
    rivers.push({
      id,
      name,
      level,
      vertexOffset,
      vertexCount: vertexCountR,
      indexOffset,
      indexCount: indexCountR,
    })
  }

  return { vertices, uvs, indices, rivers }
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
