/**
 * Task 22 · GPU 颜色拾取单测（picking.ts 纯逻辑 + 注入式 pickAt）。
 *
 * 验证（SPEC §6.3 D9 / 风险验证 3「抗锯齿下 ID 稳定」）：
 *   · countryId↔pickId↔RGB 映射纯函数全可逆（含背景 pickId=0）
 *   · 量化稳定：pickIdToColor → 8-bit round(×255) → rgbToPickId 可逆 + 相邻 id 不碰撞（边缘 ID 不串色）
 *   · buildPickColors：每国家顶点色一致 = pickIdToColor(countryId+1)、不同国家色不同、顶点数对齐
 *   · buildPickingGeometry：position 与 buildBoundaryPositions 同源 + color attr + index=fillIndices
 *   · 材质/RT 契约：vertexColors+不透明+DoubleSide / NearestFilter+RGBA8+depth
 *   · pickAt（注入 mock renderer）：像素色→正确 countryId、背景(0,0,0)→null、RT 复位、NDC→像素映射
 *
 * 不渲染真实 WebGL（agent 无浏览器 / vitest node 环境）；pickAt 注入式 mock readRenderTargetPixels
 * 验证「命中判定准确」逻辑，真实 RT 渲染留 Task 23 hook 接指针后 dev Review。
 */
import { describe, it, expect, vi } from 'vitest'
import * as THREE from 'three'
import { packBoundaries } from '../scripts/data-pipeline/lib/boundary-pack.mjs'
import { SYNTHETIC_COUNTRIES } from '../scripts/data-pipeline/lib/boundaries-data.mjs'
import { uniqueContinents } from '../scripts/data-pipeline/lib/boundary-source.mjs'
import { decodeBoundaries } from '../src/data/boundaries'
import {
  countryIdToPickId,
  pickIdToCountryId,
  pickIdToRGB,
  rgbToPickId,
  pickIdToColor,
  buildPickColors,
  buildPickingGeometry,
  createPickingMaterial,
  createPickingTarget,
  pickAt,
  setPickingApi,
  getPickingApi,
  clearPickingApi,
  MAX_PICK_ID,
  PICKING_MATERIAL_OPTS,
} from '../src/three/borders/picking'
import { buildBoundaryPositions } from '../src/three/borders/boundaryGeometry'
import type { BoundaryData, ElevationData } from '../src/data/types'
import type { ElevationMeta } from '../src/config/projection'

// ---------------------------------------------------------------------------
// 辅助（仿 boundaries-render.test.ts 合成数据 + flat elevation）
// ---------------------------------------------------------------------------

function packSynthetic() {
  const continents = uniqueContinents(SYNTHETIC_COUNTRIES)
  return packBoundaries(SYNTHETIC_COUNTRIES, continents, { simplify: 0 })
}

function decodeSynthetic(): BoundaryData {
  return decodeBoundaries(packSynthetic().bytes)
}

/** 全均匀高程（Uint16 值）。 */
function flatElevation(width: number, height: number, value: number): ElevationData {
  return { width, height, data: new Uint16Array(width * height).fill(value) }
}

/** 最小 ElevationMeta（鸭子类型，与 projection.ElevationMeta 兼容）。 */
function meta(over: Partial<ElevationMeta> = {}): ElevationMeta {
  return { elevationMin: 0, elevationMax: 1000, seaLevelMeters: 0, width: 4, height: 2, ...over }
}

/**
 * mock renderer：readRenderTargetPixels 把指定 [r,g,b] 写入像素缓冲（alpha=255）。
 * 暴露 _currentTarget 供「复位 renderTarget 到主画布」断言。仅实现 pickAt 用到的 4 个方法。
 */
