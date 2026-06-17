/**
 * Task 20 · 国家边界渲染层单测（前端 decoder + 几何构建 + 材质契约）。
 *
 * 验证：
 *   · 前端 `decodeBoundaries`（src/data/boundaries.ts）与 pipeline `packBoundaries`（boundary-pack.mjs）
 *     等价：pipeline 打包的字节 → 前端解码 → 结构正确（magic/version/顶点/索引/国家属性/范围）
 *   · `buildBoundaryPositions`：lon,lat → project() 落 PLANE（R2 同源）+ y=max(地面,海面)+ε（贴地，R3 同源）
 *   · 材质 / 渲染序常量契约：半透明/depthWrite=false/renderOrder 顺序/低饱和色（SPEC §6.3/§4.3/§2.4）
 *   · 索引结构：fillIndices %3 / borderIndices %2（合成数据）
 *
 * 不渲染真实 WebGL（agent 无浏览器）；几何/材质契约编程可验证，dev 视觉轮廓观感留 Review。
 */
import { describe, it, expect } from 'vitest'
import * as THREE from 'three'
import { packBoundaries, packDisputed } from '../scripts/data-pipeline/lib/boundary-pack.mjs'
import { SYNTHETIC_COUNTRIES, SYNTHETIC_DISPUTED } from '../scripts/data-pipeline/lib/boundaries-data.mjs'
import { uniqueContinents } from '../scripts/data-pipeline/lib/boundary-source.mjs'
import {
  decodeBoundaries,
  decodeDisputed,
  BOUNDARIES_MAGIC,
  BOUNDARIES_VERSION,
  BOUNDARIES_LAYOUT,
  DISPUTED_MAGIC,
  DISPUTED_VERSION,
  DISPUTED_LAYOUT,
} from '../src/data/boundaries'
import {
  buildBoundaryPositions,
  buildDisputedSegments,
  BOUNDARY_Y_OFFSET,
  COUNTRY_FILL_COLOR,
  COUNTRY_FILL_OPACITY,
  COUNTRY_FILL_MATERIAL_OPTS,
  COUNTRY_FILL_RENDER_ORDER,
  BORDER_LINE_COLOR,
  BORDER_LINE_OPACITY,
  BORDER_LINE_WIDTH,
  BORDER_LINE_MATERIAL_OPTS,
  BORDER_LINE_RENDER_ORDER,
  DISPUTED_LINE_COLOR,
  DISPUTED_LINE_OPACITY,
  DISPUTED_DASH_SIZE,
  DISPUTED_GAP_SIZE,
  DISPUTED_LINE_MATERIAL_OPTS,
  DISPUTED_RENDER_ORDER,
} from '../src/three/borders/boundaryGeometry'
import {
  project,
  metersToWorldY,
  heightToWorldY,
  PLANE_WIDTH,
  PLANE_HEIGHT,
  type ElevationMeta,
} from '../src/config/projection'
import { sampleWorldY } from '../src/data/assets'
import { palette } from '../src/config/palette'
import { OCEAN_RENDER_ORDER } from '../src/three/ocean/oceanMaterial'
import type { BoundaryData, DisputedData, ElevationData } from '../src/data/types'
import {
  BOUNDARY_VARIANTS,
  DEFAULT_BOUNDARY_VARIANT,
  CURRENT_BOUNDARY_VARIANT,
  getBoundaryVariant,
  availableVariants,
  type BoundaryVariantId,
} from '../src/config/boundaryVariant'

// ---------------------------------------------------------------------------
// 辅助
// ---------------------------------------------------------------------------

function packSynthetic() {
  const continents = uniqueContinents(SYNTHETIC_COUNTRIES)
  return packBoundaries(SYNTHETIC_COUNTRIES, continents, { simplify: 0 })
}

function decodeSynthetic(): BoundaryData {
  return decodeBoundaries(packSynthetic().bytes)
}

/** 全均匀高程（value=归一化 h×65535）。 */
function flatElevation(width: number, height: number, value: number): ElevationData {
  return { width, height, data: new Uint16Array(width * height).fill(value) }
}

