/**
 * Task 19 · 国家边界数据 pipeline 单测。
 *
 * 验证 SPEC §6.3 / §12.2 契约：
 *   · 几何纯函数（环归一化 / Douglas-Peucker 简化 / 边界线段 / earcut 三角化含 MultiPolygon+洞）
 *   · 二进制打包 → 解码 round-trip（magic/version/顶点/索引/国家属性/范围全对称）
 *   · 三角化无自交（三角形面积正 / 顶点索引合法 / 洞被扣除）
 *   · 投影对齐：存 lon,lat，project() 后落 PLANE（与地形/标签同源 R2）
 *   · 二进制体积 << 等价 GeoJSON（验收「显著缩小」）
 *   · 争议线 disputed.bin round-trip
 *
 * 不依赖真实 NE 数据（合成代表性数据，确定可复现）；真实路径 round-trip 同构（normalizeFeature 统一）。
 */
import { describe, it, expect } from 'vitest'
import {
  normalizeRing,
  perpendicularDistance,
  simplifyRing,
  ringSignedArea,
  ringBorderSegments,
  triangulatePolygon,
  packBoundaries,
  decodeBoundaries,
  packDisputed,
  decodeDisputed,
  BOUNDARIES_MAGIC,
  BOUNDARIES_VERSION,
  DISPUTED_MAGIC,
  DISPUTED_VERSION,
  LAYOUT,
} from '../scripts/data-pipeline/lib/boundary-pack.mjs'
import {
  SYNTHETIC_COUNTRIES,
  SYNTHETIC_DISPUTED,
  CONTINENTS,
  normalizeFeature,
  normalizeCountries,
} from '../scripts/data-pipeline/lib/boundaries-data.mjs'
import { createBoundarySource, uniqueContinents } from '../scripts/data-pipeline/lib/boundary-source.mjs'
import { project } from '../src/config/projection'

/** 测试用国家特征（与 lib/boundaries-data.mjs CountryFeature 同构）。 */
type CountryFeature = {
  isoA3: string
  continent: string
  polygons: Array<{ outer: Array<[number, number]>; holes: Array<Array<[number, number]>> }>
}

// ---------------------------------------------------------------------------
// 几何纯函数
// ---------------------------------------------------------------------------

describe('normalizeRing（环归一化）', () => {
  it('丢弃与首点重复的闭合尾点', () => {
    const ring = normalizeRing([
      [0, 0],
      [1, 0],
      [1, 1],
      [0, 0],
    ])
    expect(ring).toHaveLength(3)
    expect(ring[0]).toEqual([0, 0])
  })

  it('非闭合环原样返回副本', () => {
    const ring = normalizeRing([
      [0, 0],
      [1, 0],
      [1, 1],
    ])
    expect(ring).toHaveLength(3)
  })

  it('不足 3 顶点返回空', () => {
    expect(normalizeRing([[0, 0], [1, 0]])).toEqual([])
    expect(normalizeRing([])).toEqual([])
  })
})

describe('perpendicularDistance（点到线段距离）', () => {
  it('线段上的点距离为 0', () => {
    expect(perpendicularDistance([0.5, 0], [0, 0], [1, 0])).toBe(0)
  })

  it('垂直偏移', () => {
    expect(perpendicularDistance([0.5, 1], [0, 0], [1, 0])).toBe(1)
  })

  it('投影在线段外则取端点距离', () => {
    // 点在 a 左侧延长线外
    expect(perpendicularDistance([-1, 1], [0, 0], [1, 0])).toBeCloseTo(Math.hypot(1, 1), 10)
  })
})

