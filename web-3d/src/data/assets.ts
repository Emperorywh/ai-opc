/**
 * 资源加载与解析（SPEC §4.2 / §7，D16 全部打包进构建）。
 *
 * 职责：把 `public/data/*.png|json` 解析为 typed arrays / 纹理 / 领域对象。
 * 解码部分（PNG→Uint16、meta 解析、双线性采样）为无副作用纯函数，可在 Node 单测验证；
 * 仅构建 THREE 纹理一步耦合 three（roadmap「texture/typed array」产出）。
 *
 * 高程加载是 M1 最高风险点（SPEC §6.1 / ROADMAP PoC #2）：
 *   浏览器原生 Image/canvas 路径会把 16-bit PNG 降为 8-bit（256 级 ≈ 45m/步，破坏精度），
 *   故用 `fast-png` 在浏览器侧逐字节解码 16-bit → Uint16Array（与 Task 02 大端烘焙一致），
 *   再上传为 R32F 纹理——float32 完整保留 16-bit 精度、支持 LINEAR 滤波、全平台支持
 *   （three 0.184 不支持 R16_UNORM；半浮点损精度；整数纹理仅 NEAREST。详见 createHeightTexture）。
 */
import * as THREE from 'three'
import { decode } from 'fast-png'
import {
  project,
  PLANE_WIDTH,
  PLANE_HEIGHT,
  heightToWorldY,
  type ElevationMeta,
} from '../config/projection'
import type {
  BoundaryData,
  DisputedData,
  ElevationData,
  Label,
  MetaJson,
  RiverData,
  TerrainAssets,
} from './types'
import { decodeBoundaries, decodeDisputed } from './boundaries'
import { decodeRivers } from './rivers'

/** 运行时资源 URL（Vite 把 public/ 映射到 BASE_URL）。懒求值，避免模块加载期 env 依赖。 */
function dataUrl(name: string): string {
  return `${import.meta.env.BASE_URL}data/${name}`
}

// ---------------------------------------------------------------------------
// 纯函数：解析（无副作用，可在 Node 单测验证）
// ---------------------------------------------------------------------------

/** 从任意输入解析并校验 `meta.json`。 */
export function parseMeta(input: unknown): MetaJson {
  if (typeof input !== 'object' || input === null) {
    throw new Error('meta.json 必须是对象')
  }
  const m = input as Record<string, unknown>
  const num = (k: string): number => {
    const v = m[k]
    if (typeof v !== 'number' || !Number.isFinite(v)) {
      throw new Error(`meta.json 字段 ${k} 必须是有限数`)
    }
    return v
  }
  const str = (k: string): string => {
    const v = m[k]
    if (typeof v !== 'string') throw new Error(`meta.json 字段 ${k} 必须是字符串`)
    return v
  }
  const projection = str('projection')
  if (projection !== 'equirectangular' && projection !== 'robinson') {
    throw new Error(`meta.json projection 不支持：${projection}`)
  }
  const heightExaggeration = num('heightExaggeration')
  if (heightExaggeration <= 0) {
    throw new Error('meta.json heightExaggeration 必须为正')
  }
  const meta: MetaJson = {
    version: num('version'),
    source: str('source'),
    projection,
    width: num('width'),
    height: num('height'),
    elevationMin: num('elevationMin'),
    elevationMax: num('elevationMax'),
    seaLevelMeters: num('seaLevelMeters'),
    heightExaggeration,
  }
  if (meta.width <= 0 || meta.height <= 0) {
    throw new Error('meta.json width/height 必须为正')
  }
  return meta
}

/**
 * 解码 16-bit 灰度 PNG → `ElevationData`（Uint16，与 Task 02 大端烘焙一致）。
 * fast-png 对 depth=16 返回 Uint16Array（已转本机字节序）。
 */
