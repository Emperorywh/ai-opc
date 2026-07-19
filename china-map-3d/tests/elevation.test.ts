/**
 * 共享运行时高程查询测试（TASK-008 验证方式 1–5）。
 *
 * 依赖方向：测试基线（vitest，Node 环境），import src/lib/elevation（运行时访问层）、
 * src/lib/projection（坐标层，用于世界坐标路径）与 src/geo-contracts（编解码唯一源）。
 * 不依赖浏览器、React、Three.js。
 *
 * 覆盖：
 * - 验证方式 1：小型 2×2 / 已知编码夹具在像元中心、边界、四角中心插值处得到可计算的真实米制结果。
 * - 验证方式 2：生产资产抽样，CPU 查询值与 TASK-003 资产验证的地势相对关系一致，浅水点保持负值。
 * - 验证方式 3：重复创建多个消费者，底层 16 位数据只解码一次；release 后不再持有缓存。
 * - 验证方式 4：损坏位深、错配元数据、范围外坐标、非有限输入显式失败，不返回伪造海拔。
 * - 验证方式 5（构建）：lint / build 在其它套件与本套件共同作用下无回归（由 pnpm lint / build 覆盖）。
 */

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  ElevationProviderError,
  createElevationProvider,
  decodeHeightmapBytes,
  getSharedElevationProvider,
  type ElevationQueryFailure,
  type ElevationQuerySuccess,
  type ElevationProvider,
} from '../src/lib/elevation'
import { projectToMercator, projectToWorld } from '../src/lib/projection'
import {
  decodeUint16ToElevation,
  encodeElevationToUint16,
  type TerrainMetaContract,
} from '../src/geo-contracts'

const projectRoot = resolve(fileURLToPath(import.meta.url), '..', '..')
const RANGE = { min: -1500, max: 9000 }

/** 构造一份合法 terrain-meta（测试夹具，范围与编码区间可注入）。 */
function makeMeta(opts: {
  readonly width: number
  readonly height: number
  readonly extent?: { readonly west: number; readonly south: number; readonly east: number; readonly north: number }
  readonly range?: { readonly min: number; readonly max: number }
}): TerrainMetaContract {
  const extent = opts.extent ?? { west: 100, south: 20, east: 104, north: 24 }
  const range = opts.range ?? RANGE
  return {
    kind: 'terrain-meta',
    version: '1.0.0',
    crs: 'EPSG:3857',
    geographicExtent: { crs: 'EPSG:4326', ...extent },
    resolution: { widthPixels: opts.width, heightPixels: opts.height },
    elevationEncoding: {
      minValueMeters: range.min,
      maxValueMeters: range.max,
      bitDepth: 16,
      encoding: 'linear-unsigned-integer',
      outOfRangePolicy: 'clamp-to-range',
    },
    source: { sourceId: 'src-test' },
  }
}

/** 把真实米制数组编码为 16 位像素缓冲（行主序）。 */
function pixelsFromMeters(meters: readonly number[], min = RANGE.min, max = RANGE.max): Uint16Array {
  const arr = new Uint16Array(meters.length)
  for (let i = 0; i < meters.length; i++) {
    arr[i] = encodeElevationToUint16(meters[i], min, max)
  }
  return arr
}

/** 真实米制 → 16 位编码 → 解码回米制（反映像元存储的量化后米值，量化步长约 0.16m）。 */
function roundtripMeters(meters: number, min = RANGE.min, max = RANGE.max): number {
  return decodeUint16ToElevation(encodeElevationToUint16(meters, min, max), min, max)
}

/** 把 uint16 编码数组打包成小端字节流（与 .r16 落盘布局一致），供 getSharedElevationProvider 消费。 */
function packLittleEndian(codes: Uint16Array): Uint8Array {
  const bytes = new Uint8Array(codes.length * 2)
  const view = new DataView(bytes.buffer)
  for (let i = 0; i < codes.length; i++) {
    view.setUint16(i * 2, codes[i], true)
  }
  return bytes
}

/** 断言查询成功并返回其值。 */
function expectQueryOk(result: ElevationQuerySuccess | ElevationQueryFailure): ElevationQuerySuccess {
  expect(result.ok, `期望查询成功，实际失败：${result.ok ? '' : result.code}`).toBe(true)
  return result as ElevationQuerySuccess
}

