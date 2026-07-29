/**
 * 生产高程资产测试（TASK-003）。
 *
 * 依赖方向：测试基线（vitest，Node 环境），import scripts/verify-assets 深度校验函数与
 * src/geo-contracts 契约层。直接读取 public/terrain 下已交付的生产资产（.r16 + .meta.json
 * + .provenance.json），证明 16 位精度与真实米制解码未丢失、关键地势相对关系成立、
 * 篡改元数据 / 栅格 / 审计 sidecar 会被资产校验发现。
 *
 * 注意：篡改类用例一律在内存副本上构造，绝不改写 public/ 下的正式资产。
 */

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { verifyTerrainAsset } from '../../scripts/verify-assets/terrain-deep'
import {
  decodeUint16ToElevation,
  encodeElevationToUint16,
} from '../../src/geo-contracts'

const projectRoot = resolve(fileURLToPath(import.meta.url), '..', '..', '..')
const META_PATH = 'public/terrain/china-heightmap-4096.meta.json'
const RASTER_PATH = 'public/terrain/china-heightmap-4096.r16'
const PROVENANCE_PATH = 'public/terrain/china-heightmap-4096.provenance.json'

/** 生产资产载荷：元数据 + 栅格像素 + 原始字节 + 审计 sidecar。模块级缓存，避免每个用例重读 33MB。 */
interface ProductionAsset {
  readonly meta: Record<string, unknown>
  readonly provenance: Record<string, unknown>
  readonly pixels: Uint16Array
  readonly rasterBytes: Uint8Array
  readonly width: number
  readonly height: number
}

/** 读取生产资产。用 DataView 按小端 uint16 解码栅格裸字节，与 .r16 字节布局一致；同时保留原始字节供 SHA-256 复算。 */
function loadProductionAsset(): ProductionAsset {
  const meta = JSON.parse(readFileSync(resolve(projectRoot, META_PATH), 'utf-8')) as Record<string, unknown>
  const provenance = JSON.parse(readFileSync(resolve(projectRoot, PROVENANCE_PATH), 'utf-8')) as Record<string, unknown>
  const bytes = readFileSync(resolve(projectRoot, RASTER_PATH))
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const pixels = new Uint16Array(bytes.length / 2)
  for (let i = 0; i < pixels.length; i++) {
    pixels[i] = view.getUint16(i * 2, true)
  }
  const resolution = meta.resolution as { widthPixels: number; heightPixels: number }
  return {
    meta,
    provenance,
    pixels,
    rasterBytes: bytes,
    width: resolution.widthPixels,
    height: resolution.heightPixels,
  }
}

const asset = loadProductionAsset()

describe('16 位编码端到端解码', () => {
  /**
   * 直接读取生产元数据声明的编码区间（非硬编码），证明「由同一编码与同一元数据解码为真实米制海拔」
   * 的契约在已交付资产上成立：端点、海平面、典型正高程、浅水负高程、深海截断均可还原到量化误差内。
   */
  it('生产元数据声明的编码区间下，编码最小值/海平面/典型正高程/最大值可还原', () => {
    const encoding = (asset.meta.elevationEncoding ?? {}) as { minValueMeters: number; maxValueMeters: number }
    const min = encoding.minValueMeters
    const max = encoding.maxValueMeters
    expect(min).toBe(-1500)
    expect(max).toBe(9000)

    // 编码最小值：code=0 ↔ 区间下限。
    expect(encodeElevationToUint16(min, min, max)).toBe(0)
    expect(decodeUint16ToElevation(0, min, max)).toBeCloseTo(min, 0)
    // 海平面 0m 往返（量化步长 ≈0.16m，容差 0.5m）。
    expect(decodeUint16ToElevation(encodeElevationToUint16(0, min, max), min, max)).toBeCloseTo(0, 0)
    // 典型正高程 4500m 往返。
    expect(decodeUint16ToElevation(encodeElevationToUint16(4500, min, max), min, max)).toBeCloseTo(4500, 0)
    // 编码最大值：code=65535 ↔ 区间上限。
    expect(encodeElevationToUint16(max, min, max)).toBe(65535)
    expect(decodeUint16ToElevation(65535, min, max)).toBeCloseTo(max, 0)
    // 浅水负高程 -200m 保留为合法低位编码（未被钳制为 0）。
    expect(decodeUint16ToElevation(encodeElevationToUint16(-200, min, max), min, max)).toBeCloseTo(-200, 0)
    // 深海 -3000m 截断到下限 -1500m。
    expect(encodeElevationToUint16(-3000, min, max)).toBe(0)
    expect(decodeUint16ToElevation(encodeElevationToUint16(-3000, min, max), min, max)).toBeCloseTo(-1500, 0)
  })

  it('生产资产实测像素覆盖编码端点：含 code=0（深海截断）且解码全部落在声明区间内', () => {
    const encoding = (asset.meta.elevationEncoding ?? {}) as { minValueMeters: number; maxValueMeters: number }
    const min = encoding.minValueMeters
    const max = encoding.maxValueMeters
    let observedMin = Infinity
    let observedMax = -Infinity
    let hasZeroCode = false
    for (let i = 0; i < asset.pixels.length; i++) {
      const code = asset.pixels[i]
      if (code === 0) hasZeroCode = true
      const meters = decodeUint16ToElevation(code, min, max)
      if (meters < observedMin) observedMin = meters
      if (meters > observedMax) observedMax = meters
    }
    // 生产范围含深海，故必存在被截断到下限的 code=0 像元。
    expect(hasZeroCode).toBe(true)
    expect(observedMin).toBeGreaterThanOrEqual(min)
    expect(observedMax).toBeLessThanOrEqual(max)
    // 青藏高原真实存在于资产：实测最高解码应达雪线附近的数千米量级（容差宽松，只验数量级）。
    expect(observedMax).toBeGreaterThan(5000)
  })
})

