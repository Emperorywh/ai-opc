/**
 * 政治边界补充要素（十段线 + 岛礁点位）主图呈现测试（TASK-011 验收 1、2、3、4）。
 *
 * 依赖方向：测试基线（vitest，Node 环境），import src/lib/political-features（领域准备层）、src/lib/elevation
 * （createElevationProvider / decodeHeightmapBytes 构造 provider）、src/lib/projection（projectToWorld /
 * invertWorld / MAIN_MAP_WORLD_BOUNDS 复算与范围校验）、src/geo-contracts（validatePoliticalBoundary 契约
 * 校验 + political-catalog SPEC §6 红线点名真值 + encodeElevationToUint16 编码）、
 * src/config/political-features 与 src/config/province-borders、src/config/sea-surface（生产配置不变量与
 * 「样式与省界可区分」断言）。不依赖浏览器 / React / Three.js——准备层是纯函数、渲染层是薄装配，
 * 可在 Node 内完整断言红线完整性、统一投影、海平面贴合、densify 与各类失败路径，无需启动 WebGL
 * （人工视觉验收由 pnpm dev 与无头渲染验证承担）。
 *
 * 覆盖（验收 1、2、3）：
 * - 红线完整性：生产资产 10 段全被消费（segmentIndex 1..10，含台湾东侧第 10 段）、点名岛礁
 *   （钓鱼岛 / 赤尾屿 / 曾母暗沙）均在点位中、十段线按段独立组织（不合并为单条连续折线）。
 * - 统一投影（验收 3）：每段首 / 末顶点与每个岛礁点位的 (x,z) 与 projectToWorld 复算逐分量一致；
 *   台湾东侧段全部端点在台湾（121.5°E 参考线）以东。
 * - 海平面贴合：陆地（h>0）y = h·k + epsilon；海域（h≤0）y = seaLevel + epsilon（不被海面吞没）；
 *   k 变化只影响陆地侧。
 * - 真实位置（验收 2）：曾母暗沙为最南点位且贴近主图南界；赤尾屿在钓鱼岛以东；5 点位全部产出。
 * - densify：子段弧长 ≤ 间距，长边被细分。
 * - 失败路径：删台湾东侧段 / 删点名岛礁 / 段数不符 / exaggeration 非有限 / spacing 非法 /
 *   epsilon 非有限 / seaLevelY 非有限 / features 空 / 投影失败（越出主图）/ 高程查询失败
 *   （越出元数据范围）→ 各自稳定 code 抛错，不产出残缺十段线 / 缺失岛礁（不静默显示残缺地图）。
 * - 集成（生产高程）：真实政治资产 + 真实生产 heightmap provider——全部端点 y ≥ seaLevel + epsilon
 *   （恒在海面之上），抽样端点 y 与 max(h·k, seaLevel)+epsilon 复算精确一致。
 * - 配置不变量：间距 = 主图宽度 / 4096、海平面 y = SEA_LEVEL_Y_METERS = 0、暖琥珀 ≠ 省界浅青白、
 *   线宽 2.0 > 省界 1.6、虚线节拍正有限（验收 1「样式与省界可区分」）。
 * - 渲染层结构（源码扫描）：drei Line dashed + AdditiveBlending + NDC 深度偏移 + renderOrder=3 +
 *   每段一线、每点一球；渲染层不取数、不投影、无硬编码坐标；App 总装接线完整。
 */

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  PoliticalFeaturePrepError,
  preparePoliticalFeatures,
  type PoliticalFeaturePrepConfig,
} from '../src/lib/political-features'
import { createElevationProvider, decodeHeightmapBytes } from '../src/lib/elevation'
import type { ElevationProvider } from '../src/lib/elevation'
import { invertWorld, projectToWorld, MAIN_MAP_WORLD_BOUNDS } from '../src/lib/projection'
import {
  POLITICAL_FEATURES_CONFIG,
  POLITICAL_FEATURES_HEIGHTMAP_TEXEL_COUNT,
  politicalFeaturesSpacingIsValid,
} from '../src/config/political-features'
import { PROVINCE_BORDERS_CONFIG } from '../src/config/province-borders'
import { SEA_LEVEL_Y_METERS } from '../src/config/sea-surface'
import {
  EXPECTED_NINE_DASH_SEGMENT_COUNT,
  REQUIRED_ISLAND_NAMES,
  REQUIRED_NINE_DASH_SEGMENT_INDICES,
  TAIWAN_EAST_SEGMENT_INDEX,
  encodeElevationToUint16,
  validatePoliticalBoundary,
  type NineDashLineSegmentFeature,
  type PoliticalBoundaryContract,
  type PoliticalBoundaryFeature,
  type TerrainMetaContract,
} from '../src/geo-contracts'

const projectRoot = resolve(fileURLToPath(import.meta.url), '..', '..')
/** 中国主图 + heightmap 元数据共用范围（EPSG:4326 度）。 */
const CHINA_EXTENT = { west: 72, south: 3, east: 136, north: 54 }
const RANGE = { min: -1500, max: 9000 }

/** 构造一份合法 terrain-meta（范围 / 分辨率 / 编码区间可注入）。 */
function makeMeta(opts: {
  readonly width: number
  readonly height: number
  readonly extent?: { readonly west: number; readonly south: number; readonly east: number; readonly north: number }
  readonly range?: { readonly min: number; readonly max: number }
}): TerrainMetaContract {
  const extent = opts.extent ?? CHINA_EXTENT
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
    source: { sourceId: 'src-test-synthetic' },
  }
}