/** 断言查询失败且失败码等于给定值（失败不得伪装成 meters:0 的成功）。 */
function expectQueryFail(
  result: ElevationQuerySuccess | ElevationQueryFailure,
  code: string,
): ElevationQueryFailure {
  expect(result.ok, `期望查询失败 ${code}，实际成功 meters=${result.ok ? result.meters : ''}`).toBe(false)
  const failure = result as ElevationQueryFailure
  expect(failure.code).toBe(code)
  return failure
}

describe('16 位小端解码（decodeHeightmapBytes）', () => {
  it('把小端字节流精确还原为 uint16 数组，且保留 16 位精度（不降为 8 位）', () => {
    // 0xc350 = 50000，远超 8 位上限 255；若被 8 位降级会丢失。
    const codes = new Uint16Array([0x1234, 0xc350, 0x0000, 0xffff])
    const decoded = decodeHeightmapBytes(packLittleEndian(codes), 4)
    expect(Array.from(decoded)).toEqual([0x1234, 0xc350, 0x0000, 0xffff])
    expect(decoded[1]).toBe(50000)
  })

  it('字节长度与期望像元数不符时确定性失败（加载期错误）', () => {
    const bytes = packLittleEndian(new Uint16Array([1, 2, 3, 4]))
    expect(() => decodeHeightmapBytes(bytes, 5)).toThrow(ElevationProviderError)
    let caught: unknown
    try {
      decodeHeightmapBytes(bytes, 5)
    } catch (cause) {
      caught = cause
    }
    expect((caught as ElevationProviderError).code).toBe('elevation.decode-byte-length-mismatch')
  })

  it('期望像元数非正整数时确定性失败', () => {
    const bytes = new Uint8Array(0)
    expect(() => decodeHeightmapBytes(bytes, 0)).toThrow(ElevationProviderError)
  })
})

describe('双线性采样 · 像元中心与四角（验证方式 1）', () => {
  // 2×2 夹具：行 0=北、列 0=西。pixels[0]=NW, [1]=NE, [2]=SW, [3]=SE。
  const nw = 1000
  const ne = 3000
  const sw = -200
  const se = 6000
  const meta = makeMeta({ width: 2, height: 2 })
  const provider = createElevationProvider(meta, pixelsFromMeters([nw, ne, sw, se]))

  it('像元中心精确还原该像元的解码米值（不与相邻像元混合）', () => {
    // NW 中心 u=0.25, v=0.25 → fx=0, fy=0 → 纯 NW。
    expect(expectQueryOk(provider.queryAtUV(0.25, 0.25)).meters).toBeCloseTo(nw, 0)
    // NE 中心 u=0.75, v=0.25。
    expect(expectQueryOk(provider.queryAtUV(0.75, 0.25)).meters).toBeCloseTo(ne, 0)
    // SW 中心 u=0.25, v=0.75。
    expect(expectQueryOk(provider.queryAtUV(0.25, 0.75)).meters).toBeCloseTo(sw, 0)
    // SE 中心 u=0.75, v=0.75。
    expect(expectQueryOk(provider.queryAtUV(0.75, 0.75)).meters).toBeCloseTo(se, 0)
  })

  it('四角中心 (u=v=0.5) 等于四角解码米值均值（标准双线性，含编码量化）', () => {
    const r = expectQueryOk(provider.queryAtUV(0.5, 0.5))
    // 像元值经 encode→decode 量化（步长约 0.16m），故期望应取「解码后的四角米值」之均值，
    // 而非原始米值之均值——provider 正是对解码后的四角米值做双线性。
    const expected = (roundtripMeters(nw) + roundtripMeters(ne) + roundtripMeters(sw) + roundtripMeters(se)) / 4
    expect(r.meters).toBeCloseTo(expected, 6)
  })

  it('负高程像元分类为 below-sea-level，正高程分类为 above-sea-level', () => {
    expect(expectQueryOk(provider.queryAtUV(0.25, 0.75)).kind).toBe('below-sea-level') // SW=-200m
    expect(expectQueryOk(provider.queryAtUV(0.75, 0.75)).kind).toBe('above-sea-level') // SE=6000m
  })
})

