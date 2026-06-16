import { describe, it, expect } from 'vitest'
import {
  PLANE_WIDTH,
  PLANE_HEIGHT,
  HEIGHT_EXAGGERATION,
  WORLD_Y_PER_METER,
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

describe('project', () => {
  it('经度 → x ∈ [-1,1]（边界 + 原点）', () => {
    expect(project(-180, 0)[0]).toBe(-1)
    expect(project(180, 0)[0]).toBe(1)
    expect(project(0, 0)[0]).toBe(0)
  })

  it('纬度 → z ∈ [-0.5,0.5]，向北 -z（边界 + 原点）', () => {
    expect(project(0, 90)[1]).toBeCloseTo(-0.5, 10) // 北极 → -z
    expect(project(0, -90)[1]).toBeCloseTo(0.5, 10) // 南极 → +z
    // 原点 z 数值为 0（−0/90×0.5 = −0，算术上 === 0，用容差比较）
    expect(Object.is(project(0, 0)[1], -0) || project(0, 0)[1] === 0).toBe(true)
    expect(project(0, 90)[0]).toBe(0)
  })

  it('采样点数值正确（北京 / 纽约 / 安第斯）', () => {
    const beijing = project(116.4, 39.9)
    expect(beijing[0]).toBeCloseTo(116.4 / 180, 6)
    expect(beijing[1]).toBeCloseTo((-(39.9 / 90)) * 0.5, 6)

    const ny = project(-74, 40.7)
    expect(ny[0]).toBeCloseTo(-74 / 180, 6)

    const andes = project(-70, -15)
    expect(andes[1]).toBeGreaterThan(0) // 南纬 → +z
  })

  it('unproject 是 project 的反函数', () => {
    const samples: Array<[number, number]> = [
      [0, 0],
      [-180, -90],
      [180, 90],
      [116.4, 39.9],
      [-70, -15],
      [-74, 40.7],
    ]
    for (const [lon, lat] of samples) {
      const [x, z] = project(lon, lat)
      const [lon2, lat2] = unproject(x, z)
      expect(lon2).toBeCloseTo(lon, 9)
      expect(lat2).toBeCloseTo(lat, 9)
    }
  })

  it('平面尺寸常量正确', () => {
    expect(PLANE_WIDTH).toBe(2.0)
    expect(PLANE_HEIGHT).toBe(1.0)
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