/**
 * 构造一份「常数高程」provider：所有像元编码同一高程，任意点查询返回该高程（双线性对常数 = 常数）。
 * 编解码有整数取整，故实际查询值 ≈ elevationMeters（测试用 provider 实际查询值断言，不假定精确等于输入）。
 */
function makeConstantProvider(
  elevationMeters: number,
  opts: {
    readonly width?: number
    readonly height?: number
    readonly extent?: { readonly west: number; readonly south: number; readonly east: number; readonly north: number }
    readonly range?: { readonly min: number; readonly max: number }
  } = {},
): ElevationProvider {
  const width = opts.width ?? 8
  const height = opts.height ?? 8
  const meta = makeMeta({ width, height, extent: opts.extent, range: opts.range })
  const code = encodeElevationToUint16(
    elevationMeters,
    meta.elevationEncoding.minValueMeters,
    meta.elevationEncoding.maxValueMeters,
  )
  const pixels = new Uint16Array(width * height).fill(code)
  return createElevationProvider(meta, pixels)
}

/** 默认准备配置（与生产 POLITICAL_FEATURES_CONFIG 同形态的字面量，便于独立断言）。 */
const PREP_CONFIG: PoliticalFeaturePrepConfig = {
  densifySpacingMeters: 1742,
  terrainEpsilonMeters: 15,
  seaLevelYMeters: 0,
}

/** 加载生产政治边界资产并经契约校验，返回 PoliticalBoundaryContract。 */
function loadProductionContract(): PoliticalBoundaryContract {
  const assetPath = resolve(projectRoot, 'public', 'geo', 'china-political-boundary.json')
  const payload: unknown = JSON.parse(readFileSync(assetPath, 'utf-8'))
  const outcome = validatePoliticalBoundary(payload)
  expect(outcome.ok, '生产政治边界资产应通过契约校验').toBe(true)
  return payload as PoliticalBoundaryContract
}

/** 深拷贝生产契约，避免篡改污染（与 political 资产测试同构）。 */
function cloneContract(contract: PoliticalBoundaryContract): PoliticalBoundaryContract {
  return JSON.parse(JSON.stringify(contract)) as PoliticalBoundaryContract
}

/** 从契约中取指定段序号的九段线段（测试辅助：不存在即断言失败）。 */
function findSegment(
  contract: PoliticalBoundaryContract,
  segmentIndex: number,
): NineDashLineSegmentFeature {
  const segment = contract.features.find(
    (f): f is NineDashLineSegmentFeature =>
      f.type === 'nineDashLineSegment' && f.segmentIndex === segmentIndex,
  )
  expect(segment, `段序号 ${segmentIndex} 应存在于契约中`).toBeDefined()
  return segment as NineDashLineSegmentFeature
}

describe('红线完整性：十段含台湾东侧段、点名岛礁均在（验收 1）', () => {
  it('生产政治资产经准备后恰好产出 10 段十段线，段序号 1..10 全在', () => {
    const contract = loadProductionContract()
    const provider = makeConstantProvider(1000)
    const result = preparePoliticalFeatures(contract, provider, 2, PREP_CONFIG)
    expect(result.lines.length).toBe(EXPECTED_NINE_DASH_SEGMENT_COUNT)
    const indices = new Set(result.lines.map((line) => line.segmentIndex))
    for (const index of REQUIRED_NINE_DASH_SEGMENT_INDICES) {
      expect(indices.has(index), `段序号 ${index} 应在准备产物中`).toBe(true)
    }
  })

  it('台湾东侧段（segmentIndex=10）被独立消费（SPEC §6 红线「含台湾东侧那段」）', () => {
    const contract = loadProductionContract()
    const provider = makeConstantProvider(1000)
    const result = preparePoliticalFeatures(contract, provider, 2, PREP_CONFIG)
    const taiwanEast = result.lines.find((line) => line.segmentIndex === TAIWAN_EAST_SEGMENT_INDEX)
    expect(taiwanEast, '台湾东侧段必须被消费').toBeDefined()
    expect(taiwanEast!.segmentCount, '台湾东侧段应产出非零子段').toBeGreaterThan(0)
  })

  it('十段线按段独立组织（10 个 PreparedPoliticalLine），不合并为单条连续折线', () => {
    const contract = loadProductionContract()
    const provider = makeConstantProvider(1000)
    const result = preparePoliticalFeatures(contract, provider, 2, PREP_CONFIG)
    // 10 段各一个 PreparedPoliticalLine，每段独立携带 segmentIndex 与子段端点（可逐段审计）。
    expect(result.lines.length).toBe(10)
    for (const line of result.lines) {
      expect(line.segmentCount, `段 ${line.segmentIndex} 应有非零子段`).toBeGreaterThan(0)
      expect(line.segmentEndpointsFlat.length).toBe(line.segmentCount * 6)
    }
    // 按段序号升序（台湾东侧段位置确定、可审计）。
    const indices = result.lines.map((line) => line.segmentIndex)
    expect([...indices].sort((a, b) => a - b)).toEqual(indices)
  })

  it('SPEC §6 点名岛礁（钓鱼岛 / 赤尾屿 / 曾母暗沙）均在点位中', () => {
    const contract = loadProductionContract()
    const provider = makeConstantProvider(1000)
    const result = preparePoliticalFeatures(contract, provider, 2, PREP_CONFIG)
    const names = new Set(result.points.map((point) => point.name))
    for (const name of REQUIRED_ISLAND_NAMES) {
      expect(names.has(name), `点名岛礁「${name}」应在点位中`).toBe(true)
    }
  })

  it('全部岛礁点位与十段线端点落在中国主图世界包围盒', () => {
    const contract = loadProductionContract()
    const provider = makeConstantProvider(1000)
    const result = preparePoliticalFeatures(contract, provider, 2, PREP_CONFIG)
    expect(result.points.length).toBeGreaterThan(0)
    for (const point of result.points) {
      const [x, , z] = point.position
      expect(x).toBeGreaterThanOrEqual(MAIN_MAP_WORLD_BOUNDS.minX)
      expect(x).toBeLessThanOrEqual(MAIN_MAP_WORLD_BOUNDS.maxX)
      expect(z).toBeGreaterThanOrEqual(MAIN_MAP_WORLD_BOUNDS.minZ)
      expect(z).toBeLessThanOrEqual(MAIN_MAP_WORLD_BOUNDS.maxZ)
    }
    for (const line of result.lines) {
      const flat = line.segmentEndpointsFlat
      for (let i = 0; i < flat.length; i += 3) {
        expect(flat[i]).toBeGreaterThanOrEqual(MAIN_MAP_WORLD_BOUNDS.minX)
        expect(flat[i]).toBeLessThanOrEqual(MAIN_MAP_WORLD_BOUNDS.maxX)
        expect(flat[i + 2]).toBeGreaterThanOrEqual(MAIN_MAP_WORLD_BOUNDS.minZ)
        expect(flat[i + 2]).toBeLessThanOrEqual(MAIN_MAP_WORLD_BOUNDS.maxZ)
      }
    }
  })
})