function mockRenderer(pixel: [number, number, number]): THREE.WebGLRenderer {
  let current: THREE.WebGLRenderTarget | null = null
  return {
    getRenderTarget: () => current,
    setRenderTarget: (t: THREE.WebGLRenderTarget | null) => {
      current = t
    },
    render: vi.fn(),
    readRenderTargetPixels: vi.fn(
      (_t: THREE.WebGLRenderTarget, _x: number, _y: number, _w: number, _h: number, buf: Uint8Array) => {
        buf[0] = pixel[0]
        buf[1] = pixel[1]
        buf[2] = pixel[2]
        buf[3] = 255
      },
    ),
  } as unknown as THREE.WebGLRenderer
}

// ---------------------------------------------------------------------------
// countryId ↔ pickId ↔ RGB 映射（全可逆）
// ---------------------------------------------------------------------------

describe('countryId↔pickId↔RGB 映射', () => {
  it('countryIdToPickId = countryId+1（0-based country → 1-based pickId，0 留背景）', () => {
    expect(countryIdToPickId(0)).toBe(1)
    expect(countryIdToPickId(5)).toBe(6)
    expect(countryIdToPickId(299)).toBe(300)
  })

  it('pickIdToCountryId：背景 0 → null，1 → 0；非正整数 / 分数 → null', () => {
    expect(pickIdToCountryId(0)).toBeNull()
    expect(pickIdToCountryId(1)).toBe(0)
    expect(pickIdToCountryId(6)).toBe(5)
    expect(pickIdToCountryId(-1)).toBeNull()
    expect(pickIdToCountryId(0.5)).toBeNull()
  })

  it('countryId → pickId → countryId 全可逆（0..999，覆盖国家规模）', () => {
    for (let id = 0; id < 1000; id++) {
      expect(pickIdToCountryId(countryIdToPickId(id))).toBe(id)
    }
  })

  it('pickIdToRGB / rgbToPickId round-trip（含 0 / 通道边界 / MAX）', () => {
    const samples = [0, 1, 2, 254, 255, 256, 65535, 65536, 0x7f7f7f, 0x010101, MAX_PICK_ID]
    for (const p of samples) {
      const [r, g, b] = pickIdToRGB(p)
      expect(rgbToPickId(r, g, b)).toBe(p)
    }
  })

  it('pickId=0 → RGB(0,0,0) 背景（RT 清屏黑读出 → null 命中）', () => {
    expect(pickIdToRGB(0)).toEqual([0, 0, 0])
  })

  it('MAX_PICK_ID = 0xffffff（24-bit 上限，三通道满）', () => {
    expect(MAX_PICK_ID).toBe(0xffffff)
    expect(pickIdToRGB(MAX_PICK_ID)).toEqual([255, 255, 255])
  })
})

// ---------------------------------------------------------------------------
// 量化稳定性（边缘 ID 不串色，SPEC §6.3 风险验证 3）
// ---------------------------------------------------------------------------

describe('量化稳定性（边缘 ID 不串色）', () => {
  it('pickIdToColor → round(×255) → rgbToPickId：国家规模 pickId 全可逆', () => {
    // 颜色经归一化 [0,1] → 帧缓冲 8-bit 量化后必须还原 pickId（边缘像素不串邻国）
    for (let pickId = 1; pickId <= 300; pickId++) {
      const c = pickIdToColor(pickId)
      const r = Math.round(c.r * 255)
      const g = Math.round(c.g * 255)
      const b = Math.round(c.b * 255)
      expect(rgbToPickId(r, g, b)).toBe(pickId)
    }
  })

  it('相邻 countryId 量化后 pickId 不碰撞（边缘像素不串到邻国）', () => {
    for (let id = 0; id < 300; id++) {
      const c1 = pickIdToColor(countryIdToPickId(id))
      const c2 = pickIdToColor(countryIdToPickId(id + 1))
      const q1 = rgbToPickId(Math.round(c1.r * 255), Math.round(c1.g * 255), Math.round(c1.b * 255))
      const q2 = rgbToPickId(Math.round(c2.r * 255), Math.round(c2.g * 255), Math.round(c2.b * 255))
      expect(q1).not.toBe(q2)
    }
  })

  it('countryId→pickId→Color→量化→pickId→countryId 端到端可逆', () => {
    for (let id = 0; id < 300; id++) {
      const c = pickIdToColor(countryIdToPickId(id))
      const pickId = rgbToPickId(Math.round(c.r * 255), Math.round(c.g * 255), Math.round(c.b * 255))
      expect(pickIdToCountryId(pickId)).toBe(id)
    }
  })
})

