import { describe, it, expect } from 'vitest'
import * as THREE from 'three'
import {
  PLANE_WIDTH,
  PLANE_HEIGHT,
  heightToWorldY,
  computeHeightUniforms,
  type ElevationMeta,
} from '../src/config/projection'
import { TERRAIN_SEGMENTS, shaderWorldY } from '../src/three/terrain/terrainMaterial'

/** 与 Task 02 合成 DEM 的 meta.json 一致。 */
const META: ElevationMeta = {
  elevationMin: -5000,
  elevationMax: 6500,
  seaLevelMeters: 0,
  width: 1024,
  height: 512,
}

describe('Terrain 网格（顶点数符合配置，SPEC §6.1）', () => {
  it('PlaneGeometry 顶点数 = (segX+1)·(segY+1)', () => {
    const geo = new THREE.PlaneGeometry(
      PLANE_WIDTH,
      PLANE_HEIGHT,
      TERRAIN_SEGMENTS.x,
      TERRAIN_SEGMENTS.y,
    )
    expect(geo.attributes.position.count).toBe(
      (TERRAIN_SEGMENTS.x + 1) * (TERRAIN_SEGMENTS.y + 1),
    )
  })

  it('M1 默认密度 = 512×256（≈13 万顶点）', () => {
    expect(TERRAIN_SEGMENTS.x).toBe(512)
    expect(TERRAIN_SEGMENTS.y).toBe(256)
  })

  it('平面尺寸覆盖 PLANE_WIDTH × PLANE_HEIGHT', () => {
    const geo = new THREE.PlaneGeometry(PLANE_WIDTH, PLANE_HEIGHT, 2, 2)
    const pos = geo.attributes.position
    let minX = Infinity
    let maxX = -Infinity
    let minY = Infinity
    let maxY = -Infinity
    for (let i = 0; i < pos.count; i++) {
      minX = Math.min(minX, pos.getX(i))
      maxX = Math.max(maxX, pos.getX(i))
      minY = Math.min(minY, pos.getY(i))
      maxY = Math.max(maxY, pos.getY(i))
    }
    expect(maxX - minX).toBeCloseTo(PLANE_WIDTH, 6)
    expect(maxY - minY).toBeCloseTo(PLANE_HEIGHT, 6)
  })
})

describe('最大高差 > 0（地形有起伏，M1 验收）', () => {
  it('峰值世界 Y(6500m) - 海沟世界 Y(-5000m) > 0', () => {
    const peak = heightToWorldY(1, META) // elevationMax
    const floor = heightToWorldY(0, META) // elevationMin
    expect(peak - floor).toBeGreaterThan(0)
    expect(peak - floor).toBeCloseTo(0.1625 - -0.125, 4) // 11500m × 2.5 × 1e-5
  })
})

describe('shader 位移公式与 CPU 同源（R3，误差 < 1e-4）', () => {
  it('shaderWorldY(h, uniforms) == heightToWorldY(h, meta)，≪ 1e-4', () => {
    const u = computeHeightUniforms(META)
    for (const h of [0, 0.1, 0.25, 0.43478, 0.5, 0.75, 1]) {
      const gpu = shaderWorldY(h, u.scale, u.offset)
      const cpu = heightToWorldY(h, META)
      expect(Math.abs(gpu - cpu)).toBeLessThan(1e-9)
    }
  })
})