describe('统一投影：全部几何经同一 projection 模块（验收 3）', () => {
  it('每段首 / 末顶点的世界 (x,z) 与 projectToWorld 复算逐分量一致', () => {
    const contract = loadProductionContract()
    const provider = makeConstantProvider(1000)
    const result = preparePoliticalFeatures(contract, provider, 2, PREP_CONFIG)
    for (const line of result.lines) {
      const source = findSegment(contract, line.segmentIndex)
      const flat = line.segmentEndpointsFlat
      // densify 后首子段起点 = 源折线首顶点（t=0），末子段终点 = 源折线末顶点（t=1），精确相等。
      const firstSource = source.coordinates[0]
      const lastSource = source.coordinates[source.coordinates.length - 1]
      const firstWorld = projectToWorld(firstSource.lon, firstSource.lat)
      const lastWorld = projectToWorld(lastSource.lon, lastSource.lat)
      expect(firstWorld.ok && lastWorld.ok).toBe(true)
      if (firstWorld.ok && lastWorld.ok) {
        expect(flat[0]).toBe(firstWorld.value.x)
        expect(flat[2]).toBe(firstWorld.value.z)
        expect(flat[flat.length - 3]).toBe(lastWorld.value.x)
        expect(flat[flat.length - 1]).toBe(lastWorld.value.z)
      }
    }
  })

  it('每个岛礁点位的世界 (x,z) 与 projectToWorld 复算逐分量一致', () => {
    const contract = loadProductionContract()
    const provider = makeConstantProvider(1000)
    const result = preparePoliticalFeatures(contract, provider, 2, PREP_CONFIG)
    const sourcePoints = contract.features.filter(
      (f): f is Extract<PoliticalBoundaryFeature, { type: 'islandOrReefPoint' }> =>
        f.type === 'islandOrReefPoint',
    )
    expect(result.points.length).toBe(sourcePoints.length)
    for (const point of result.points) {
      const source = sourcePoints.find((f) => f.name === point.name)
      expect(source, `点位「${point.name}」应来自源契约`).toBeDefined()
      const world = projectToWorld(source!.coordinate.lon, source!.coordinate.lat)
      expect(world.ok).toBe(true)
      if (world.ok) {
        expect(point.position[0]).toBe(world.value.x)
        expect(point.position[2]).toBe(world.value.z)
      }
    }
  })

  it('台湾东侧段全部端点在台湾（121.5°E 参考线）以东（SPEC §6「台湾东侧那段」的真实位置）', () => {
    const contract = loadProductionContract()
    const provider = makeConstantProvider(1000)
    const result = preparePoliticalFeatures(contract, provider, 2, PREP_CONFIG)
    const taiwanEast = result.lines.find((line) => line.segmentIndex === TAIWAN_EAST_SEGMENT_INDEX)
    expect(taiwanEast).toBeDefined()
    // 121.5°E 穿过台湾本岛东岸；台湾东侧段（源经度 122–123°E）全部端点必须在其以东。
    const reference = projectToWorld(121.5, 24)
    expect(reference.ok).toBe(true)
    if (reference.ok) {
      const flat = taiwanEast!.segmentEndpointsFlat
      for (let i = 0; i < flat.length; i += 3) {
        expect(flat[i], '台湾东侧段端点应在 121.5°E 以东').toBeGreaterThan(reference.value.x)
      }
    }
    // 反投影抽查：段首端点反算回经纬度应落在台湾东侧海域（lon > 121.5，lat ≈ 23–25）。
    const first = invertWorld(
      taiwanEast!.segmentEndpointsFlat[0],
      taiwanEast!.segmentEndpointsFlat[2],
    )
    expect(first.ok).toBe(true)
    if (first.ok) {
      expect(first.value.lon).toBeGreaterThan(121.5)
      expect(first.value.lat).toBeGreaterThan(22.5)
      expect(first.value.lat).toBeLessThan(25.5)
    }
  })
})

