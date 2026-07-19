/**
 * 统一米制投影与世界坐标转换测试（TASK-007 验证方式 1–4）。
 *
 * 覆盖：
 * - 主图四角 + 中心投影到稳定米制包围盒，中心接近世界原点，轴方向与地图方位一致（验证方式 1）。
 * - 省会 / 岛礁代表点经纬度→世界→经纬度往返，落在声明容差内（验证方式 2）。
 * - 主图与附图投影同一南海点位，二者来自同一墨卡托结果，仅视口映射不同（验证方式 3）。
 * - NaN / 非法纬度 / 契约范围外坐标显式失败，不落到原点（验证方式 4）。
 * - 与离线 DEM 闭式墨卡托（scripts/dem/mercator.ts）在主图四角一致，证明离线产出的 heightmap
 *   范围与运行时统一投影无漂移——两套公式数值等价，不存在分歧。
 */

import { describe, it, expect } from 'vitest'
import {
  MAIN_MAP_CENTER,
  MAIN_MAP_EXTENT,
  MAIN_MAP_WORLD_BOUNDS,
  WEB_MERCATOR_MAX_LATITUDE_DEGREES,
  invertMercator,
  invertWorld,
  projectToInset,
  projectToMercator,
  projectToWorld,
} from '../src/lib/projection'
import {
  projectLonLatToWebMercator,
  inverseWebMercatorToLonLat,
} from '../scripts/dem/mercator'

/** 断言两个数值在给定绝对容差内相等。 */
function expectAlmostEqual(actual: number, expected: number, tolerance: number, note = ''): void {
  expect(
    Math.abs(actual - expected),
    `期望 ${actual} ≈ ${expected}（容差 ${tolerance}）${note}`,
  ).toBeLessThanOrEqual(tolerance)
}

/** 断言投影结果成功，并返回其值供后续断言。 */
function expectOk<T>(result: { readonly ok: boolean } & Partial<{ readonly value: T }>): T {
  expect(result.ok).toBe(true)
  return (result as { readonly value: T }).value
}

/** 断言投影结果失败，且失败码等于给定值（失败不得伪装成原点成功）。 */
function expectFail(
  result: { readonly ok: boolean } & Partial<{ readonly code: string }>,
  code: string,
): void {
  expect(result.ok).toBe(false)
  expect((result as { readonly code?: string }).code).toBe(code)
}

describe('主图范围投影与轴方向（验证方式 1）', () => {
  it('地图中心投影到世界原点', () => {
    const c = expectOk(projectToWorld(MAIN_MAP_CENTER.lon, MAIN_MAP_CENTER.lat))
    expectAlmostEqual(c.x, 0, 1e-6, '中心 x')
    expectAlmostEqual(c.z, 0, 1e-6, '中心 z')
  })

  it('四角投影到稳定的米制包围盒且 x 关于原点对称', () => {
    const bounds = MAIN_MAP_WORLD_BOUNDS
    // 西界 x 为负、东界 x 为正；墨卡托 x = R·lon 关于中心经度 104° 线性对称。
    expect(bounds.minX).toBeLessThan(0)
    expect(bounds.maxX).toBeGreaterThan(0)
    expectAlmostEqual(bounds.minX, -bounds.maxX, 1e-3, 'x 东西对称')
    // 北侧 z 为负（−Z=北）、南侧 z 为正（+Z=南）。
    expect(bounds.minZ).toBeLessThan(0)
    expect(bounds.maxZ).toBeGreaterThan(0)
    // 墨卡托纬度非线性：北侧 −Z 量级大于南侧 +Z（北方被放大），不要求 z 对称。
    expect(Math.abs(bounds.minZ)).toBeGreaterThan(bounds.maxZ)
  })

  it('四角各自投影到包围盒对应端点', () => {
    const nw = expectOk(projectToWorld(MAIN_MAP_EXTENT.west, MAIN_MAP_EXTENT.north))
    const se = expectOk(projectToWorld(MAIN_MAP_EXTENT.east, MAIN_MAP_EXTENT.south))
    expectAlmostEqual(nw.x, MAIN_MAP_WORLD_BOUNDS.minX, 1e-6, 'NW x = minX')
    expectAlmostEqual(nw.z, MAIN_MAP_WORLD_BOUNDS.minZ, 1e-6, 'NW z = minZ(北)')
    expectAlmostEqual(se.x, MAIN_MAP_WORLD_BOUNDS.maxX, 1e-6, 'SE x = maxX')
    expectAlmostEqual(se.z, MAIN_MAP_WORLD_BOUNDS.maxZ, 1e-6, 'SE z = maxZ(南)')
  })

  it('轴方向：+X=东、+Z=南、−Z=北', () => {
    // 同纬度、中心以东 → x > 0、z ≈ 0。
    const east = expectOk(projectToWorld(110, MAIN_MAP_CENTER.lat))
    expect(east.x).toBeGreaterThan(0)
    expectAlmostEqual(east.z, 0, 1e-6, '同纬度 z≈0')
    // 中心以北 → z < 0；中心以南 → z > 0。
    const north = expectOk(projectToWorld(MAIN_MAP_CENTER.lon, 40))
    expect(north.z).toBeLessThan(0)
    expectAlmostEqual(north.x, 0, 1e-6, '同经度 x≈0')
    const south = expectOk(projectToWorld(MAIN_MAP_CENTER.lon, 15))
    expect(south.z).toBeGreaterThan(0)
  })
})

