import { describe, it, expect } from 'vitest'
import * as THREE from 'three'
import {
  PLANE_WIDTH,
  PLANE_HEIGHT,
  heightToWorldY,
  computeHeightUniforms,
  type ElevationMeta,
} from '../src/config/projection'
import { palette, desaturateHex } from '../src/config/palette'
import {
  TERRAIN_SEGMENTS,
  TERRAIN_EFFECTS,
  shaderWorldY,
  shaderSlopeFactor,
  shaderRimFactor,
  shaderCoastlineFactor,
  shaderDetailNormalDecode,
  createTerrainMaterial,
} from '../src/three/terrain/terrainMaterial'
import type { TerrainAssets } from '../src/data/types'

/** 构造最小可用 assets（createTerrainMaterial 读 meta + heightTexture + normalTexture）。 */
function mockAssets(): TerrainAssets {
  return {
    meta: {
      elevationMin: -5000,
      elevationMax: 6500,
      seaLevelMeters: 0,
      width: 1024,
      height: 512,
    },
    heightTexture: {} as THREE.Texture,
    normalTexture: {} as THREE.Texture,
    elevation: { width: 1024, height: 512, data: new Uint16Array(0) },
  } as unknown as TerrainAssets
}

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

// ===========================================================================
// Task 08 —— 地形水彩 shader 完善（SPEC §2.2 / §2.4 / §6.1.3 / §2.1）
// ===========================================================================

describe('坡度强调因子（§2.2.3，与 GLSL 同源）', () => {
  it('平地(N.y=1) → 0（缓坡保持草绿）', () => {
    expect(shaderSlopeFactor(1)).toBe(0)
  })

  it('陡崖(N.y=0) → 1（偏暖灰绿）', () => {
    expect(shaderSlopeFactor(0)).toBe(1)
  })

  it('N.y<0 clamp 后仍 → 1（法线朝下视为最陡）', () => {
    expect(shaderSlopeFactor(-0.5)).toBe(1)
  })

  it('单调：N.y 越小（越陡）权重越大', () => {
    expect(shaderSlopeFactor(0.9)).toBeLessThan(shaderSlopeFactor(0.5))
    expect(shaderSlopeFactor(0.5)).toBeLessThan(shaderSlopeFactor(0.1))
  })
})

describe('软描边轮廓因子（§2.2.4，与 GLSL 同源）', () => {
  it('正视(N·V=1) → 0（无 rim）', () => {
    expect(shaderRimFactor(1)).toBeCloseTo(0, 6)
  })

  it('掠射(N·V=0) → 1（最大暖白 rim）', () => {
    expect(shaderRimFactor(0)).toBe(1)
  })

  it('背离(N·V<0) → clamp 1', () => {
    expect(shaderRimFactor(-1)).toBe(1)
  })

  it('单调：N·V 越小 rim 越亮', () => {
    expect(shaderRimFactor(0.8)).toBeLessThan(shaderRimFactor(0.3))
  })
})

describe('海岸线等高线因子（§2.4，与 GLSL 同源）', () => {
  it('海平面(y=0) → 1（满描边）', () => {
    expect(shaderCoastlineFactor(0, 0.01)).toBe(1)
  })

  it('远离海岸(y≫lineWidth) → 0（无描边）', () => {
    expect(shaderCoastlineFactor(0.1, 0.01)).toBe(0)
  })

  it('lineWidth=0 → 0（关闭开关）', () => {
    expect(shaderCoastlineFactor(0, 0)).toBe(0)
  })

  it('半程(y=lineWidth/2) → 介于 0/1 之间（抗锯齿过渡）', () => {
    const v = shaderCoastlineFactor(0.005, 0.01)
    expect(v).toBeGreaterThan(0)
    expect(v).toBeLessThan(1)
  })
})

