/**
 * 省级贴地边界准备层测试（TASK-009 验收 1、4；SPEC §3.6）。
 *
 * 依赖方向：测试基线（vitest，Node 环境），import src/lib/province-borders（领域准备层）、src/lib/elevation
 * （createElevationProvider / decodeHeightmapBytes 构造 provider）、src/lib/projection（projectToWorld /
 * invertWorld 复算与校验）、src/config/province-borders（配置不变量）、src/geo-contracts
 * （encodeElevationToUint16 编码 + 几何类型 + 契约校验）。不依赖浏览器 / React / Three.js——准备层是
 * 纯函数，可在 Node 内完整断言 densify 间距、贴地 y = h·k+epsilon 不变量、多多边形 / 闭环 / 岛屿保留、
 * 负高程、与各类失败路径，无需启动 WebGL（人工视觉验收由 pnpm dev 承担）。
 *
 * 覆盖（验收 1、4）：
 * - densify 间距：长边按 ceil(边长/间距) 细分，每个子段长度 ≤ 间距；短边整段 1 子段。
 * - 贴地不变量：每个 densified 端点 y === provider.queryAtWorld(x,z).meters · k + epsilon（精确相等——
 *   准备层与测试走同一 queryAtWorld 路径、同一算术）。
 * - 负高程：浅水 / 低于海平面点 y = h·k + epsilon 仍成立（h 为负）。
 * - 多多边形 / 岛屿 / 内环：MultiPolygon 的多个 polygon 与 Polygon 的内环（洞）边界均完整产出。
 * - 闭环：环视为闭合，最后一条边从末顶点回到首顶点（接缝段存在）。
 * - 失败路径：exaggeration 非有限 / spacing 非法 / epsilon 非有限 / features 空 / 投影失败（越出主图）/
 *   高程查询失败（越出元数据范围）/ 全体退化（零线段）→ 各自稳定 code 抛错，不产出平地边界。
 * - 集成（合成高程）：真实 34 省资产 + 常数 provider 跑通，产出 34 个行政区边界、每个非零。
 * - 集成（生产高程）：真实 34 省资产 + 真实生产 heightmap provider——端点 y 随真实地形起伏（全省界
 *   y 极差达数公里，非平地），抽样端点 y 与 provider 复算精确一致，相邻子段共享端点逐分量相等
 *   （无缝隙）。
 */

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  ProvinceBorderPrepError,
  prepareProvinceBorders,
  type ProvinceBorderPrepConfig,
} from '../src/lib/province-borders'
import { createElevationProvider, decodeHeightmapBytes } from '../src/lib/elevation'
import type { ElevationProvider } from '../src/lib/elevation'
import { invertWorld, projectToWorld, MAIN_MAP_WORLD_BOUNDS } from '../src/lib/projection'
import {
  PROVINCE_BORDERS_CONFIG,
  PROVINCE_BORDER_HEIGHTMAP_TEXEL_COUNT,
  provinceBorderSpacingIsValid,
} from '../src/config/province-borders'
import {
  encodeElevationToUint16,
  validateAdministrativeGeometry,
  type AdministrativeGeometryFeature,
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

/** 构造一个三角形 Polygon feature（小到每边 < spacing，便于断言「短边整段 1 子段」与闭环）。 */
function makeTinyTriangleFeature(adminId: string): AdministrativeGeometryFeature {
  // 经纬度跨度极小（约 0.001°，世界 ~100 m），远小于 densify 间距 → 每边 1 子段。
  return {
    adminId,
    geometry: {
      type: 'Polygon',
      rings: [
        [
          { lon: 100.0, lat: 30.0 },
          { lon: 100.001, lat: 30.0 },
          { lon: 100.0005, lat: 30.001 },
        ],
      ],
    },
  }
}

/** 默认准备配置（与生产 PROVINCE_BORDERS_CONFIG 同形态的字面量，便于断言）。 */
const PREP_CONFIG: ProvinceBorderPrepConfig = {
  densifySpacingMeters: 1742,
  terrainEpsilonMeters: 15,
}

/** 加载真实 34 省行政区几何资产（已过 TASK-004 契约 + 深度校验）。 */
function loadProductionFeatures(): readonly AdministrativeGeometryFeature[] {
  const assetPath = resolve(projectRoot, 'public', 'geo', 'china-provinces-geometry.json')
  const payload: unknown = JSON.parse(readFileSync(assetPath, 'utf-8'))
  // 先确认资产通过 administrative-geometry 契约校验（与运行时 loadProvinceGeometry 同入口）。
  const outcome = validateAdministrativeGeometry(payload)
  expect(outcome.ok, '真实省界资产应通过契约校验').toBe(true)
  return (payload as { features: readonly AdministrativeGeometryFeature[] }).features
}

describe('densify 间距：长边按 ceil(边长/间距) 细分，子段长度 ≤ 间距（验收 1、4）', () => {
  it('长边被细分为多条子段（原始稀疏折线被补点，非整条直线跨地形）', () => {
    // 一个大正方形环：经纬度跨度 10°，每边世界弧长约 1000+ km，远大于 1742 m 间距 → 大量子段。
    const feature: AdministrativeGeometryFeature = {
      adminId: 'CN-test',
      geometry: {
        type: 'Polygon',
        rings: [
          [
            { lon: 100.0, lat: 25.0 },
            { lon: 110.0, lat: 25.0 },
            { lon: 110.0, lat: 35.0 },
            { lon: 100.0, lat: 35.0 },
          ],
        ],
      },
    }
    const provider = makeConstantProvider(1000)
    const result = prepareProvinceBorders([feature], provider, 2, PREP_CONFIG)
    // 原始 4 条边；densify 后子段数远大于 4（证明补点，非稀疏直线）。
    expect(result.borders[0].segmentCount).toBeGreaterThan(4)
    expect(result.totalSegmentCount).toBe(result.borders[0].segmentCount)
  })

  it('每个 densified 子段的世界弧长 ≤ 间距（含容差）', () => {
    const feature: AdministrativeGeometryFeature = {
      adminId: 'CN-test',
      geometry: {
        type: 'Polygon',
        rings: [
          [
            { lon: 100.0, lat: 25.0 },
            { lon: 108.0, lat: 25.0 },
            { lon: 108.0, lat: 33.0 },
            { lon: 100.0, lat: 33.0 },
          ],
        ],
      },
    }
    const provider = makeConstantProvider(500)
    const result = prepareProvinceBorders([feature], provider, 2, PREP_CONFIG)
    const flat = result.borders[0].segmentEndpointsFlat
    const spacing = PREP_CONFIG.densifySpacingMeters
    // 遍历每条子段（每 6 个数），断言其起终点世界弧长 ≤ 间距（+1e-6 浮点容差）。
    let violations = 0
    for (let i = 0; i + 5 < flat.length; i += 6) {
      const x0 = flat[i]
      const z0 = flat[i + 2]
      const x1 = flat[i + 3]
      const z1 = flat[i + 5]
      const len = Math.hypot(x1 - x0, z1 - z0)
      if (len > spacing + 1e-6) violations++
    }
    expect(violations, '所有 densified 子段长度必须 ≤ 间距').toBe(0)
  })

  it('短边（< 间距）整段为 1 子段，不细分', () => {
    // 极小三角形：每边 ~100 m << 1742 m 间距 → 每边 1 子段，3 边 → 3 子段。
    const provider = makeConstantProvider(1000)
    const result = prepareProvinceBorders([makeTinyTriangleFeature('CN-tiny')], provider, 2, PREP_CONFIG)
    expect(result.borders[0].segmentCount).toBe(3)
  })
})

describe('贴地不变量：y = queryAtWorld(x,z).meters · k + epsilon（精确相等，验收 1）', () => {
  it('常数高程 provider：所有 densified 端点 y === meters·k + epsilon', () => {
    const feature: AdministrativeGeometryFeature = {
      adminId: 'CN-test',
      geometry: {
        type: 'Polygon',
        rings: [
          [
            { lon: 100.0, lat: 25.0 },
            { lon: 110.0, lat: 25.0 },
            { lon: 110.0, lat: 35.0 },
            { lon: 100.0, lat: 35.0 },
          ],
        ],
      },
    }
    const provider = makeConstantProvider(1000)
    const k = 2
    const epsilon = PREP_CONFIG.terrainEpsilonMeters
    const result = prepareProvinceBorders([feature], provider, k, PREP_CONFIG)
    const flat = result.borders[0].segmentEndpointsFlat
    // 任取一个端点 (x,z)，复算 provider 在该点的 meters，断言 y === meters·k + epsilon（精确）。
    const x = flat[0]
    const z = flat[2]
    const y = flat[1]
    const query = provider.queryAtWorld(x, z)
    expect(query.ok).toBe(true)
    if (query.ok) {
      expect(y).toBe(query.meters * k + epsilon)
    }
    // 取常数 provider 在另一点的 meters，断言所有端点 y 都等于同一值（常数高程 → 所有 y 相同）。
    const sample = provider.queryAtWorld(flat[6], flat[8])
    expect(sample.ok).toBe(true)
    const expectedY = sample.ok ? sample.meters * k + epsilon : NaN
    for (let i = 1; i < flat.length; i += 3) {
      expect(flat[i]).toBe(expectedY)
    }
  })

  it('负高程（浅水 / 低于海平面）：y = h·k + epsilon 仍成立（h 为负）', () => {
    // 海岸外浅水点：用负高程 provider（约 -500 m），k=2，epsilon=15。
    const provider = makeConstantProvider(-500)
    const feature: AdministrativeGeometryFeature = {
      adminId: 'CN-sea',
      geometry: {
        type: 'Polygon',
        rings: [
          [
            { lon: 120.0, lat: 20.0 },
            { lon: 122.0, lat: 20.0 },
            { lon: 122.0, lat: 22.0 },
            { lon: 120.0, lat: 22.0 },
          ],
        ],
      },
    }
    const k = 2
    const epsilon = PREP_CONFIG.terrainEpsilonMeters
    const result = prepareProvinceBorders([feature], provider, k, PREP_CONFIG)
    const flat = result.borders[0].segmentEndpointsFlat
    // 取 provider 在首个端点的实际 meters（编码取整后 ≈ -500，非精确 -500）。
    const sample = provider.queryAtWorld(flat[0], flat[2])
    if (!sample.ok) {
      expect.unreachable('常数 provider 查询应成功')
      return
    }
    // 负高程：meters < 0 → y = meters·k + epsilon < 0（|h·k| 远大于 epsilon）。
    expect(sample.meters).toBeLessThan(0)
    const expectedY = sample.meters * k + epsilon
    expect(expectedY).toBeLessThan(0)
    for (let i = 1; i < flat.length; i += 3) {
      expect(flat[i]).toBe(expectedY)
      expect(flat[i]).toBeLessThan(0)
    }
  })

  it('夸张系数变化时 y 同步变化（y 与 k 一致，k 只放大 world-y）', () => {
    const provider = makeConstantProvider(1000)
    const feature = makeTinyTriangleFeature('CN-k')
    const r15 = prepareProvinceBorders([feature], provider, 1.5, PREP_CONFIG)
    const r30 = prepareProvinceBorders([feature], provider, 3.0, PREP_CONFIG)
    const sample = provider.queryAtWorld(
      r15.borders[0].segmentEndpointsFlat[0],
      r15.borders[0].segmentEndpointsFlat[2],
    )
    expect(sample.ok).toBe(true)
    if (sample.ok) {
      const y15 = r15.borders[0].segmentEndpointsFlat[1]
      const y30 = r30.borders[0].segmentEndpointsFlat[1]
      expect(y15).toBe(sample.meters * 1.5 + PREP_CONFIG.terrainEpsilonMeters)
      expect(y30).toBe(sample.meters * 3.0 + PREP_CONFIG.terrainEpsilonMeters)
      // 平面位置 (x,z) 不随 k 变化（k 只放大 world-y，不改平面）。
      expect(r30.borders[0].segmentEndpointsFlat[0]).toBe(r15.borders[0].segmentEndpointsFlat[0])
      expect(r30.borders[0].segmentEndpointsFlat[2]).toBe(r15.borders[0].segmentEndpointsFlat[2])
    }
  })
})

describe('多多边形 / 岛屿 / 内环：所有环边界完整保留（验收 1）', () => {
  it('MultiPolygon 的多个 polygon（岛屿）边界均产出', () => {
    // 一个多多边形：大陆块 + 远处岛屿。两块都应产出线段。
    const feature: AdministrativeGeometryFeature = {
      adminId: 'CN-multi',
      geometry: {
        type: 'MultiPolygon',
        polygons: [
          {
            rings: [
              [
                { lon: 100.0, lat: 25.0 },
                { lon: 105.0, lat: 25.0 },
                { lon: 105.0, lat: 30.0 },
                { lon: 100.0, lat: 30.0 },
              ],
            ],
          },
          {
            rings: [
              [
                { lon: 118.0, lat: 22.0 },
                { lon: 119.0, lat: 22.0 },
                { lon: 118.5, lat: 23.0 },
              ],
            ],
          },
        ],
      },
    }
    const provider = makeConstantProvider(1000)
    const result = prepareProvinceBorders([feature], provider, 2, PREP_CONFIG)
    expect(result.borders[0].segmentCount).toBeGreaterThan(0)
    // 检查端点覆盖两块区域：大陆块（lon 100-105）与岛屿（lon 118-119）。
    const flat = result.borders[0].segmentEndpointsFlat
    let hitsMainland = 0
    let hitsIsland = 0
    for (let i = 0; i < flat.length; i += 3) {
      const x = flat[i]
      // 反算经度近似判断区域：invertWorld 得到 lon。
      const inv = invertWorld(x, flat[i + 2])
      if (inv.ok) {
        if (inv.value.lon >= 99 && inv.value.lon <= 106) hitsMainland++
        if (inv.value.lon >= 117 && inv.value.lon <= 120) hitsIsland++
      }
    }
    expect(hitsMainland, '大陆块边界应产出').toBeGreaterThan(0)
    expect(hitsIsland, '岛屿边界应产出').toBeGreaterThan(0)
  })

  it('Polygon 的内环（洞 / 飞地）边界也产出', () => {
    // 一个带洞的 Polygon：外环 + 内环（洞）。两个环都应产出边界。
    const feature: AdministrativeGeometryFeature = {
      adminId: 'CN-hole',
      geometry: {
        type: 'Polygon',
        rings: [
          [
            { lon: 100.0, lat: 25.0 },
            { lon: 110.0, lat: 25.0 },
            { lon: 110.0, lat: 35.0 },
            { lon: 100.0, lat: 35.0 },
          ],
          [
            { lon: 104.0, lat: 29.0 },
            { lon: 105.0, lat: 29.0 },
            { lon: 104.5, lat: 30.0 },
          ],
        ],
      },
    }
    const provider = makeConstantProvider(1000)
    const result = prepareProvinceBorders([feature], provider, 2, PREP_CONFIG)
    // 外环 4 边被细分（>4 子段）+ 内环 3 边 → 总子段数 > 7。
    expect(result.borders[0].segmentCount).toBeGreaterThan(7)
  })
})

describe('闭环：环视为闭合，接缝段回到首顶点（验收 1）', () => {
  it('三角形环产出 3 条子段，末段终点 = 首顶点（闭合）', () => {
    const provider = makeConstantProvider(1000)
    const result = prepareProvinceBorders([makeTinyTriangleFeature('CN-closed')], provider, 2, PREP_CONFIG)
    const flat = result.borders[0].segmentEndpointsFlat
    expect(result.borders[0].segmentCount).toBe(3)
    // 首顶点投影世界坐标。
    const firstWorld = projectToWorld(100.0, 30.0)
    expect(firstWorld.ok).toBe(true)
    if (!firstWorld.ok) return
    // 首段起点 = 首顶点。
    expect(flat[0]).toBe(firstWorld.value.x)
    expect(flat[2]).toBe(firstWorld.value.z)
    // 末段（第 3 段，索引 12..17）终点 = 首顶点（闭合回到起点）。
    const lastSegEndX = flat[15]
    const lastSegEndZ = flat[17]
    expect(lastSegEndX).toBe(firstWorld.value.x)
    expect(lastSegEndZ).toBe(firstWorld.value.z)
  })
})

describe('失败路径：不产出平地边界（验收 1 / 领域异常语义）', () => {
  it('exaggeration 非有限 → exaggeration-not-finite', () => {
    const provider = makeConstantProvider(1000)
    expect(() =>
      prepareProvinceBorders([makeTinyTriangleFeature('CN-x')], provider, Number.NaN, PREP_CONFIG),
    ).toThrowError(/夸张系数/)
    try {
      prepareProvinceBorders([makeTinyTriangleFeature('CN-x')], provider, Number.NaN, PREP_CONFIG)
    } catch (e) {
      expect((e as ProvinceBorderPrepError).code).toBe('province-borders.exaggeration-not-finite')
    }
  })

  it('spacing 为 0 / 负 / 非有限 → spacing-invalid', () => {
    const provider = makeConstantProvider(1000)
    const feature = makeTinyTriangleFeature('CN-x')
    for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      try {
        prepareProvinceBorders([feature], provider, 2, {
          densifySpacingMeters: bad,
          terrainEpsilonMeters: 15,
        })
        expect.unreachable(`spacing=${bad} 应被拒绝`)
      } catch (e) {
        expect((e as ProvinceBorderPrepError).code).toBe('province-borders.spacing-invalid')
      }
    }
  })

  it('epsilon 非有限 → epsilon-not-finite', () => {
    const provider = makeConstantProvider(1000)
    try {
      prepareProvinceBorders([makeTinyTriangleFeature('CN-x')], provider, 2, {
        densifySpacingMeters: 1742,
        terrainEpsilonMeters: Number.NaN,
      })
      expect.unreachable('epsilon=NaN 应被拒绝')
    } catch (e) {
      expect((e as ProvinceBorderPrepError).code).toBe('province-borders.epsilon-not-finite')
    }
  })

  it('features 为空 → empty-features', () => {
    const provider = makeConstantProvider(1000)
    try {
      prepareProvinceBorders([], provider, 2, PREP_CONFIG)
      expect.unreachable('空 features 应被拒绝')
    } catch (e) {
      expect((e as ProvinceBorderPrepError).code).toBe('province-borders.empty-features')
    }
  })

  it('顶点越出主图范围 → projection-failed', () => {
    // 主图经度范围 [72, 136]；200° 越界 → projectToWorld 失败。
    const provider = makeConstantProvider(1000)
    const feature: AdministrativeGeometryFeature = {
      adminId: 'CN-oob',
      geometry: {
        type: 'Polygon',
        rings: [
          [
            { lon: 100.0, lat: 30.0 },
            { lon: 200.0, lat: 30.0 },
            { lon: 100.0, lat: 31.0 },
          ],
        ],
      },
    }
    try {
      prepareProvinceBorders([feature], provider, 2, PREP_CONFIG)
      expect.unreachable('越界顶点应触发 projection-failed')
    } catch (e) {
      expect((e as ProvinceBorderPrepError).code).toBe('province-borders.projection-failed')
    }
  })

  it('顶点在主图范围内但越出元数据范围 → elevation-query-failed', () => {
    // provider 元数据范围缩到 [100,104]×[20,24]；顶点 lon=110 在主图 [72,136] 内但越出元数据 → 查询失败。
    const provider = makeConstantProvider(1000, {
      extent: { west: 100, south: 20, east: 104, north: 24 },
    })
    const feature: AdministrativeGeometryFeature = {
      adminId: 'CN-meta-oob',
      geometry: {
        type: 'Polygon',
        rings: [
          [
            { lon: 110.0, lat: 30.0 },
            { lon: 110.001, lat: 30.0 },
            { lon: 110.0005, lat: 30.001 },
          ],
        ],
      },
    }
    try {
      prepareProvinceBorders([feature], provider, 2, PREP_CONFIG)
      expect.unreachable('越出元数据范围应触发 elevation-query-failed')
    } catch (e) {
      expect((e as ProvinceBorderPrepError).code).toBe('province-borders.elevation-query-failed')
    }
  })

  it('全体退化（所有环零长度边）→ no-segments-produced', () => {
    // 三个完全重合的点：所有边零长度 → 无子段。
    const provider = makeConstantProvider(1000)
    const feature: AdministrativeGeometryFeature = {
      adminId: 'CN-degenerate',
      geometry: {
        type: 'Polygon',
        rings: [
          [
            { lon: 100.0, lat: 30.0 },
            { lon: 100.0, lat: 30.0 },
            { lon: 100.0, lat: 30.0 },
          ],
        ],
      },
    }
    try {
      prepareProvinceBorders([feature], provider, 2, PREP_CONFIG)
      expect.unreachable('全体退化应触发 no-segments-produced')
    } catch (e) {
      expect((e as ProvinceBorderPrepError).code).toBe('province-borders.no-segments-produced')
    }
  })
})

