import { describe, it, expect } from 'vitest'
import proj4 from 'proj4'
import {
  PLANE_WIDTH,
  PLANE_HEIGHT,
  HEIGHT_EXAGGERATION,
  WORLD_Y_PER_METER,
  ROBINSON_DEF,
  ROBINSON_MAX_X,
  ROBINSON_MAX_Y,
  project,
  unproject,
  heightToMeters,
  metersToWorldY,
  heightToWorldY,
  computeHeightUniforms,
  type ElevationMeta,
} from '../src/config/projection'

/** 与 Task 02 合成 DEM 的 meta.json 一致（用于高度解码断言）。 */
const META: ElevationMeta = {
  elevationMin: -5000,
  elevationMax: 6500,
  seaLevelMeters: 0,
  width: 1024,
  height: 512,
}

// 独立 proj4 实例（同源对照：验证 project() 内部 proj4 计算与外部独立计算一致）
const WGS84 = new proj4.Proj('EPSG:4326')
const ROBIN = new proj4.Proj(ROBINSON_DEF)
const refProject = (lon: number, lat: number): [number, number] => {
  const [rx, ry] = proj4(WGS84, ROBIN, [lon, lat])
  return [(rx / ROBINSON_MAX_X) * (PLANE_WIDTH / 2), (-ry / ROBINSON_MAX_Y) * (PLANE_HEIGHT / 2)]
}

describe('project（Robinson · Task 26）', () => {
  it('经度边界 → x ∈ [-1,1]（与 equirect 同范围，渲染层零改动）', () => {
    expect(project(-180, 0)[0]).toBe(-1)
    expect(project(180, 0)[0]).toBe(1)
    expect(project(0, 0)[0]).toBe(0)
  })

  it('纬度边界 → z ∈ [-0.5,0.5]，向北 -z', () => {
    expect(project(0, 90)[1]).toBeCloseTo(-0.5, 10) // 北极 → -z
    expect(project(0, -90)[1]).toBeCloseTo(0.5, 10) // 南极 → +z
    expect(project(0, 0)[1]).toBeCloseTo(0, 10)
    expect(project(0, 90)[0]).toBe(0) // 经度 0 → x=0
  })

  it('与 proj4 robinson 同源（独立 proj4 实例对照）', () => {
    const samples: Array<[number, number]> = [
      [116.4, 39.9],
      [-74, 40.7],
      [-70, -15],
      [0, 60],
      [120, -30],
      [45, 0],
    ]
    for (const [lon, lat] of samples) {
      const [x, z] = project(lon, lat)
      const [rx, rz] = refProject(lon, lat)
      expect(x).toBeCloseTo(rx, 9)
      expect(z).toBeCloseTo(rz, 9)
    }
  })

  it('极区压缩：高纬经线收敛（消除极区拉伸，M9 核心验收）', () => {
    // equirect: project(lon,lat)[0] 与 lat 无关恒 lon/180；Robinson: 纬度越高同经度 x 越小
    expect(project(180, 0)[0]).toBe(1) // 赤道 lon=180 → x=1（最宽）
    expect(project(180, 85)[0]).toBeLessThan(0.6) // 北极区收敛
    expect(project(180, -85)[0]).toBeLessThan(0.6) // 南极区收敛
    // 南极洲不再被横向拉伸：lat=-80 经度跨度 < 1.5（equirect 恒 2.0）
    const antSpan = project(180, -80)[0] - project(-180, -80)[0]
    expect(antSpan).toBeLessThan(1.5)
    expect(antSpan).toBeGreaterThan(0)
  })

  it('Robinson 非线性：经度方向随纬度收敛（区别于 equirect 线性）', () => {
    // equirect: project(90,60)[0] === project(90,0)[0] === 0.5
    // Robinson: project(90,60)[0] < 0.5（高纬经线收敛）
    expect(project(90, 0)[0]).toBeCloseTo(0.5, 6)
    expect(project(90, 60)[0]).toBeLessThan(0.5)
  })

  it('unproject 是 project 的反函数', () => {
    // ±180 边缘经度在 Robinson 是矩形左右边（同一条经线，反投影返回 ±180 之一，环绕歧义非 bug），
    // 故 round-trip 用内部点验证；极点经度 0 无歧义可保留。
    const samples: Array<[number, number]> = [
      [0, 0],
      [116.4, 39.9],
      [-74, 40.7],
      [-70, -15],
      [0, 85],
      [0, -89],
      [-150, -80],
      [120, 60],
    ]
    for (const [lon, lat] of samples) {
      const [x, z] = project(lon, lat)
      const [lon2, lat2] = unproject(x, z)
      expect(lon2).toBeCloseTo(lon, 6)
      expect(lat2).toBeCloseTo(lat, 6)
    }
  })

  it('平面尺寸常量正确', () => {
    expect(PLANE_WIDTH).toBe(2.0)
    expect(PLANE_HEIGHT).toBe(1.0)
  })

  it('Robinson 归一化常数 = proj4 robin 极值（前端与 pipeline 同源基石）', () => {
    expect(ROBINSON_MAX_X).toBeCloseTo(proj4(WGS84, ROBIN, [180, 0])[0], 6)
    expect(ROBINSON_MAX_Y).toBeCloseTo(proj4(WGS84, ROBIN, [0, 90])[1], 6)
    expect(ROBINSON_MAX_X).toBeGreaterThan(0)
    expect(ROBINSON_MAX_Y).toBeGreaterThan(0)
    // Robinson 真实比例 ≈ 1.97:1（接近 PLANE 2:1，拉伸可忽略）
    const ratio = (2 * ROBINSON_MAX_X) / (2 * ROBINSON_MAX_Y)
    expect(ratio).toBeGreaterThan(1.9)
    expect(ratio).toBeLessThan(2.05)
  })
})