describe('normal.png 细节法线解码（§6.1.3，与 GLSL 同源）', () => {
  it('平地纹理 (128,128,255)/255 → 世界法线 ≈ (0,1,0) 朝上', () => {
    // 烘焙编码：nz=1 → B=255；nx=ny=0 → R=G=128。
    // ⚠️ 8-bit 烘焙 round(n·127.5+127.5) 把 n=0 落到 128，反解 128/255·2-1=0.0039 有量化残差（可忽略）；
    // B=255 反解为精确 1.0，故 worldY 主导。容差放宽至 2 位小数。
    const [x, y, z] = shaderDetailNormalDecode(128 / 255, 128 / 255, 255 / 255)
    expect(x).toBeCloseTo(0, 2)
    expect(y).toBeCloseTo(1, 3)
    expect(z).toBeCloseTo(0, 2)
  })

  it('返回为单位向量（长度 ≈ 1）', () => {
    for (const [r, g, b] of [
      [0.6, 0.5, 0.9],
      [0.3, 0.7, 0.8],
      [0.9, 0.4, 0.6],
    ]) {
      const [x, y, z] = shaderDetailNormalDecode(r, g, b)
      expect(Math.hypot(x, y, z)).toBeCloseTo(1, 5)
    }
  })

  it('R 通道编码 worldX（向东倾斜 → X>0）', () => {
    // R=1 → nx=1（世界 X 法线分量 +1）
    const [x] = shaderDetailNormalDecode(1, 0.5, 0.5)
    expect(x).toBeGreaterThan(0)
  })

  it('通道顺序 R=X / G=Z / B=Y（非 R=X/G=Y/B=Z）', () => {
    // 仅 B 偏离 0.5 → 仅 worldY 非零（验证 B=Y 而非 G=Y）
    const [x, y, z] = shaderDetailNormalDecode(0.5, 0.5, 1)
    expect(x).toBeCloseTo(0, 5)
    expect(y).toBeCloseTo(1, 5) // B=1 → worldY
    expect(z).toBeCloseTo(0, 5)
  })
})

describe('水彩效果开关（SPEC §8 / D18，M3 uniform 钩子）', () => {
  it('高档默认全开（slope/noise/coastline/rim = 1，detail=0.3）', () => {
    expect(TERRAIN_EFFECTS.slopeEmphasis).toBe(1)
    expect(TERRAIN_EFFECTS.watercolorNoise).toBe(1)
    expect(TERRAIN_EFFECTS.coastline).toBe(1)
    expect(TERRAIN_EFFECTS.rimOutline).toBe(1)
    expect(TERRAIN_EFFECTS.detailNormal).toBe(0.3)
  })

  it('材质 uniforms 含全部 5 个开关（默认 = 高档）', () => {
    const m = createTerrainMaterial(mockAssets())
    expect(m.uniforms.uSlopeEmphasis.value).toBe(TERRAIN_EFFECTS.slopeEmphasis)
    expect(m.uniforms.uWatercolorNoise.value).toBe(TERRAIN_EFFECTS.watercolorNoise)
    expect(m.uniforms.uCoastline.value).toBe(TERRAIN_EFFECTS.coastline)
    expect(m.uniforms.uRimOutline.value).toBe(TERRAIN_EFFECTS.rimOutline)
    expect(m.uniforms.uDetailNormal.value).toBe(TERRAIN_EFFECTS.detailNormal)
  })

  it('opts 覆盖单个开关（低档可关，M3 经 store 注入）', () => {
    const m = createTerrainMaterial(mockAssets(), {
      watercolorNoise: 0,
      rimOutline: 0,
      detailNormal: 0,
    })
    expect(m.uniforms.uWatercolorNoise.value).toBe(0)
    expect(m.uniforms.uRimOutline.value).toBe(0)
    expect(m.uniforms.uDetailNormal.value).toBe(0)
    // 未覆盖的保持默认
    expect(m.uniforms.uSlopeEmphasis.value).toBe(TERRAIN_EFFECTS.slopeEmphasis)
  })

  it('detailNormal ∈ [0,1] 范围（blend 权重）', () => {
    expect(TERRAIN_EFFECTS.detailNormal).toBeGreaterThanOrEqual(0)
    expect(TERRAIN_EFFECTS.detailNormal).toBeLessThanOrEqual(1)
  })
})