/** 最小 ElevationMeta（鸭子类型，与 projection.ElevationMeta 兼容）。 */
function meta(over: Partial<ElevationMeta> = {}): ElevationMeta {
  return {
    elevationMin: 0,
    elevationMax: 1000,
    seaLevelMeters: 0,
    width: 4,
    height: 2,
    ...over,
  }
}

// ---------------------------------------------------------------------------
// 前端 decoder ↔ pipeline pack 等价
// ---------------------------------------------------------------------------

describe('前端 decodeBoundaries（与 pipeline packBoundaries 等价）', () => {
  it('pipeline 打包字节 → 前端解码：顶点 / 索引 / 国家数与 pipeline stats 一致', () => {
    const { bytes, stats } = packSynthetic()
    const dec = decodeBoundaries(bytes)
    expect(dec.vertices.length).toBe(stats.vertexCount * 2)
    expect(dec.fillIndices.length).toBe(stats.fillIndexCount)
    expect(dec.borderIndices.length).toBe(stats.borderIndexCount)
    expect(dec.countries.length).toBe(stats.countryCount)
    expect(dec.continents.length).toBe(stats.continentCount)
  })

  it('解码成功隐含 magic/version 校验通过（错误则抛）', () => {
    const dec = decodeSynthetic()
    expect(BOUNDARIES_MAGIC).toBe('BDRT')
    expect(BOUNDARIES_VERSION).toBe(1)
    expect(dec.countries).toHaveLength(6)
  })

  it('国家属性：isoA3 / continent / continentIndex 正确', () => {
    const dec = decodeSynthetic()
    const isoSet = new Set(dec.countries.map((c) => c.isoA3))
    expect(isoSet.has('CHN')).toBe(true)
    expect(isoSet.has('USA')).toBe(true)
    const usa = dec.countries.find((c) => c.isoA3 === 'USA')!
    expect(usa.continent).toBe('North America')
    expect(dec.continents[usa.continentIndex]).toBe('North America')
  })

  it('id 为稳定记录序号 0..count-1', () => {
    const dec = decodeSynthetic()
    expect(dec.countries.map((c) => c.id)).toEqual(dec.countries.map((_, i) => i))
  })

  it('错误魔数抛错（坏数据不静默渲染）', () => {
    const { bytes } = packSynthetic()
    const bad = bytes.slice()
    bad[0] = 88
    expect(() => decodeBoundaries(bad)).toThrow(/魔数/)
  })

  it('顶点 lon,lat ∈ [-180,180]×[-90,90]', () => {
    const dec = decodeSynthetic()
    for (let i = 0; i < dec.vertices.length; i += 2) {
      expect(dec.vertices[i]).toBeGreaterThanOrEqual(-180)
      expect(dec.vertices[i]).toBeLessThanOrEqual(180)
      expect(dec.vertices[i + 1]).toBeGreaterThanOrEqual(-90)
      expect(dec.vertices[i + 1]).toBeLessThanOrEqual(90)
    }
  })

  it('每国家范围合法：索引在顶点池内 / 填充 %3 / 边界 %2', () => {
    const dec = decodeSynthetic()
    const vertexCount = dec.vertices.length / 2
    for (const c of dec.countries) {
      expect(c.vertexOffset + c.vertexCount).toBeLessThanOrEqual(vertexCount)
      expect(c.fillIndexCount % 3).toBe(0)
      expect(c.borderIndexCount % 2).toBe(0)
      for (let i = c.fillIndexOffset; i < c.fillIndexOffset + c.fillIndexCount; i++) {
        expect(dec.fillIndices[i]).toBeGreaterThanOrEqual(c.vertexOffset)
        expect(dec.fillIndices[i]).toBeLessThan(c.vertexOffset + c.vertexCount)
      }
      for (let i = c.borderIndexOffset; i < c.borderIndexOffset + c.borderIndexCount; i++) {
        expect(dec.borderIndices[i]).toBeGreaterThanOrEqual(c.vertexOffset)
        expect(dec.borderIndices[i]).toBeLessThan(c.vertexOffset + c.vertexCount)
      }
    }
  })

  it('USA MultiPolygon 顶点数 > CHN 单多边形（逐多边形三角化+多环描边生效）', () => {
    const dec = decodeSynthetic()
    const usa = dec.countries.find((c) => c.isoA3 === 'USA')!
    const chn = dec.countries.find((c) => c.isoA3 === 'CHN')!
    expect(usa.vertexCount).toBe(12) // 3 块领土 × 4 顶点
    expect(chn.vertexCount).toBe(4) // 单块矩形
    expect(usa.fillIndexCount / 3).toBeGreaterThan(chn.fillIndexCount / 3)
  })

  it('布局常量与 pipeline LAYOUT 子集逐字节一致', () => {
    expect(BOUNDARIES_LAYOUT.HEADER).toBe(28)
    expect(BOUNDARIES_LAYOUT.CONTINENT_NAME).toBe(16)
    expect(BOUNDARIES_LAYOUT.ISO_A3).toBe(4)
    expect(BOUNDARIES_LAYOUT.COUNTRY_RECORD).toBe(36)
  })
})