describe('双线性采样 · 边界像元收敛（验证方式 1 边界）', () => {
  // 3×3 夹具：每像元赋予其线性索引作为编码（经 decode 还原为可识别米值）。
  const width = 3
  const height = 3
  const meta = makeMeta({ width, height })
  const codes = new Uint16Array(width * height)
  for (let i = 0; i < codes.length; i++) codes[i] = (i + 1) * 100
  const provider = createElevationProvider(meta, codes)

  /** 解码某像元中心应等于该像元的米值。 */
  function decodedAt(col: number, row: number): number {
    return decodeUint16ToElevation(codes[row * width + col], RANGE.min, RANGE.max)
  }

  it('u=0 收敛到西列、u=1 收敛到东列（不外推）', () => {
    // 北行 (v≈0.1667 即 v=0.5/3)：u=0 → (col0,row0)，u=1 → (col2,row0)。
    const vNorth = 0.5 / height
    expect(expectQueryOk(provider.queryAtUV(0, vNorth)).meters).toBeCloseTo(decodedAt(0, 0), 6)
    expect(expectQueryOk(provider.queryAtUV(1, vNorth)).meters).toBeCloseTo(decodedAt(width - 1, 0), 6)
  })

  it('v=0 收敛到北行、v=1 收敛到南行（不外推）', () => {
    const uWest = 0.5 / width
    expect(expectQueryOk(provider.queryAtUV(uWest, 0)).meters).toBeCloseTo(decodedAt(0, 0), 6)
    expect(expectQueryOk(provider.queryAtUV(uWest, 1)).meters).toBeCloseTo(decodedAt(0, height - 1), 6)
  })

  it('四角 UV (0,0)/(1,0)/(0,1)/(1,1) 分别收敛到对应角像元', () => {
    expect(expectQueryOk(provider.queryAtUV(0, 0)).meters).toBeCloseTo(decodedAt(0, 0), 6)
    expect(expectQueryOk(provider.queryAtUV(1, 0)).meters).toBeCloseTo(decodedAt(width - 1, 0), 6)
    expect(expectQueryOk(provider.queryAtUV(0, 1)).meters).toBeCloseTo(decodedAt(0, height - 1), 6)
    expect(expectQueryOk(provider.queryAtUV(1, 1)).meters).toBeCloseTo(decodedAt(width - 1, height - 1), 6)
  })
})

describe('双线性精度：先解码四角再插值 == decode(双线性编码)，与 GPU 语义一致', () => {
  it('中心插值不把编码 round 成整数（保留亚像元精度，区别于资产统计口径）', () => {
    // 选四角编码使其中心双线性编码为非整数 150.25：provider 应给出 decode(150.25)，
    // 而非 round-then-decode 的 decode(150)——二者相差约 0.04m，据此证明未量化。
    const codes = new Uint16Array([0, 101, 200, 300])
    const provider = createElevationProvider(makeMeta({ width: 2, height: 2 }), codes)
    const r = expectQueryOk(provider.queryAtUV(0.5, 0.5))
    const expectedFractional = (150.25 / 65535) * (RANGE.max - RANGE.min) + RANGE.min
    const roundedBaseline = (150 / 65535) * (RANGE.max - RANGE.min) + RANGE.min
    expect(r.meters).toBeCloseTo(expectedFractional, 9)
    // 与「先 round 编码再 decode」的口径明显不同（差 ~0.04m），证明未做整数 round。
    expect(Math.abs(r.meters - roundedBaseline)).toBeGreaterThan(0.01)
  })
})

describe('查询异常路径：越界 / 非有限 / 已释放（验证方式 4 · 不返回伪造海拔）', () => {
  const provider = createElevationProvider(
    makeMeta({ width: 2, height: 2 }),
    pixelsFromMeters([100, 200, 300, 400]),
  )

  it('UV 越界 → uv-out-of-range 失败（ok:false，绝不伪装成 meters:0）', () => {
    for (const [u, v] of [
      [-0.1, 0.5],
      [1.1, 0.5],
      [0.5, -0.1],
      [0.5, 1.1],
    ] as const) {
      const f = expectQueryFail(provider.queryAtUV(u, v), 'elevation.uv-out-of-range')
      // 失败分支绝不携带 meters 字段，避免与海平面 0m 混淆。
      expect((f as { meters?: number }).meters).toBeUndefined()
    }
  })

  it('非有限输入 → input-not-finite（NaN/Infinity 不得因比较恒假漏过范围检查）', () => {
    expectQueryFail(provider.queryAtUV(Number.NaN, 0.5), 'elevation.input-not-finite')
    expectQueryFail(provider.queryAtUV(0.5, Number.POSITIVE_INFINITY), 'elevation.input-not-finite')
    expectQueryFail(provider.queryAtLonLat(Number.NaN, 22), 'elevation.input-not-finite')
    expectQueryFail(provider.queryAtWorld(Number.NaN, 0), 'elevation.input-not-finite')
  })
})