describe('palette 完整接入 + 低饱和（§2.1，Task 08）', () => {
  it('地形分层色源自 palette（经 desaturateHex 降饱和）', () => {
    const m = createTerrainMaterial(mockAssets())
    // beach ← desert[0]，plain ← grassland[0]，hill ← mountain[1]，mountain ← mountain[0]
    expect(m.uniforms.uColorBeach.value.getHexString()).toBe(
      desaturateHex(palette.desert[0]).replace('#', '').toLowerCase(),
    )
    expect(m.uniforms.uColorPlain.value.getHexString()).toBe(
      desaturateHex(palette.grassland[0]).replace('#', '').toLowerCase(),
    )
    expect(m.uniforms.uColorHill.value.getHexString()).toBe(
      desaturateHex(palette.mountain[1]).replace('#', '').toLowerCase(),
    )
    expect(m.uniforms.uColorMtn.value.getHexString()).toBe(
      desaturateHex(palette.mountain[0]).replace('#', '').toLowerCase(),
    )
  })

  it('雪线色源自 palette.snow（降饱和）', () => {
    const m = createTerrainMaterial(mockAssets())
    expect(m.uniforms.uColorSnow.value.getHexString()).toBe(
      desaturateHex(palette.snow).replace('#', '').toLowerCase(),
    )
  })

  it('海岸线/rim 描边色源自 palette.border（暖白，降饱和）', () => {
    const m = createTerrainMaterial(mockAssets())
    const coast = desaturateHex(palette.border).replace('#', '').toLowerCase()
    expect(m.uniforms.uColorCoast.value.getHexString()).toBe(coast)
    expect(m.uniforms.uColorRim.value.getHexString()).toBe(coast)
  })

  it('地形色为低饱和（S 已降，≠ palette 原始高饱和值）', () => {
    // grassland[0] 原始 vs 降饱和后不同（确认 S 确实被降低）
    expect(desaturateHex(palette.grassland[0])).not.toBe(palette.grassland[0])
    expect(desaturateHex(palette.mountain[0])).not.toBe(palette.mountain[0])
  })
})

describe('normal.png 细节增强接入（§6.1.3，Task 08）', () => {
  it('材质复用 assets.normalTexture', () => {
    const assets = mockAssets()
    const tex = new THREE.Texture()
    assets.normalTexture = tex
    expect(createTerrainMaterial(assets).uniforms.uNormalMap.value).toBe(tex)
  })

  it('高度/法线共享同源 heightmap UV（顶点 varying vHeightUv）', () => {
    const m = createTerrainMaterial(mockAssets())
    expect(m.vertexShader).toMatch(/vHeightUv/)
    expect(m.fragmentShader).toMatch(/uNormalMap/)
  })
})

describe('shader 源码含水彩五要素（防回归，Task 08）', () => {
  const frag = () => createTerrainMaterial(mockAssets()).fragmentShader

  it('坡度强调 smoothstep on slope', () => {
    expect(frag()).toMatch(/slope = 1.0 - clamp\(N.y/)
    expect(frag()).toMatch(/smoothstep\(0.30, 0.65, slope\)/)
  })

  it('水彩噪声 hash fbm', () => {
    expect(frag()).toMatch(/float fbm/)
    expect(frag()).toMatch(/hash21/)
    expect(frag()).toMatch(/uWatercolorNoise/)
  })

  it('海岸线 fwidth 等高线', () => {
    expect(frag()).toMatch(/fwidth\(vWorldY\)/)
    expect(frag()).toMatch(/smoothstep\(0.0, lineWidth, abs\(vWorldY\)\)/)
  })

  it('软描边轮廓 pow(1-dot(N,V),2)', () => {
    expect(frag()).toMatch(/pow\(1.0 - max\(dot\(N, normalize\(vViewDir\)\), 0.0\), 2.0\)/)
  })

  it('normal.png 细节法线解码 R=X/G=Z/B=Y', () => {
    expect(frag()).toMatch(/vec3\(nrgb.r \* 2.0 - 1.0, nrgb.b \* 2.0 - 1.0, nrgb.g \* 2.0 - 1.0\)/)
  })

  it('既有 Lambert 光照不退化（半球 + 方向光）', () => {
    expect(frag()).toMatch(/mix\(uGroundColor, uSkyColor/)
    expect(frag()).toMatch(/max\(dot\(N, normalize\(uLightDir\)\), 0.0\)/)
  })

  it('sRGB encode 保留（raw material 手动 gamma）', () => {
    expect(frag()).toMatch(/pow\(linear, vec3\(1.0 \/ 2.2\)\)/)
  })
})

describe('既有契约不退化（Task 04/06/07）', () => {
  it('terrainLight 导出未变（Scene.tsx 依赖）', () => {
    // 间接：createTerrainMaterial 仍能从 terrainLight 取光照参数建材质
    const m = createTerrainMaterial(mockAssets())
    expect(m.uniforms.uLightIntensity.value).toBeGreaterThan(0)
    expect(m.uniforms.uHemiIntensity.value).toBeGreaterThan(0)
  })

  it('shaderWorldY / TERRAIN_SEGMENTS 导出未变', () => {
    expect(typeof shaderWorldY).toBe('function')
    expect(TERRAIN_SEGMENTS.x).toBe(512)
  })

  it('Terrain 材质保持不透明（transparent 未开 → 先绘写深度，Ocean 后绘）', () => {
    const m = createTerrainMaterial(mockAssets())
    expect(m.transparent).toBe(false)
    expect(m.depthWrite).toBe(true)
  })
})