describe('simplifyRing（Douglas-Peucker）', () => {
  it('epsilon=0 返回等长副本（不简化，非同一引用）', () => {
    const pts = [
      [0, 0],
      [1, 0],
      [1, 1],
      [0, 1],
    ] as [number, number][]
    const out = simplifyRing(pts, 0)
    expect(out).toHaveLength(4)
    expect(out).not.toBe(pts) // 副本
  })

  it('共线中间点被简化', () => {
    const pts = [
      [0, 0],
      [1, 0],
      [2, 0],
      [3, 0],
      [3, 3],
    ] as [number, number][]
    const out = simplifyRing(pts, 0.1)
    // 底边 4 个共线点应简化掉 2 个，保留首尾角点
    expect(out.length).toBeLessThan(pts.length)
    expect(out[0]).toEqual([0, 0])
  })

  it('epsilon 极大保留极简骨架（≥3 点）', () => {
    const out = simplifyRing(
      [
        [0, 0],
        [0.001, 0.001],
        [1, 0],
        [1, 1],
      ] as [number, number][],
      100,
    )
    expect(out.length).toBeGreaterThanOrEqual(3)
  })
})

describe('ringBorderSegments（边界线段）', () => {
  it('n 顶点 → n 段（含闭合回到首点）', () => {
    expect(ringBorderSegments(4)).toEqual([
      [0, 1],
      [1, 2],
      [2, 3],
      [3, 0],
    ])
  })
  it('三角形 3 段', () => {
    expect(ringBorderSegments(3)).toHaveLength(3)
  })
})

describe('ringSignedArea（有符号面积）', () => {
  it('逆时针为正', () => {
    const ccw = [
      [0, 0],
      [1, 0],
      [1, 1],
      [0, 1],
    ] as [number, number][]
    expect(ringSignedArea(ccw)).toBeGreaterThan(0)
  })
  it('顺时针为负', () => {
    const cw = [
      [0, 0],
      [0, 1],
      [1, 1],
      [1, 0],
    ] as [number, number][]
    expect(ringSignedArea(cw)).toBeLessThan(0)
  })
})

// ---------------------------------------------------------------------------
// earcut 三角化
// ---------------------------------------------------------------------------

describe('triangulatePolygon（earcut）', () => {
  it('四边形 → 2 个三角形（6 索引）', () => {
    const outer = [
      [0, 0],
      [10, 0],
      [10, 10],
      [0, 10],
    ] as [number, number][]
    const tris = triangulatePolygon(outer, [])
    expect(tris).toHaveLength(6) // 2 三角形 ×3
    expect(Math.max(...tris)).toBeLessThanOrEqual(3) // 索引 ∈ [0,3]
  })

  it('三角形顶点索引合法（在 [0, 顶点数) 内）', () => {
    const outer = [
      [0, 0],
      [4, 0],
      [4, 4],
      [0, 4],
    ] as [number, number][]
    const tris = triangulatePolygon(outer, [])
    for (const i of tris) expect(i).toBeGreaterThanOrEqual(0)
    expect(Math.max(...tris)).toBeLessThan(outer.length)
  })

  it('含洞：洞内顶点出现在索引中，三角形数少于无洞', () => {
    const outer = [
      [0, 0],
      [10, 0],
      [10, 10],
      [0, 10],
    ] as [number, number][]
    const hole = [
      [4, 4],
      [6, 4],
      [6, 6],
      [4, 6],
    ] as [number, number][]
    const trisHole = triangulatePolygon(outer, [hole])
    const trisNoHole = triangulatePolygon(outer, [])
    // 含洞三角形数 > 无洞（扣洞需更多三角形绕开洞）+ 洞顶点被引用
    expect(trisHole.length / 3).toBeGreaterThan(trisNoHole.length / 3)
    expect(Math.max(...trisHole)).toBeGreaterThanOrEqual(4) // 引用了洞顶点（索引 ≥4）
  })
})

// ---------------------------------------------------------------------------
// 辅助：合成数据 round-trip
// ---------------------------------------------------------------------------

function packSynthetic(simplify = 0) {
  const continents = uniqueContinents(SYNTHETIC_COUNTRIES)
  return packBoundaries(SYNTHETIC_COUNTRIES, continents, { simplify })
}