describe('经纬度→世界→经纬度往返（验证方式 2）', () => {
  const samples: ReadonlyArray<{ readonly name: string; readonly lon: number; readonly lat: number }> = [
    { name: '北京', lon: 116.3912, lat: 39.9075 },
    { name: '哈尔滨（北）', lon: 126.5358, lat: 45.8028 },
    { name: '三亚（南）', lon: 109.5083, lat: 18.2473 },
    { name: '喀什（西）', lon: 75.9893, lat: 39.4647 },
    { name: '上海（东）', lon: 121.4737, lat: 31.2304 },
    { name: '曾母暗沙（岛礁南端）', lon: 112.17, lat: 3.95 },
  ]
  const ROUNDTRIP_TOLERANCE_DEG = 1e-7

  for (const sample of samples) {
    it(`${sample.name} 往返误差 ≤ ${ROUNDTRIP_TOLERANCE_DEG}°`, () => {
      const world = expectOk(projectToWorld(sample.lon, sample.lat))
      const back = expectOk(invertWorld(world.x, world.z))
      expectAlmostEqual(back.lon, sample.lon, ROUNDTRIP_TOLERANCE_DEG, `${sample.name} lon`)
      expectAlmostEqual(back.lat, sample.lat, ROUNDTRIP_TOLERANCE_DEG, `${sample.name} lat`)
    })
  }

  it('通用墨卡托正反变换往返一致', () => {
    const m = expectOk(projectToMercator(100, 30))
    const back = expectOk(invertMercator(m.x, m.y))
    expectAlmostEqual(back.lon, 100, 1e-9)
    expectAlmostEqual(back.lat, 30, 1e-9)
  })
})

describe('主图与附图共享同一墨卡托（验证方式 3）', () => {
  // 南海附图子范围（2D overlay 视口）；非冻结契约，此处仅作测试夹具。
  const inset = { west: 104, south: 0, east: 122, north: 26 }
  // 黄岩岛：同时落在主图范围与附图范围内，便于同一断言。
  const point = { lon: 117.75, lat: 15.13 }

  it('主图世界坐标由同一墨卡托结果中心化得到', () => {
    const merc = expectOk(projectToMercator(point.lon, point.lat))
    const center = expectOk(projectToMercator(MAIN_MAP_CENTER.lon, MAIN_MAP_CENTER.lat))
    const world = expectOk(projectToWorld(point.lon, point.lat))
    expectAlmostEqual(world.x, merc.x - center.x, 1e-6, 'world.x = Mx − Mxc')
    expectAlmostEqual(world.z, center.y - merc.y, 1e-6, 'world.z = Myc − My')
  })

  it('附图视口由同一墨卡托结果线性归一化得到', () => {
    const merc = expectOk(projectToMercator(point.lon, point.lat))
    const sw = expectOk(projectToMercator(inset.west, inset.south))
    const ne = expectOk(projectToMercator(inset.east, inset.north))
    const insetPoint = expectOk(projectToInset(point.lon, point.lat, inset))
    expectAlmostEqual(
      insetPoint.u,
      (merc.x - sw.x) / (ne.x - sw.x),
      1e-9,
      'u = (Mx − Mx_sw)/(Mx_ne − Mx_sw)',
    )
    expectAlmostEqual(
      insetPoint.v,
      (merc.y - sw.y) / (ne.y - sw.y),
      1e-9,
      'v = (My − My_sw)/(My_ne − My_sw)',
    )
  })

  it('附图视口落在 [0,1]² 且端点对齐', () => {
    expectOk(projectToInset(point.lon, point.lat, inset)) // 不抛、不失败
    const sw = expectOk(projectToInset(inset.west, inset.south, inset))
    const ne = expectOk(projectToInset(inset.east, inset.north, inset))
    expectAlmostEqual(sw.u, 0, 1e-9)
    expectAlmostEqual(sw.v, 0, 1e-9)
    expectAlmostEqual(ne.u, 1, 1e-9)
    expectAlmostEqual(ne.v, 1, 1e-9)
  })
})

