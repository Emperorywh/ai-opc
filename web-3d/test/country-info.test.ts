/**
 * Task 24 · 国家信息解析单测（countryInfo.ts 纯函数，SPEC §6.7 / D19 / §10）。
 *
 * 验证：
 *   · continentZh / countryZhName：已知映射 + 未知回退（避免面板空白）
 *   · resolveCountryInfo：BoundaryCountry + continents → {中文国名, 中文大洲}（D19）
 *   · countryAnchorLonLat：§10 落海修复——USA 用主体陆地人工锚点（落海顶点均值被覆盖），
 *     其余国家顶点均值（落陆地）；vertexCount=0 防御回退
 *
 * 不渲染真实 WebGL（vitest node 环境）；用合成 boundaries（pack+decode round-trip）。
 */
import { describe, it, expect } from 'vitest'
import { packBoundaries } from '../scripts/data-pipeline/lib/boundary-pack.mjs'
import { SYNTHETIC_COUNTRIES } from '../scripts/data-pipeline/lib/boundaries-data.mjs'
import { uniqueContinents } from '../scripts/data-pipeline/lib/boundary-source.mjs'
import { decodeBoundaries } from '../src/data/boundaries'
import {
  continentZh,
  countryZhName,
  resolveCountryInfo,
  countryAnchorLonLat,
  COUNTRY_ANCHORS,
} from '../src/three/labels/countryInfo'
import type { BoundaryData, BoundaryCountry } from '../src/data/types'

// ---- 合成数据（仿 highlight.test / picking.test）----
function decodeSynthetic(): BoundaryData {
  const continents = uniqueContinents(SYNTHETIC_COUNTRIES)
  return decodeBoundaries(packBoundaries(SYNTHETIC_COUNTRIES, continents, { simplify: 0 }).bytes)
}

/** 手算某国全部顶点 (lon,lat) 均值（独立复算，校验 countryAnchorLonLat 读取的范围正确）。 */
function rawVertexMean(data: BoundaryData, country: BoundaryCountry): [number, number] {
  const base = country.vertexOffset
  const n = country.vertexCount
  let sl = 0
  let la = 0
  for (let i = 0; i < n; i++) {
    sl += data.vertices[(base + i) * 2]
    la += data.vertices[(base + i) * 2 + 1]
  }
  return [sl / n, la / n]
}

// ---------------------------------------------------------------------------
// 大洲 / 国名 中文解析（已知 + 未知回退）
// ---------------------------------------------------------------------------

describe('continentZh / countryZhName', () => {
  it('已知大洲 → 中文', () => {
    expect(continentZh('Asia')).toBe('亚洲')
    expect(continentZh('North America')).toBe('北美洲')
    expect(continentZh('South America')).toBe('南美洲')
    expect(continentZh('Seven seas')).toBe('公海')
  })

  it('未知大洲 → 回退原值（不空白）', () => {
    expect(continentZh('Atlantis')).toBe('Atlantis')
  })

  it('已知 ISO_A3 → 中文国名', () => {
    expect(countryZhName('CHN')).toBe('中国')
    expect(countryZhName('USA')).toBe('美国')
    expect(countryZhName('EGY')).toBe('埃及')
  })

  it('未知 ISO_A3 → 回退 ISO_A3（不空白）', () => {
    expect(countryZhName('XYZ')).toBe('XYZ')
  })
})

// ---------------------------------------------------------------------------
// resolveCountryInfo（D19：名称 + 所属大洲）
// ---------------------------------------------------------------------------

