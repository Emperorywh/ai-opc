/**
 * 省名 Billboard 标签 / 省会光点 / 省会名小字准备层测试（TASK-010 验收 1、2；SPEC §3.7）。
 *
 * 依赖方向：测试基线（vitest，Node 环境），import src/lib/place-labels（领域准备层）、
 * src/lib/elevation（createElevationProvider / decodeHeightmapBytes 构造 provider）、
 * src/lib/projection（projectToWorld / MAIN_MAP_WORLD_BOUNDS 复算与校验）、
 * src/config/place-labels（配置不变量）、src/geo-contracts（encodeElevationToUint16 编码 +
 * 契约校验）、scripts/places/place-catalog（EXPECTED_PLACE_PROVINCE_COUNT /
 * REQUIRED_POLITICAL_PLACE_IDS，34 省真值）。不依赖浏览器 / React / Three.js / troika——
 * 准备层是纯函数，可在 Node 内完整断言标签数、投影一致性、贴地 / 浮高 y 语义、
 * hover 小字同源关联与各类失败路径，无需启动 WebGL（人工视觉验收由 pnpm dev 无头渲染承担）。
 *
 * 覆盖（验收 1、2）：
 * - 34 省名标签 + 34 省会光点 + 34 省会名小字（每行政区各一，adminId 唯一，按 adminId 升序）。
 * - 港、澳、台齐全（SPEC §6 红线最小集）；台湾省名 = 「台湾」、台湾省会名 = 「台北」。
 * - 投影一致性：每个标签 / 光点的 (x, z) 与 projectToWorld(锚点 / 省会经纬度) 逐分量一致。
 * - 贴地 / 浮高语义：省名 y = h·k + 省名浮高；光点 y = h·k + epsilon；省会名小字 y =
 *   光点 y + 小字浮高、x/z 与光点一致（同源稳定关联）。
 * - 全部点位落在主图世界包围盒内。
 * - 失败路径：exaggeration 非有限 / 浮高非有限 / epsilon 非有限 / entries 空 / 角色-配对失衡 /
 *   投影失败（越出主图）/ 高程查询失败（越出元数据范围）→ 各自稳定 code 抛错，不产出部分标签。
 * - collectRenderedPlaceLabelStrings：68 条（省名 + 省会名）、顺序 = 条目序、含台湾 / 台北。
 * - 集成（生产高程）：真实 68 点 + 真实生产 heightmap provider——全部准备成功（投影 + 高程
 *   查询无一失败），抽样 y 与 provider 复算精确一致，所有省会点位 h ≥ -1m（不沉海，贴地成立）。
 * - 配置不变量：浮高 / 字号 / 半径为正且派生自主图宽度、省名字号 > 省会名字号（读图层次）、
 *   epsilon 与省界同值、字体 URL 本地（无在线请求）、基线色可区分、光柱默认关闭、配置冻结。
 */

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  PlaceLabelPrepError,
  collectRenderedPlaceLabelStrings,
  preparePlaceLabels,
  type PlaceLabelPrepConfig,
} from '../src/lib/place-labels'
import { createElevationProvider, decodeHeightmapBytes } from '../src/lib/elevation'
import type { ElevationProvider } from '../src/lib/elevation'
import { MAIN_MAP_WORLD_BOUNDS, projectToWorld } from '../src/lib/projection'
import { PLACE_LABELS_CONFIG } from '../src/config/place-labels'
import { PROVINCE_BORDERS_CONFIG } from '../src/config/province-borders'
import {
  encodeElevationToUint16,
  validatePlaceDirectory,
  type PlaceDirectoryContract,
  type TerrainMetaContract,
} from '../src/geo-contracts'
import {
  EXPECTED_PLACE_PROVINCE_COUNT,
  REQUIRED_POLITICAL_PLACE_IDS,
} from '../scripts/places/place-catalog'

const projectRoot = resolve(fileURLToPath(import.meta.url), '..', '..')
/** 中国主图 + heightmap 元数据共用范围（EPSG:4326 度）。 */
const CHINA_EXTENT = { west: 72, south: 3, east: 136, north: 54 }
const RANGE = { min: -1500, max: 9000 }