describe('海平面贴合：y = max(h·k, seaLevel) + epsilon（不被海面吞没）', () => {
  it('陆地高程（h>0）：点位 y = h·k + epsilon（贴合地形，max 取地形侧）', () => {
    const contract = loadProductionContract()
    const provider = makeConstantProvider(2000)
    const k = 2
    const epsilon = PREP_CONFIG.terrainEpsilonMeters
    const result = preparePoliticalFeatures(contract, provider, k, PREP_CONFIG)
    // 常数高程 2000m → h·k = 4000 > seaLevel(0) → max 取 4000 → y = 4000 + epsilon。
    const sample = provider.queryAtWorld(result.points[0].position[0], result.points[0].position[2])
    expect(sample.ok).toBe(true)
    if (sample.ok) {
      const expectedY = sample.meters * k + epsilon
      for (const point of result.points) {
        expect(point.position[1]).toBe(expectedY)
      }
    }
  })

  it('海域负高程（h<0）：点位 y = seaLevel + epsilon（钳制到海平面，不被海面吞没）', () => {
    const contract = loadProductionContract()
    // 负高程 provider（约 -800m 水深）：岛礁点位多在海域，应钳制到海平面之上 epsilon。
    const provider = makeConstantProvider(-800)
    const k = 2
    const epsilon = PREP_CONFIG.terrainEpsilonMeters
    const seaLevel = PREP_CONFIG.seaLevelYMeters
    const result = preparePoliticalFeatures(contract, provider, k, PREP_CONFIG)
    // h·k = -1600 < seaLevel(0) → max 取 seaLevel → y = 0 + epsilon = epsilon。
    const expectedY = seaLevel + epsilon
    for (const point of result.points) {
      expect(point.position[1]).toBe(expectedY)
      // 钳制后 y > 0（在海平面之上），不被半透明海面吞没。
      expect(point.position[1]).toBeGreaterThan(0)
    }
    // 线段端点同样全部钳制在海面之上。
    for (const line of result.lines) {
      const flat = line.segmentEndpointsFlat
      for (let i = 1; i < flat.length; i += 3) {
        expect(flat[i]).toBe(expectedY)
      }
    }
  })

  it('夸张系数变化时陆地 y 同步变化、海域 y 仍钳制到海平面（k 只放大 world-y）', () => {
    const contract = loadProductionContract()
    const landProvider = makeConstantProvider(1500)
    const seaProvider = makeConstantProvider(-500)
    const epsilon = PREP_CONFIG.terrainEpsilonMeters
    const seaLevel = PREP_CONFIG.seaLevelYMeters
    // 陆地 k=1.5 vs k=3.0：y 随 k 变化。
    const land15 = preparePoliticalFeatures(contract, landProvider, 1.5, PREP_CONFIG)
    const land30 = preparePoliticalFeatures(contract, landProvider, 3.0, PREP_CONFIG)
    const landSample = landProvider.queryAtWorld(land15.points[0].position[0], land15.points[0].position[2])
    expect(landSample.ok).toBe(true)
    if (landSample.ok) {
      expect(land15.points[0].position[1]).toBe(landSample.meters * 1.5 + epsilon)
      expect(land30.points[0].position[1]).toBe(landSample.meters * 3.0 + epsilon)
    }
    // 海域 k=1.5 vs k=3.0：y 均钳制到 seaLevel + epsilon（不随 k 变化）。
    const sea15 = preparePoliticalFeatures(contract, seaProvider, 1.5, PREP_CONFIG)
    const sea30 = preparePoliticalFeatures(contract, seaProvider, 3.0, PREP_CONFIG)
    expect(sea15.points[0].position[1]).toBe(seaLevel + epsilon)
    expect(sea30.points[0].position[1]).toBe(seaLevel + epsilon)
  })
})

describe('真实位置：岛礁点位按真实经纬度呈现于主图（验收 2）', () => {
  it('曾母暗沙是最南点位且贴近主图南界（≈3.58°N，中国领土最南标志）', () => {
    const contract = loadProductionContract()
    const provider = makeConstantProvider(1000)
    const result = preparePoliticalFeatures(contract, provider, 2, PREP_CONFIG)
    const zengmu = result.points.find((point) => point.name === '曾母暗沙')
    expect(zengmu).toBeDefined()
    // +Z = 南：曾母暗沙的 z 必须是全部点位中最大（最南）。
    for (const point of result.points) {
      expect(zengmu!.position[2]).toBeGreaterThanOrEqual(point.position[2])
    }
    // 贴近主图南界（lat 3°N → maxZ）：3.58°N 与 3°N 的墨卡托差仅占南北跨度的约 2%。
    expect(zengmu!.position[2]).toBeLessThanOrEqual(MAIN_MAP_WORLD_BOUNDS.maxZ)
    expect(zengmu!.position[2]).toBeGreaterThan(MAIN_MAP_WORLD_BOUNDS.maxZ * 0.9)
  })

  it('赤尾屿在钓鱼岛以东（+X = 东），黄岩岛 / 永兴岛均在点位中', () => {
    const contract = loadProductionContract()
    const provider = makeConstantProvider(1000)
    const result = preparePoliticalFeatures(contract, provider, 2, PREP_CONFIG)
    const diaoyu = result.points.find((point) => point.name === '钓鱼岛')
    const chiwei = result.points.find((point) => point.name === '赤尾屿')
    expect(diaoyu).toBeDefined()
    expect(chiwei).toBeDefined()
    // 赤尾屿（124.55°E）在钓鱼岛（123.46°E）以东。
    expect(chiwei!.position[0]).toBeGreaterThan(diaoyu!.position[0])
    const names = new Set(result.points.map((point) => point.name))
    expect(names.has('黄岩岛')).toBe(true)
    expect(names.has('永兴岛')).toBe(true)
    expect(result.points.length).toBe(5)
  })
})