describe('集成：真实 34 省资产 + 合成常数 provider 跑通（验收 1、2）', () => {
  it('真实 china-provinces-geometry.json 经契约校验 + densify + 贴地产出 34 个行政区边界', () => {
    const features = loadProductionFeatures()
    // 用常数高程 provider（真实范围）+ 生产间距跑全量 densify + 贴地。
    const provider = makeConstantProvider(1000)
    const result = prepareProvinceBorders(features, provider, 2, PREP_CONFIG)
    // 恰好 34 个行政区边界。
    expect(result.borders.length).toBe(34)
    // 每个行政区都产出非零线段（无平地 / 空边界）。
    for (const border of result.borders) {
      expect(border.segmentCount, `${border.adminId} 应有非零线段`).toBeGreaterThan(0)
      expect(border.segmentEndpointsFlat.length).toBe(border.segmentCount * 6)
    }
    // 总线段数为正且为有限量级（draw call 审计）。
    expect(result.totalSegmentCount).toBeGreaterThan(0)
    expect(Number.isFinite(result.totalSegmentCount)).toBe(true)
  })

  it('真实 34 省边界端点 y 全部等于 meters·k + epsilon（贴地不变量在全量数据上成立）', () => {
    const features = loadProductionFeatures()
    const provider = makeConstantProvider(1234)
    const k = 2
    const epsilon = PREP_CONFIG.terrainEpsilonMeters
    const result = prepareProvinceBorders(features, provider, k, PREP_CONFIG)
    // 常数高程：所有 y 应等于同一 meters·k + epsilon。取一个样点确定基准 y。
    const firstFlat = result.borders[0].segmentEndpointsFlat
    const sample = provider.queryAtWorld(firstFlat[0], firstFlat[2])
    expect(sample.ok).toBe(true)
    const expectedY = sample.ok ? sample.meters * k + epsilon : NaN
    // 全量遍历 34 省所有端点断言（常数高程下遍历成本低）。
    let checked = 0
    for (const border of result.borders) {
      const flat = border.segmentEndpointsFlat
      for (let i = 1; i < flat.length; i += 3) {
        expect(flat[i]).toBe(expectedY)
        checked++
      }
    }
    expect(checked, '应检查了若干 densified 端点').toBeGreaterThan(0)
  })
})