export function decodeHeightmap(pngBytes: ArrayBuffer | Uint8Array): ElevationData {
  const bytes = pngBytes instanceof Uint8Array ? pngBytes : new Uint8Array(pngBytes)
  const decoded = decode(bytes)
  if (decoded.depth !== 16) {
    throw new Error(`heightmap.png 必须是 16-bit 灰度，实际 depth=${decoded.depth}`)
  }
  if (decoded.channels !== 1) {
    throw new Error(`heightmap.png 必须是单通道灰度，实际 channels=${decoded.channels}`)
  }
  if (!(decoded.data instanceof Uint16Array)) {
    throw new Error('heightmap.png 解码未得到 Uint16Array（fast-png 行为异常）')
  }
  if (decoded.data.length !== decoded.width * decoded.height) {
    throw new Error('heightmap.png 解码尺寸与像素数不符')
  }
  return {
    width: decoded.width,
    height: decoded.height,
    // 拷贝一份，解耦对底层 buffer 的外部持有
    data: new Uint16Array(decoded.data),
  }
}

// ---------------------------------------------------------------------------
// labels.json 解析（Task 14 前端运行时消费 Task 13 pipeline 产物）
// ---------------------------------------------------------------------------

/** 合法 kind 值（SPEC §6.5：大洲 / 大洋 / 国家 / 城市）。 */
const LABEL_KINDS = ['continent', 'ocean', 'country', 'city'] as const
function isLabelKind(v: unknown): v is Label['kind'] {
  return typeof v === 'string' && (LABEL_KINDS as readonly string[]).includes(v)
}

/**
 * 从 `labels.json` 原始数组解析并校验为 `Label[]`（无副作用纯函数，可在 Node 单测验证）。
 * 结构对齐 SPEC §6.5 `{id,zhName,kind,continent,lon,lat,priority}`；逐条严格校验类型，
 * 非法输入抛错（与 `parseMeta` 同风格），避免运行时坏数据静默渲染。
 */
export function parseLabels(input: unknown): Label[] {
  if (!Array.isArray(input)) {
    throw new Error('labels.json 必须是数组')
  }
  return input.map((raw, i) => {
    if (typeof raw !== 'object' || raw === null) {
      throw new Error(`labels.json[${i}] 必须是对象`)
    }
    const r = raw as Record<string, unknown>
    const strField = (k: string): string => {
      const v = r[k]
      if (typeof v !== 'string') throw new Error(`labels.json[${i}].${k} 必须是字符串`)
      return v
    }
    const numField = (k: string): number => {
      const v = r[k]
      if (typeof v !== 'number' || !Number.isFinite(v)) {
        throw new Error(`labels.json[${i}].${k} 必须是有限数`)
      }
      return v
    }
    const kind = r['kind']
    if (!isLabelKind(kind)) {
      throw new Error(`labels.json[${i}].kind 非法：${String(kind)}`)
    }
    const continent = r['continent']
    if (continent !== null && typeof continent !== 'string') {
      throw new Error(`labels.json[${i}].continent 必须是字符串或 null`)
    }
    return {
      id: strField('id'),
      zhName: strField('zhName'),
      kind,
      continent,
      lon: numField('lon'),
      lat: numField('lat'),
      priority: numField('priority'),
    }
  })
}

// ---------------------------------------------------------------------------
// THREE 纹理（仅此步耦合 three）
// ---------------------------------------------------------------------------

/**
 * 由 Uint16 高程构建可采样的高度纹理（R32F，LINEAR）。
 *
 * three.js 0.184 不支持 R16_UNORM 归一化 16-bit 单通道纹理（全仓库无该映射）；
 * 半浮点（HalfFloat）仅 ~2048 级，量化 ~5.6m，破坏 M1「CPU/GPU 误差 < 1e-4」；
 * 整数纹理（R16UI）只支持 NEAREST 滤波，位移呈阶梯。
 * 故上传为 R32F：源数据仍为紧凑 16-bit PNG，GPU 端 float32 完整保留 16-bit 精度、
 * LINEAR 可滤波、全平台支持。
 */
export function createHeightTexture(elevation: ElevationData): THREE.DataTexture {
  const { width, height, data } = elevation
  const float = new Float32Array(width * height)
  for (let i = 0; i < data.length; i++) float[i] = data[i] / 65535
  const texture = new THREE.DataTexture(
    float,
    width,
    height,
    THREE.RedFormat,
    THREE.FloatType,
  )
  texture.minFilter = THREE.LinearFilter
  texture.magFilter = THREE.LinearFilter
  // 经度方向可环绕（−180°/+180° 同一经线），纬度方向钳制到极点
  texture.wrapS = THREE.RepeatWrapping
  texture.wrapT = THREE.ClampToEdgeWrapping
  // 高程数据，非颜色，不做 transfer function
  texture.colorSpace = THREE.NoColorSpace
  texture.needsUpdate = true
  return texture
}

