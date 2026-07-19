/**
 * heightmap 纹理加载（资产访问层，TASK-009）。
 *
 * 角色与依赖方向：
 * - 本模块属于渲染层的资产访问子层（src/three），把 TASK-003 交付的 16 位 heightmap 资产
 *   （public/terrain/china-heightmap-4096.r16 + meta）加载、校验、解码为 GPU 纹理，供 ChinaTerrainMesh
 *   的 vertex shader 按顶点 UV 采样做位移。本模块**只**依赖：契约层（validateTerrainMeta / 元数据类型）、
 *   运行时高程层（decodeHeightmapBytes —— 16 位小端解码的唯一入口，避免本层另写一套解码）、
 *   three.js（DataTexture 类型）。不依赖 React / R3F / DOM 事件 / hover / GeoJSON
 *   （TASK-009 实现约束「渲染层不得自行读取 GeoJSON / 维护 hover / 加载外网」）。
 *
 * 16 位端到端精度（SPEC §5.1、§7.1；TASK-009 实现约束「不得因纹理载入链路静默退化为 8 位」）：
 * - .r16 是 16 位小端 uint16 原始字节（4096²×2B ≈ 32MB），不经任何 8 位浏览器图像解码——浏览器图像
 *   解码会把每通道压到 8 位，丢失高程精度（SPEC §5.1 红线）。本模块用 fetch 取 ArrayBuffer，再经
 *   decodeHeightmapBytes（小端 Uint16Array 零拷贝视图）拿回 16 位编码，全程零 8 位中间态。
 * - 归一化上传：uint16 编码 → float32 归一化值（code/65535）→ RedFormat+FloatType DataTexture。
 *   float32 尾数 23 位 > 16 位，归一化值完整保留 65536 个量级，端到端无精度损失（HalfFloat 仅 10 位
 *   尾数 = 1024 量级，会退化，故**不用** HalfFloat）。GPU LinearFilter 在归一化值上做硬件双线性，
 *   与 CPU 高程层「先解码四角再双线性米值」在仿射等价下一致（docs/elevation.md §3）。
 *
 * 加载失败语义（绝不静默退化为平面 fallback，TASK-009 实现约束「没有 8 位降级、临时平面 fallback」）：
 * - 元数据不通过契约校验、字节长度与分辨率不符、fetch 失败：抛错（带稳定信息），由上层在加载期暴露，
 *   不返回「平地纹理」伪结果——平地 fallback 会把「看不到起伏」伪装成「成功」，违反 TASK 验收。
 */

import * as THREE from 'three'
import { validateTerrainMeta } from '../geo-contracts'
import type { TerrainMetaContract } from '../geo-contracts'
import { decodeHeightmapBytes } from '../lib/elevation'

/** 加载产物：经契约校验的元数据 + 可供 shader 采样的 16 位精度归一化纹理。 */
export interface HeightmapTextureLoadResult {
  readonly meta: TerrainMetaContract
  readonly texture: THREE.DataTexture
}

/** 加载期失败的稳定错误码（含 fetch / 元数据 / 字节长度三类根因）。 */
export type HeightmapLoadFailureCode =
  | 'heightmap.fetch-failed'
  | 'heightmap.meta-invalid'
  | 'heightmap.byte-length-mismatch'

/** 加载期错误：携带稳定 code 与简体中文说明，绝不静默退化为平面 fallback。 */
export class HeightmapLoadError extends Error {
  readonly code: HeightmapLoadFailureCode
  constructor(code: HeightmapLoadFailureCode, message: string) {
    super(message)
    this.name = 'HeightmapLoadError'
    this.code = code
  }
}

/**
 * 把 16 位 uint16 像素缓冲转为「归一化 float32 纹理数据」（code/65535）。
 *
 * 这是本层从「16 位编码」到「GPU 纹理」的唯一转换。float32 完整保留 16 位精度（23 位尾数 > 16）；
 * 着色器内再仿射解码到米。绝不用 8 位通道（会丢精度）、绝不用 HalfFloat（10 位尾数不够）。
 *
 * 导出供测试在 Node 环境内省数据形状（如断言归一化后范围 ∈ [0,1]、与 CPU 解码一致性）。
 */
export function uint16PixelsToNormalizedFloat(pixels: Uint16Array): Float32Array {
  const out = new Float32Array(pixels.length)
  for (let i = 0; i < pixels.length; i++) {
    out[i] = pixels[i] / 65535
  }
  return out
}

/**
 * 由已解码的 16 位像素与元数据构造 GPU 纹理（纯同步，便于测试注入像素）。
 *
 * 纹理参数：
 * - 格式 RedFormat + FloatType：单通道 32 位浮点，承载归一化高程码，保留 16 位精度。
 * - magFilter / minFilter 均为 LinearFilter：启用硬件双线性，使低分段 mesh（2048²）仍能呈现
 *   4096² 纹理级的起伏细节（SPEC §7.1「纹理分辨率 ≠ 网格分段数」的落点）。
 * - wrapS/T ClampToEdge：边缘收敛到边界像元，与 CPU 高程层边缘语义一致（不外推）。
 * - generateMipmaps=false：heightmap 是数据纹理，不需 mipmap（且省显存）；texture.needsUpdate=true
 *   触发上传。
 */