/** 构造一份合法 terrain-meta（范围 / 分辨率 / 编码区间可注入）。 */
function makeMeta(opts: {
  readonly width: number
  readonly height: number
  readonly extent?: { readonly west: number; readonly south: number; readonly east: number; readonly north: number }
}): TerrainMetaContract {
  const extent = opts.extent ?? CHINA_EXTENT
  return {
    kind: 'terrain-meta',
    version: '1.0.0',
    crs: 'EPSG:3857',
    geographicExtent: { crs: 'EPSG:4326', ...extent },
    resolution: { widthPixels: opts.width, heightPixels: opts.height },
    elevationEncoding: {
      minValueMeters: RANGE.min,
      maxValueMeters: RANGE.max,
      bitDepth: 16,
      encoding: 'linear-unsigned-integer',
      outOfRangePolicy: 'clamp-to-range',
    },
    source: { sourceId: 'src-test-synthetic' },
  }
}

/**
 * 构造一份「常数高程」provider：所有像元编码同一高程，任意点查询返回该高程（双线性对常数 =
 * 常数）。编解码有整数取整，故实际查询值 ≈ elevationMeters（测试用 provider 实际查询值断言，
 * 不假定精确等于输入）。
 */
function makeConstantProvider(
  elevationMeters: number,
  opts: {
    readonly width?: number
    readonly height?: number
    readonly extent?: { readonly west: number; readonly south: number; readonly east: number; readonly north: number }
  } = {},
): ElevationProvider {
  const width = opts.width ?? 8
  const height = opts.height ?? 8
  const meta = makeMeta({ width, height, extent: opts.extent })
  const code = encodeElevationToUint16(
    elevationMeters,
    meta.elevationEncoding.minValueMeters,
    meta.elevationEncoding.maxValueMeters,
  )
  const pixels = new Uint16Array(width * height).fill(code)
  return createElevationProvider(meta, pixels)
}

/** 生产地点目录（与运行时 fetch 的 JSON 同一份，经契约校验）。 */
function loadProductionPlaces(): PlaceDirectoryContract {
  const payload: unknown = JSON.parse(
    readFileSync(resolve(projectRoot, 'public/geo/china-places.json'), 'utf-8'),
  )
  expect(validatePlaceDirectory(payload).ok).toBe(true)
  return payload as PlaceDirectoryContract
}

/** 测试用准备配置（取生产配置冻结值，与运行时同一事实源）。 */
const PREP_CONFIG: PlaceLabelPrepConfig = {
  provinceLabelHeightOffsetMeters: PLACE_LABELS_CONFIG.provinceLabelHeightOffsetMeters,
  capitalLabelHeightOffsetMeters: PLACE_LABELS_CONFIG.capitalLabelHeightOffsetMeters,
  terrainEpsilonMeters: PLACE_LABELS_CONFIG.terrainEpsilonMeters,
}

