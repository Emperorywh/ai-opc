/**
 * 统一米制投影与世界坐标转换测试（SPEC §3.3）。
 *
 * 覆盖：
 * - 主图中心投影到世界原点，四至角点投影到稳定的米制包围盒，轴方向与地图方位一致。
 * - 前向输出与 EPSG:3857 闭式公式逐点一致（x = R·λ，y = R·ln(tan(π/4 + φ/2))），
 *   证明投影输出确定、无第二套公式。
 * - 省会/岛礁代表点经纬度→世界→经纬度往返，落在声明容差内。
 * - 主图与南海附图投影同一点位，二者来自同一墨卡托结果，仅视口映射不同（SPEC §3.8）。
 * - NaN / 非法纬度 / 契约范围外坐标显式失败，不落到原点。
 */

import { describe, it, expect } from 'vitest'
import {
  MAIN_MAP_CENTER,
  MAIN_MAP_EXTENT,
  MAIN_MAP_WORLD_BOUNDS,
  WEB_MERCATOR_MAX_LATITUDE_DEGREES,
  WEB_MERCATOR_RADIUS,
  invertMercator,
  invertWorld,
  projectToInset,
  projectToMercator,
  projectToWorld,
} from '../src/lib/projection'

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

/** EPSG:3857 闭式公式（北距向北递增），作为投影输出确定性的独立对照。 */
function closedFormWebMercator(lon: number, lat: number): { x: number; y: number } {
  const lambda = (lon * Math.PI) / 180
  const phi = (lat * Math.PI) / 180
  return {
    x: WEB_MERCATOR_RADIUS * lambda,
    y: WEB_MERCATOR_RADIUS * Math.log(Math.tan(Math.PI / 4 + phi / 2)),
  }
}

describe('主图中心与四至角点（SPEC §3.3）', () => {
  it('主图地理中心为四至中点 (104°E, 28.5°N)', () => {
    expect(MAIN_MAP_CENTER.lon).toBe(104)
    expect(MAIN_MAP_CENTER.lat).toBe(28.5)
  })

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

  it('四至角点各自投影到包围盒对应端点', () => {
    const nw = expectOk(projectToWorld(MAIN_MAP_EXTENT.west, MAIN_MAP_EXTENT.north))
    const ne = expectOk(projectToWorld(MAIN_MAP_EXTENT.east, MAIN_MAP_EXTENT.north))
    const sw = expectOk(projectToWorld(MAIN_MAP_EXTENT.west, MAIN_MAP_EXTENT.south))
    const se = expectOk(projectToWorld(MAIN_MAP_EXTENT.east, MAIN_MAP_EXTENT.south))
    expectAlmostEqual(nw.x, MAIN_MAP_WORLD_BOUNDS.minX, 1e-6, 'NW x = minX')
    expectAlmostEqual(nw.z, MAIN_MAP_WORLD_BOUNDS.minZ, 1e-6, 'NW z = minZ(北)')
    expectAlmostEqual(ne.x, MAIN_MAP_WORLD_BOUNDS.maxX, 1e-6, 'NE x = maxX')
    expectAlmostEqual(ne.z, MAIN_MAP_WORLD_BOUNDS.minZ, 1e-6, 'NE z = minZ(北)')
    expectAlmostEqual(sw.x, MAIN_MAP_WORLD_BOUNDS.minX, 1e-6, 'SW x = minX')
    expectAlmostEqual(sw.z, MAIN_MAP_WORLD_BOUNDS.maxZ, 1e-6, 'SW z = maxZ(南)')
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

describe('投影输出确定性：与 EPSG:3857 闭式公式逐点一致', () => {
  const samples: ReadonlyArray<{ readonly name: string; readonly lon: number; readonly lat: number }> = [
    { name: '西南角', lon: MAIN_MAP_EXTENT.west, lat: MAIN_MAP_EXTENT.south },
    { name: '东北角', lon: MAIN_MAP_EXTENT.east, lat: MAIN_MAP_EXTENT.north },
    { name: '西北角', lon: MAIN_MAP_EXTENT.west, lat: MAIN_MAP_EXTENT.north },
    { name: '东南角', lon: MAIN_MAP_EXTENT.east, lat: MAIN_MAP_EXTENT.south },
    { name: '主图中心', lon: MAIN_MAP_CENTER.lon, lat: MAIN_MAP_CENTER.lat },
    { name: '北京', lon: 116.3912, lat: 39.9075 },
    { name: '曾母暗沙', lon: 112.17, lat: 3.95 },
  ]

  for (const sample of samples) {
    it(`${sample.name} (${sample.lon},${sample.lat}) 墨卡托输出与闭式公式一致（≤1mm）`, () => {
      const unified = expectOk(projectToMercator(sample.lon, sample.lat))
      const closed = closedFormWebMercator(sample.lon, sample.lat)
      expectAlmostEqual(unified.x, closed.x, 1e-3, 'Mx')
      expectAlmostEqual(unified.y, closed.y, 1e-3, 'My')
    })
  }

  it('反向投影与闭式公式互逆', () => {
    const closed = closedFormWebMercator(100, 30)
    const back = expectOk(invertMercator(closed.x, closed.y))
    expectAlmostEqual(back.lon, 100, 1e-9)
    expectAlmostEqual(back.lat, 30, 1e-9)
  })
})

describe('经纬度→世界→经纬度往返', () => {
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

describe('主图与南海附图共享同一墨卡托（SPEC §3.3、§3.8）', () => {
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

describe('越界 / 不可投影 / 非有限输入显式失败', () => {
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