// ---------------------------------------------------------------------------
// buildBoundaryPositions（投影 + 贴地高度采样）
// ---------------------------------------------------------------------------

describe('buildBoundaryPositions（lon,lat → [x,y,z] 贴地）', () => {
  it('position 数 = 顶点数 × 3', () => {
    const dec = decodeSynthetic()
    const elev = flatElevation(4, 2, 32768)
    const positions = buildBoundaryPositions(dec, elev, meta())
    expect(positions.length).toBe((dec.vertices.length / 2) * 3)
  })

  it('x,z 落 PLANE（与 project() 同源 R2）', () => {
    const dec = decodeSynthetic()
    const elev = flatElevation(4, 2, 32768)
    const positions = buildBoundaryPositions(dec, elev, meta())
    for (let i = 0; i < dec.vertices.length / 2; i++) {
      const lon = dec.vertices[i * 2]
      const lat = dec.vertices[i * 2 + 1]
      const [px, pz] = project(lon, lat)
      expect(positions[i * 3]).toBeCloseTo(px, 6)
      expect(positions[i * 3 + 2]).toBeCloseTo(pz, 6)
      expect(px).toBeGreaterThanOrEqual(-PLANE_WIDTH / 2)
      expect(px).toBeLessThanOrEqual(PLANE_WIDTH / 2)
      expect(pz).toBeGreaterThanOrEqual(-PLANE_HEIGHT / 2)
      expect(pz).toBeLessThanOrEqual(PLANE_HEIGHT / 2)
    }
  })

  it('y = max(sampleWorldY, seaLevelWorldY) + ε（贴地，与 labelWorldPosition 同源）', () => {
    const dec = decodeSynthetic()
    const elev = flatElevation(4, 2, 32768)
    const m = meta({ elevationMin: 0, elevationMax: 1000, seaLevelMeters: 0 })
    const seaY = metersToWorldY(m.seaLevelMeters)
    const positions = buildBoundaryPositions(dec, elev, m)
    for (let i = 0; i < dec.vertices.length / 2; i++) {
      const lon = dec.vertices[i * 2]
      const lat = dec.vertices[i * 2 + 1]
      const groundY = sampleWorldY(elev, m, lon, lat)
      const expected = Math.max(groundY, seaY) + BOUNDARY_Y_OFFSET
      expect(positions[i * 3 + 1]).toBeCloseTo(expected, 6)
    }
  })

  it('陆地（groundY > seaY）：y = 地面高 + ε', () => {
    const dec = decodeSynthetic()
    const elev = flatElevation(4, 2, 32768) // h≈0.5
    const m = meta({ elevationMin: 0, elevationMax: 1000, seaLevelMeters: 0 })
    const positions = buildBoundaryPositions(dec, elev, m)
    // groundY = heightToWorldY(0.5) = metersToWorldY(500) = 0.0125 > seaY=0
    const expectedGround = heightToWorldY(32768 / 65535, m)
    expect(expectedGround).toBeGreaterThan(metersToWorldY(m.seaLevelMeters))
    expect(positions[1]).toBeCloseTo(expectedGround + BOUNDARY_Y_OFFSET, 5)
  })

  it('海底（groundY < seaY）：y 钳到海面 + ε（陆地/海面取较高者）', () => {
    const dec = decodeSynthetic()
    const elev = flatElevation(4, 2, 0) // h=0 → 最低
    const m = meta({ elevationMin: -5000, elevationMax: 1000, seaLevelMeters: 0 })
    const seaY = metersToWorldY(m.seaLevelMeters) // 0
    const positions = buildBoundaryPositions(dec, elev, m)
    // groundY = heightToWorldY(0, m) = metersToWorldY(-5000) = -0.125 < seaY=0 → 钳到 seaY
    expect(heightToWorldY(0, m)).toBeLessThan(seaY)
    for (let i = 0; i < dec.vertices.length / 2; i++) {
      expect(positions[i * 3 + 1]).toBeCloseTo(seaY + BOUNDARY_Y_OFFSET, 6)
    }
  })

  it('y 始终 ≥ 海面 + ε（防 z-fighting 浮起）', () => {
    const dec = decodeSynthetic()
    const elev = flatElevation(4, 2, 32768)
    const m = meta({ seaLevelMeters: 0 })
    const seaY = metersToWorldY(m.seaLevelMeters)
    const positions = buildBoundaryPositions(dec, elev, m)
    for (let i = 0; i < positions.length / 3; i++) {
      expect(positions[i * 3 + 1]).toBeGreaterThanOrEqual(seaY + BOUNDARY_Y_OFFSET - 1e-9)
    }
  })
})

