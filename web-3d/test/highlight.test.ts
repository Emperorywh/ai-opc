/**
 * Task 23 · 国家高亮单测（highlight.ts 纯函数 + 材质契约 + countryId 属性）。
 *
 * 验证（SPEC §6.3「高亮层：填充提亮 + 边缘发光」）：
 *   · buildCountryIdAttribute：每顶点国家 id 与 c.id 同源、同国一致、异国不同、对齐顶点数
 *   · matchesCountry：countryId↔hovered/selected 命中判定（含 -1 哨兵、countryId=0 有效）
 *   · edgeGlowMask：fwidth(countryId) → 边缘 mask（内部 0 / 边界 1 / clamp / scale）
 *   · createHighlightMaterial：uniforms 初值（-1 哨兵）+ 透明属性契约 + shader 含 countryId/fwidth
 *
 * 不渲染真实 WebGL（vitest node 环境）；材质仅断言对象契约（同 picking.test createPickingMaterial 模式），
 * 真实 GLSL 编译 + 高亮观感留 dev Review。
 */
import { describe, it, expect } from 'vitest'
import * as THREE from 'three'
import { packBoundaries } from '../scripts/data-pipeline/lib/boundary-pack.mjs'
import { SYNTHETIC_COUNTRIES } from '../scripts/data-pipeline/lib/boundaries-data.mjs'
import { uniqueContinents } from '../scripts/data-pipeline/lib/boundary-source.mjs'
import { decodeBoundaries } from '../src/data/boundaries'
import {
  buildCountryIdAttribute,
  matchesCountry,
  edgeGlowMask,
  createHighlightMaterial,
  HIGHLIGHT_NONE_ID,
  HIGHLIGHT_MATERIAL_OPTS,
  HIGHLIGHT_GLOW_SCALE,
} from '../src/three/borders/highlight'
import { COUNTRY_FILL_MATERIAL_OPTS } from '../src/three/borders/boundaryGeometry'
import type { BoundaryData } from '../src/data/types'

// ---- 合成数据（仿 picking.test）----
function decodeSynthetic(): BoundaryData {
  const continents = uniqueContinents(SYNTHETIC_COUNTRIES)
  return decodeBoundaries(packBoundaries(SYNTHETIC_COUNTRIES, continents, { simplify: 0 }).bytes)
}

// ---------------------------------------------------------------------------
// buildCountryIdAttribute（每顶点国家 id）
// ---------------------------------------------------------------------------