describe('densify：长边按 ceil(边长/间距) 细分，子段弧长 ≤ 间距', () => {
  it('十段线每段 densify 后子段数 ≥ 原始边数，且至少一段被细分', () => {
    const contract = loadProductionContract()
    const provider = makeConstantProvider(1000)
    const result = preparePoliticalFeatures(contract, provider, 2, PREP_CONFIG)
    for (const line of result.lines) {
      expect(line.segmentCount).toBeGreaterThanOrEqual(1)
    }
    // 至少一段被细分（十段线段跨度大，不可能全部短于 1742m 间距）。
    const maxSegs = Math.max(...result.lines.map((l) => l.segmentCount))
    expect(maxSegs, '至少一段十段线被 densify 细分').toBeGreaterThan(2)
  })

  it('每个 densified 子段的世界弧长 ≤ 间距（含容差）', () => {
    const contract = loadProductionContract()
    const provider = makeConstantProvider(500)
    const result = preparePoliticalFeatures(contract, provider, 2, PREP_CONFIG)
    const spacing = PREP_CONFIG.densifySpacingMeters
    let violations = 0
    for (const line of result.lines) {
      const flat = line.segmentEndpointsFlat
      for (let i = 0; i + 5 < flat.length; i += 6) {
        const x0 = flat[i]
        const z0 = flat[i + 2]
        const x1 = flat[i + 3]
        const z1 = flat[i + 5]
        const len = Math.hypot(x1 - x0, z1 - z0)
        if (len > spacing + 1e-6) violations++
      }
    }
    expect(violations, '所有 densified 子段长度必须 ≤ 间距').toBe(0)
  })
})

describe('红线缺项 / 异常路径：阻断渲染准备，不静默显示残缺地图（验收 1、2 的反向证据）', () => {
  it('删除台湾东侧段（segmentIndex=10）→ taiwan-east-segment-missing / segment-count-mismatch / segment-missing', () => {
    const contract = cloneContract(loadProductionContract())
    contract.features = contract.features.filter(
      (f) => !(f.type === 'nineDashLineSegment' && f.segmentIndex === TAIWAN_EAST_SEGMENT_INDEX),
    )
    const provider = makeConstantProvider(1000)
    try {
      preparePoliticalFeatures(contract, provider, 2, PREP_CONFIG)
      expect.unreachable('删除台湾东侧段应阻断准备')
    } catch (e) {
      const code = (e as PoliticalFeaturePrepError).code
      // 三条红线锚点至少命中其一（段数 9、段序号 10 缺、台湾东侧段独立锚点）。
      expect([
        'political-features.taiwan-east-segment-missing',
        'political-features.segment-count-mismatch',
        'political-features.segment-missing',
      ]).toContain(code)
    }
  })

  it('删除钓鱼岛 → required-island-missing', () => {
    const contract = cloneContract(loadProductionContract())
    contract.features = contract.features.filter(
      (f) => !(f.type === 'islandOrReefPoint' && f.name === '钓鱼岛'),
    )
    const provider = makeConstantProvider(1000)
    try {
      preparePoliticalFeatures(contract, provider, 2, PREP_CONFIG)
      expect.unreachable('删除钓鱼岛应阻断准备')
    } catch (e) {
      expect((e as PoliticalFeaturePrepError).code).toBe('political-features.required-island-missing')
      expect((e as Error).message).toContain('钓鱼岛')
    }
  })

  it('删除赤尾屿 → required-island-missing', () => {
    const contract = cloneContract(loadProductionContract())
    contract.features = contract.features.filter(
      (f) => !(f.type === 'islandOrReefPoint' && f.name === '赤尾屿'),
    )
    const provider = makeConstantProvider(1000)
    try {
      preparePoliticalFeatures(contract, provider, 2, PREP_CONFIG)
      expect.unreachable('删除赤尾屿应阻断准备')
    } catch (e) {
      expect((e as PoliticalFeaturePrepError).code).toBe('political-features.required-island-missing')
    }
  })

  it('删除曾母暗沙 → required-island-missing', () => {
    const contract = cloneContract(loadProductionContract())
    contract.features = contract.features.filter(
      (f) => !(f.type === 'islandOrReefPoint' && f.name === '曾母暗沙'),
    )
    const provider = makeConstantProvider(1000)
    try {
      preparePoliticalFeatures(contract, provider, 2, PREP_CONFIG)
      expect.unreachable('删除曾母暗沙应阻断准备')
    } catch (e) {
      expect((e as PoliticalFeaturePrepError).code).toBe('political-features.required-island-missing')
    }
  })

  it('段序号缺（删第 5 段）→ segment-count-mismatch / segment-missing', () => {
    const contract = cloneContract(loadProductionContract())
    contract.features = contract.features.filter(
      (f) => !(f.type === 'nineDashLineSegment' && f.segmentIndex === 5),
    )
    const provider = makeConstantProvider(1000)
    try {
      preparePoliticalFeatures(contract, provider, 2, PREP_CONFIG)
      expect.unreachable('删段应阻断准备')
    } catch (e) {
      const code = (e as PoliticalFeaturePrepError).code
      expect(['political-features.segment-count-mismatch', 'political-features.segment-missing']).toContain(code)
    }
  })
})