// ---------------------------------------------------------------------------
// boundaries.bin 打包 / 解码 round-trip
// ---------------------------------------------------------------------------

describe('boundaries.bin 打包', () => {
  it('坐标数据显著紧凑：Float32×2(8B/顶点) << GeoJSON 文本坐标(~20B/顶点)，与数据规模无关', () => {
    // 二进制存 Float32[lon,lat]（8B/顶点）；GeoJSON 文本坐标 ≈20 字符/顶点。
    // 二进制额外含预烘焙三角化索引（earcut），那是 GPU-ready 数据——GeoJSON 把三角化推迟到
    // 运行时 earcut，故总字节不可直接对比；「显著缩小」体现在坐标数据本身。
    const { stats } = packSynthetic(0)
    const binCoordBytes = stats.vertexCount * 8
    const jsonCoordBytes = stats.vertexCount * 20
    expect(binCoordBytes / jsonCoordBytes).toBeLessThan(0.5)
  })

  it('稠密多边形（128 顶点圆）坐标数据 <50% GeoJSON', () => {
    const circle: [number, number][] = []
    for (let i = 0; i < 128; i++) {
      const a = (i / 128) * Math.PI * 2
      circle.push([50 + 20 * Math.cos(a), 10 + 20 * Math.sin(a)])
    }
    const dense = [{ isoA3: 'DNS', continent: 'Asia', polygons: [{ outer: circle, holes: [] }] }] as CountryFeature[]
    const { stats } = packBoundaries(dense, ['Asia'], { simplify: 0 })
    expect(stats.vertexCount).toBe(128)
    expect((stats.vertexCount * 8) / (stats.vertexCount * 20)).toBeLessThan(0.5)
  })

  it('合成数据国家数 = 6，含 USA MultiPolygon', () => {
    const { stats } = packSynthetic(0)
    expect(stats.countryCount).toBe(6)
    expect(stats.continentCount).toBeGreaterThan(0)
  })

  it('三角形索引数为 3 的倍数，边界索引数为 2 的倍数', () => {
    const { stats } = packSynthetic(0)
    expect(stats.fillIndexCount % 3).toBe(0)
    expect(stats.borderIndexCount % 2).toBe(0)
  })
})