describe('集成：真实 34 省资产 + 生产 heightmap——端点随真实地形起伏贴地（验收 1 的核心证据）', () => {
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
  const epsilon = PROVINCE_BORDERS_CONFIG.terrainEpsilonMeters
  const prepared = (() => {
    const features = loadProductionFeatures()
    return prepareProvinceBorders(features, productionProvider, k, {
      densifySpacingMeters: PROVINCE_BORDERS_CONFIG.densifySpacingMeters,
      terrainEpsilonMeters: epsilon,
    })
  })()

  it('34 省边界全部产出，生产间距下 densify 后每子段 ≤ 间距（抽样）', () => {
    expect(prepared.borders.length).toBe(34)
    const spacing = PROVINCE_BORDERS_CONFIG.densifySpacingMeters
    // 逐省抽样（首 / 中 / 尾各一条子段）断言弧长 ≤ 间距（全量遍历已由合成 provider 用例覆盖）。
    for (const border of prepared.borders) {
      const flat = border.segmentEndpointsFlat
      const segIdx = [0, Math.floor(border.segmentCount / 2), border.segmentCount - 1]
      for (const s of segIdx) {
        const base = s * 6
        const len = Math.hypot(flat[base + 3] - flat[base], flat[base + 5] - flat[base + 2])
        expect(len, `${border.adminId} 第 ${s} 段子段长度`).toBeLessThanOrEqual(spacing + 1e-6)
      }
    }
  })

  it('端点 y 随真实地形起伏（非平地）：全省界 y 极差达数公里', () => {
    let minY = Number.POSITIVE_INFINITY
    let maxY = Number.NEGATIVE_INFINITY
    for (const border of prepared.borders) {
      const flat = border.segmentEndpointsFlat
      for (let i = 1; i < flat.length; i += 3) {
        if (flat[i] < minY) minY = flat[i]
        if (flat[i] > maxY) maxY = flat[i]
      }
    }
    // 省界跨越沿海低地（h≈0 → y≈epsilon=15）到青藏高原边界（h≈4000–5000+ → y≈8000–10000+）：
    // 若准备层退化为平地（如 y 恒 = epsilon 或恒 0），极差会 ≈0——本断言正是「贴地起伏」的反伪证。
    expect(maxY, '最高省界点应位于青藏高原量级（y > 4000m）').toBeGreaterThan(4000)
    expect(minY, '最低省界点应接近海平面（y < 500m）').toBeLessThan(500)
    expect(maxY - minY, '省界 y 极差应达数公里（随地形起伏，非平地）').toBeGreaterThan(4000)
  })

  it('抽样端点 y 与 provider.queryAtWorld 复算精确一致（y = h·k + epsilon 在生产高程上成立）', () => {
    let checked = 0
    for (const border of prepared.borders) {
      const flat = border.segmentEndpointsFlat
      // 每省抽首 / 中 / 尾三个端点复算。
      const pointIdx = [0, Math.floor(border.segmentCount / 2) * 6, (border.segmentCount - 1) * 6 + 3]
      for (const base of pointIdx) {
        const query = productionProvider.queryAtWorld(flat[base], flat[base + 2])
        expect(query.ok, `${border.adminId} 端点 (${flat[base]}, ${flat[base + 2]}) 高程查询应成功`).toBe(true)
        if (query.ok) {
          expect(flat[base + 1], `${border.adminId} 端点 y 应 = h·k+epsilon`).toBe(
            query.meters * k + epsilon,
          )
          checked++
        }
      }
    }
    expect(checked).toBeGreaterThanOrEqual(34 * 3)
  })

  it('相邻子段共享端点逐分量相等（折线连续无缝隙，抽样）', () => {
    for (const border of prepared.borders) {
      const flat = border.segmentEndpointsFlat
      if (border.segmentCount < 2) continue
      // 抽第一段与第二段的接缝：第一段终点 (3,4,5) 应与第二段起点 (6,7,8) 逐分量相等。
      expect(flat[6]).toBe(flat[3])
      expect(flat[7]).toBe(flat[4])
      expect(flat[8]).toBe(flat[5])
    }
  })
})

