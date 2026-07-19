/**
 * 省名 / 省会光点 / 岛礁名称标注准备层测试（TASK-016 验证方式 1、2）。
 *
 * 依赖方向：测试基线（vitest，Node），import src/lib/place-labels（领域准备层）、src/lib/elevation
 * （createElevationProvider 构造合成 provider）、src/lib/projection（MAIN_MAP_WORLD_BOUNDS 范围校验）、
 * src/geo-contracts（validatePlaceDirectory / validatePoliticalBoundary 契约校验 + political-catalog 红线真值）、
 * scripts/places/place-catalog（EXPECTED_PLACE_PROVINCE_COUNT / REQUIRED_POLITICAL_PLACE_IDS，34 省真值）。
 * 不依赖浏览器 / React / Three.js / troika——准备层是纯函数。
 */

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  PlaceLabelPrepError,
  collectAllLabelDomainStrings,
  preparePlaceLabels,
  type PlaceLabelPrepConfig,
} from '../src/lib/place-labels'
import { createElevationProvider } from '../src/lib/elevation'
import type { ElevationProvider } from '../src/lib/elevation'
import { MAIN_MAP_WORLD_BOUNDS } from '../src/lib/projection'
import { PLACE_LABELS_CONFIG } from '../src/config/place-labels'
import {
  encodeElevationToUint16,
  validatePlaceDirectory,
  validatePoliticalBoundary,
  type PlaceDirectoryContract,
  type PoliticalBoundaryContract,
  type TerrainMetaContract,
} from '../src/geo-contracts'
import {
  EXPECTED_PLACE_PROVINCE_COUNT,
  REQUIRED_POLITICAL_PLACE_IDS,
} from '../scripts/places/place-catalog'

const projectRoot = resolve(fileURLToPath(import.meta.url), '..', '..')
const CHINA_EXTENT = { west: 72, south: 3, east: 136, north: 54 }
const RANGE = { min: -1500, max: 9000 }