// ---------------------------------------------------------------------------
// 材质 / 渲染序常量契约（SPEC §6.3 / §4.3 / §2.4）
// ---------------------------------------------------------------------------

describe('材质 / 渲染序常量契约', () => {
  it('填充：默认几乎不可见（opacity ≤ 0.2）', () => {
    expect(COUNTRY_FILL_OPACITY).toBeGreaterThan(0)
    expect(COUNTRY_FILL_OPACITY).toBeLessThanOrEqual(0.2)
  })

  it('填充材质：transparent + depthWrite=false + DoubleSide（§4.3 透明契约）', () => {
    expect(COUNTRY_FILL_MATERIAL_OPTS.transparent).toBe(true)
    expect(COUNTRY_FILL_MATERIAL_OPTS.depthWrite).toBe(false)
    expect(COUNTRY_FILL_MATERIAL_OPTS.side).toBe(THREE.DoubleSide)
  })

  it('填充色为合法 hex（低饱和）', () => {
    expect(() => new THREE.Color(COUNTRY_FILL_COLOR)).not.toThrow()
  })

  it('渲染序：填充 > Ocean（Terrain=0/Ocean=1/填充=2/描边=3）', () => {
    expect(COUNTRY_FILL_RENDER_ORDER).toBeGreaterThan(OCEAN_RENDER_ORDER)
    expect(BORDER_LINE_RENDER_ORDER).toBeGreaterThan(COUNTRY_FILL_RENDER_ORDER)
    expect(BORDER_LINE_RENDER_ORDER).toBeLessThan(10) // < AtmosphereRim 末项
  })

  it('描边：色 = palette.border 暖白，半透明，原生 linewidth=1', () => {
    expect(BORDER_LINE_COLOR).toBe(palette.border)
    expect(BORDER_LINE_OPACITY).toBeGreaterThan(0)
    expect(BORDER_LINE_OPACITY).toBeLessThan(1)
    expect(BORDER_LINE_WIDTH).toBe(1)
  })

  it('描边材质：transparent + depthWrite=false（后绘读 Terrain 深度）', () => {
    expect(BORDER_LINE_MATERIAL_OPTS.transparent).toBe(true)
    expect(BORDER_LINE_MATERIAL_OPTS.depthWrite).toBe(false)
  })

  it('BOUNDARY_Y_OFFSET > 0（防 z-fighting 浮起）', () => {
    expect(BOUNDARY_Y_OFFSET).toBeGreaterThan(0)
  })
})

// ---------------------------------------------------------------------------
// 索引结构（合成数据 → 渲染层几何合法性）
// ---------------------------------------------------------------------------