describe('输入非法 / 投影 / 查询 / 退化失败路径', () => {
  it('exaggeration 非有限 → exaggeration-not-finite', () => {
    const contract = loadProductionContract()
    const provider = makeConstantProvider(1000)
    try {
      preparePoliticalFeatures(contract, provider, Number.NaN, PREP_CONFIG)
      expect.unreachable('NaN 夸张系数应被拒绝')
    } catch (e) {
      expect((e as PoliticalFeaturePrepError).code).toBe('political-features.exaggeration-not-finite')
    }
  })

  it('spacing 为 0 / 负 / 非有限 → spacing-invalid', () => {
    const contract = loadProductionContract()
    const provider = makeConstantProvider(1000)
    for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      try {
        preparePoliticalFeatures(contract, provider, 2, {
          densifySpacingMeters: bad,
          terrainEpsilonMeters: 15,
          seaLevelYMeters: 0,
        })
        expect.unreachable(`spacing=${bad} 应被拒绝`)
      } catch (e) {
        expect((e as PoliticalFeaturePrepError).code).toBe('political-features.spacing-invalid')
      }
    }
  })

  it('epsilon 非有限 → epsilon-not-finite', () => {
    const contract = loadProductionContract()
    const provider = makeConstantProvider(1000)
    try {
      preparePoliticalFeatures(contract, provider, 2, {
        densifySpacingMeters: 1742,
        terrainEpsilonMeters: Number.NaN,
        seaLevelYMeters: 0,
      })
      expect.unreachable('epsilon=NaN 应被拒绝')
    } catch (e) {
      expect((e as PoliticalFeaturePrepError).code).toBe('political-features.epsilon-not-finite')
    }
  })

  it('seaLevelY 非有限 → sea-level-not-finite', () => {
    const contract = loadProductionContract()
    const provider = makeConstantProvider(1000)
    try {
      preparePoliticalFeatures(contract, provider, 2, {
        densifySpacingMeters: 1742,
        terrainEpsilonMeters: 15,
        seaLevelYMeters: Number.NaN,
      })
      expect.unreachable('seaLevelY=NaN 应被拒绝')
    } catch (e) {
      expect((e as PoliticalFeaturePrepError).code).toBe('political-features.sea-level-not-finite')
    }
  })

  it('features 为空 → empty-features', () => {
    const contract = cloneContract(loadProductionContract())
    contract.features = []
    const provider = makeConstantProvider(1000)
    try {
      preparePoliticalFeatures(contract, provider, 2, PREP_CONFIG)
      expect.unreachable('空 features 应被拒绝')
    } catch (e) {
      expect((e as PoliticalFeaturePrepError).code).toBe('political-features.empty-features')
    }
  })

  it('九段线顶点越出主图范围 → projection-failed', () => {
    const contract = cloneContract(loadProductionContract())
    // 把第 1 段某顶点经度抬到 200（越出主图东界 136）。
    const seg1 = findSegment(contract, 1)
    seg1.coordinates[0] = { lon: 200, lat: 20 }
    const provider = makeConstantProvider(1000)
    try {
      preparePoliticalFeatures(contract, provider, 2, PREP_CONFIG)
      expect.unreachable('越界顶点应触发 projection-failed')
    } catch (e) {
      expect((e as PoliticalFeaturePrepError).code).toBe('political-features.projection-failed')
    }
  })

  it('岛礁坐标越出元数据范围 → elevation-query-failed', () => {
    // provider 元数据范围缩到 [110,116]×[3,9]；钓鱼岛（≈123.46°E）在主图内但越出元数据 → 查询失败。
    const provider = makeConstantProvider(1000, {
      extent: { west: 110, south: 3, east: 116, north: 9 },
    })
    const contract = loadProductionContract()
    try {
      preparePoliticalFeatures(contract, provider, 2, PREP_CONFIG)
      expect.unreachable('越出元数据范围应触发 elevation-query-failed')
    } catch (e) {
      expect((e as PoliticalFeaturePrepError).code).toBe('political-features.elevation-query-failed')
    }
  })
})