describe('加载期错误：损坏位深 / 错配元数据（验证方式 4）', () => {
  it('8 位位深元数据被拒绝（防 8 位降级冒充 16 位）', () => {
    const meta = makeMeta({ width: 2, height: 2 }) as unknown as {
      elevationEncoding: { bitDepth: number }
    }
    meta.elevationEncoding.bitDepth = 8
    expect(() => createElevationProvider(meta, new Uint16Array(4))).toThrow(ElevationProviderError)
    let caught: unknown
    try {
      createElevationProvider(meta, new Uint16Array(4))
    } catch (cause) {
      caught = cause
    }
    expect((caught as ElevationProviderError).code).toBe('elevation.meta-invalid')
  })

  it('栅格像元数与分辨率不符 → raster-size-mismatch', () => {
    const meta = makeMeta({ width: 4, height: 4 })
    expect(() => createElevationProvider(meta, new Uint16Array(10))).toThrow(ElevationProviderError)
    let caught: unknown
    try {
      createElevationProvider(meta, new Uint16Array(10))
    } catch (cause) {
      caught = cause
    }
    expect((caught as ElevationProviderError).code).toBe('elevation.raster-size-mismatch')
  })

  it('编码区间倒置的元数据被拒绝', () => {
    const meta = makeMeta({ width: 2, height: 2, range: { min: 9000, max: -1500 } })
    expect(() => createElevationProvider(meta, new Uint16Array(4))).toThrow(ElevationProviderError)
  })

  it('getSharedElevationProvider 在字节长度不符时抛 decode-byte-length-mismatch（不写入缓存）', () => {
    const meta = makeMeta({ width: 4, height: 4 })
    const bytes = packLittleEndian(new Uint16Array(4)) // 只有 4 像，元数据期望 16
    expect(() => getSharedElevationProvider(meta, bytes)).toThrow(ElevationProviderError)
    let caught: unknown
    try {
      getSharedElevationProvider(meta, bytes)
    } catch (cause) {
      caught = cause
    }
    expect((caught as ElevationProviderError).code).toBe('elevation.decode-byte-length-mismatch')
  })
})

describe('共享缓存 · 单份事实源与生命周期（验证方式 3）', () => {
  function makeBytes(): Uint8Array {
    return packLittleEndian(pixelsFromMeters([10, 20, 30, 40]))
  }
  const meta = makeMeta({ width: 2, height: 2 })

  it('同一源字节引用多次取用 → 返回同一 provider（底层只解码一次）', () => {
    const bytes = makeBytes()
    const p1 = getSharedElevationProvider(meta, bytes)
    const p2 = getSharedElevationProvider(meta, bytes)
    expect(p1).toBe(p2) // 引用相等 ⇒ 构造（含解码）只发生一次
  })

  it('不同源字节引用 → 各自独立 provider（重新取数即重新解码）', () => {
    const bytesA = makeBytes()
    const bytesB = makeBytes()
    const pA = getSharedElevationProvider(meta, bytesA)
    const pB = getSharedElevationProvider(meta, bytesB)
    expect(pA).not.toBe(pB)
    // 两份 provider 查询结果一致（内容相同），但实例独立。
    const a = expectQueryOk(pA.queryAtUV(0.5, 0.5)).meters
    const b = expectQueryOk(pB.queryAtUV(0.5, 0.5)).meters
    expect(a).toBe(b)
  })

  it('release 后查询返回 released 失败，并从缓存摘除（再次取用重新解码）', () => {
    const bytes = makeBytes()
    const p1 = getSharedElevationProvider(meta, bytes)
    expect(p1.released).toBe(false)
    p1.release()
    expect(p1.released).toBe(true)
    expectQueryFail(p1.queryAtUV(0.5, 0.5), 'elevation.released')
    // 缓存已摘除：同一 bytes 再取得到新实例（重新解码），与已释放的 p1 不同。
    const p2 = getSharedElevationProvider(meta, bytes)
    expect(p2).not.toBe(p1)
    expect(p2.released).toBe(false)
    expectQueryOk(p2.queryAtUV(0.5, 0.5))
    p2.release()
  })

  it('release 是幂等的（多次调用不报错）', () => {
    const bytes = makeBytes()
    const p = getSharedElevationProvider(meta, bytes)
    p.release()
    expect(() => p.release()).not.toThrow()
    expect(p.released).toBe(true)
  })

  it('createElevationProvider 不介入共享缓存：每次构造返回新实例', () => {
    const pixels = pixelsFromMeters([1, 2, 3, 4])
    const p1 = createElevationProvider(meta, pixels)
    const p2 = createElevationProvider(meta, pixels)
    expect(p1).not.toBe(p2)
    p1.release()
    // p1 释放不影响 p2（各自独立生命周期）。
    expectQueryOk(p2.queryAtUV(0.5, 0.5))
  })
})

