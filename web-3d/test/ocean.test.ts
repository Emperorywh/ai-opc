import { describe, it, expect } from 'vitest'
import * as THREE from 'three'
import {
  PLANE_WIDTH,
  PLANE_HEIGHT,
  metersToWorldY,
} from '../src/config/projection'
import {
  OCEAN_SEGMENTS,
  OCEAN_MATERIAL_PROPS,
  OCEAN_RENDER_ORDER,
  seaLevelWorldY,
} from '../src/three/ocean/oceanMaterial'
import type { TerrainAssets } from '../src/data/types'

/** 构造仅含 seaLevelMeters 的最小 assets（seaLevelWorldY 只读该字段）。 */
function mockAssets(seaLevelMeters = 0): TerrainAssets {
  return { meta: { seaLevelMeters } } as unknown as TerrainAssets
}

describe('Ocean 几何（平面同地形尺寸，SPEC §6.2 / Task 06）', () => {
  it('PlaneGeometry 顶点数 = (segX+1)·(segY+1)', () => {
    const geo = new THREE.PlaneGeometry(
      PLANE_WIDTH,
      PLANE_HEIGHT,
      OCEAN_SEGMENTS.x,
      OCEAN_SEGMENTS.y,
    )
    expect(geo.attributes.position.count).toBe(
      (OCEAN_SEGMENTS.x + 1) * (OCEAN_SEGMENTS.y + 1),
    )
  })

  it('平面尺寸覆盖 PLANE_WIDTH × PLANE_HEIGHT（与地形同源）', () => {
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

describe('透明渲染顺序契约（SPEC §4.3 修正点，M2 风险验证 #1）', () => {
  it('Ocean 材质 transparent=true（Three.js 据此后绘透明物体）', () => {
    expect(OCEAN_MATERIAL_PROPS.transparent).toBe(true)
  })

  it('Ocean 材质 depthWrite=false（不污染深度缓冲，不遮挡后续透明物体）', () => {
    expect(OCEAN_MATERIAL_PROPS.depthWrite).toBe(false)
  })

  it('Ocean renderOrder > 0（Terrain 默认 0 先绘写深度，Ocean 后绘）', () => {
    expect(OCEAN_RENDER_ORDER).toBeGreaterThan(0)
  })

  it('Ocean 半透明（0 < opacity < 1，可见海床纵深）', () => {
    expect(OCEAN_MATERIAL_PROPS.opacity).toBeGreaterThan(0)
    expect(OCEAN_MATERIAL_PROPS.opacity).toBeLessThan(1)
  })

  it('MeshBasicMaterial 按契约构建（transparent/depthWrite/opacity 落地）', () => {
    const mat = new THREE.MeshBasicMaterial({ ...OCEAN_MATERIAL_PROPS })
    expect(mat.transparent).toBe(true)
    expect(mat.depthWrite).toBe(false)
    expect(mat.opacity).toBeCloseTo(OCEAN_MATERIAL_PROPS.opacity, 5)
    // depthTest 默认 true：与 Terrain 已写深度比较 → 陆地遮挡海洋、海床被覆盖
    expect(mat.depthTest).toBe(true)
  })

  it('海洋颜色取自 palette.oceanShallow（青绿，SPEC §2.1）', () => {
    expect(OCEAN_MATERIAL_PROPS.color).toMatch(/^#7FC4C0$/i)
  })
})

describe('海平面世界 Y（Task 03 契约：seaLevelMeters → 世界 Y，R3 同源）', () => {
  it('seaLevel=0 → 世界 Y=0（海平面即 y=0）', () => {
    expect(seaLevelWorldY(mockAssets(0))).toBe(0)
  })

  it('与 metersToWorldY(seaLevelMeters) 同源', () => {
    for (const s of [0, 50, 100, -20]) {
      expect(seaLevelWorldY(mockAssets(s))).toBeCloseTo(metersToWorldY(s), 9)
    }
  })
})