describe('索引结构（填充三角形 / 描边线段对）', () => {
  it('fillIndices %3 = 0 / borderIndices %2 = 0', () => {
    const dec = decodeSynthetic()
    expect(dec.fillIndices.length % 3).toBe(0)
    expect(dec.borderIndices.length % 2).toBe(0)
  })

  it('borderIndices 成对引用全局顶点池合法', () => {
    const dec = decodeSynthetic()
    const n = dec.vertices.length / 2
    for (let i = 0; i < dec.borderIndices.length; i++) {
      expect(dec.borderIndices[i]).toBeGreaterThanOrEqual(0)
      expect(dec.borderIndices[i]).toBeLessThan(n)
    }
  })
})

// ---------------------------------------------------------------------------
// Task 21 · 争议虚线：前端 decodeDisputed ↔ pipeline packDisputed 等价
// ---------------------------------------------------------------------------

describe('前端 decodeDisputed（与 pipeline packDisputed 等价）', () => {
  function packSyntheticDisputed() {
    return packDisputed(SYNTHETIC_DISPUTED, { simplify: 0 })
  }
  function decodeSyntheticDisputed(): DisputedData {
    return decodeDisputed(packSyntheticDisputed().bytes)
  }

  it('pipeline 打包字节 → 前端解码：顶点 / 线条数与 pipeline stats 一致', () => {
    const { bytes, stats } = packSyntheticDisputed()
    const dec = decodeDisputed(bytes)
    expect(dec.vertices.length).toBe(stats.vertexCount * 2)
    expect(dec.lines.length).toBe(stats.lineCount)
  })

  it('解码成功隐含 magic/version 校验通过', () => {
    const dec = decodeSyntheticDisputed()
    expect(DISPUTED_MAGIC).toBe('DSPT')
    expect(DISPUTED_VERSION).toBe(1)
    expect(dec.lines).toHaveLength(3) // kashmir / crimea / western-sahara
  })

  it('line 记录 id 正确（克什米尔 / 克里米亚 / 西撒哈拉）', () => {
    const dec = decodeSyntheticDisputed()
    expect(dec.lines.map((l) => l.id)).toEqual(['kashmir', 'crimea', 'western-sahara'])
  })

  it('每条 line 范围合法：顶点在全局池内 / vertexCount≥2', () => {
    const dec = decodeSyntheticDisputed()
    const vertexCount = dec.vertices.length / 2
    for (const l of dec.lines) {
      expect(l.vertexOffset + l.vertexCount).toBeLessThanOrEqual(vertexCount)
      expect(l.vertexCount).toBeGreaterThanOrEqual(2)
    }
  })

  it('顶点 lon,lat ∈ [-180,180]×[-90,90]', () => {
    const dec = decodeSyntheticDisputed()
    for (let i = 0; i < dec.vertices.length; i += 2) {
      expect(dec.vertices[i]).toBeGreaterThanOrEqual(-180)
      expect(dec.vertices[i]).toBeLessThanOrEqual(180)
      expect(dec.vertices[i + 1]).toBeGreaterThanOrEqual(-90)
      expect(dec.vertices[i + 1]).toBeLessThanOrEqual(90)
    }
  })

  it('错误魔数抛错（坏数据不静默渲染）', () => {
    const { bytes } = packSyntheticDisputed()
    const bad = bytes.slice()
    bad[0] = 88
    expect(() => decodeDisputed(bad)).toThrow(/魔数/)
  })

  it('布局常量与 pipeline LAYOUT.DISPUTED_* 逐字节一致', () => {
    expect(DISPUTED_LAYOUT.HEADER).toBe(16)
    expect(DISPUTED_LAYOUT.LINE_RECORD).toBe(24)
    expect(DISPUTED_LAYOUT.LINE_ID).toBe(16)
  })

  it('文件大小 = HEADER + vertices + lines（逐字节校验）', () => {
    const { bytes, stats } = packSyntheticDisputed()
    const expected =
      DISPUTED_LAYOUT.HEADER +
      stats.vertexCount * 2 * 4 +
      stats.lineCount * DISPUTED_LAYOUT.LINE_RECORD
    expect(bytes.length).toBe(expected)
  })
})