describe('34 省名标签 + 34 省会光点 + 34 省会名小字（验收 1、2）', () => {
  it('恰好产出 34 个省名标签 + 34 个省会光点 + 34 个省会名小字（每行政区各一，adminId 唯一）', () => {
    const places = loadProductionPlaces()
    const result = preparePlaceLabels(places, makeConstantProvider(1000), 2, PREP_CONFIG)
    expect(result.provinceLabels.length).toBe(EXPECTED_PLACE_PROVINCE_COUNT)
    expect(result.capitalPoints.length).toBe(EXPECTED_PLACE_PROVINCE_COUNT)
    expect(result.capitalLabels.length).toBe(EXPECTED_PLACE_PROVINCE_COUNT)
    expect(new Set(result.provinceLabels.map((l) => l.adminId)).size).toBe(EXPECTED_PLACE_PROVINCE_COUNT)
    expect(new Set(result.capitalPoints.map((p) => p.adminId)).size).toBe(EXPECTED_PLACE_PROVINCE_COUNT)
    expect(new Set(result.capitalLabels.map((l) => l.adminId)).size).toBe(EXPECTED_PLACE_PROVINCE_COUNT)
  })

  it('输出按 adminId 升序（确定性、可审计，港澳台 CN-71/81/82 在尾部）', () => {
    const places = loadProductionPlaces()
    const result = preparePlaceLabels(places, makeConstantProvider(1000), 2, PREP_CONFIG)
    const sorted = [...result.provinceLabels.map((l) => l.adminId)].sort((a, b) => a.localeCompare(b))
    expect(result.provinceLabels.map((l) => l.adminId)).toEqual(sorted)
    expect(result.capitalPoints.map((p) => p.adminId)).toEqual(sorted)
    expect(result.capitalLabels.map((l) => l.adminId)).toEqual(sorted)
    // 港澳台在尾部（CN-71/81/82 字典序最大）。
    const tail = result.provinceLabels.slice(-3).map((l) => l.adminId)
    expect(tail).toEqual(['CN-710000', 'CN-810000', 'CN-820000'])
  })

  it('港、澳、台均有省名标签 + 省会光点 + 省会名小字（SPEC §6 红线最小集，不缺失）', () => {
    const places = loadProductionPlaces()
    const result = preparePlaceLabels(places, makeConstantProvider(1000), 2, PREP_CONFIG)
    const labelAdmins = new Set(result.provinceLabels.map((l) => l.adminId))
    const pointAdmins = new Set(result.capitalPoints.map((p) => p.adminId))
    const capitalAdmins = new Set(result.capitalLabels.map((l) => l.adminId))
    for (const id of REQUIRED_POLITICAL_PLACE_IDS) {
      expect(labelAdmins.has(id), `${id} 应有省名标签`).toBe(true)
      expect(pointAdmins.has(id), `${id} 应有省会光点`).toBe(true)
      expect(capitalAdmins.has(id), `${id} 应有省会名小字`).toBe(true)
    }
    // 台湾省名标签文字为「台湾」，台湾省会名小字为「台北」。
    expect(result.provinceLabels.find((l) => l.adminId === 'CN-710000')?.text).toBe('台湾')
    expect(result.capitalLabels.find((l) => l.adminId === 'CN-710000')?.name).toBe('台北')
  })

  it('全部省名标签 / 省会光点 / 省会名小字投影落在中国主图世界包围盒', () => {
    const places = loadProductionPlaces()
    const result = preparePlaceLabels(places, makeConstantProvider(1000), 2, PREP_CONFIG)
    const all = [
      ...result.provinceLabels.map((l) => l.position),
      ...result.capitalPoints.map((p) => p.position),
      ...result.capitalLabels.map((l) => l.position),
    ]
    expect(all.length).toBe(EXPECTED_PLACE_PROVINCE_COUNT * 3)
    for (const [x, , z] of all) {
      expect(x).toBeGreaterThanOrEqual(MAIN_MAP_WORLD_BOUNDS.minX)
      expect(x).toBeLessThanOrEqual(MAIN_MAP_WORLD_BOUNDS.maxX)
      expect(z).toBeGreaterThanOrEqual(MAIN_MAP_WORLD_BOUNDS.minZ)
      expect(z).toBeLessThanOrEqual(MAIN_MAP_WORLD_BOUNDS.maxZ)
    }
  })
})

describe('投影一致性（验收 2「点位投影与世界坐标一致」）', () => {
  it('每个省名标签 / 省会光点的 (x, z) 与 projectToWorld(经纬度) 逐分量一致', () => {
    const places = loadProductionPlaces()
    const result = preparePlaceLabels(places, makeConstantProvider(1000), 2, PREP_CONFIG)
    const anchors = places.entries.filter((e) => e.role === 'provinceNameAnchor')
    const capitals = places.entries.filter((e) => e.role === 'administrativeCapital')
    for (const label of result.provinceLabels) {
      const entry = anchors.find((a) => a.adminId === label.adminId)
      expect(entry, `${label.adminId} 应有锚点条目`).toBeDefined()
      const projected = projectToWorld(entry!.coordinate.lon, entry!.coordinate.lat)
      expect(projected.ok).toBe(true)
      if (projected.ok) {
        expect(label.position[0]).toBe(projected.value.x)
        expect(label.position[2]).toBe(projected.value.z)
      }
    }
    for (const point of result.capitalPoints) {
      const entry = capitals.find((c) => c.adminId === point.adminId)
      expect(entry, `${point.adminId} 应有行政中心条目`).toBeDefined()
      const projected = projectToWorld(entry!.coordinate.lon, entry!.coordinate.lat)
      expect(projected.ok).toBe(true)
      if (projected.ok) {
        expect(point.position[0]).toBe(projected.value.x)
        expect(point.position[2]).toBe(projected.value.z)
      }
    }
  })
})