describe('queryAtLonLat · 经纬度采样路径', () => {
  // 2×2 夹具覆盖范围 [100,20,104,24]：NW=1000, NE=3000, SW=500, SE=700。
  const extent = { west: 100, south: 20, east: 104, north: 24 }
  const meta = makeMeta({ width: 2, height: 2, extent })
  const provider = createElevationProvider(meta, pixelsFromMeters([1000, 3000, 500, 700]))

  it('西北角经纬度采样到 NW 像元值', () => {
    // lon=west=100, lat=north=24 → UV (0,0) → NW。
    const r = expectQueryOk(provider.queryAtLonLat(100, 24))
    expect(r.meters).toBeCloseTo(1000, 0)
  })

  it('范围中心经纬度映射到对应 UV，与 UV 路径结果一致（墨卡托纬度非线性，中心 lat 不映射到 v=0.5）', () => {
    // 经纬度 → UV 走墨卡托；lat=22（20–24 中点）因墨卡托 y 非线性不映射到 v=0.5。
    // 这里在测试内独立计算 UV，断言 queryAtLonLat 与 queryAtUV 在同一 UV 给出同一海拔，
    // 从而验证 lonlat→UV 映射与 UV 采样路径自洽（而非假定中心 = 四角均值）。
    const lon = 102
    const lat = 22
    const target = projectToMercator(lon, lat).value
    const sw = projectToMercator(extent.west, extent.south).value
    const ne = projectToMercator(extent.east, extent.north).value
    const u = (target.x - sw.x) / (ne.x - sw.x)
    const v = (ne.y - target.y) / (ne.y - sw.y)
    // 中心 lat 经墨卡托后 v 偏离 0.5（高纬被拉伸），证明非简单线性。
    expect(Math.abs(v - 0.5)).toBeGreaterThan(1e-6)
    const byLonLat = expectQueryOk(provider.queryAtLonLat(lon, lat)).meters
    const byUV = expectQueryOk(provider.queryAtUV(u, v)).meters
    expect(byLonLat).toBeCloseTo(byUV, 9)
  })

  it('四角经纬度分别采样到对应角像元值（角点 UV 恰为 (0/1, 0/1)）', () => {
    // 角点经纬度恰为范围端点，UV 恰为 0 或 1（墨卡托在端点无漂移）。
    expect(expectQueryOk(provider.queryAtLonLat(100, 24)).meters).toBeCloseTo(roundtripMeters(1000), 6) // NW
    expect(expectQueryOk(provider.queryAtLonLat(104, 24)).meters).toBeCloseTo(roundtripMeters(3000), 6) // NE
    expect(expectQueryOk(provider.queryAtLonLat(100, 20)).meters).toBeCloseTo(roundtripMeters(500), 6) // SW
    expect(expectQueryOk(provider.queryAtLonLat(104, 20)).meters).toBeCloseTo(roundtripMeters(700), 6) // SE
  })

  it('越出元数据范围的经纬度 → lonlat-out-of-extent 失败', () => {
    expectQueryFail(provider.queryAtLonLat(99, 22), 'elevation.lonlat-out-of-extent')
    expectQueryFail(provider.queryAtLonLat(105, 22), 'elevation.lonlat-out-of-extent')
    expectQueryFail(provider.queryAtLonLat(102, 19), 'elevation.lonlat-out-of-extent')
    expectQueryFail(provider.queryAtLonLat(102, 25), 'elevation.lonlat-out-of-extent')
  })
})