describe('生产高程资产地势抽样不变量', () => {
  /**
   * 用与 CLI 同一的 verifyTerrainAsset 对已交付资产做地势抽样，并额外断言相对关系的方向与数量级，
   * 作为「阈值得当、非魔法常量」的双重保护：即便 terrain-deep 的阈值被放宽，方向性断言仍会兜底。
   */
  it('青藏高原高于东部平原、四川/塔里木盆地低于周边山地、海域含负高程、深海截断到下限', () => {
    const outcome = verifyTerrainAsset({
      meta: asset.meta,
      pixels: asset.pixels,
      width: asset.width,
      height: asset.height,
    })
    expect(outcome.ok, outcome.errors.map((e) => e.message).join('; ')).toBe(true)

    const s = outcome.samples
    // 方向 + 数量级双断言（阈值远低于实测差距，稳定可复现）。
    expect(s.tibetanMeters).toBeGreaterThan(s.easternMeters + 2000)
    expect(s.sichuanSurroundingsMeters).toBeGreaterThan(s.sichuanBasinMeters + 500)
    expect(s.tarimNorthRimMeters).toBeGreaterThan(s.tarimBasinMeters + 500)
    expect(s.tarimSouthRimMeters).toBeGreaterThan(s.tarimBasinMeters + 500)
    expect(s.eastChinaSeaShelfMeters).toBeLessThan(-10)
    expect(s.eastChinaSeaShelfMeters).toBeGreaterThan(-1500)
    expect(s.southChinaSeaDeepMeters).toBeLessThanOrEqual(-1400)
  })

  it('16 位精度保持：不同 uint16 编码数远超 8 位上限 256，未被静默降为 8 位', () => {
    const outcome = verifyTerrainAsset({
      meta: asset.meta,
      pixels: asset.pixels,
      width: asset.width,
      height: asset.height,
    })
    expect(outcome.samples.distinctCodes).toBeGreaterThan(1000)
  })
})