describe('贴地 / 浮高语义（SPEC §3.7「标签浮于地形之上」「光点贴地」）', () => {
  it('省名标签 y = h·k + 省名浮高（与 provider 复算精确一致）', () => {
    const provider = makeConstantProvider(1000)
    const k = 2
    const result = preparePlaceLabels(loadProductionPlaces(), provider, k, PREP_CONFIG)
    for (const label of result.provinceLabels) {
      const query = provider.queryAtWorld(label.position[0], label.position[2])
      expect(query.ok).toBe(true)
      if (query.ok) {
        expect(label.position[1]).toBe(query.meters * k + PREP_CONFIG.provinceLabelHeightOffsetMeters)
      }
    }
  })

  it('省会光点 y = h·k + epsilon（贴地，与 provider 复算精确一致）', () => {
    const provider = makeConstantProvider(1000)
    const k = 2
    const result = preparePlaceLabels(loadProductionPlaces(), provider, k, PREP_CONFIG)
    for (const point of result.capitalPoints) {
      const query = provider.queryAtWorld(point.position[0], point.position[2])
      expect(query.ok).toBe(true)
      if (query.ok) {
        expect(point.position[1]).toBe(query.meters * k + PREP_CONFIG.terrainEpsilonMeters)
      }
    }
  })

  it('省会名小字 y = 光点 y + 小字浮高，x/z 与光点逐分量一致（同源稳定关联）', () => {
    const provider = makeConstantProvider(1000)
    const k = 2
    const result = preparePlaceLabels(loadProductionPlaces(), provider, k, PREP_CONFIG)
    for (const label of result.capitalLabels) {
      const point = result.capitalPoints.find((p) => p.adminId === label.adminId)
      expect(point, `${label.adminId} 应有对应光点`).toBeDefined()
      expect(label.position[0]).toBe(point!.position[0])
      expect(label.position[2]).toBe(point!.position[2])
      expect(label.position[1]).toBe(point!.position[1] + PREP_CONFIG.capitalLabelHeightOffsetMeters)
    }
  })

  it('负高程（浅水）点 y = h·k + epsilon 仍成立（h 为负）', () => {
    // 常数 -200m provider：全部点位在浅水下，y 语义仍是 h·k + epsilon（保留负高程，不 clamp 到 0）。
    const provider = makeConstantProvider(-200)
    const k = 2
    const result = preparePlaceLabels(loadProductionPlaces(), provider, k, PREP_CONFIG)
    for (const point of result.capitalPoints) {
      const query = provider.queryAtWorld(point.position[0], point.position[2])
      expect(query.ok).toBe(true)
      if (query.ok) {
        expect(query.meters).toBeLessThan(0)
        expect(point.position[1]).toBe(query.meters * k + PREP_CONFIG.terrainEpsilonMeters)
      }
    }
  })
})

describe('collectRenderedPlaceLabelStrings（运行时字体覆盖校验的渲染字符串唯一入口）', () => {
  it('返回全部 68 条地点名（34 省名 + 34 省会名），顺序 = 条目序', () => {
    const places = loadProductionPlaces()
    const strings = collectRenderedPlaceLabelStrings(places)
    expect(strings.length).toBe(68)
    expect(strings).toEqual(places.entries.map((e) => e.name))
  })

  it('含台湾（省名）与台北（省会名）——SPEC §6 红线名称在覆盖范围内', () => {
    const strings = collectRenderedPlaceLabelStrings(loadProductionPlaces())
    expect(strings).toContain('台湾')
    expect(strings).toContain('台北')
    expect(strings).toContain('香港')
    expect(strings).toContain('澳门')
  })
})