// ---------------------------------------------------------------------------
// buildPickColors / buildPickingGeometry（合成数据）
// ---------------------------------------------------------------------------

describe('buildPickColors（每顶点国家色）', () => {
  it('长度 = 顶点数 ×3，对齐 vertices/2', () => {
    const b = decodeSynthetic()
    const colors = buildPickColors(b)
    expect(colors.length).toBe((b.vertices.length / 2) * 3)
  })

  it('同一国家所有顶点颜色一致 = pickIdToColor(countryId+1)', () => {
    const b = decodeSynthetic()
    const colors = buildPickColors(b)
    for (const c of b.countries) {
      const expected = pickIdToColor(countryIdToPickId(c.id))
      for (let i = 0; i < c.vertexCount; i++) {
        const vi = (c.vertexOffset + i) * 3
        expect(colors[vi]).toBeCloseTo(expected.r, 6)
        expect(colors[vi + 1]).toBeCloseTo(expected.g, 6)
        expect(colors[vi + 2]).toBeCloseTo(expected.b, 6)
      }
    }
  })

  it('不同国家颜色不同（合成 6 国 6 色）', () => {
    const b = decodeSynthetic()
    const colors = buildPickColors(b)
    const sigs = b.countries.map((c) => {
      const vi = c.vertexOffset * 3
      return `${colors[vi]},${colors[vi + 1]},${colors[vi + 2]}`
    })
    expect(new Set(sigs).size).toBe(b.countries.length)
  })

  it('每国家首顶点色 = pickIdToRGB(countryId+1)/255 三通道', () => {
    const b = decodeSynthetic()
    const colors = buildPickColors(b)
    for (const c of b.countries) {
      const [r, g, bl] = pickIdToRGB(countryIdToPickId(c.id))
      const vi = c.vertexOffset * 3
      expect(colors[vi]).toBeCloseTo(r / 255, 6)
      expect(colors[vi + 1]).toBeCloseTo(g / 255, 6)
      expect(colors[vi + 2]).toBeCloseTo(bl / 255, 6)
    }
  })
})

describe('buildPickingGeometry（同源 position + color + index）', () => {
  it('position 与 buildBoundaryPositions 逐元素一致（同源贴地）', () => {
    const b = decodeSynthetic()
    const elev = flatElevation(4, 2, 32768)
    const m = meta()
    const g = buildPickingGeometry(b, elev, m)
    const expected = buildBoundaryPositions(b, elev, m)
    const pos = g.getAttribute('position') as THREE.BufferAttribute
    expect(pos.array.length).toBe(expected.length)
    for (let i = 0; i < expected.length; i++) {
      expect(pos.array[i]).toBeCloseTo(expected[i], 6)
    }
  })

  it('color attribute itemSize=3 + 与 buildPickColors 一致', () => {
    const b = decodeSynthetic()
    const g = buildPickingGeometry(b, flatElevation(4, 2, 32768), meta())
    const colorAttr = g.getAttribute('color') as THREE.BufferAttribute
    expect(colorAttr).toBeTruthy()
    expect(colorAttr.itemSize).toBe(3)
    const expected = buildPickColors(b)
    expect(colorAttr.array.length).toBe(expected.length)
    for (let i = 0; i < expected.length; i++) {
      expect(colorAttr.array[i]).toBeCloseTo(expected[i], 6)
    }
  })

  it('index = fillIndices（同三角形索引，与可见几何一致）', () => {
    const b = decodeSynthetic()
    const g = buildPickingGeometry(b, flatElevation(4, 2, 32768), meta())
    const idx = g.getIndex() as THREE.BufferAttribute
    expect(idx.array.length).toBe(b.fillIndices.length)
    for (let i = 0; i < b.fillIndices.length; i++) {
      expect(idx.array[i]).toBe(b.fillIndices[i])
    }
  })

  it('顶点数 = vertices/2（position / color 对齐）', () => {
    const b = decodeSynthetic()
    const g = buildPickingGeometry(b, flatElevation(4, 2, 32768), meta())
    const n = b.vertices.length / 2
    expect((g.getAttribute('position') as THREE.BufferAttribute).count).toBe(n)
    expect((g.getAttribute('color') as THREE.BufferAttribute).count).toBe(n)
  })
})