describe('篡改元数据后资产校验确定性失败', () => {
  /** 深拷贝生产元数据，避免后续篡改污染缓存的对象。 */
  function cloneMeta(): Record<string, unknown> {
    return JSON.parse(JSON.stringify(asset.meta)) as Record<string, unknown>
  }

  /** 把位深改为 8 位：契约层即拒绝（bit-depth-not-16），资产校验必须失败。 */
  it('篡改位深为 8 位时资产校验失败', () => {
    const tampered = cloneMeta()
    const encoding = tampered.elevationEncoding as { bitDepth: number }
    encoding.bitDepth = 8
    const outcome = verifyTerrainAsset({
      meta: tampered,
      pixels: asset.pixels,
      width: asset.width,
      height: asset.height,
    })
    expect(outcome.ok).toBe(false)
    expect(outcome.errors.map((e) => e.code)).toContain('terrain-meta.bit-depth-not-16')
  })

  /** 篡改分辨率（与栅格实际像元数不一致）：资产级 raster-size-mismatch 失败。 */
  it('篡改分辨率（与栅格不一致）时资产校验失败', () => {
    const tampered = cloneMeta()
    const resolution = tampered.resolution as { widthPixels: number; heightPixels: number }
    resolution.widthPixels = 2048
    resolution.heightPixels = 2048
    const outcome = verifyTerrainAsset({
      meta: tampered,
      pixels: asset.pixels,
      width: 2048,
      height: 2048,
    })
    expect(outcome.ok).toBe(false)
    expect(outcome.errors.map((e) => e.code)).toContain('terrain-asset.raster-size-mismatch')
  })

  /** 篡改地理范围（偏离中国主图）：资产级 extent-not-main-map 失败。 */
  it('篡改地理范围时资产校验失败', () => {
    const tampered = cloneMeta()
    const ext = tampered.geographicExtent as { west: number; east: number }
    ext.west = 100
    ext.east = 130
    const outcome = verifyTerrainAsset({
      meta: tampered,
      pixels: asset.pixels,
      width: asset.width,
      height: asset.height,
    })
    expect(outcome.ok).toBe(false)
    expect(outcome.errors.map((e) => e.code)).toContain('terrain-asset.extent-not-main-map')
  })

  /**
   * 精度丢失检测（校验必须能发现被静默降为 8 位的栅格）。
   * 把真实栅格的每个 uint16 编码量化到 256 级（模拟图像工具 8 位降级后回填 uint16），
   * 元数据保持合法 16 位——校验必须据此失败，而非仍然宣称满足契约。
   */
  it('栅格被静默降为 8 位（元数据仍为 16 位）时资产校验发现精度丢失', () => {
    const degraded = new Uint16Array(asset.pixels.length)
    for (let i = 0; i < asset.pixels.length; i++) {
      // 8 位降级：code 先映射到 0..255 再回填到 uint16 等距网格（不同编码数 ≤256）。
      const byte = Math.round((asset.pixels[i] / 65535) * 255)
      degraded[i] = Math.round((byte / 255) * 65535)
    }
    const outcome = verifyTerrainAsset({
      meta: asset.meta,
      pixels: degraded,
      width: asset.width,
      height: asset.height,
    })
    expect(outcome.ok).toBe(false)
    expect(outcome.errors.map((e) => e.code)).toContain('terrain-asset.bit-depth-degraded')
  })
})