describe('resolveCountryInfo', () => {
  it('中国 → {中国, 亚洲}', () => {
    const b = decodeSynthetic()
    const chn = b.countries.find((c) => c.isoA3 === 'CHN')!
    const info = resolveCountryInfo(chn, b.continents)
    expect(info).toEqual({ isoA3: 'CHN', zhName: '中国', zhContinent: '亚洲' })
  })

  it('美国 → {美国, 北美洲}', () => {
    const b = decodeSynthetic()
    const usa = b.countries.find((c) => c.isoA3 === 'USA')!
    const info = resolveCountryInfo(usa, b.continents)
    expect(info).toEqual({ isoA3: 'USA', zhName: '美国', zhContinent: '北美洲' })
  })

  it('埃及 → {埃及, 非洲}（continentIndex 取 continents 表）', () => {
    const b = decodeSynthetic()
    const egy = b.countries.find((c) => c.isoA3 === 'EGY')!
    expect(resolveCountryInfo(egy, b.continents).zhContinent).toBe('非洲')
  })
})

// ---------------------------------------------------------------------------
// countryAnchorLonLat（§10 国名质心落海修复）
// ---------------------------------------------------------------------------

describe('countryAnchorLonLat（§10 质心落海修复）', () => {
  it('USA → 主体陆地人工锚点 [-96,37]，覆盖落海的顶点均值', () => {
    const b = decodeSynthetic()
    const usa = b.countries.find((c) => c.isoA3 === 'USA')!
    const [rawLon] = rawVertexMean(b, usa)
    // 顶点均值（本土+阿拉斯加+夏威夷）lon 落海（西经 < 本土西界 -125，即太平洋）。
    expect(rawLon).toBeLessThan(-125)
    // 锚点覆盖：落到本土（lon 在本土 [-125,-67] 内）。
    const [lon, lat] = countryAnchorLonLat(b, usa)
    expect([lon, lat]).toEqual(COUNTRY_ANCHORS.USA)
    expect(lon).toBeGreaterThanOrEqual(-125)
    expect(lat).toBeGreaterThanOrEqual(25)
    expect(lat).toBeLessThanOrEqual(49)
  })

  it('单陆地国家（中国）→ 顶点均值 = 手算均值，且落本土矩形内', () => {
    const b = decodeSynthetic()
    const chn = b.countries.find((c) => c.isoA3 === 'CHN')!
    const expected = rawVertexMean(b, chn)
    const [lon, lat] = countryAnchorLonLat(b, chn)
    expect([lon, lat]).toEqual(expected)
    expect(lon).toBeGreaterThanOrEqual(73)
    expect(lon).toBeLessThanOrEqual(135)
    expect(lat).toBeGreaterThanOrEqual(18)
    expect(lat).toBeLessThanOrEqual(53)
  })

  it('埃及（单陆地）→ 顶点均值，落本土矩形内', () => {
    const b = decodeSynthetic()
    const egy = b.countries.find((c) => c.isoA3 === 'EGY')!
    const [lon, lat] = countryAnchorLonLat(b, egy)
    expect([lon, lat]).toEqual(rawVertexMean(b, egy))
    expect(lon).toBeGreaterThanOrEqual(25)
    expect(lon).toBeLessThanOrEqual(35)
    expect(lat).toBeGreaterThanOrEqual(22)
    expect(lat).toBeLessThanOrEqual(32)
  })

  it('非锚点国家的均值 = 独立复算（验证读取的顶点范围正确）', () => {
    const b = decodeSynthetic()
    for (const c of b.countries) {
      if (COUNTRY_ANCHORS[c.isoA3]) continue // 锚点国家走人工锚点分支
      expect(countryAnchorLonLat(b, c)).toEqual(rawVertexMean(b, c))
    }
  })

  it('vertexCount=0 → 防御回退 [0,0]（不 NaN）', () => {
    const data: BoundaryData = {
      vertices: new Float32Array([1, 2]),
      fillIndices: new Uint32Array(),
      borderIndices: new Uint32Array(),
      continents: ['Asia'],
      countries: [
        {
          id: 0,
          isoA3: 'ZZZ',
          continent: 'Asia',
          continentIndex: 0,
          vertexOffset: 0,
          vertexCount: 0,
          fillIndexOffset: 0,
          fillIndexCount: 0,
          borderIndexOffset: 0,
          borderIndexCount: 0,
        },
      ],
    }
    expect(countryAnchorLonLat(data, data.countries[0])).toEqual([0, 0])
  })
})