describe('buildCountryIdAttribute（每顶点国家 id）', () => {
  it('长度 = 顶点数（1 float/顶点），对齐 vertices/2', () => {
    const b = decodeSynthetic()
    const ids = buildCountryIdAttribute(b)
    expect(ids.length).toBe(b.vertices.length / 2)
  })

  it('同一国家所有顶点 id 一致 = c.id（0-based 记录序号）', () => {
    const b = decodeSynthetic()
    const ids = buildCountryIdAttribute(b)
    for (const c of b.countries) {
      for (let i = 0; i < c.vertexCount; i++) {
        expect(ids[c.vertexOffset + i]).toBe(c.id)
      }
    }
  })

  it('不同国家 id 不同（合成 6 国 6 个不同 id）', () => {
    const b = decodeSynthetic()
    const ids = buildCountryIdAttribute(b)
    const firstIds = b.countries.map((c) => ids[c.vertexOffset])
    expect(new Set(firstIds).size).toBe(b.countries.length)
  })

  it('每国家首顶点 = c.id（与 buildPickColors 同源遍历）', () => {
    const b = decodeSynthetic()
    const ids = buildCountryIdAttribute(b)
    for (const c of b.countries) {
      expect(ids[c.vertexOffset]).toBe(c.id)
    }
  })

  it('countryId 是 0-based 连续序号（0..n-1，与 picking countryIdToPickId+1 同源）', () => {
    const b = decodeSynthetic()
    const ids = buildCountryIdAttribute(b)
    const present = new Set<number>()
    for (const c of b.countries) present.add(ids[c.vertexOffset])
    expect(present.size).toBe(b.countries.length)
    for (let i = 0; i < b.countries.length; i++) expect(present.has(i)).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// matchesCountry（命中判定，含 -1 哨兵 / countryId=0 有效）
// ---------------------------------------------------------------------------

describe('matchesCountry（countryId↔目标 命中）', () => {
  it('target=null → false（无高亮目标）', () => {
    expect(matchesCountry(0, null)).toBe(false)
    expect(matchesCountry(5, null)).toBe(false)
  })

  it('target=HIGHLIGHT_NONE_ID(-1) → false（哨兵）', () => {
    expect(matchesCountry(0, HIGHLIGHT_NONE_ID)).toBe(false)
    expect(matchesCountry(5, HIGHLIGHT_NONE_ID)).toBe(false)
  })

  it('target<0 → false（任意负数哨兵）', () => {
    expect(matchesCountry(0, -5)).toBe(false)
  })

  it('精确匹配 → true（countryId=0 有效，不被哨兵吞掉）', () => {
    expect(matchesCountry(0, 0)).toBe(true)
    expect(matchesCountry(5, 5)).toBe(true)
    expect(matchesCountry(299, 299)).toBe(true)
  })

  it('abs(countryId-target) < 0.5 → true（浮点插值容差）', () => {
    expect(matchesCountry(5.3, 5)).toBe(true)
    expect(matchesCountry(4.7, 5)).toBe(true)
  })

  it('abs(countryId-target) >= 0.5 → false（不同国家）', () => {
    expect(matchesCountry(5, 6)).toBe(false)
    expect(matchesCountry(5.6, 5)).toBe(false)
    expect(matchesCountry(0, 1)).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// edgeGlowMask（fwidth(countryId) → 边缘 mask）
// ---------------------------------------------------------------------------

describe('edgeGlowMask（fwidth → 边缘 mask）', () => {
  it('fwidth=0 → mask=0（国家内部不发光）', () => {
    expect(edgeGlowMask(0, HIGHLIGHT_GLOW_SCALE)).toBe(0)
  })

  it('fwidth>=1 + scale=1 → mask=1（跨国边界发光，id 差>=1）', () => {
    expect(edgeGlowMask(1, 1)).toBe(1)
    expect(edgeGlowMask(50, 1)).toBe(1) // 相邻国家 id 差任意值，fwidth 大
  })

  it('clamp 到 [0,1]（fwidth×scale 超出截断）', () => {
    expect(edgeGlowMask(10, 0.5)).toBe(1)
    expect(edgeGlowMask(0.3, 2)).toBeCloseTo(0.6, 6)
    expect(edgeGlowMask(-1, 1)).toBe(0) // 负值（不应出现）钳 0
  })

  it('scale 缩放：小 scale 抑制、大 scale 放大', () => {
    expect(edgeGlowMask(0.5, 1)).toBeCloseTo(0.5, 6)
    expect(edgeGlowMask(0.5, 2)).toBe(1)
    expect(edgeGlowMask(0.5, 0.5)).toBeCloseTo(0.25, 6)
  })
})

// ---------------------------------------------------------------------------
// createHighlightMaterial（uniforms + 透明契约 + shader 源码）
// ---------------------------------------------------------------------------

describe('createHighlightMaterial（材质契约）', () => {
  it('ShaderMaterial + 透明属性复用 COUNTRY_FILL_MATERIAL_OPTS（渲染顺序不退化）', () => {
    const mat = createHighlightMaterial()
    expect(mat.transparent).toBe(true)
    expect(mat.depthWrite).toBe(false)
    expect(mat.side).toBe(THREE.DoubleSide)
    expect(HIGHLIGHT_MATERIAL_OPTS).toBe(COUNTRY_FILL_MATERIAL_OPTS) // 直接复用同对象
    mat.dispose()
  })

  it('uHoveredId / uSelectedId 初值 = HIGHLIGHT_NONE_ID(-1)（无高亮）', () => {
    const mat = createHighlightMaterial()
    expect(mat.uniforms.uHoveredId.value).toBe(HIGHLIGHT_NONE_ID)
    expect(mat.uniforms.uSelectedId.value).toBe(HIGHLIGHT_NONE_ID)
    mat.dispose()
  })

  it('uniforms 齐全（fill/hover/selected/glow 色 + 强度 + opacity）', () => {
    const mat = createHighlightMaterial()
    const keys = [
      'uHoveredId',
      'uSelectedId',
      'uFillColor',
      'uHoverColor',
      'uSelectedColor',
      'uGlowColor',
      'uOpacity',
      'uHoverStrength',
      'uSelectedStrength',
      'uHoverOpacity',
      'uSelectedOpacity',
      'uGlowStrength',
      'uGlowScale',
    ]
    for (const k of keys) {
      expect(mat.uniforms[k]).toBeTruthy()
    }
    // 色 uniform 为 THREE.Color 实例
    expect(mat.uniforms.uFillColor.value).toBeInstanceOf(THREE.Color)
    expect(mat.uniforms.uGlowColor.value).toBeInstanceOf(THREE.Color)
    mat.dispose()
  })

  it('vertexShader 声明 attribute float countryId + varying vCountryId', () => {
    const mat = createHighlightMaterial()
    expect(mat.vertexShader).toContain('attribute float countryId')
    expect(mat.vertexShader).toContain('varying float vCountryId')
    mat.dispose()
  })

  it('fragmentShader 用 fwidth(vCountryId) 检测国家边界（边缘发光巧思）', () => {
    const mat = createHighlightMaterial()
    expect(mat.fragmentShader).toContain('fwidth(vCountryId)')
    mat.dispose()
  })

  it('fragmentShader 含 hover/selected 分支（abs(id-target)<0.5 匹配）', () => {
    const mat = createHighlightMaterial()
    expect(mat.fragmentShader).toContain('uHoveredId >= 0.0')
    expect(mat.fragmentShader).toContain('uSelectedId >= 0.0')
    expect(mat.fragmentShader).toContain('abs(id - uHoveredId) < 0.5')
    expect(mat.fragmentShader).toContain('abs(id - uSelectedId) < 0.5')
    mat.dispose()
  })

  it('改 uniform value 不重建材质（CountryMeshes 订阅 store 同步用）', () => {
    const mat = createHighlightMaterial()
    const before = mat.uniforms.uHoveredId.value
    mat.uniforms.uHoveredId.value = 3
    expect(mat.uniforms.uHoveredId.value).toBe(3)
    expect(mat.uniforms.uHoveredId.value).not.toBe(before)
    mat.dispose()
  })
})