describe('height decode（R3 同源）', () => {
  it('heightToMeters 边界 = elevationMin / elevationMax', () => {
    expect(heightToMeters(0, META)).toBe(META.elevationMin)
    expect(heightToMeters(1, META)).toBe(META.elevationMax)
    expect(heightToMeters(0.5, META)).toBeCloseTo(
      META.elevationMin + 0.5 * (META.elevationMax - META.elevationMin),
      9,
    )
  })

  it('metersToWorldY = meters × exaggeration × per-meter', () => {
    expect(metersToWorldY(1000)).toBeCloseTo(
      1000 * HEIGHT_EXAGGERATION * WORLD_Y_PER_METER,
      12,
    )
  })

  it('峰值 / 海沟 / 海平面 世界 Y 合理（沙盘观感）', () => {
    const peak = heightToWorldY(1, META) // 6500m
    const floor = heightToWorldY(0, META) // -5000m
    const hSea = (META.seaLevelMeters - META.elevationMin) / (META.elevationMax - META.elevationMin)
    const sea = heightToWorldY(hSea, META) // 0m
    expect(peak).toBeCloseTo(0.1625, 4) // 6500 × 2.5 × 1e-5
    expect(floor).toBeCloseTo(-0.125, 4) // -5000 × 2.5 × 1e-5
    expect(sea).toBeCloseTo(0, 6)
  })

  it('海平面归一化值反解回 0 米', () => {
    const hSea = (META.seaLevelMeters - META.elevationMin) / (META.elevationMax - META.elevationMin)
    expect(heightToMeters(hSea, META)).toBeCloseTo(0, 6)
  })

  it('CPU 查询与 shader uniform 公式一致（误差 ≪ 1e-4，满足 M1 验收）', () => {
    const u = computeHeightUniforms(META)
    for (const h of [0, 0.25, 0.5, 0.75, 1, 0.43478]) {
      const cpu = heightToWorldY(h, META)
      const shader = h * u.scale + u.offset // GLSL: worldY = h * uHeightScale + uHeightOffset
      expect(Math.abs(cpu - shader)).toBeLessThan(1e-9)
    }
  })
})