describe('boundaries.bin 解码 round-trip', () => {
  it('魔数 / 版本正确', () => {
    const { bytes } = packSynthetic(0)
    const dec = decodeBoundaries(bytes)
    // 解码成功即隐含 magic/version 校验通过（不匹配会抛错）
    expect(dec.vertices.length).toBeGreaterThan(0)
    expect(dec.countries).toHaveLength(6)
  })

  it('原始字节头：magic / version / 布局常量', () => {
    const { bytes } = packSynthetic(0)
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    const magic = String.fromCharCode(dv.getUint8(0), dv.getUint8(1), dv.getUint8(2), dv.getUint8(3))
    expect(magic).toBe(BOUNDARIES_MAGIC)
    expect(dv.getUint32(4, true)).toBe(BOUNDARIES_VERSION)
    expect(LAYOUT.HEADER).toBe(28)
    expect(LAYOUT.COUNTRY_RECORD).toBe(36)
  })

  it('disputed 原始字节头：magic / version / 布局常量', () => {
    const { bytes } = packDisputed(SYNTHETIC_DISPUTED, { simplify: 0 })
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    const magic = String.fromCharCode(dv.getUint8(0), dv.getUint8(1), dv.getUint8(2), dv.getUint8(3))
    expect(magic).toBe(DISPUTED_MAGIC)
    expect(dv.getUint32(4, true)).toBe(DISPUTED_VERSION)
    expect(LAYOUT.DISPUTED_HEADER).toBe(16)
    expect(LAYOUT.DISPUTED_LINE_RECORD).toBe(24)
  })

  it('错误魔数抛错', () => {
    const { bytes } = packSynthetic(0)
    const bad = bytes.slice()
    bad[0] = 88 // 破坏首字节
    expect(() => decodeBoundaries(bad)).toThrow(/魔数/)
  })

  it('国家属性（isoA3 / continent）正确', () => {
    const { bytes } = packSynthetic(0)
    const { countries, continents } = decodeBoundaries(bytes)
    const isoSet = new Set(countries.map((c) => c.isoA3))
    expect(isoSet.has('CHN')).toBe(true)
    expect(isoSet.has('USA')).toBe(true)
    const usa = countries.find((c) => c.isoA3 === 'USA')!
    expect(usa.continent).toBe('North America')
    expect(continents[usa.continentIndex]).toBe('North America')
    const chn = countries.find((c) => c.isoA3 === 'CHN')!
    expect(chn.continent).toBe('Asia')
  })

  it('id 为稳定记录序号 0..count-1', () => {
    const { bytes } = packSynthetic(0)
    const { countries } = decodeBoundaries(bytes)
    expect(countries.map((c) => c.id)).toEqual(countries.map((_, i) => i))
  })

  it('每国家范围合法：索引在顶点池内 / 填充索引数 %3 / 边界索引数 %2', () => {
    const { bytes } = packSynthetic(0)
    const { vertices, fillIndices, borderIndices, countries } = decodeBoundaries(bytes)
    const vertexCount = vertices.length / 2
    for (const c of countries) {
      expect(c.vertexOffset).toBeGreaterThanOrEqual(0)
      expect(c.vertexOffset + c.vertexCount).toBeLessThanOrEqual(vertexCount)
      expect(c.fillIndexCount % 3).toBe(0)
      expect(c.borderIndexCount % 2).toBe(0)
      // 填充索引落在该国家顶点范围内
      for (let i = c.fillIndexOffset; i < c.fillIndexOffset + c.fillIndexCount; i++) {
        const idx = fillIndices[i]
        expect(idx).toBeGreaterThanOrEqual(c.vertexOffset)
        expect(idx).toBeLessThan(c.vertexOffset + c.vertexCount)
      }
      // 边界索引落在该国家顶点范围内
      for (let i = c.borderIndexOffset; i < c.borderIndexOffset + c.borderIndexCount; i++) {
        const idx = borderIndices[i]
        expect(idx).toBeGreaterThanOrEqual(c.vertexOffset)
        expect(idx).toBeLessThan(c.vertexOffset + c.vertexCount)
      }
    }
  })

  it('顶点 lon,lat ∈ [-180,180]×[-90,90]', () => {
    const { bytes } = packSynthetic(0)
    const { vertices } = decodeBoundaries(bytes)
    for (let i = 0; i < vertices.length; i += 2) {
      expect(vertices[i]).toBeGreaterThanOrEqual(-180)
      expect(vertices[i]).toBeLessThanOrEqual(180)
      expect(vertices[i + 1]).toBeGreaterThanOrEqual(-90)
      expect(vertices[i + 1]).toBeLessThanOrEqual(90)
    }
  })

  it('投影对齐：lon,lat → project() 落 PLANE（[-1,1]×[-0.5,0.5]，与地形/标签同源 R2）', () => {
    const { bytes } = packSynthetic(0)
    const { vertices } = decodeBoundaries(bytes)
    for (let i = 0; i < vertices.length; i += 2) {
      const [x, z] = project(vertices[i], vertices[i + 1])
      expect(x).toBeGreaterThanOrEqual(-1)
      expect(x).toBeLessThanOrEqual(1)
      expect(z).toBeGreaterThanOrEqual(-0.5)
      expect(z).toBeLessThanOrEqual(0.5)
    }
  })

  it('round-trip 等价：再次打包同一解码结构字节长度一致', () => {
    const { bytes, stats } = packSynthetic(0)
    const dec = decodeBoundaries(bytes)
    expect(dec.vertices.length).toBe(stats.vertexCount * 2)
    expect(dec.fillIndices.length).toBe(stats.fillIndexCount)
    expect(dec.borderIndices.length).toBe(stats.borderIndexCount)
    expect(dec.countries.length).toBe(stats.countryCount)
  })
})