describe('失败路径（绝不产出缺省 / 错位标签）', () => {
  const places = loadProductionPlaces()

  it('exaggeration 非有限 → exaggeration-not-finite', () => {
    expect(() => preparePlaceLabels(places, makeConstantProvider(1000), Number.NaN, PREP_CONFIG))
      .toThrowError(PlaceLabelPrepError)
    try {
      preparePlaceLabels(places, makeConstantProvider(1000), Number.POSITIVE_INFINITY, PREP_CONFIG)
      expect.unreachable('应抛 PlaceLabelPrepError')
    } catch (e) {
      expect((e as PlaceLabelPrepError).code).toBe('place-labels.exaggeration-not-finite')
    }
  })

  it('浮高非有限 → height-offset-not-finite', () => {
    for (const bad of [
      { ...PREP_CONFIG, provinceLabelHeightOffsetMeters: Number.NaN },
      { ...PREP_CONFIG, capitalLabelHeightOffsetMeters: Number.POSITIVE_INFINITY },
    ]) {
      try {
        preparePlaceLabels(places, makeConstantProvider(1000), 2, bad)
        expect.unreachable('应抛 PlaceLabelPrepError')
      } catch (e) {
        expect((e as PlaceLabelPrepError).code).toBe('place-labels.height-offset-not-finite')
      }
    }
  })

  it('epsilon 非有限 → epsilon-not-finite', () => {
    try {
      preparePlaceLabels(places, makeConstantProvider(1000), 2, {
        ...PREP_CONFIG,
        terrainEpsilonMeters: Number.NaN,
      })
      expect.unreachable('应抛 PlaceLabelPrepError')
    } catch (e) {
      expect((e as PlaceLabelPrepError).code).toBe('place-labels.epsilon-not-finite')
    }
  })

  it('entries 为空 → empty-places', () => {
    const empty: PlaceDirectoryContract = { ...places, entries: [] }
    try {
      preparePlaceLabels(empty, makeConstantProvider(1000), 2, PREP_CONFIG)
      expect.unreachable('应抛 PlaceLabelPrepError')
    } catch (e) {
      expect((e as PlaceLabelPrepError).code).toBe('place-labels.empty-places')
    }
  })

  it('角色-配对失衡（某省缺行政中心）→ role-pair-imbalance', () => {
    const imbalanced: PlaceDirectoryContract = {
      ...places,
      entries: places.entries.filter(
        (e) => !(e.adminId === 'CN-110000' && e.role === 'administrativeCapital'),
      ),
    }
    try {
      preparePlaceLabels(imbalanced, makeConstantProvider(1000), 2, PREP_CONFIG)
      expect.unreachable('应抛 PlaceLabelPrepError')
    } catch (e) {
      expect((e as PlaceLabelPrepError).code).toBe('place-labels.role-pair-imbalance')
    }
  })

  it('角色-配对失衡（某省多一个锚点）→ role-pair-imbalance', () => {
    const duplicated: PlaceDirectoryContract = {
      ...places,
      entries: [
        ...places.entries,
        { ...places.entries[0], id: 'CN-110000-anchor-dup' },
      ],
    }
    try {
      preparePlaceLabels(duplicated, makeConstantProvider(1000), 2, PREP_CONFIG)
      expect.unreachable('应抛 PlaceLabelPrepError')
    } catch (e) {
      expect((e as PlaceLabelPrepError).code).toBe('place-labels.role-pair-imbalance')
    }
  })

  it('锚点坐标越出主图范围 → projection-failed（不产出部分标签）', () => {
    const outOfExtent: PlaceDirectoryContract = {
      ...places,
      entries: places.entries.map((e) =>
        e.id === 'CN-110000-anchor' ? { ...e, coordinate: { lon: 140, lat: 40 } } : e,
      ),
    }
    try {
      preparePlaceLabels(outOfExtent, makeConstantProvider(1000), 2, PREP_CONFIG)
      expect.unreachable('应抛 PlaceLabelPrepError')
    } catch (e) {
      expect((e as PlaceLabelPrepError).code).toBe('place-labels.projection-failed')
    }
  })

  it('高程查询失败（点位越出 heightmap 元数据范围）→ elevation-query-failed', () => {
    // 元数据范围收窄到 [100, 20, 110, 40]：北京（116.4°E）在范围外 → queryAtWorld 失败。
    const narrowProvider = makeConstantProvider(1000, {
      extent: { west: 100, south: 20, east: 110, north: 40 },
    })
    try {
      preparePlaceLabels(places, narrowProvider, 2, PREP_CONFIG)
      expect.unreachable('应抛 PlaceLabelPrepError')
    } catch (e) {
      expect((e as PlaceLabelPrepError).code).toBe('place-labels.elevation-query-failed')
    }
  })
})