export function buildHeightmapDataTexture(
  meta: TerrainMetaContract,
  pixels: Uint16Array,
): THREE.DataTexture {
  const width = meta.resolution.widthPixels
  const height = meta.resolution.heightPixels
  const expected = width * height
  if (pixels.length !== expected) {
    throw new HeightmapLoadError(
      'heightmap.byte-length-mismatch',
      `16 位像元数 ${pixels.length} 与元数据分辨率 ${width}x${height}=${expected} 不一致。`,
    )
  }
  const data = uint16PixelsToNormalizedFloat(pixels)
  const texture = new THREE.DataTexture(data, width, height, THREE.RedFormat, THREE.FloatType)
  texture.magFilter = THREE.LinearFilter
  texture.minFilter = THREE.LinearFilter
  texture.wrapS = THREE.ClampToEdgeWrapping
  texture.wrapT = THREE.ClampToEdgeWrapping
  texture.generateMipmaps = false
  texture.needsUpdate = true
  return texture
}

/**
 * 校验元数据；失败抛 heightmap.meta-invalid（加载期确定性失败，绝不静默放过）。
 * 复用契约层 validateTerrainMeta 作为唯一校验入口，不在本层另写一套元数据校验。
 */
function validateMetaOrThrow(metaInput: unknown): TerrainMetaContract {
  const outcome = validateTerrainMeta(metaInput)
  if (!outcome.ok) {
    throw new HeightmapLoadError(
      'heightmap.meta-invalid',
      `heightmap 元数据未通过 terrain-meta 契约校验：${outcome.errors.map((e) => `${e.code}@${e.path}`).join('; ')}。`,
    )
  }
  return metaInput as TerrainMetaContract
}

/**
 * 从浏览器 fetch 异步加载生产 heightmap 资产并构造 GPU 纹理。
 *
 * 参数是 meta 与 raster 的 URL（默认指向 public/terrain 下的生产资产）。先取 meta、经契约校验，
 * 再取 raster 字节、校验字节长度 = width·height·2（16 位小端），最后经 decodeHeightmapBytes 解码
 * （复用运行时高程层的唯一解码入口）并构造 DataTexture。任一步失败抛 HeightmapLoadError。
 *
 * 该函数只在浏览器运行（用 fetch）；测试环境请直接用 buildHeightmapDataTexture 注入像素。
 */
export async function loadHeightmapTexture(
  metaUrl = '/terrain/china-heightmap-4096.meta.json',
  rasterUrl = '/terrain/china-heightmap-4096.r16',
): Promise<HeightmapTextureLoadResult> {
  let metaResponse: Response
  try {
    metaResponse = await fetch(metaUrl)
  } catch (cause) {
    throw new HeightmapLoadError(
      'heightmap.fetch-failed',
      `获取 heightmap 元数据失败（${metaUrl}）：${(cause as Error).message}。`,
    )
  }
  if (!metaResponse.ok) {
    throw new HeightmapLoadError(
      'heightmap.fetch-failed',
      `获取 heightmap 元数据失败（${metaUrl}）：HTTP ${metaResponse.status}。`,
    )
  }
  const metaInput = await metaResponse.json()
  const meta = validateMetaOrThrow(metaInput)

  const expectedPixels = meta.resolution.widthPixels * meta.resolution.heightPixels
  let rasterResponse: Response
  try {
    rasterResponse = await fetch(rasterUrl)
  } catch (cause) {
    throw new HeightmapLoadError(
      'heightmap.fetch-failed',
      `获取 heightmap 栅格失败（${rasterUrl}）：${(cause as Error).message}。`,
    )
  }
  if (!rasterResponse.ok) {
    throw new HeightmapLoadError(
      'heightmap.fetch-failed',
      `获取 heightmap 栅格失败（${rasterUrl}）：HTTP ${rasterResponse.status}。`,
    )
  }
  const bytes = new Uint8Array(await rasterResponse.arrayBuffer())
  if (bytes.byteLength !== expectedPixels * 2) {
    throw new HeightmapLoadError(
      'heightmap.byte-length-mismatch',
      `栅格字节长度 ${bytes.byteLength} 与期望 ${expectedPixels * 2}（${meta.resolution.widthPixels}x${meta.resolution.heightPixels}·2，16 位小端）不符。`,
    )
  }

  // 复用运行时高程层的唯一 16 位小端解码入口；全程零 8 位浏览器图像解码。
  const pixels = decodeHeightmapBytes(bytes, expectedPixels)
  const texture = buildHeightmapDataTexture(meta, pixels)
  return { meta, texture }
}