// ---------------------------------------------------------------------------
// 拾取材质 / RT 契约
// ---------------------------------------------------------------------------

describe('拾取材质 / RT 契约', () => {
  it('createPickingMaterial：vertexColors + DoubleSide + 不透明', () => {
    const mat = createPickingMaterial()
    expect(mat.vertexColors).toBe(true)
    expect(mat.side).toBe(THREE.DoubleSide)
    expect(mat.transparent).toBe(false)
    mat.dispose()
  })

  it('PICKING_MATERIAL_OPTS 导出契约（单测守）', () => {
    expect(PICKING_MATERIAL_OPTS.vertexColors).toBe(true)
    expect(PICKING_MATERIAL_OPTS.side).toBe(THREE.DoubleSide)
  })

  it('createPickingTarget：尺寸 / NearestFilter（防插值串色） / RGBA8 / depth', () => {
    const rt = createPickingTarget(64, 32)
    expect(rt.width).toBe(64)
    expect(rt.height).toBe(32)
    expect(rt.texture.magFilter).toBe(THREE.NearestFilter)
    expect(rt.texture.minFilter).toBe(THREE.NearestFilter)
    expect(rt.texture.format).toBe(THREE.RGBAFormat)
    expect(rt.texture.type).toBe(THREE.UnsignedByteType)
    expect(rt.depthBuffer).toBe(true)
    rt.dispose()
  })

  it('createPickingTarget：0 尺寸钳到 1（防 WebGLRenderTarget 零尺寸）', () => {
    const rt = createPickingTarget(0, 0)
    expect(rt.width).toBe(1)
    expect(rt.height).toBe(1)
    rt.dispose()
  })
})

// ---------------------------------------------------------------------------
// pickAt（命中判定准确，注入式 mock renderer）
// ---------------------------------------------------------------------------

