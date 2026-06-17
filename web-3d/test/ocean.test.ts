import { describe, it, expect } from 'vitest'
import * as THREE from 'three'
import {
  PLANE_WIDTH,
  PLANE_HEIGHT,
  metersToWorldY,
} from '../src/config/projection'
import { palette } from '../src/config/palette'
import { qualityConfigs, defaultQualityTier } from '../src/config/quality'
import {
  OCEAN_SEGMENTS,
  OCEAN_RENDER_ORDER,
  OCEAN_MATERIAL_OPTS,
  OCEAN_OPACITY,
  OCEAN_MAX_DEPTH_METERS,
  MAX_OCEAN_WAVES,
  seaLevelWorldY,
  createOceanMaterial,
  buildGerstnerWaves,
  oceanDepthFactor,
  oceanFresnel,
} from '../src/three/ocean/oceanMaterial'
import type { TerrainAssets } from '../src/data/types'

/** 构造最小可用 assets（createOceanMaterial 读 meta + heightTexture；heightTexture 用占位对象）。 */
function mockAssets(seaLevelMeters = 0): TerrainAssets {
  return {
    meta: {
      elevationMin: -10000,
      elevationMax: 9000,
      seaLevelMeters,
      width: 4096,
      height: 2048,
    },
    heightTexture: {} as THREE.Texture,
    normalTexture: {} as THREE.Texture,
    elevation: { width: 4096, height: 2048, data: new Uint16Array(0) },
  } as unknown as TerrainAssets
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

describe('透明渲染顺序契约（SPEC §4.3 修正点，M2 风险验证 #1，Task 07 不退化）', () => {
  it('Ocean 材质 transparent=true（Three.js 据此后绘透明物体）', () => {
    expect(OCEAN_MATERIAL_OPTS.transparent).toBe(true)
    expect(createOceanMaterial(mockAssets()).transparent).toBe(true)
  })

  it('Ocean 材质 depthWrite=false（不污染深度缓冲）', () => {
    expect(OCEAN_MATERIAL_OPTS.depthWrite).toBe(false)
    expect(createOceanMaterial(mockAssets()).depthWrite).toBe(false)
  })

  it('Ocean 材质 DoubleSide（掠射角两面可见，波浪亦需）', () => {
    expect(OCEAN_MATERIAL_OPTS.side).toBe(THREE.DoubleSide)
    expect(createOceanMaterial(mockAssets()).side).toBe(THREE.DoubleSide)
  })

  it('Ocean 材质 depthTest=true（与 Terrain 已写深度比较 → 陆地遮挡海洋、海床被覆盖）', () => {
    expect(createOceanMaterial(mockAssets()).depthTest).toBe(true)
  })

  it('Ocean renderOrder > 0（Terrain 默认 0 先绘写深度，Ocean 后绘）', () => {
    expect(OCEAN_RENDER_ORDER).toBeGreaterThan(0)
  })

  it('Ocean 半透明（0 < opacity < 1，可见海床纵深）', () => {
    expect(OCEAN_OPACITY).toBeGreaterThan(0)
    expect(OCEAN_OPACITY).toBeLessThan(1)
    expect(createOceanMaterial(mockAssets()).uniforms.uOpacity.value).toBeCloseTo(
      OCEAN_OPACITY,
      5,
    )
  })
})

describe('Gerstner 波参数（SPEC §6.2.1 / D8）', () => {
  it('数组长度恒为 MAX_OCEAN_WAVES（GLSL uniform 数组定长）', () => {
    const w = buildGerstnerWaves(5)
    expect(w.dirs).toHaveLength(MAX_OCEAN_WAVES)
    expect(w.amps).toHaveLength(MAX_OCEAN_WAVES)
    expect(w.freqs).toHaveLength(MAX_OCEAN_WAVES)
    expect(w.speeds).toHaveLength(MAX_OCEAN_WAVES)
    expect(w.steeps).toHaveLength(MAX_OCEAN_WAVES)
  })

  it('方向向量单位化', () => {
    const w = buildGerstnerWaves(5)
    for (const d of w.dirs) {
      expect(d.length()).toBeCloseTo(1, 6)
    }
  })

  it('高档(5)：count=5，5 波全活跃且陡度 Q∈(0,1]（Gerstner 尖峰）', () => {
    const w = buildGerstnerWaves(5)
    expect(w.count).toBe(5)
    for (let i = 0; i < 5; i++) {
      expect(w.amps[i]).toBeGreaterThan(0)
      expect(w.steeps[i]).toBeGreaterThan(0)
      expect(w.steeps[i]).toBeLessThanOrEqual(1)
    }
  })

  it('中档(3)：count=3，前 3 波活跃、后 2 波置零', () => {
    const w = buildGerstnerWaves(3)
    expect(w.count).toBe(3)
    for (let i = 0; i < 3; i++) expect(w.amps[i]).toBeGreaterThan(0)
    for (let i = 3; i < MAX_OCEAN_WAVES; i++) {
      expect(w.amps[i]).toBe(0)
      expect(w.steeps[i]).toBe(0)
    }
  })

  it('低档(0)降级为正弦波：count=1 且 steep[0]=0（SPEC §6.2.1）', () => {
    const w = buildGerstnerWaves(0)
    expect(w.count).toBe(1)
    expect(w.amps[0]).toBeGreaterThan(0)
    expect(w.steeps[0]).toBe(0)
    for (let i = 1; i < MAX_OCEAN_WAVES; i++) expect(w.amps[i]).toBe(0)
  })

  it('振幅随波序递减（主浪→涟漪，自然叠加）', () => {
    const w = buildGerstnerWaves(5)
    for (let i = 1; i < 5; i++) {
      expect(w.amps[i]).toBeLessThanOrEqual(w.amps[i - 1])
    }
  })

  it('波幅为世界 Y 尺度（≪ 地形起伏 ±0.16，柔和浪涌不刺穿陆地）', () => {
    const w = buildGerstnerWaves(5)
    const sumAmp = w.amps.reduce((a, b) => a + b, 0)
    expect(sumAmp).toBeLessThan(0.05)
    expect(Math.max(...w.amps)).toBeLessThan(0.01)
  })
})

describe('深浅渐变因子（SPEC §6.2.3，与 GLSL 同源）', () => {
  const maxD = metersToWorldY(OCEAN_MAX_DEPTH_METERS)

  it('海平面(terrainY=0) → 0（最浅）', () => {
    expect(oceanDepthFactor(0, maxD)).toBe(0)
  })

  it('陆地上方(terrainY>0) → clamp 0（陆地本就被 depthTest 遮挡）', () => {
    expect(oceanDepthFactor(0.05, maxD)).toBe(0)
  })

  it('深海(terrainY=-maxD) → 1（最深，饱和深青绿）', () => {
    expect(oceanDepthFactor(-maxD, maxD)).toBeCloseTo(1, 6)
  })

  it('更深 → clamp 1', () => {
    expect(oceanDepthFactor(-maxD * 2, maxD)).toBe(1)
  })

  it('半深(-maxD/2) → 0.5（线性插值浅→深）', () => {
    expect(oceanDepthFactor(-maxD / 2, maxD)).toBeCloseTo(0.5, 6)
  })
})

describe('菲涅尔因子（SPEC §6.2.2，与 GLSL 同源）', () => {
  it('正视(N·V=1) → 0（无掠射微光）', () => {
    expect(oceanFresnel(1)).toBeCloseTo(0, 6)
  })

  it('掠射(N·V=0) → 1（最大亮青绿）', () => {
    expect(oceanFresnel(0)).toBe(1)
  })

  it('背离(N·V<0) → clamp 1（max(·,0)=0 → pow(1,3)=1）', () => {
    expect(oceanFresnel(-1)).toBe(1)
  })

  it('单调：N·V 越小菲涅尔越大（掠射越亮）', () => {
    expect(oceanFresnel(0.8)).toBeLessThan(oceanFresnel(0.2))
  })
})

describe('海洋材质 uniforms（Task 07 接管，SPEC §6.2）', () => {
  it('默认波数 = 高档 oceanWaves（M2 默认高档，M3 改 store 不动 shader）', () => {
    const m = createOceanMaterial(mockAssets())
    expect(m.uniforms.uWaveCount.value).toBe(qualityConfigs[defaultQualityTier].oceanWaves)
  })

  it('opts.waveCount 覆盖波数（开关位）', () => {
    expect(createOceanMaterial(mockAssets(), { waveCount: 3 }).uniforms.uWaveCount.value).toBe(3)
    expect(createOceanMaterial(mockAssets(), { waveCount: 0 }).uniforms.uWaveCount.value).toBe(1)
  })

  it('浅/深色取自 palette（SPEC §2.1）', () => {
    const m = createOceanMaterial(mockAssets())
    expect(m.uniforms.uColorShallow.value.getHexString()).toBe(
      palette.oceanShallow.replace('#', '').toLowerCase(),
    )
    expect(m.uniforms.uColorDeep.value.getHexString()).toBe(
      palette.oceanDeep.replace('#', '').toLowerCase(),
    )
  })

  it('uTime 初始 0（Ocean useFrame 每帧累加驱动流动）', () => {
    expect(createOceanMaterial(mockAssets()).uniforms.uTime.value).toBe(0)
  })

  it('uMaxDepth = metersToWorldY(OCEAN_MAX_DEPTH_METERS)', () => {
    const m = createOceanMaterial(mockAssets())
    expect(m.uniforms.uMaxDepth.value).toBeCloseTo(metersToWorldY(OCEAN_MAX_DEPTH_METERS), 9)
  })

  it('复用同源 heightmap 纹理（深浅渐变 per-pixel 采样）', () => {
    const assets = mockAssets()
    const tex = new THREE.Texture()
    assets.heightTexture = tex
    expect(createOceanMaterial(assets).uniforms.uHeightmap.value).toBe(tex)
  })

  it('shader 源码含 Gerstner/菲涅尔/深浅关键逻辑（防回归）', () => {
    const m = createOceanMaterial(mockAssets())
    expect(m.vertexShader).toMatch(/uWaveCount/)
    expect(m.vertexShader).toMatch(/dispY/)
    expect(m.fragmentShader).toMatch(/pow\(1\.0 - max\(dot/)
    expect(m.fragmentShader).toMatch(/clamp\(-terrainY/)
  })
})

describe('海平面世界 Y（Task 03 契约：seaLevelMeters → 世界 Y，R3 同源）', () => {
  it('seaLevel=0 → 世界 Y=0（海平面即 y=0，体积感由 Gerstner 波振幅提供不破坏契约）', () => {
    expect(seaLevelWorldY(mockAssets(0))).toBe(0)
  })

  it('与 metersToWorldY(seaLevelMeters) 同源', () => {
    for (const s of [0, 50, 100, -20]) {
      expect(seaLevelWorldY(mockAssets(s))).toBeCloseTo(metersToWorldY(s), 9)
    }
  })
})