describe('集成：真实 68 点 + 生产 heightmap——投影与贴地无一失败（验收 2 的核心证据）', () => {
  /**
   * 生产高程 provider（4096²，解码 TASK-003 交付资产）。与运行时 App 装配同一入口
   * （createElevationProvider 包装已解码 pixels），与 GPU 位移同一份高程事实源。
   */
  const productionProvider: ElevationProvider = (() => {
    const metaPath = resolve(projectRoot, 'public/terrain/china-heightmap-4096.meta.json')
    const rasterPath = resolve(projectRoot, 'public/terrain/china-heightmap-4096.r16')
    const meta = JSON.parse(readFileSync(metaPath, 'utf-8')) as unknown
    const bytes = readFileSync(rasterPath) as Uint8Array
    return createElevationProvider(meta, decodeHeightmapBytes(bytes, 4096 * 4096))
  })()

  const k = 2
  const prepared = preparePlaceLabels(loadProductionPlaces(), productionProvider, k, PREP_CONFIG)

  it('真实生产资产全量准备成功：34 + 34 + 34（投影 / 高程查询无一失败）', () => {
    expect(prepared.provinceLabels.length).toBe(EXPECTED_PLACE_PROVINCE_COUNT)
    expect(prepared.capitalPoints.length).toBe(EXPECTED_PLACE_PROVINCE_COUNT)
    expect(prepared.capitalLabels.length).toBe(EXPECTED_PLACE_PROVINCE_COUNT)
  })

  it('抽样标签 / 光点 y 与生产 provider 复算精确一致（贴地 / 浮高语义在生产地形上成立）', () => {
    const samples = ['CN-110000', 'CN-540000', 'CN-440000', 'CN-710000', 'CN-810000']
    for (const adminId of samples) {
      const label = prepared.provinceLabels.find((l) => l.adminId === adminId)!
      const point = prepared.capitalPoints.find((p) => p.adminId === adminId)!
      const labelQuery = productionProvider.queryAtWorld(label.position[0], label.position[2])
      const pointQuery = productionProvider.queryAtWorld(point.position[0], point.position[2])
      expect(labelQuery.ok).toBe(true)
      expect(pointQuery.ok).toBe(true)
      if (labelQuery.ok) {
        expect(label.position[1]).toBe(labelQuery.meters * k + PREP_CONFIG.provinceLabelHeightOffsetMeters)
      }
      if (pointQuery.ok) {
        expect(point.position[1]).toBe(pointQuery.meters * k + PREP_CONFIG.terrainEpsilonMeters)
      }
    }
  })

  it('所有省会点位真实海拔 h ≥ -1m（不沉海——贴地语义对生产坐标成立，无需海平面钳制）', () => {
    for (const point of prepared.capitalPoints) {
      const query = productionProvider.queryAtWorld(point.position[0], point.position[2])
      expect(query.ok).toBe(true)
      if (query.ok) {
        expect(query.meters, `${point.adminId} 省会不应沉海`).toBeGreaterThanOrEqual(-1)
      }
    }
  })

  it('光点 y 与省名标签 y 的浮高差符合配置（标签恒在光点上方）', () => {
    for (const label of prepared.provinceLabels) {
      const point = prepared.capitalPoints.find((p) => p.adminId === label.adminId)!
      // 同省标签与光点未必同点（锚点 ≠ 行政中心），但标签浮高（≈59km）远大于地形起伏，
      // 标签恒高于光点。
      expect(label.position[1]).toBeGreaterThan(point.position[1])
    }
  })
})