describe('越界 / 不可投影 / 非有限输入显式失败（验证方式 4）', () => {
  it('NaN / Infinity 输入 → projection.input-not-finite，不落到原点', () => {
    expectFail(projectToWorld(Number.NaN, 28.5), 'projection.input-not-finite')
    expectFail(projectToWorld(104, Number.POSITIVE_INFINITY), 'projection.input-not-finite')
    expectFail(projectToMercator(Number.NaN, Number.NaN), 'projection.input-not-finite')
    expectFail(invertWorld(Number.NaN, 0), 'projection.input-not-finite')
  })

  it('经度越 [-180,180] → projection.longitude-out-of-domain', () => {
    expectFail(projectToMercator(200, 30), 'projection.longitude-out-of-domain')
    expectFail(projectToMercator(-181, 30), 'projection.longitude-out-of-domain')
  })

  it('纬度超出墨卡托有效上限 → projection.latitude-out-of-mercator-domain', () => {
    expectFail(
      projectToMercator(100, WEB_MERCATOR_MAX_LATITUDE_DEGREES + 0.01),
      'projection.latitude-out-of-mercator-domain',
    )
    expectFail(projectToMercator(100, -90), 'projection.latitude-out-of-mercator-domain')
  })

  it('主图契约范围外坐标 → projection.*-out-of-extent', () => {
    expectFail(projectToWorld(71.9, 28.5), 'projection.longitude-out-of-extent')
    expectFail(projectToWorld(136.1, 28.5), 'projection.longitude-out-of-extent')
    expectFail(projectToWorld(104, 2.9), 'projection.latitude-out-of-extent')
    expectFail(projectToWorld(104, 54.1), 'projection.latitude-out-of-extent')
  })

  it('主图范围端点（72/136/3/54）含端点接受，不被误拒', () => {
    expectOk(projectToWorld(72, 3))
    expectOk(projectToWorld(136, 54))
    expectOk(projectToWorld(72, 54))
    expectOk(projectToWorld(136, 3))
  })

  it('附图范围外坐标与畸形的附图四至 → 显式失败', () => {
    const inset = { west: 104, south: 0, east: 122, north: 26 }
    expectFail(projectToInset(103, 15, inset), 'projection.longitude-out-of-extent')
    expectFail(projectToInset(117, -1, inset), 'projection.latitude-out-of-extent')
    // 畸形四至：west ≥ east（130 > 122）。
    expectFail(
      projectToInset(110, 10, { west: 130, south: 0, east: 122, north: 26 }),
      'projection.extent-malformed',
    )
    // 畸形四至：south ≥ north（30 > 26）。
    expectFail(
      projectToInset(110, 10, { west: 104, south: 30, east: 122, north: 26 }),
      'projection.extent-malformed',
    )
  })
})

describe('与离线 DEM 闭式墨卡托一致（无公式漂移）', () => {
  const corners: ReadonlyArray<{ readonly lon: number; readonly lat: number }> = [
    { lon: MAIN_MAP_EXTENT.west, lat: MAIN_MAP_EXTENT.south },
    { lon: MAIN_MAP_EXTENT.east, lat: MAIN_MAP_EXTENT.north },
    { lon: MAIN_MAP_EXTENT.west, lat: MAIN_MAP_EXTENT.north },
    { lon: MAIN_MAP_EXTENT.east, lat: MAIN_MAP_EXTENT.south },
    { lon: 104, lat: 28.5 },
    { lon: 116.3912, lat: 39.9075 },
  ]

  for (const corner of corners) {
    it(`统一投影与闭式墨卡托在 (${corner.lon},${corner.lat}) 一致（≤1mm）`, () => {
      const unified = expectOk(projectToMercator(corner.lon, corner.lat))
      const closed = projectLonLatToWebMercator(corner.lon, corner.lat)
      expectAlmostEqual(unified.x, closed.x, 1e-3, 'Mx')
      expectAlmostEqual(unified.y, closed.y, 1e-3, 'My')
    })
  }

  it('统一反向投影与闭式反向墨卡托一致', () => {
    const closed = projectLonLatToWebMercator(100, 30)
    const unifiedBack = expectOk(invertMercator(closed.x, closed.y))
    const closedBack = inverseWebMercatorToLonLat(closed.x, closed.y)
    expectAlmostEqual(unifiedBack.lon, closedBack.lon, 1e-9)
    expectAlmostEqual(unifiedBack.lat, closedBack.lat, 1e-9)
  })
})