// ---------------------------------------------------------------------------
// CPU 高度查询表（R3：与 GPU shader 同源）
// ---------------------------------------------------------------------------

/**
 * 世界平面坐标 → 连续像素采样坐标（与 heightmap 布局一致：v=0 顶行=北，u=0 左列=西）。
 *
 * 与 Task 04 vertex shader 的 `heightUv = (worldX/PLANE_WIDTH + 0.5, 0.5 + worldZ/PLANE_HEIGHT)`
 * **严格同源**（R3 CPU/GPU 一致）。Robinson 重烘焙后 heightmap 像素均匀对应 worldXY，
 * 故 CPU 采样也走 worldXY→UV（而非经纬度→像素 —— 后者假设 equirect 网格，Robinson 下错位）。
 */
function worldToSample(
  worldX: number,
  worldZ: number,
  width: number,
  height: number,
): { sx: number; sy: number } {
  const sx = (worldX / PLANE_WIDTH + 0.5) * width
  const sy = (0.5 + worldZ / PLANE_HEIGHT) * height
  return { sx, sy }
}

/**
 * 双线性采样归一化高程 h∈[0,1]（像素中心约定，与 Task 02 一致）。
 * 经度方向环绕、纬度方向钳制。与 GPU LINEAR 采样同一 heightmap 源、同一解码公式 → CPU/GPU 一致（R3）。
 *
 * 以**世界平面坐标**为输入（worldXY→UV，与 shader 同源），投影无关 —— Robinson 或 equirect
 * 下皆正确。供需要直接定位 worldXY 的场景（如河流贴地采样 / 拾取深度偏移）。
 */
export function sampleHeightAtWorld(
  elevation: ElevationData,
  worldX: number,
  worldZ: number,
): number {
  const { width: W, height: H, data } = elevation
  const { sx, sy } = worldToSample(worldX, worldZ, W, H)
  const x0 = Math.floor(sx - 0.5)
  const y0 = Math.floor(sy - 0.5)
  const fx = sx - 0.5 - x0
  const fy = sy - 0.5 - y0
  const wrap = (i: number): number => ((i % W) + W) % W
  const clamp = (i: number): number => Math.min(H - 1, Math.max(0, i))
  const xi0 = wrap(x0)
  const xi1 = wrap(x0 + 1)
  const yi0 = clamp(y0)
  const yi1 = clamp(y0 + 1)
  const h00 = data[yi0 * W + xi0] / 65535
  const h10 = data[yi0 * W + xi1] / 65535
  const h01 = data[yi1 * W + xi0] / 65535
  const h11 = data[yi1 * W + xi1] / 65535
  const a = h00 + (h10 - h00) * fx
  const b = h01 + (h11 - h01) * fx
  return a + (b - a) * fy
}

/**
 * 经纬度 → 归一化高程 h∈[0,1]。先经 `project(lon,lat)` 投影到 worldXY 再采样（R2 单一投影契约），
 * 与地形顶点 / 边界 / 标签同源对齐。equirect 下 project 退化为线性，与原「经纬度→像素」逐字节等价；
 * Robinson 下经 project 走 worldXY→UV，自动与重烘焙的 Robinson heightmap 对齐。
 */
export function sampleHeight(elevation: ElevationData, lon: number, lat: number): number {
  const [x, z] = project(lon, lat)
  return sampleHeightAtWorld(elevation, x, z)
}

/** (lon,lat) → 世界 Y（CPU 查询，与 shader 同源公式；河流采样 / 标签锚点 / 拾取深度偏移用）。 */
export function sampleWorldY(
  elevation: ElevationData,
  meta: ElevationMeta,
  lon: number,
  lat: number,
): number {
  return heightToWorldY(sampleHeight(elevation, lon, lat), meta)
}

// ---------------------------------------------------------------------------
// 顶层加载（运行时 fetch，浏览器侧）
// ---------------------------------------------------------------------------