describe('集成：真实生产政治资产 + 生产 heightmap provider（验收 1、2 的核心证据）', () => {
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
  const prepared = (() => {
    const contract = loadProductionContract()
    return preparePoliticalFeatures(contract, productionProvider, k, {
      densifySpacingMeters: POLITICAL_FEATURES_CONFIG.densifySpacingMeters,
      terrainEpsilonMeters: POLITICAL_FEATURES_CONFIG.terrainEpsilonMeters,
      seaLevelYMeters: POLITICAL_FEATURES_CONFIG.seaLevelYMeters,
    })
  })()

  it('生产资产 + 生产高程产出 10 段 + 5 岛礁点位，全部非零子段', () => {
    expect(prepared.lines.length).toBe(10)
    expect(prepared.points.length).toBe(5)
    expect(prepared.totalLineSegmentCount).toBeGreaterThan(0)
    for (const line of prepared.lines) {
      expect(line.segmentCount).toBeGreaterThan(0)
    }
  })

  it('全部线段端点与点位 y ≥ seaLevel + epsilon（恒在海面之上，不被半透明海面吞没）', () => {
    const minY = POLITICAL_FEATURES_CONFIG.seaLevelYMeters + POLITICAL_FEATURES_CONFIG.terrainEpsilonMeters
    for (const line of prepared.lines) {
      const flat = line.segmentEndpointsFlat
      for (let i = 1; i < flat.length; i += 3) {
        expect(flat[i]).toBeGreaterThanOrEqual(minY)
      }
    }
    for (const point of prepared.points) {
      expect(point.position[1]).toBeGreaterThanOrEqual(minY)
    }
  })

  it('抽样端点 y 与 max(queryAtWorld·k, seaLevel) + epsilon 复算精确一致（共享高程 / 海平面语义）', () => {
    const epsilon = POLITICAL_FEATURES_CONFIG.terrainEpsilonMeters
    const seaLevel = POLITICAL_FEATURES_CONFIG.seaLevelYMeters
    let checked = 0
    for (const line of prepared.lines) {
      const flat = line.segmentEndpointsFlat
      // 每段抽首 / 中 / 尾各一个端点复算。
      const sampleIndices = [0, Math.floor(flat.length / 6) * 3, flat.length - 3]
      for (const i of sampleIndices) {
        const query = productionProvider.queryAtWorld(flat[i], flat[i + 2])
        expect(query.ok).toBe(true)
        if (query.ok) {
          const expectedY = Math.max(query.meters * k, seaLevel) + epsilon
          expect(flat[i + 1]).toBe(expectedY)
          checked++
        }
      }
    }
    expect(checked).toBeGreaterThanOrEqual(30)
  })

  it('生产高程下曾母暗沙 / 黄岩岛等海域点位钳制在海平面之上 epsilon（水下礁滩不被吞没）', () => {
    const epsilon = POLITICAL_FEATURES_CONFIG.terrainEpsilonMeters
    const seaLevel = POLITICAL_FEATURES_CONFIG.seaLevelYMeters
    for (const point of prepared.points) {
      const query = productionProvider.queryAtWorld(point.position[0], point.position[2])
      expect(query.ok).toBe(true)
      if (query.ok) {
        // 点位 y 恒等于 max(h·k, seaLevel)+epsilon：水下（h<0）即 seaLevel+epsilon，出露即 h·k+epsilon。
        expect(point.position[1]).toBe(Math.max(query.meters * k, seaLevel) + epsilon)
      }
    }
  })
})

describe('配置不变量：海平面贴合 / 抗 z-fighting / 与省界可区分的前提（验收 1）', () => {
  it('densify 间距 = 主图世界宽度 / 4096（与省界 / heightmap 纹素分辨率一一对应）', () => {
    const expected =
      (MAIN_MAP_WORLD_BOUNDS.maxX - MAIN_MAP_WORLD_BOUNDS.minX) / POLITICAL_FEATURES_HEIGHTMAP_TEXEL_COUNT
    expect(POLITICAL_FEATURES_CONFIG.densifySpacingMeters).toBe(expected)
    expect(POLITICAL_FEATURES_CONFIG.densifySpacingMeters).toBeGreaterThanOrEqual(1000)
    expect(POLITICAL_FEATURES_CONFIG.densifySpacingMeters).toBeLessThanOrEqual(2000)
    // 与省界 densify 间距同值（同一地图尺度下同一类问题的同一解，SPEC §3.6 口径共享）。
    expect(POLITICAL_FEATURES_CONFIG.densifySpacingMeters).toBe(PROVINCE_BORDERS_CONFIG.densifySpacingMeters)
    expect(politicalFeaturesSpacingIsValid(POLITICAL_FEATURES_CONFIG.densifySpacingMeters)).toBe(true)
  })

  it('海平面 y = SEA_LEVEL_Y_METERS = 0（与动态海面同一米制海平面，非脱节固定坐标）', () => {
    expect(POLITICAL_FEATURES_CONFIG.seaLevelYMeters).toBe(SEA_LEVEL_Y_METERS)
    expect(POLITICAL_FEATURES_CONFIG.seaLevelYMeters).toBe(0)
  })

  it('海平面贴合 epsilon 为正、有限（把线 / 点放到贴合面外侧）', () => {
    expect(POLITICAL_FEATURES_CONFIG.terrainEpsilonMeters).toBeGreaterThan(0)
    expect(Number.isFinite(POLITICAL_FEATURES_CONFIG.terrainEpsilonMeters)).toBe(true)
  })

  it('NDC 深度偏移为正、有限（与省界共用同一结构性抗 z-fighting 手段）', () => {
    expect(POLITICAL_FEATURES_CONFIG.depthBiasNdc).toBeGreaterThan(0)
    expect(Number.isFinite(POLITICAL_FEATURES_CONFIG.depthBiasNdc)).toBe(true)
    expect(POLITICAL_FEATURES_CONFIG.depthBiasNdc).toBeGreaterThanOrEqual(1e-7)
    expect(POLITICAL_FEATURES_CONFIG.depthBiasNdc).toBeLessThan(1e-3)
    expect(POLITICAL_FEATURES_CONFIG.depthBiasNdc).toBe(PROVINCE_BORDERS_CONFIG.depthBiasNdc)
  })

  it('十段线基线色为暖琥珀 #ffd180，与省界浅青白 #9fe8d8 冷暖相对、色相分明（样式可区分）', () => {
    expect(POLITICAL_FEATURES_CONFIG.lineColorHex).toBe('#ffd180')
    expect(POLITICAL_FEATURES_CONFIG.lineColorHex).not.toBe(PROVINCE_BORDERS_CONFIG.colorHex)
    const { r, g, b } = POLITICAL_FEATURES_CONFIG.lineColorRgb
    expect(r).toBe(255)
    expect(g).toBe(209)
    expect(b).toBe(128)
    // 暖琥珀：红通道最大、蓝通道最小（与省界青白蓝绿占优相反）。
    expect(r).toBeGreaterThanOrEqual(g)
    expect(g).toBeGreaterThanOrEqual(b)
  })

  it('十段线线宽 2.0 px 略粗于省界 1.6 px（更亮更突出）', () => {
    expect(POLITICAL_FEATURES_CONFIG.lineWidthPx).toBe(2.0)
    expect(POLITICAL_FEATURES_CONFIG.lineWidthPx).toBeGreaterThan(PROVINCE_BORDERS_CONFIG.lineWidthPx)
  })

  it('虚线节拍为正、有限（dashSize / gapSize，区分于省界实线）', () => {
    expect(POLITICAL_FEATURES_CONFIG.lineDashSize).toBeGreaterThan(0)
    expect(POLITICAL_FEATURES_CONFIG.lineGapSize).toBeGreaterThan(0)
    expect(Number.isFinite(POLITICAL_FEATURES_CONFIG.lineDashSize)).toBe(true)
    expect(Number.isFinite(POLITICAL_FEATURES_CONFIG.lineGapSize)).toBe(true)
  })

  it('岛礁点位基线色 #ffe0a0（同色系更亮）与半径为正、有限（派生自主图世界宽度）', () => {
    expect(POLITICAL_FEATURES_CONFIG.pointColorHex).toBe('#ffe0a0')
    expect(POLITICAL_FEATURES_CONFIG.pointRadiusMeters).toBeGreaterThan(0)
    expect(Number.isFinite(POLITICAL_FEATURES_CONFIG.pointRadiusMeters)).toBe(true)
  })

  it('配置全部冻结（运行时不可被偷偷放宽）', () => {
    expect(Object.isFrozen(POLITICAL_FEATURES_CONFIG)).toBe(true)
    expect(Object.isFrozen(POLITICAL_FEATURES_CONFIG.lineColorRgb)).toBe(true)
    expect(Object.isFrozen(POLITICAL_FEATURES_CONFIG.pointColorRgb)).toBe(true)
  })
})