describe('配置不变量：抗 z-fighting / 海面共存的结构性前提（验收 1、2）', () => {
  it('densify 间距 = 主图世界宽度 / 4096（与 heightmap 纹素分辨率一一对应）', () => {
    const expected =
      (MAIN_MAP_WORLD_BOUNDS.maxX - MAIN_MAP_WORLD_BOUNDS.minX) / PROVINCE_BORDER_HEIGHTMAP_TEXEL_COUNT
    expect(PROVINCE_BORDERS_CONFIG.densifySpacingMeters).toBe(expected)
    // 间距落在 SPEC §3.6 的 1–2 km 区间。
    expect(PROVINCE_BORDERS_CONFIG.densifySpacingMeters).toBeGreaterThanOrEqual(1000)
    expect(PROVINCE_BORDERS_CONFIG.densifySpacingMeters).toBeLessThanOrEqual(2000)
  })

  it('贴地 epsilon 为正、有限（把省界放到地表外侧的辅助防线）', () => {
    expect(PROVINCE_BORDERS_CONFIG.terrainEpsilonMeters).toBeGreaterThan(0)
    expect(Number.isFinite(PROVINCE_BORDERS_CONFIG.terrainEpsilonMeters)).toBe(true)
  })

  it('NDC 深度偏移为正、有限（结构性消除省界-地表 z-fighting；海面共存时不被吞没的前提）', () => {
    // depthBiasNdc > 0：在 LineMaterial 顶点着色器内把省界片元 NDC z 推近，使其恒胜过同位置地表。
    // 这是大屏尺度下（相机远、深度量化粗）抗 z-fighting 的主防线，单靠世界 epsilon 无法跨越一个深度桶。
    expect(PROVINCE_BORDERS_CONFIG.depthBiasNdc).toBeGreaterThan(0)
    expect(Number.isFinite(PROVINCE_BORDERS_CONFIG.depthBiasNdc)).toBe(true)
    // 偏移应「小而足」：足够胜过同位置地表（> 数个 24 位深度 ULP ≈ 6e-8 NDC），又远小于前方山体的 NDC 差。
    expect(PROVINCE_BORDERS_CONFIG.depthBiasNdc).toBeGreaterThanOrEqual(1e-7)
    expect(PROVINCE_BORDERS_CONFIG.depthBiasNdc).toBeLessThan(1e-3)
  })

  it('基线色为浅青白 #9fe8d8（SPEC §3.6），蓝绿通道占优', () => {
    expect(PROVINCE_BORDERS_CONFIG.colorHex).toBe('#9fe8d8')
    const { r, g, b } = PROVINCE_BORDERS_CONFIG.colorRgb
    // #9fe8d8 = (159, 232, 216)：青绿占优、明度高，深色背景下呈浅青白发光。
    expect(r).toBe(159)
    expect(g).toBe(232)
    expect(b).toBe(216)
    expect(g).toBeGreaterThanOrEqual(r)
    expect(b).toBeGreaterThanOrEqual(r)
  })

  it('屏幕线宽为正、有限（SPEC §3.6「可设线宽」）', () => {
    expect(PROVINCE_BORDERS_CONFIG.lineWidthPx).toBeGreaterThan(0)
    expect(Number.isFinite(PROVINCE_BORDERS_CONFIG.lineWidthPx)).toBe(true)
  })

  it('provinceBorderSpacingIsValid：正有限为 true、非正 / 非有限为 false（防御畸形 spacing）', () => {
    expect(provinceBorderSpacingIsValid(PROVINCE_BORDERS_CONFIG.densifySpacingMeters)).toBe(true)
    expect(provinceBorderSpacingIsValid(1)).toBe(true)
    expect(provinceBorderSpacingIsValid(0)).toBe(false)
    expect(provinceBorderSpacingIsValid(-1)).toBe(false)
    expect(provinceBorderSpacingIsValid(Number.NaN)).toBe(false)
    expect(provinceBorderSpacingIsValid(Number.POSITIVE_INFINITY)).toBe(false)
  })

  it('配置全部冻结（运行时不可被偷偷放宽，如把深度偏移改 0 复发 z-fighting）', () => {
    expect(Object.isFrozen(PROVINCE_BORDERS_CONFIG)).toBe(true)
    expect(Object.isFrozen(PROVINCE_BORDERS_CONFIG.colorRgb)).toBe(true)
  })
})