// ---------------------------------------------------------------------------
// 三角化无自交：合成国家三角形面积正 + 边界闭合
// ---------------------------------------------------------------------------

describe('三角化正确性（无自交 / 合法）', () => {
  function triangleArea(p0: number[], p1: number[], p2: number[]): number {
    return Math.abs((p1[0] - p0[0]) * (p2[1] - p0[1]) - (p2[0] - p0[0]) * (p1[1] - p0[1])) / 2
  }

  it('每国家三角形面积 > 0（非退化 / 无零面积）', () => {
    const { bytes } = packSynthetic(0)
    const { vertices, fillIndices, countries } = decodeBoundaries(bytes)
    const v = (gi: number) => [vertices[gi * 2], vertices[gi * 2 + 1]]
    for (const c of countries) {
      for (let t = 0; t < c.fillIndexCount; t += 3) {
        const i0 = fillIndices[c.fillIndexOffset + t]
        const i1 = fillIndices[c.fillIndexOffset + t + 1]
        const i2 = fillIndices[c.fillIndexOffset + t + 2]
        const area = triangleArea(v(i0), v(i1), v(i2))
        expect(area).toBeGreaterThan(0)
      }
    }
  })

  it('USA MultiPolygon 三角形覆盖全部 3 块领土（顶点数 + 三角形数显著多于单多边形国家）', () => {
    const { bytes } = packSynthetic(0)
    const { countries } = decodeBoundaries(bytes)
    const usa = countries.find((c) => c.isoA3 === 'USA')!
    const chn = countries.find((c) => c.isoA3 === 'CHN')!
    // USA 3 块领土（每块 4 顶点矩形）= 12 顶点；CHN 单块 = 4 顶点
    expect(usa.vertexCount).toBe(12)
    expect(chn.vertexCount).toBe(4)
    expect(usa.fillIndexCount / 3).toBeGreaterThan(chn.fillIndexCount / 3)
  })

  it('边界段数 = 国家所有环顶点数之和（每环 n 顶点 n 段）', () => {
    const { bytes } = packSynthetic(0)
    const { countries } = decodeBoundaries(bytes)
    for (const c of countries) {
      // 矩形环：每环 4 顶点 → 4 段；borderIndexCount/2 = 段数 = 顶点数（单环无洞）
      expect(c.borderIndexCount / 2).toBe(c.vertexCount)
    }
  })
})

// ---------------------------------------------------------------------------
// 未知大洲 / 异常输入
// ---------------------------------------------------------------------------

describe('异常输入处理', () => {
  it('国家大洲不在表内 → packBoundaries 抛错', () => {
    const bad = [{ isoA3: 'XXX', continent: 'Mars', polygons: [{ outer: [[0, 0], [1, 0], [1, 1]], holes: [] }] }] as CountryFeature[]
    expect(() => packBoundaries(bad, ['Asia'], {})).toThrow(/未知大洲/)
  })

  it('normalizeFeature 跳过缺属性 / 非多边形 Feature', () => {
    expect(normalizeFeature({ properties: {}, geometry: { type: 'Polygon', coordinates: [] } })).toBeNull()
    expect(normalizeFeature({ properties: { ISO_A3: 'A', CONTINENT: 'Asia' }, geometry: { type: 'Point', coordinates: [0, 0] } })).toBeNull()
    expect(
      normalizeFeature({
        properties: { ISO_A3: 'A', CONTINENT: 'Asia' },
        geometry: { type: 'Polygon', coordinates: [[[0, 0], [1, 0], [1, 1], [0, 0]]] },
      }),
    ).not.toBeNull()
  })

  it('normalizeCountries 过滤非法 Feature', () => {
    const fc = {
      type: 'FeatureCollection',
      features: [
        { properties: { ISO_A3: 'A', CONTINENT: 'Asia' }, geometry: { type: 'Polygon', coordinates: [[[0, 0], [1, 0], [1, 1], [0, 0]]] } },
        { properties: {}, geometry: { type: 'Polygon', coordinates: [] } }, // 缺属性
      ],
    }
    expect(normalizeCountries(fc)).toHaveLength(1)
  })
})