describe('审计 sidecar 完整性闭环（provenance.integrity 防篡改锚点）', () => {
  /**
   * provenance.integrity 声明 rasterBytes / sha256 / distinctCodes / observedMinMeters /
   * observedMaxMeters / clampedToMinCount 六项摘要。校验必须逐项复算比对，否则 integrity 块
   * 对自动校验形同装饰——只比对 rasterBytes 会被同字节数的劣化栅格绕过。
   *
   * 此用例证明：对未篡改的生产资产，全部六项摘要与栅格复算精确一致（SHA-256 闭环）。
   */
  it('生产资产的 provenance.integrity 六项摘要与栅格复算全部一致', () => {
    const outcome = verifyTerrainAsset({
      meta: asset.meta,
      pixels: asset.pixels,
      rasterBytes: asset.rasterBytes,
      width: asset.width,
      height: asset.height,
      provenance: asset.provenance,
    })
    expect(outcome.ok, outcome.errors.map((e) => e.message).join('; ')).toBe(true)
    // 审计 sidecar 确实声明了六项摘要（防止生产侧悄悄删除某项后校验仍通过）。
    const integrity = asset.provenance.integrity as Record<string, unknown>
    expect(integrity).toBeDefined()
    expect(integrity.sha256).toEqual(expect.any(String))
    expect(integrity.rasterBytes).toEqual(expect.any(Number))
    expect(integrity.distinctCodes).toEqual(expect.any(Number))
    expect(integrity.observedMinMeters).toEqual(expect.any(Number))
    expect(integrity.observedMaxMeters).toEqual(expect.any(Number))
    expect(integrity.clampedToMinCount).toEqual(expect.any(Number))
  })

  /**
   * 篡改栅格字节但保持字节数不变（只改首像元的低位字节）：rasterBytes 仍匹配，
   * 但 SHA-256 与统计量必然漂移。校验必须据此失败——这是「同字节数劣化栅格」的确定性检测点。
   * 元数据与审计 sidecar 均保持未篡改，故只有栅格侧的不一致被归因。
   */
  it('栅格被同字节数篡改时校验发现 SHA-256 与统计量不一致', () => {
    const tamperedBytes = new Uint8Array(asset.rasterBytes)
    // 翻转首像元低位字节：保持字节总数不变，但内容已变。
    tamperedBytes[0] = (tamperedBytes[0] + 1) & 0xff
    const view = new DataView(tamperedBytes.buffer, tamperedBytes.byteOffset, tamperedBytes.byteLength)
    const tamperedPixels = new Uint16Array(tamperedBytes.length / 2)
    for (let i = 0; i < tamperedPixels.length; i++) {
      tamperedPixels[i] = view.getUint16(i * 2, true)
    }
    const outcome = verifyTerrainAsset({
      meta: asset.meta,
      pixels: tamperedPixels,
      rasterBytes: tamperedBytes,
      width: asset.width,
      height: asset.height,
      provenance: asset.provenance,
    })
    expect(outcome.ok).toBe(false)
    const codes = outcome.errors.map((e) => e.code)
    // SHA-256 是最强的锚点：任意单字节改动即变，必须命中。
    expect(codes).toContain('terrain-asset.provenance-integrity-mismatch')
    const shaErrors = outcome.errors.filter((e) => e.path === '$.provenance.integrity.sha256')
    expect(shaErrors.length).toBe(1)
  })

  /**
   * 篡改审计 sidecar 的统计量字段（distinctCodes +1）而保持栅格不变：栅格复算的统计量
   * 与审计声明不一致，校验必须发现。证明统计量锚点（非仅 SHA-256）也在生效。
   */
  it('审计 sidecar 统计量被篡改时校验发现不一致', () => {
    const tamperedProvenance = JSON.parse(JSON.stringify(asset.provenance)) as Record<string, unknown>
    const integrity = tamperedProvenance.integrity as { distinctCodes: number }
    integrity.distinctCodes = integrity.distinctCodes + 1
    const outcome = verifyTerrainAsset({
      meta: asset.meta,
      pixels: asset.pixels,
      rasterBytes: asset.rasterBytes,
      width: asset.width,
      height: asset.height,
      provenance: tamperedProvenance,
    })
    expect(outcome.ok).toBe(false)
    expect(outcome.errors.map((e) => e.path)).toContain('$.provenance.integrity.distinctCodes')
  })

  /**
   * 篡改审计 sidecar 的来源标识（与元数据 sourceId 不一致）：来源可审计性的交叉印证必须发现。
   */
  it('审计 sourceId 与元数据不一致时校验失败', () => {
    const tamperedProvenance = JSON.parse(JSON.stringify(asset.provenance)) as Record<string, unknown>
    ;(tamperedProvenance.source as { sourceId: string }).sourceId = 'src-tampered'
    const outcome = verifyTerrainAsset({
      meta: asset.meta,
      pixels: asset.pixels,
      rasterBytes: asset.rasterBytes,
      width: asset.width,
      height: asset.height,
      provenance: tamperedProvenance,
    })
    expect(outcome.ok).toBe(false)
    expect(outcome.errors.map((e) => e.code)).toContain('terrain-asset.provenance-source-mismatch')
  })

  /**
   * 审计声明了 sha256 但校验入参未提供 rasterBytes：无法复算 SHA-256，必须报错
   * （避免「声明锚点但不闭环」的装饰性校验静默通过）。
   */
  it('审计声明 sha256 但未提供 rasterBytes 时校验报缺口错误', () => {
    const outcome = verifyTerrainAsset({
      meta: asset.meta,
      pixels: asset.pixels,
      width: asset.width,
      height: asset.height,
      provenance: asset.provenance,
      // 故意不传 rasterBytes。
    })
    expect(outcome.ok).toBe(false)
    expect(outcome.errors.map((e) => e.path)).toContain('$.provenance.integrity.sha256')
  })
})