// ---------------------------------------------------------------------------
// Task 21 · buildDisputedSegments（折线 → lineSegments 顶点 + lineDistance）
// ---------------------------------------------------------------------------

describe('buildDisputedSegments（折线 → lineSegments 顶点 + lineDistance）', () => {
  function decodeSyntheticDisputed(): DisputedData {
    return decodeDisputed(packDisputed(SYNTHETIC_DISPUTED, { simplify: 0 }).bytes)
  }

  it('输出顶点数 = Σ(line.vertexCount−1)×2（每段 2 顶点，仅 vertexCount≥2 的线）', () => {
    const dec = decodeSyntheticDisputed()
    const elev = flatElevation(4, 2, 32768)
    const { positions, lineDistances } = buildDisputedSegments(dec, elev, meta())
    const expectedSegVerts = dec.lines
      .filter((l) => l.vertexCount >= 2)
      .reduce((sum, l) => sum + (l.vertexCount - 1) * 2, 0)
    expect(positions.length).toBe(expectedSegVerts * 3)
    expect(lineDistances.length).toBe(expectedSegVerts)
  })

  it('x,z 落 PLANE（与 project() 同源 R2）', () => {
    const dec = decodeSyntheticDisputed()
    const elev = flatElevation(4, 2, 32768)
    const { positions } = buildDisputedSegments(dec, elev, meta())
    for (let i = 0; i < positions.length / 3; i++) {
      expect(positions[i * 3]).toBeGreaterThanOrEqual(-PLANE_WIDTH / 2 - 1e-6)
      expect(positions[i * 3]).toBeLessThanOrEqual(PLANE_WIDTH / 2 + 1e-6)
      expect(positions[i * 3 + 2]).toBeGreaterThanOrEqual(-PLANE_HEIGHT / 2 - 1e-6)
      expect(positions[i * 3 + 2]).toBeLessThanOrEqual(PLANE_HEIGHT / 2 + 1e-6)
    }
  })

  it('y 始终 ≥ 海面 + ε（防 z-fighting 浮起，贴地）', () => {
    const dec = decodeSyntheticDisputed()
    const elev = flatElevation(4, 2, 32768)
    const m = meta({ elevationMin: 0, elevationMax: 1000, seaLevelMeters: 0 })
    const seaY = metersToWorldY(m.seaLevelMeters)
    const { positions } = buildDisputedSegments(dec, elev, m)
    for (let i = 0; i < positions.length / 3; i++) {
      expect(positions[i * 3 + 1]).toBeGreaterThanOrEqual(seaY + BOUNDARY_Y_OFFSET - 1e-9)
    }
  })

  it('海底顶点 y 钳到海面 + ε（陆地/海面取较高者）', () => {
    const dec = decodeSyntheticDisputed()
    const elev = flatElevation(4, 2, 0)
    const m = meta({ elevationMin: -5000, elevationMax: 1000, seaLevelMeters: 0 })
    const seaY = metersToWorldY(m.seaLevelMeters)
    const { positions } = buildDisputedSegments(dec, elev, m)
    for (let i = 0; i < positions.length / 3; i++) {
      expect(positions[i * 3 + 1]).toBeCloseTo(seaY + BOUNDARY_Y_OFFSET, 6)
    }
  })

  it('lineDistance 沿每条线单调递增、段间连续（段终点 = 下段起点 → 虚线连续不逐段断裂）', () => {
    const dec = decodeSyntheticDisputed()
    const elev = flatElevation(4, 2, 32768)
    const { lineDistances } = buildDisputedSegments(dec, elev, meta())
    let idx = 0
    for (const line of dec.lines) {
      if (line.vertexCount < 2) continue
      const segs = line.vertexCount - 1
      for (let s = 0; s < segs; s++) {
        const start = lineDistances[idx + s * 2]
        const end = lineDistances[idx + s * 2 + 1]
        expect(end).toBeGreaterThanOrEqual(start) // 段内单调（段长≥0）
        if (s < segs - 1) {
          // 下一段起点 = 当前段终点（累积连续，computeLineDistances 做不到）
          expect(lineDistances[idx + (s + 1) * 2]).toBeCloseTo(end, 6)
        }
      }
      idx += segs * 2
    }
  })

  it('每条线 lineDistance 从 0 重置（跨线 phase 独立）', () => {
    const dec = decodeSyntheticDisputed()
    const elev = flatElevation(4, 2, 32768)
    const { lineDistances } = buildDisputedSegments(dec, elev, meta())
    let idx = 0
    for (const line of dec.lines) {
      if (line.vertexCount < 2) continue
      expect(lineDistances[idx]).toBe(0)
      idx += (line.vertexCount - 1) * 2
    }
  })
})