describe('pickAt（注入式 mock renderer）', () => {
  it('读出国家色 → 正确 countryId（命中判定准确）', () => {
    const b = decodeSynthetic()
    const country = b.countries[2]
    const [r, g, bl] = pickIdToRGB(countryIdToPickId(country.id))
    const renderer = mockRenderer([r, g, bl])
    const rt = createPickingTarget(10, 10)
    const result = pickAt(renderer, rt, new THREE.Scene(), new THREE.Camera(), 0, 0)
    expect(result).toBe(country.id)
    rt.dispose()
  })

  it('合成 6 国逐一命中：每国色 → 对应 countryId', () => {
    const b = decodeSynthetic()
    const rt = createPickingTarget(10, 10)
    for (const c of b.countries) {
      const [r, g, bl] = pickIdToRGB(countryIdToPickId(c.id))
      const renderer = mockRenderer([r, g, bl])
      expect(pickAt(renderer, rt, new THREE.Scene(), new THREE.Camera(), 0, 0)).toBe(c.id)
    }
    rt.dispose()
  })

  it('读出背景 (0,0,0) → null（无命中）', () => {
    const renderer = mockRenderer([0, 0, 0])
    const rt = createPickingTarget(10, 10)
    const result = pickAt(renderer, rt, new THREE.Scene(), new THREE.Camera(), 0.5, 0.5)
    expect(result).toBeNull()
    rt.dispose()
  })

  it('RT 复位：pickAt 后 renderTarget 恢复主画布（null）', () => {
    const renderer = mockRenderer([0, 0, 0])
    expect(renderer.getRenderTarget()).toBeNull()
    const rt = createPickingTarget(10, 10)
    pickAt(renderer, rt, new THREE.Scene(), new THREE.Camera(), 0, 0)
    expect(renderer.getRenderTarget()).toBeNull()
    rt.dispose()
  })

  it('render 在 pickAt 中被调用一次（按需渲染 RT）', () => {
    const renderer = mockRenderer([1, 0, 0])
    const rt = createPickingTarget(10, 10)
    pickAt(renderer, rt, new THREE.Scene(), new THREE.Camera(), 0, 0)
    expect(renderer.render).toHaveBeenCalledTimes(1)
    rt.dispose()
  })

  it('NDC→像素映射：中心 (0,0) → 中间像素；readRenderTargetPixels 收到映射坐标', () => {
    const seen: Array<[number, number]> = []
    let current: THREE.WebGLRenderTarget | null = null
    const renderer = {
      getRenderTarget: () => current,
      setRenderTarget: (t: THREE.WebGLRenderTarget | null) => {
        current = t
      },
      render: vi.fn(),
      readRenderTargetPixels: vi.fn(
        (_t: unknown, x: number, y: number, _w: number, _h: number, buf: Uint8Array) => {
          seen.push([x, y])
          buf[0] = 0
          buf[1] = 0
          buf[2] = 0
          buf[3] = 255
        },
      ),
    } as unknown as THREE.WebGLRenderer
    const rt = createPickingTarget(100, 100)
    pickAt(renderer, rt, new THREE.Scene(), new THREE.Camera(), 0, 0) // NDC(0,0)→像素(50,50)
    expect(seen[0]).toEqual([50, 50])
    rt.dispose()
  })

  it('NDC 越界钳到边缘像素（不越界 readPixels）', () => {
    const seen: Array<[number, number]> = []
    let current: THREE.WebGLRenderTarget | null = null
    const renderer = {
      getRenderTarget: () => current,
      setRenderTarget: (t: THREE.WebGLRenderTarget | null) => {
        current = t
      },
      render: vi.fn(),
      readRenderTargetPixels: vi.fn(
        (_t: unknown, x: number, y: number, _w: number, _h: number, buf: Uint8Array) => {
          seen.push([x, y])
          buf[0] = 0
          buf[1] = 0
          buf[2] = 0
          buf[3] = 255
        },
      ),
    } as unknown as THREE.WebGLRenderer
    const rt = createPickingTarget(100, 100)
    pickAt(renderer, rt, new THREE.Scene(), new THREE.Camera(), 5, 5) // 越界 → 钳到 (99,99)
    expect(seen[0]).toEqual([99, 99])
    pickAt(renderer, rt, new THREE.Scene(), new THREE.Camera(), -5, -5) // 越界 → 钳到 (0,0)
    expect(seen[1]).toEqual([0, 0])
    rt.dispose()
  })
})

// ---------------------------------------------------------------------------
// pickingApi 寄存器
// ---------------------------------------------------------------------------

describe('pickingApi 寄存器', () => {
  it('set / get / clear', () => {
    clearPickingApi()
    expect(getPickingApi()).toBeNull()
    const api = { pick: () => null }
    setPickingApi(api)
    expect(getPickingApi()).toBe(api)
    setPickingApi(null)
    expect(getPickingApi()).toBeNull()
  })

  it('api.pick 闭包调用（验证寄存器透传）', () => {
    clearPickingApi()
    let called: [number, number] | null = null
    setPickingApi({
      pick: (x, y) => {
        called = [x, y]
        return 42
      },
    })
    const api = getPickingApi()
    expect(api).not.toBeNull()
    expect(api!.pick(0.3, -0.2)).toBe(42)
    expect(called).toEqual([0.3, -0.2])
    clearPickingApi()
  })
})