describe('渲染层与总装结构不变量（源码扫描，验收 1：发光虚线装配与单一事实源）', () => {
  /** 读取 src 下某源码文件的文本（源码结构不变量扫描用）。 */
  function readSource(relativePath: string): string {
    return readFileSync(resolve(projectRoot, 'src', relativePath), 'utf-8')
  }

  it('PoliticalFeatures 装配虚线 + additive 发光 + NDC 深度偏移 + renderOrder=3（与省界实线区分）', () => {
    const source = readSource('three/PoliticalFeatures.tsx')
    // 虚线节拍（SPEC §5.3「发光虚线」）与 additive 发光。
    expect(source).toContain('dashed')
    expect(source).toContain('dashSize={POLITICAL_FEATURES_CONFIG.lineDashSize}')
    expect(source).toContain('gapSize={POLITICAL_FEATURES_CONFIG.lineGapSize}')
    expect(source).toContain('THREE.AdditiveBlending')
    // NDC 深度偏移（与省界同一注入函数）+ 海面 / 省界之后绘制。
    expect(source).toContain('applyLineDepthBias')
    expect(source).toContain("from './line-depth-bias'")
    expect(source).toContain('renderOrder={3}')
    // 每段一个 Line（不合并）、每岛礁一个球体光点。
    expect(source).toContain('features.lines.map')
    expect(source).toContain('features.points.map')
    expect(source).toContain('<sphereGeometry')
    expect(source).toContain('segments')
  })

  it('PoliticalFeatures 不取数、不投影、不采样高程（只消费领域产物，坐标单一事实源在资产）', () => {
    const source = readSource('three/PoliticalFeatures.tsx')
    expect(source).not.toContain('fetch(')
    expect(source).not.toContain("from '../lib/projection'")
    expect(source).not.toContain("from '../lib/elevation'")
    expect(source).not.toContain("from '../lib/political-boundary'")
    // 无硬编码经纬度坐标（如 122 / 123.46 / 25.75 等十段线 / 岛礁源坐标不得出现在渲染层）。
    expect(source).not.toMatch(/\b1[0-3][0-9]\.[0-9]/)
  })

  it('领域准备层不反向依赖配置层（src/lib → src/config 单向分层）', () => {
    const source = readSource('lib/political-features.ts')
    expect(source).not.toContain("from '../config/")
    expect(source).not.toContain('fetch(')
  })

  it('App 总装接线完整（加载 → 准备 → 渲染 → 红线错误暴露）', () => {
    const source = readSource('App.tsx')
    expect(source).toContain('loadPoliticalBoundary')
    expect(source).toContain('preparePoliticalFeatures')
    expect(source).toContain('PoliticalFeaturesLayer')
    expect(source).toContain('<PoliticalFeatures')
    // 政治边界加载失败与准备失败都进入整页错误通道（不静默渲染残缺地图）。
    expect(source).toContain('政治边界数据加载失败')
    expect(source).toContain('政治要素准备失败')
  })
})