function makeMeta(): TerrainMetaContract {
  return {
    kind: 'terrain-meta',
    version: '1.0.0',
    crs: 'EPSG:3857',
    geographicExtent: { crs: 'EPSG:4326', ...CHINA_EXTENT },
    resolution: { widthPixels: 8, heightPixels: 8 },
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

function makeConstantProvider(elevationMeters: number): ElevationProvider {
  const meta = makeMeta()
  const code = encodeElevationToUint16(elevationMeters, RANGE.min, RANGE.max)
  const pixels = new Uint16Array(8 * 8).fill(code)
  return createElevationProvider(meta, pixels)
}

const PREP_CONFIG: PlaceLabelPrepConfig = {
  provinceLabelHeightOffsetMeters: PLACE_LABELS_CONFIG.provinceLabelHeightOffsetMeters,
  islandLabelHeightOffsetMeters: PLACE_LABELS_CONFIG.islandLabelHeightOffsetMeters,
  terrainEpsilonMeters: PLACE_LABELS_CONFIG.terrainEpsilonMeters,
  seaLevelYMeters: PLACE_LABELS_CONFIG.seaLevelYMeters,
}

function loadProductionPlaces(): PlaceDirectoryContract {
  const payload: unknown = JSON.parse(
    readFileSync(resolve(projectRoot, 'public/geo/china-places.json'), 'utf-8'),
  )
  expect(validatePlaceDirectory(payload).ok).toBe(true)
  return payload as PlaceDirectoryContract
}

function loadProductionPolitical(): PoliticalBoundaryContract {
  const payload: unknown = JSON.parse(
    readFileSync(resolve(projectRoot, 'public/geo/china-political-boundary.json'), 'utf-8'),
  )
  expect(validatePoliticalBoundary(payload).ok).toBe(true)
  return payload as PoliticalBoundaryContract
}

describe('34 省名标签 + 34 省会光点 + 岛礁名称（TASK-016 验证方式 1）', () => {
  it('恰好产出 34 个省名标签 + 34 个省会光点（每行政区各一）', () => {
    const places = loadProductionPlaces()
    const political = loadProductionPolitical()
    const result = preparePlaceLabels(places, political, makeConstantProvider(1000), 2, PREP_CONFIG)
    expect(result.provinceLabels.length).toBe(EXPECTED_PLACE_PROVINCE_COUNT)
    expect(result.capitalPoints.length).toBe(EXPECTED_PLACE_PROVINCE_COUNT)
    // 每行政区恰一个标签 + 一个光点（adminId 唯一）。
    expect(new Set(result.provinceLabels.map((l) => l.adminId)).size).toBe(EXPECTED_PLACE_PROVINCE_COUNT)
    expect(new Set(result.capitalPoints.map((p) => p.adminId)).size).toBe(EXPECTED_PLACE_PROVINCE_COUNT)
  })

  it('港、澳、台均有省名标签 + 省会光点（SPEC §6 红线最小集，不缺失）', () => {
    const places = loadProductionPlaces()
    const political = loadProductionPolitical()
    const result = preparePlaceLabels(places, political, makeConstantProvider(1000), 2, PREP_CONFIG)
    const labelAdmins = new Set(result.provinceLabels.map((l) => l.adminId))
    const pointAdmins = new Set(result.capitalPoints.map((p) => p.adminId))
    for (const id of REQUIRED_POLITICAL_PLACE_IDS) {
      expect(labelAdmins.has(id), `${id} 应有省名标签`).toBe(true)
      expect(pointAdmins.has(id), `${id} 应有省会光点`).toBe(true)
    }
    // 台湾省名标签文字为「台湾」。
    const twLabel = result.provinceLabels.find((l) => l.adminId === 'CN-710000')
    expect(twLabel?.text).toBe('台湾')
  })

  it('岛礁名称标签全部稳定关联（含 SPEC §6 点名岛礁），与岛礁点位同源', () => {
    const places = loadProductionPlaces()
    const political = loadProductionPolitical()
    const result = preparePlaceLabels(places, political, makeConstantProvider(1000), 2, PREP_CONFIG)
    const names = new Set(result.islandLabels.map((l) => l.name))
    // 生产资产含 5 岛礁（钓鱼岛 / 赤尾屿 / 曾母暗沙 / 黄岩岛 / 永兴岛）。
    expect(result.islandLabels.length).toBeGreaterThanOrEqual(3)
    for (const required of ['钓鱼岛', '赤尾屿', '曾母暗沙']) {
      expect(names.has(required), `岛礁名称「${required}」应在标签中`).toBe(true)
    }
  })

  it('全部省名标签 / 省会光点 / 岛礁标签投影落在中国主图世界包围盒', () => {
    const places = loadProductionPlaces()
    const political = loadProductionPolitical()
    const result = preparePlaceLabels(places, political, makeConstantProvider(1000), 2, PREP_CONFIG)
    const all = [
      ...result.provinceLabels.map((l) => l.position),
      ...result.capitalPoints.map((p) => p.position),
      ...result.islandLabels.map((l) => l.position),
    ]
    for (const [x, , z] of all) {
      expect(x).toBeGreaterThanOrEqual(MAIN_MAP_WORLD_BOUNDS.minX)
      expect(x).toBeLessThanOrEqual(MAIN_MAP_WORLD_BOUNDS.maxX)
      expect(z).toBeGreaterThanOrEqual(MAIN_MAP_WORLD_BOUNDS.minZ)
      expect(z).toBeLessThanOrEqual(MAIN_MAP_WORLD_BOUNDS.maxZ)
    }
  })
})

describe('浮高 / 贴地语义（TASK-016 输出约束「锚点上方浮高」「光点贴地」）', () => {
  it('省名标签浮于地形之上：y = h·k + provinceLabelHeightOffset（陆地）', () => {
    const places = loadProductionPlaces()
    const political = loadProductionPolitical()
    const k = 2
    const offset = PREP_CONFIG.provinceLabelHeightOffsetMeters
    const provider = makeConstantProvider(1500)
    const result = preparePlaceLabels(places, political, provider, k, PREP_CONFIG)
    // 常数 provider 经 16 位编解码有亚米级量化误差，故查询实际解码米值 h 再断言 y = h·k + offset。
    const sample = provider.queryAtWorld(result.provinceLabels[0].position[0], result.provinceLabels[0].position[2])
    expect(sample.ok).toBe(true)
    const expectedY = sample.meters * k + offset
    for (const label of result.provinceLabels) {
      expect(label.position[1]).toBeCloseTo(expectedY, 5)
      expect(label.position[1]).toBeGreaterThan(sample.meters * k) // 浮于地形之上
    }
  })

  it('省会光点贴地：y = h·k + epsilon（陆地）', () => {
    const places = loadProductionPlaces()
    const political = loadProductionPolitical()
    const k = 2
    const epsilon = PREP_CONFIG.terrainEpsilonMeters
    const provider = makeConstantProvider(2000)
    const result = preparePlaceLabels(places, political, provider, k, PREP_CONFIG)
    const sample = provider.queryAtWorld(result.capitalPoints[0].position[0], result.capitalPoints[0].position[2])
    expect(sample.ok).toBe(true)
    const expectedY = sample.meters * k + epsilon
    for (const point of result.capitalPoints) {
      expect(point.position[1]).toBeCloseTo(expectedY, 5)
    }
  })

  it('岛礁名称标签海平面贴合 + 浮高：海域钳制到海平面之上 epsilon + 浮高', () => {
    const places = loadProductionPlaces()
    const political = loadProductionPolitical()
    const k = 2
    const epsilon = PREP_CONFIG.terrainEpsilonMeters
    const seaLevel = PREP_CONFIG.seaLevelYMeters
    const islandOffset = PREP_CONFIG.islandLabelHeightOffsetMeters
    // 负高程（海域）→ h·k < seaLevel → 钳制到 seaLevel → y = seaLevel + epsilon + islandOffset。
    const result = preparePlaceLabels(places, political, makeConstantProvider(-800), k, PREP_CONFIG)
    for (const label of result.islandLabels) {
      expect(label.position[1]).toBe(seaLevel + epsilon + islandOffset)
      expect(label.position[1]).toBeGreaterThan(0) // 在海平面之上，不被吞没
    }
  })

  it('夸张系数变化时省名标签 / 省会光点 y 同步变化（k 只放大 world-y）', () => {
    const places = loadProductionPlaces()
    const political = loadProductionPolitical()
    const offset = PREP_CONFIG.provinceLabelHeightOffsetMeters
    const epsilon = PREP_CONFIG.terrainEpsilonMeters
    const provider15 = makeConstantProvider(1000)
    const provider30 = makeConstantProvider(1000)
    const r15 = preparePlaceLabels(places, political, provider15, 1.5, PREP_CONFIG)
    const r30 = preparePlaceLabels(places, political, provider30, 3.0, PREP_CONFIG)
    // 同一常数 1000m 经 16 位编解码为同一解码米值 h，故两 provider 的 h 相等；k 差异体现在 h·k。
    const h15 = provider15.queryAtWorld(r15.provinceLabels[0].position[0], r15.provinceLabels[0].position[2])
    const h30 = provider30.queryAtWorld(r30.provinceLabels[0].position[0], r30.provinceLabels[0].position[2])
    expect(h15.ok && h30.ok).toBe(true)
    expect(h15.meters).toBeCloseTo(h30.meters, 5)
    expect(r15.provinceLabels[0].position[1]).toBeCloseTo(h15.meters * 1.5 + offset, 4)
    expect(r30.provinceLabels[0].position[1]).toBeCloseTo(h30.meters * 3.0 + offset, 4)
    expect(r15.capitalPoints[0].position[1]).toBeCloseTo(h15.meters * 1.5 + epsilon, 4)
    expect(r30.capitalPoints[0].position[1]).toBeCloseTo(h30.meters * 3.0 + epsilon, 4)
    // k=3 的标签 y 明显高于 k=1.5（随 k 增大）。
    expect(r30.provinceLabels[0].position[1]).toBeGreaterThan(r15.provinceLabels[0].position[1])
  })
})

describe('collectAllLabelDomainStrings：字体覆盖的领域字符串确定性提取', () => {
  it('提取省名 + 省会名 + 岛礁名，无遗漏', () => {
    const places = loadProductionPlaces()
    const political = loadProductionPolitical()
    const strings = collectAllLabelDomainStrings(places, political)
    // 68 条地点名（34 省 × 2 角色）+ 5 岛礁名 = 73。
    expect(strings.length).toBe(68 + 5)
    expect(strings).toContain('北京')
    expect(strings).toContain('台北')
    expect(strings).toContain('钓鱼岛')
    expect(strings).toContain('曾母暗沙')
  })
})

describe('异常 / 缺项路径：阻断准备，不静默显示残缺标签（TASK-016 验证方式 2）', () => {
  it('exaggeration 非有限 → exaggeration-not-finite', () => {
    const places = loadProductionPlaces()
    const political = loadProductionPolitical()
    try {
      preparePlaceLabels(places, political, makeConstantProvider(1000), Number.NaN, PREP_CONFIG)
      expect.unreachable('NaN 夸张系数应被拒绝')
    } catch (e) {
      expect((e as PlaceLabelPrepError).code).toBe('place-labels.exaggeration-not-finite')
    }
  })

  it('epsilon 非有限 → epsilon-not-finite', () => {
    const places = loadProductionPlaces()
    const political = loadProductionPolitical()
    try {
      preparePlaceLabels(places, political, makeConstantProvider(1000), 2, {
        ...PREP_CONFIG,
        terrainEpsilonMeters: Number.NaN,
      })
      expect.unreachable('NaN epsilon 应被拒绝')
    } catch (e) {
      expect((e as PlaceLabelPrepError).code).toBe('place-labels.epsilon-not-finite')
    }
  })

  it('地点 entries 为空 → empty-places', () => {
    const empty = { ...loadProductionPlaces(), entries: [] }
    const political = loadProductionPolitical()
    try {
      preparePlaceLabels(empty, political, makeConstantProvider(1000), 2, PREP_CONFIG)
      expect.unreachable('空地点应被拒绝')
    } catch (e) {
      expect((e as PlaceLabelPrepError).code).toBe('place-labels.empty-places')
    }
  })

  it('角色-配对失衡（删除某省会）→ role-pair-imbalance', () => {
    const tampered = { ...loadProductionPlaces() }
    tampered.entries = tampered.entries.filter(
      (e) => !(e.adminId === 'CN-440000' && e.role === 'administrativeCapital'),
    )
    const political = loadProductionPolitical()
    try {
      preparePlaceLabels(tampered, political, makeConstantProvider(1000), 2, PREP_CONFIG)
      expect.unreachable('角色失衡应被拒绝')
    } catch (e) {
      expect((e as PlaceLabelPrepError).code).toBe('place-labels.role-pair-imbalance')
    }
  })

  it('删除点名岛礁（钓鱼岛）→ required-island-missing', () => {
    const places = loadProductionPlaces()
    const tampered = { ...loadProductionPolitical() }
    tampered.features = tampered.features.filter(
      (f) => !(f.type === 'islandOrReefPoint' && f.name === '钓鱼岛'),
    )
    try {
      preparePlaceLabels(places, tampered, makeConstantProvider(1000), 2, PREP_CONFIG)
      expect.unreachable('缺钓鱼岛应被拒绝')
    } catch (e) {
      expect((e as PlaceLabelPrepError).code).toBe('place-labels.required-island-missing')
      expect((e as Error).message).toContain('钓鱼岛')
    }
  })

  it('删除台湾省名锚点 → role-pair-imbalance（港澳台不缺失在结构层把关）', () => {
    const tampered = { ...loadProductionPlaces() }
    tampered.entries = tampered.entries.filter(
      (e) => !(e.adminId === 'CN-710000' && e.role === 'provinceNameAnchor'),
    )
    const political = loadProductionPolitical()
    try {
      preparePlaceLabels(tampered, political, makeConstantProvider(1000), 2, PREP_CONFIG)
      expect.unreachable('删台湾锚点应被拒绝')
    } catch (e) {
      expect((e as PlaceLabelPrepError).code).toBe('place-labels.role-pair-imbalance')
    }
  })
})