describe('配置不变量（src/config/place-labels 唯一事实源）', () => {
  it('浮高 / 字号 / 光点半径全部为正、有限，且派生自主图世界宽度（不写死绝对米数）', () => {
    const width = MAIN_MAP_WORLD_BOUNDS.maxX - MAIN_MAP_WORLD_BOUNDS.minX
    expect(PLACE_LABELS_CONFIG.provinceLabelHeightOffsetMeters).toBe(width / 120)
    expect(PLACE_LABELS_CONFIG.capitalLabelHeightOffsetMeters).toBe(width / 200)
    expect(PLACE_LABELS_CONFIG.provinceLabelFontSizeMeters).toBe(width / 220)
    expect(PLACE_LABELS_CONFIG.capitalLabelFontSizeMeters).toBe(width / 350)
    expect(PLACE_LABELS_CONFIG.capitalPointRadiusMeters).toBe(width / 512)
    for (const v of [
      PLACE_LABELS_CONFIG.provinceLabelHeightOffsetMeters,
      PLACE_LABELS_CONFIG.capitalLabelHeightOffsetMeters,
      PLACE_LABELS_CONFIG.provinceLabelFontSizeMeters,
      PLACE_LABELS_CONFIG.capitalLabelFontSizeMeters,
      PLACE_LABELS_CONFIG.capitalPointRadiusMeters,
    ]) {
      expect(Number.isFinite(v)).toBe(true)
      expect(v).toBeGreaterThan(0)
    }
  })

  it('读图层次：省名字号 > 省会名字号；省名浮高 > 省会名小字浮高', () => {
    expect(PLACE_LABELS_CONFIG.provinceLabelFontSizeMeters).toBeGreaterThan(
      PLACE_LABELS_CONFIG.capitalLabelFontSizeMeters,
    )
    expect(PLACE_LABELS_CONFIG.provinceLabelHeightOffsetMeters).toBeGreaterThan(
      PLACE_LABELS_CONFIG.capitalLabelHeightOffsetMeters,
    )
  })

  it('贴地 epsilon 与省界同值（15m，同一贴地语义），光柱默认关闭（0 = 仅球体光点）', () => {
    expect(PLACE_LABELS_CONFIG.terrainEpsilonMeters).toBe(15)
    expect(PLACE_LABELS_CONFIG.terrainEpsilonMeters).toBe(PROVINCE_BORDERS_CONFIG.terrainEpsilonMeters)
    expect(PLACE_LABELS_CONFIG.capitalBeamHeightMeters).toBe(0)
  })

  it('字体与清单 URL 指向本地 /fonts/ 静态资产（无在线字体请求）', () => {
    expect(PLACE_LABELS_CONFIG.fontPath.startsWith('/fonts/')).toBe(true)
    expect(PLACE_LABELS_CONFIG.fontManifestPath.startsWith('/fonts/')).toBe(true)
    expect(PLACE_LABELS_CONFIG.fontPath).not.toContain('http://')
    expect(PLACE_LABELS_CONFIG.fontPath).not.toContain('https://')
    expect(PLACE_LABELS_CONFIG.fontManifestPath).not.toContain('https://')
    expect(PLACE_LABELS_CONFIG.fontPath.endsWith('.ttf')).toBe(true)
  })

  it('基线色为合法 #rrggbb 且三类可区分（省名浅青白 / 光点暖琥珀 / 小字同族更亮）', () => {
    const hexPattern = /^#[0-9a-f]{6}$/
    expect(PLACE_LABELS_CONFIG.provinceLabelColorHex).toMatch(hexPattern)
    expect(PLACE_LABELS_CONFIG.capitalPointColorHex).toMatch(hexPattern)
    expect(PLACE_LABELS_CONFIG.capitalLabelColorHex).toMatch(hexPattern)
    // 省名（冷色）与光点（暖色）色相分明。
    expect(PLACE_LABELS_CONFIG.provinceLabelColorHex).not.toBe(PLACE_LABELS_CONFIG.capitalPointColorHex)
    // 字节 RGB 与十六进制一致。
    expect(PLACE_LABELS_CONFIG.provinceLabelColorRgb).toEqual({ r: 207, g: 245, b: 236 })
    expect(PLACE_LABELS_CONFIG.capitalPointColorRgb).toEqual({ r: 255, g: 209, b: 128 })
    expect(PLACE_LABELS_CONFIG.capitalLabelColorRgb).toEqual({ r: 255, g: 224, b: 160 })
  })

  it('配置冻结（运行时不可被偷偷改，如把字体 URL 改成 CDN / 把浮高改 0）', () => {
    expect(Object.isFrozen(PLACE_LABELS_CONFIG)).toBe(true)
  })
})