// ---------------------------------------------------------------------------
// Task 21 · 争议虚线材质 / 渲染序常量契约（SPEC §6.3 / §4.3 / §2.4）
// ---------------------------------------------------------------------------

describe('争议虚线材质 / 渲染序常量契约', () => {
  it('色 = palette.disputed 暖灰（合法 hex）', () => {
    expect(DISPUTED_LINE_COLOR).toBe(palette.disputed)
    expect(() => new THREE.Color(DISPUTED_LINE_COLOR)).not.toThrow()
  })

  it('不透明度半透明（0 < opacity < 1）', () => {
    expect(DISPUTED_LINE_OPACITY).toBeGreaterThan(0)
    expect(DISPUTED_LINE_OPACITY).toBeLessThan(1)
  })

  it('虚线段长 / 间隔 > 0', () => {
    expect(DISPUTED_DASH_SIZE).toBeGreaterThan(0)
    expect(DISPUTED_GAP_SIZE).toBeGreaterThan(0)
  })

  it('材质：transparent + depthWrite=false（后绘读 Terrain 深度，与描边同契约）', () => {
    expect(DISPUTED_LINE_MATERIAL_OPTS.transparent).toBe(true)
    expect(DISPUTED_LINE_MATERIAL_OPTS.depthWrite).toBe(false)
  })

  it('渲染序：争议虚线 > 描边（=3）、< AtmosphereRim（=10 末项）', () => {
    expect(DISPUTED_RENDER_ORDER).toBeGreaterThan(BORDER_LINE_RENDER_ORDER)
    expect(DISPUTED_RENDER_ORDER).toBeLessThan(10)
  })
})

// ---------------------------------------------------------------------------
// Task 21 · boundaryVariant 接口（D10 可替换数据源）
// ---------------------------------------------------------------------------

describe('boundaryVariant 接口（D10 可替换数据源）', () => {
  it('MVP 默认 / 当前变体 = ne（Natural Earth，教育中立）', () => {
    expect(DEFAULT_BOUNDARY_VARIANT).toBe('ne')
    expect(CURRENT_BOUNDARY_VARIANT).toBe('ne')
  })

  it('ne 变体可用（available=true）+ 数据源为 NE disputed_areas', () => {
    const ne = getBoundaryVariant('ne')
    expect(ne.available).toBe(true)
    expect(ne.disputedSource).toContain('disputed')
  })

  it('预留变体（china / international）available=false（占位，未接入）', () => {
    expect(getBoundaryVariant('china').available).toBe(false)
    expect(getBoundaryVariant('international').available).toBe(false)
  })

  it('availableVariants() MVP 仅 ne', () => {
    const avail = availableVariants()
    expect(avail).toHaveLength(1)
    expect(avail[0].id).toBe('ne')
  })

  it('未知 id 回退默认 ne（配置容错，不抛错）', () => {
    expect(getBoundaryVariant('unknown' as BoundaryVariantId).id).toBe('ne')
  })

  it('接口可扩展：BOUNDARY_VARIANTS 覆盖所有 BoundaryVariantId', () => {
    const ids: BoundaryVariantId[] = ['ne', 'china', 'international']
    for (const id of ids) {
      expect(BOUNDARY_VARIANTS[id]).toBeDefined()
      expect(BOUNDARY_VARIANTS[id].id).toBe(id)
    }
  })
})