describe('queryAtWorld · 世界坐标采样路径（hover 反查语义）', () => {
  const extent = { west: 100, south: 20, east: 104, north: 24 }
  const meta = makeMeta({ width: 2, height: 2, extent })
  const provider = createElevationProvider(meta, pixelsFromMeters([1000, 3000, 500, 700]))

  it('世界坐标查询与经纬度查询结果一致（同一位置两条路径给出同一海拔）', () => {
    const lon = 102
    const lat = 22
    const world = projectToWorld(lon, lat)
    expect(world.ok).toBe(true)
    const byWorld = expectQueryOk(provider.queryAtWorld(world.value.x, world.value.z))
    const byLonLat = expectQueryOk(provider.queryAtLonLat(lon, lat))
    expect(byWorld.meters).toBeCloseTo(byLonLat.meters, 9)
  })

  it('远离主图的世界坐标 → 失败（反投影落点越出元数据范围）', () => {
    // 极远的世界点经 invertWorld 反算成经纬度后必然越出 [100,20,104,24]，返回失败而非伪造海拔。
    const r = provider.queryAtWorld(1e8, 1e8)
    expect(r.ok).toBe(false)
    const code = (r as ElevationQueryFailure).code
    expect(['elevation.lonlat-out-of-extent', 'elevation.projection-failed']).toContain(code)
  })
})

describe('生产资产抽样（验证方式 2 · CPU 查询与 TASK-003 资产验证一致）', () => {
  /**
   * 加载已交付的生产 heightmap（public/terrain/china-heightmap-4096），用本 TASK 的运行时入口
   * 解码 + 构造 provider，再对关键地势区块做区域均值抽样。断言与 TASK-003 的 terrain-deep
   * 资产验证得出的同一相对关系一致：青藏高原显著高于东部平原、东海陆架保留负高程、南海深海被
   * 截断到下限附近——证明 CPU 查询值在编码误差内与资产事实一致，浅水点保持负值。
   */
  const productionProvider: ElevationProvider = (() => {
    const metaPath = resolve(projectRoot, 'public/terrain/china-heightmap-4096.meta.json')
    const rasterPath = resolve(projectRoot, 'public/terrain/china-heightmap-4096.r16')
    const meta = JSON.parse(readFileSync(metaPath, 'utf-8')) as unknown
    const bytes = readFileSync(rasterPath) as Uint8Array
    const width = 4096
    const height = 4096
    return createElevationProvider(meta, decodeHeightmapBytes(bytes, width * height))
  })()

  /** 在区块内取 n×n 网格 queryAtLonLat 均值（与 terrain-deep 的区域均值口径一致）。 */
  function regionMeanMeters(
    centerLon: number,
    centerLat: number,
    halfLon: number,
    halfLat: number,
    pointsPerAxis = 3,
  ): number {
    let sum = 0
    let count = 0
    for (let i = 0; i < pointsPerAxis; i++) {
      for (let j = 0; j < pointsPerAxis; j++) {
        const lat = centerLat - halfLat + (2 * halfLat * i) / (pointsPerAxis - 1)
        const lon = centerLon - halfLon + (2 * halfLon * j) / (pointsPerAxis - 1)
        const r = productionProvider.queryAtLonLat(lon, lat)
        if (!r.ok) throw new Error(`生产资产采样失败 (${lon},${lat}): ${r.code}`)
        sum += r.meters
        count++
      }
    }
    return sum / count
  }

  it('生产元数据通过契约校验，provider 成功构造且分辨率为 4096²', () => {
    expect(productionProvider.width).toBe(4096)
    expect(productionProvider.height).toBe(4096)
    expect(productionProvider.meta.elevationEncoding.bitDepth).toBe(16)
  })

  it('青藏高原区域均值显著高于东部平原（西高东低）', () => {
    const tibetan = regionMeanMeters(88, 33, 1.5, 1.5)
    const eastern = regionMeanMeters(117, 33, 1.5, 1.5)
    expect(tibetan).toBeGreaterThan(eastern + 2000)
  })

  it('东海陆架浅水点保持负高程（浅水负高程未被钳制为 0）', () => {
    const shelf = regionMeanMeters(125, 28, 1, 1)
    expect(shelf).toBeLessThan(-10)
    expect(shelf).toBeGreaterThan(-1500)
    // 单点抽样同样为负（kind 为 below-sea-level），证明海陆判断可用同一事实源。
    const point = expectQueryOk(productionProvider.queryAtLonLat(125, 28))
    expect(point.kind).toBe('below-sea-level')
  })

  it('南海深海被截断到编码下限附近（深海 clamp-to-range 生效）', () => {
    const deep = regionMeanMeters(115, 15, 1, 1)
    expect(deep).toBeLessThanOrEqual(-1400)
  })
})