/** 加载并校验 `meta.json`。 */
export async function loadMeta(): Promise<MetaJson> {
  const res = await fetch(dataUrl('meta.json'))
  if (!res.ok) throw new Error(`加载 meta.json 失败：${res.status}`)
  return parseMeta(await res.json())
}

/** 加载并校验 `labels.json`（Task 13 产出：大洲 + 大洋中文标签）。 */
export async function loadLabels(): Promise<Label[]> {
  const res = await fetch(dataUrl('labels.json'))
  if (!res.ok) throw new Error(`加载 labels.json 失败：${res.status}`)
  return parseLabels(await res.json())
}

/**
 * 加载并解码 `boundaries.bin`（Task 19 pipeline 产出：国家填充三角化 + 描边线段，紧凑二进制）。
 * 解码侧见 `./boundaries`（与 pipeline 单一格式契约）；失败抛错由 Scene catch（与 loadLabels 同模式，
 * 独立 fetch 不阻塞地形）。返回 typed arrays 供 BufferGeometry 直接上传 GPU。
 */
export async function loadBoundaries(): Promise<BoundaryData> {
  const res = await fetch(dataUrl('boundaries.bin'))
  if (!res.ok) throw new Error(`加载 boundaries.bin 失败：${res.status}`)
  return decodeBoundaries(await res.arrayBuffer())
}

/**
 * 加载并解码 `disputed.bin`（Task 19 pipeline 产出：争议区折线，紧凑二进制）。
 * 解码侧 `decodeDisputed` 见 `./boundaries`（与 pipeline 单一格式契约）；失败抛错由 Scene catch
 * （与 loadBoundaries 同模式，独立 fetch 不阻塞地形 / 国家边界）。返回 typed arrays 供
 * DisputedLines 渲染层投影 + lineSegments 上传 GPU。
 */
export async function loadDisputed(): Promise<DisputedData> {
  const res = await fetch(dataUrl('disputed.bin'))
  if (!res.ok) throw new Error(`加载 disputed.bin 失败：${res.status}`)
  return decodeDisputed(await res.arrayBuffer())
}

/**
 * 加载并解码 `rivers.bin`（Task 28 pipeline 产出：主要河流带状几何，紧凑二进制）。
 *
 * 解码侧 `decodeRivers` 见 `./rivers`（与 pipeline 单一格式契约）；失败抛错由 Scene catch
 * （与 loadBoundaries/loadDisputed 同模式，独立 fetch 不阻塞地形 / 边界）。返回 typed arrays 供
 * Task 29 Rivers 渲染层 BufferGeometry 直接上传 GPU——pipeline 已烘焙带状几何（已投影 worldXY +
 * heightmap 采样高度 + ε + 累积弧长 uv），前端**不再 project() / 不再采样高度**（详见
 * `./rivers` 顶部对齐说明）。
 */
export async function loadRivers(): Promise<RiverData> {
  const res = await fetch(dataUrl('rivers.bin'))
  if (!res.ok) throw new Error(`加载 rivers.bin 失败：${res.status}`)
  return decodeRivers(await res.arrayBuffer())
}

/** 加载 8-bit RGB `normal.png` 为线性纹理（细节增强用）。 */
export async function loadNormalTexture(): Promise<THREE.Texture> {
  const texture = await new THREE.TextureLoader().loadAsync(dataUrl('normal.png'))
  texture.colorSpace = THREE.NoColorSpace
  return texture
}

/** 加载全部地形资产：meta + 16-bit heightmap（R32F 纹理）+ normal + CPU 高程。 */
export async function loadTerrainAssets(): Promise<TerrainAssets> {
  const meta = await loadMeta()
  const [heightPng, normalTexture] = await Promise.all([
    fetch(dataUrl('heightmap.png')).then((r) => {
      if (!r.ok) throw new Error(`加载 heightmap.png 失败：${r.status}`)
      return r.arrayBuffer()
    }),
    loadNormalTexture(),
  ])
  const elevation = decodeHeightmap(heightPng)
  const heightTexture = createHeightTexture(elevation)
  return { meta, heightTexture, normalTexture, elevation }
}