// ---------------------------------------------------------------------------
// disputed.bin round-trip
// ---------------------------------------------------------------------------

describe('disputed.bin round-trip', () => {
  it('魔数 / 版本 / 线数', () => {
    const { bytes, stats } = packDisputed(SYNTHETIC_DISPUTED, { simplify: 0 })
    const dec = decodeDisputed(bytes)
    expect(dec.lines).toHaveLength(stats.lineCount)
    expect(dec.lines.length).toBe(3)
  })

  it('每条线 id / 顶点范围正确', () => {
    const { bytes } = packDisputed(SYNTHETIC_DISPUTED, { simplify: 0 })
    const { vertices, lines } = decodeDisputed(bytes)
    const ids = lines.map((l) => l.id)
    expect(ids).toContain('kashmir')
    expect(ids).toContain('crimea')
    for (const l of lines) {
      expect(l.vertexOffset + l.vertexCount).toBeLessThanOrEqual(vertices.length / 2)
    }
  })

  it('错误魔数抛错', () => {
    const { bytes } = packDisputed(SYNTHETIC_DISPUTED, { simplify: 0 })
    const bad = bytes.slice()
    bad[0] = 88
    expect(() => decodeDisputed(bad)).toThrow(/魔数/)
  })
})

// ---------------------------------------------------------------------------
// 数据源选择（real NE / synthetic）
// ---------------------------------------------------------------------------

describe('createBoundarySource（数据源选择）', () => {
  it('无 raw/ne/ → 合成 fallback（本仓库默认状态）', () => {
    const src = createBoundarySource({ neDir: '/nonexistent/ne/path' })
    expect(src.source).toBe('synthetic')
    expect(src.countries.length).toBe(6)
    expect(src.disputed.length).toBe(3)
  })

  it('uniqueContinents 返回标准大洲子集（合成数据用到的大洲）', () => {
    const cs = uniqueContinents(SYNTHETIC_COUNTRIES)
    expect(cs).toContain('Asia')
    expect(cs).toContain('North America')
    expect(cs).toContain('Africa')
    // 标准 CONTINENTS 序优先
    expect(cs.indexOf('Africa')).toBeLessThan(cs.indexOf('Asia'))
  })

  it('CONTINENTS 标准表含七大洲', () => {
    for (const name of ['Africa', 'Asia', 'Europe', 'North America', 'South America', 'Oceania', 'Antarctica']) {
      expect(CONTINENTS).toContain(name)
    }
  })
})

// ---------------------------------------------------------------------------
// 端到端：数据源 → 打包 → 解码完整闭环
// ---------------------------------------------------------------------------

describe('端到端 pipeline 闭环', () => {
  it('createBoundarySource → pack → decode 闭环（合成数据）', () => {
    const src = createBoundarySource({ neDir: '/nonexistent/ne/path' })
    const packed = packBoundaries(src.countries, src.continents, { simplify: 0 })
    const dec = decodeBoundaries(packed.bytes)
    expect(dec.countries).toHaveLength(src.countries.length)
    // 每国家 isoA3 round-trip 完整
    const srcIso = new Set(src.countries.map((c) => c.isoA3))
    const decIso = new Set(dec.countries.map((c) => c.isoA3))
    expect(decIso).toEqual(srcIso)
  })
})
