/**
 * GPU 位移地形渲染装配测试（TASK-006 验收 1、3、4）。
 *
 * 依赖方向：测试基线（vitest，Node 环境），import src/three/terrain-shaders（纯 GLSL 字符串）、
 * src/three/load-heightmap-texture（纹理构造纯函数 + three.js DataTexture，Node 内可实例化、不触发
 * GL 上传）、src/three/terrain-layout（纯 TS）、src/config/*（纯 TS）、src/lib/elevation（纯 TS）。
 * 不启动 WebGL / 浏览器——渲染正确性由「shader 源码结构不变量 + 纹理参数断言 + CPU/GPU 采样一致性
 * 数值仿真 + 无头 Chrome 截图（人工 / 脚本）」共同保证。
 *
 * 覆盖：
 * - 验收 1：mesh 用 PlaneGeometry + shaderMaterial（源码扫描），全 src 无 CPU 端逐顶点写 position
 *   的几何构建（setXYZ / attributes.position / setAttribute 等模式不存在）；纹理为
 *   RedFormat+FloatType+Linear+ClampToEdge（16 位端到端）。
 * - 验收 2：片元按像素 UV 重采样 heightmap 得真实 h、按 meta minH/maxH 归一化查 ramp；
 *   uExaggeration（k）不出现在片元着色器（颜色与 k 结构性解耦，不可能误用 world-y）。
 * - 验收 3：uRise uniform 存在于顶点着色器且插值位移量（h·k·uRise）；法线由 heightmap 差分
 *   现场计算（texelStep + cross）。
 * - 验收 4：生产资产抽样点上，CPU provider 查询值与「GPU 纹理同源同解码」的数值仿真
 *   （uint16PixelsToNormalizedFloat → 归一化双线性 → decodeNormalizedToElevation）在 0.01m 内一致；
 *   世界 y = h·k；rise 插值语义 h·k·rise。
 */

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import * as THREE from 'three'
import { TERRAIN_FRAGMENT_SHADER, TERRAIN_VERTEX_SHADER } from '../src/three/terrain-shaders'
import {
  HeightmapLoadError,
  buildHeightmapDataTexture,
  uint16PixelsToNormalizedFloat,
} from '../src/three/load-heightmap-texture'
import {
  buildElevationRampTexture,
  rampRgbToRgbaBytes,
} from '../src/three/elevation-ramp-texture'
import { TERRAIN_PLANE_LAYOUT } from '../src/three/terrain-layout'
import {
  PRODUCTION_TERRAIN_CONFIG,
  decodeNormalizedToElevation,
  displaceElevationToWorldY,
} from '../src/config/terrain-config'
import {
  ELEVATION_COLOR_DOMAIN,
  ELEVATION_RAMP_WIDTH,
  buildElevationRampRgbData,
} from '../src/config/elevation-color-ramp'
import { createElevationProvider, decodeHeightmapBytes } from '../src/lib/elevation'
import { MAIN_MAP_WORLD_BOUNDS, projectToMercator } from '../src/lib/projection'
import type { TerrainMetaContract } from '../src/geo-contracts'

const projectRoot = resolve(fileURLToPath(import.meta.url), '..', '..')

/** 读取 src 下某源码文件的文本（源码结构不变量扫描用）。 */
function readSource(relativePath: string): string {
  return readFileSync(resolve(projectRoot, 'src', relativePath), 'utf-8')
}

describe('顶点着色器结构不变量（验收 1、3：GPU 位移 + uRise + 差分法线）', () => {
  it('声明并采样 uHeightmap（按顶点 UV 纹理采样位移，非 CPU 写位置）', () => {
    expect(TERRAIN_VERTEX_SHADER).toContain('uniform sampler2D uHeightmap')
    expect(TERRAIN_VERTEX_SHADER).toContain('texture2D(uHeightmap')
  })

  it('位移量 = h · uExaggeration · uRise（uRise 0→1 可插值，世界 y=h·k 于 uRise=1）', () => {
    expect(TERRAIN_VERTEX_SHADER).toContain('uniform float uExaggeration')
    expect(TERRAIN_VERTEX_SHADER).toContain('uniform float uRise')
    expect(TERRAIN_VERTEX_SHADER).toContain('displaced.z += hCenter * uExaggeration * uRise')
  })

  it('法线由 heightmap 有限差分现场计算（1-texel 步长采样邻接高程 + 切线叉乘）', () => {
    expect(TERRAIN_VERTEX_SHADER).toContain('texelStep')
    expect(TERRAIN_VERTEX_SHADER).toContain('vec2(1.0) / uHeightmapSize')
    expect(TERRAIN_VERTEX_SHADER).toContain('cross(tangentX, tangentY)')
  })

  it('UV v 翻转对齐 heightmap 行 0=北（与 CPU 采样器同一方位约定）', () => {
    expect(TERRAIN_VERTEX_SHADER).toContain('vec2(planeUV.x, 1.0 - planeUV.y)')
  })

  it('解码公式与契约层同一仿射：h = normalized·(max−min) + min', () => {
    expect(TERRAIN_VERTEX_SHADER).toContain('uniform float uMinElevationMeters')
    expect(TERRAIN_VERTEX_SHADER).toContain('uniform float uMaxElevationMeters')
    expect(TERRAIN_VERTEX_SHADER).toContain(
      'normalized * (uMaxElevationMeters - uMinElevationMeters) + uMinElevationMeters',
    )
  })
})

describe('片元着色器结构不变量（验收 2：真实 h 查 ramp，不用 world-y）', () => {
  it('按像素 UV 重采样 heightmap 得真实 h（不用顶点透传离散高程）', () => {
    expect(TERRAIN_FRAGMENT_SHADER).toContain('texture2D(uHeightmap, vHeightmapUV)')
  })

  it('用 meta 真实上下限（uMin/uMaxElevationMeters）归一化后采样 256×1 ramp', () => {
    expect(TERRAIN_FRAGMENT_SHADER).toContain('uniform sampler2D uElevationRamp')
    expect(TERRAIN_FRAGMENT_SHADER).toContain(
      '(elevationMeters - uMinElevationMeters) / (uMaxElevationMeters - uMinElevationMeters)',
    )
    expect(TERRAIN_FRAGMENT_SHADER).toContain('texture2D(uElevationRamp, vec2(rampU, 0.5))')
  })

  it('uExaggeration（k）不出现在片元着色器——颜色与 k 结构性解耦（不可能误用 world-y 查色）', () => {
    expect(TERRAIN_FRAGMENT_SHADER).not.toContain('uExaggeration')
    // 片元也没有任何 world-y 来源：不透传位移后位置用于查色。
    expect(TERRAIN_FRAGMENT_SHADER).not.toContain('vWorldPosition.y')
  })

  it('叠加方向光法线明暗（Lambert 漫反射 + 半球环境光，SPEC §3.1/§3.4）', () => {
    expect(TERRAIN_FRAGMENT_SHADER).toContain('dot(N, normalize(uMainLightDirection))')
    expect(TERRAIN_FRAGMENT_SHADER).toContain('uHemisphereSkyColor')
    expect(TERRAIN_FRAGMENT_SHADER).toContain('uHemisphereGroundColor')
  })
})

describe('CPU 端无逐顶点几何构建（验收 1：SPEC §7.1 红线）', () => {
  // CPU 端逐顶点写 position 的典型模式；任一出现在 src 即违反 SPEC §7.1。
  const FORBIDDEN_PATTERNS = [
    'setXYZ(',
    'attributes.position',
    'position.array',
    'setAttribute(',
    'BufferAttribute',
    'mergeVertices',
  ]
  const SRC_FILES = [
    'three/ChinaTerrainMesh.tsx',
    'three/terrain-shaders.ts',
    'three/load-heightmap-texture.ts',
    'three/elevation-ramp-texture.ts',
    'three/terrain-layout.ts',
    'lib/elevation.ts',
    'config/terrain-config.ts',
  ]

  it('ChinaTerrainMesh 以 planeGeometry + shaderMaterial 声明式装配（GPU 位移路径）', () => {
    const source = readSource('three/ChinaTerrainMesh.tsx')
    expect(source).toContain('<planeGeometry')
    expect(source).toContain('<shaderMaterial')
    expect(source).toContain('TERRAIN_VERTEX_SHADER')
    expect(source).toContain('TERRAIN_FRAGMENT_SHADER')
  })

  for (const file of SRC_FILES) {
    it(`${file} 不含 CPU 逐顶点写 position 的几何构建模式`, () => {
      const source = readSource(file)
      for (const pattern of FORBIDDEN_PATTERNS) {
        expect(source.includes(pattern), `发现禁用模式 ${pattern}`).toBe(false)
      }
    })
  }
})

describe('heightmap 纹理构造（验收 1、4：16 位端到端，无 8 位降级）', () => {
  const meta: TerrainMetaContract = {
    kind: 'terrain-meta',
    version: '1.0.0',
    crs: 'EPSG:3857',
    geographicExtent: { crs: 'EPSG:4326', west: 100, south: 20, east: 104, north: 24 },
    resolution: { widthPixels: 2, heightPixels: 2 },
    elevationEncoding: {
      minValueMeters: -1500,
      maxValueMeters: 9000,
      bitDepth: 16,
      encoding: 'linear-unsigned-integer',
      outOfRangePolicy: 'clamp-to-range',
    },
    source: { sourceId: 'src-test' },
  }

  it('uint16 → 归一化 float32 保留 16 位精度（50000 不坍缩到 8 位上限）', () => {
    const normalized = uint16PixelsToNormalizedFloat(new Uint16Array([0, 255, 50000, 65535]))
    expect(normalized[0]).toBe(0)
    expect(normalized[3]).toBe(1)
    // 50000/65535 ≈ 0.763；若被 8 位截断会坍缩到 255/65535 ≈ 0.0039。
    expect(normalized[2]).toBeCloseTo(50000 / 65535, 6)
    expect(normalized[2]).toBeGreaterThan(0.7)
  })

  it('纹理为 RedFormat + FloatType + LinearFilter + ClampToEdge，无 mipmap', () => {
    const texture = buildHeightmapDataTexture(meta, new Uint16Array([1, 2, 3, 4]))
    expect(texture.format).toBe(THREE.RedFormat)
    expect(texture.type).toBe(THREE.FloatType)
    expect(texture.magFilter).toBe(THREE.LinearFilter)
    expect(texture.minFilter).toBe(THREE.LinearFilter)
    expect(texture.wrapS).toBe(THREE.ClampToEdgeWrapping)
    expect(texture.wrapT).toBe(THREE.ClampToEdgeWrapping)
    expect(texture.generateMipmaps).toBe(false)
    expect(texture.image.width).toBe(2)
    expect(texture.image.height).toBe(2)
  })

  it('像元数与元数据分辨率不符 → heightmap.byte-length-mismatch（绝不静默放行）', () => {
    let caught: unknown
    try {
      buildHeightmapDataTexture(meta, new Uint16Array([1, 2, 3]))
    } catch (cause) {
      caught = cause
    }
    expect(caught).toBeInstanceOf(HeightmapLoadError)
    expect((caught as HeightmapLoadError).code).toBe('heightmap.byte-length-mismatch')
  })
})

describe('ramp 纹理构造（验收 2 的支撑：WebGL2 可用的 256×1 查找表）', () => {
  const rampRgb = buildElevationRampRgbData(
    ELEVATION_RAMP_WIDTH,
    ELEVATION_COLOR_DOMAIN.minValueMeters,
    ELEVATION_COLOR_DOMAIN.maxValueMeters,
  )

  it('RGB→RGBA 展开：长度 width·4、RGB 逐字节一致、alpha 恒 255', () => {
    const rgba = rampRgbToRgbaBytes(rampRgb, ELEVATION_RAMP_WIDTH)
    expect(rgba.length).toBe(ELEVATION_RAMP_WIDTH * 4)
    for (let i = 0; i < ELEVATION_RAMP_WIDTH; i++) {
      expect(rgba[i * 4]).toBe(rampRgb[i * 3])
      expect(rgba[i * 4 + 1]).toBe(rampRgb[i * 3 + 1])
      expect(rgba[i * 4 + 2]).toBe(rampRgb[i * 3 + 2])
      expect(rgba[i * 4 + 3]).toBe(255)
    }
  })

  it('RGB 字节长度与宽度不符 → RangeError（不静默放行）', () => {
    expect(() => rampRgbToRgbaBytes(new Uint8Array(6), 3)).toThrow(RangeError)
  })

  it('ramp 纹理为 RGBAFormat + UnsignedByteType + Linear + ClampToEdge，无 mipmap', () => {
    const texture = buildElevationRampTexture({
      domain: ELEVATION_COLOR_DOMAIN,
      rampRgbData: rampRgb,
      rampWidth: ELEVATION_RAMP_WIDTH,
    })
    // RGBA8 是 WebGL2 sized internal format；RGBFormat（unsized GL_RGB）在 three r185 下会被
    // texStorage2D 拒绝导致纹理恒黑——本断言锁定 RGBA 选择，防止回退。
    expect(texture.format).toBe(THREE.RGBAFormat)
    expect(texture.type).toBe(THREE.UnsignedByteType)
    expect(texture.magFilter).toBe(THREE.LinearFilter)
    expect(texture.minFilter).toBe(THREE.LinearFilter)
    expect(texture.wrapS).toBe(THREE.ClampToEdgeWrapping)
    expect(texture.wrapT).toBe(THREE.ClampToEdgeWrapping)
    expect(texture.generateMipmaps).toBe(false)
    expect(texture.image.width).toBe(ELEVATION_RAMP_WIDTH)
    expect(texture.image.height).toBe(1)
  })

  it('ChinaTerrainMesh 经 buildElevationRampTexture 构造 ramp（不内联 RGBFormat）', () => {
    const source = readSource('three/ChinaTerrainMesh.tsx')
    expect(source).toContain('buildElevationRampTexture')
    expect(source).not.toContain('RGBFormat')
  })
})

describe('terrain-layout 与统一投影包围盒一致（mesh 覆盖主图范围）', () => {
  it('plane 米制宽高 = 主图世界包围盒跨度，centerZ = 南北中点', () => {
    expect(TERRAIN_PLANE_LAYOUT.worldWidthX).toBe(
      MAIN_MAP_WORLD_BOUNDS.maxX - MAIN_MAP_WORLD_BOUNDS.minX,
    )
    expect(TERRAIN_PLANE_LAYOUT.worldHeightZ).toBe(
      MAIN_MAP_WORLD_BOUNDS.maxZ - MAIN_MAP_WORLD_BOUNDS.minZ,
    )
    expect(TERRAIN_PLANE_LAYOUT.centerZ).toBe(
      (MAIN_MAP_WORLD_BOUNDS.minZ + MAIN_MAP_WORLD_BOUNDS.maxZ) / 2,
    )
    expect(TERRAIN_PLANE_LAYOUT.worldWidthX).toBeGreaterThan(0)
    expect(TERRAIN_PLANE_LAYOUT.worldHeightZ).toBeGreaterThan(0)
  })
})

describe('CPU/GPU 同源同解码 · 生产资产抽样点一致（验收 4）', () => {
  /**
   * 加载生产 heightmap，分别走两条路径采样同一批经纬度点：
   * - CPU 路径：createElevationProvider（先解码四角 uint16 到米，再双线性米值）。
   * - GPU 仿真路径：uint16PixelsToNormalizedFloat（构造 GPU 纹理的同一函数）→ 在归一化 float32
   *   上做同一角点数学的双线性 → decodeNormalizedToElevation（着色器仿射的 CPU 镜像）。
   * 由于 decode 是仿射，两路径在浮点精度内一致（差异仅来自归一化值的 float32 量化 ≪0.01m）。
   */
  const metaPath = resolve(projectRoot, 'public/terrain/china-heightmap-4096.meta.json')
  const rasterPath = resolve(projectRoot, 'public/terrain/china-heightmap-4096.r16')
  const meta = JSON.parse(readFileSync(metaPath, 'utf-8')) as TerrainMetaContract
  const bytes = readFileSync(rasterPath) as Uint8Array
  const width = meta.resolution.widthPixels
  const height = meta.resolution.heightPixels
  const { minValueMeters, maxValueMeters } = meta.elevationEncoding

  // 同一份 16 位像素（CPU provider 与 GPU 纹理共用的事实源，与 loadHeightmapTexture 返回的 pixels 同源）。
  const pixels = decodeHeightmapBytes(bytes, width * height)
  const provider = createElevationProvider(meta, pixels)
  // GPU 纹理数据（构造 DataTexture 的同一转换函数；float32 归一化码）。
  const gpuTexels = uint16PixelsToNormalizedFloat(pixels)

  /** GPU 语义仿真：归一化 float32 硬件双线性 + 着色器仿射解码（角点数学与 provider 同构）。 */
  function gpuSimulatedMeters(u: number, v: number): number {
    const fx = u * width - 0.5
    const fy = v * height - 0.5
    const maxCol = width - 1
    const maxRow = height - 1
    const x0 = Math.min(Math.max(Math.floor(fx), 0), maxCol)
    const x1 = Math.min(x0 + 1, maxCol)
    const y0 = Math.min(Math.max(Math.floor(fy), 0), maxRow)
    const y1 = Math.min(y0 + 1, maxRow)
    const tx = Math.min(Math.max(fx - x0, 0), 1)
    const ty = Math.min(Math.max(fy - y0, 0), 1)
    const n00 = gpuTexels[y0 * width + x0]
    const n10 = gpuTexels[y0 * width + x1]
    const n01 = gpuTexels[y1 * width + x0]
    const n11 = gpuTexels[y1 * width + x1]
    const top = n00 + (n10 - n00) * tx
    const bottom = n01 + (n11 - n01) * tx
    const normalized = top + (bottom - top) * ty
    return decodeNormalizedToElevation(normalized, minValueMeters, maxValueMeters)
  }

  /** 经纬度 → heightmap UV（与 provider 内部同一墨卡托归一化，独立复算）。 */
  function lonLatToUV(lon: number, lat: number): { readonly u: number; readonly v: number } {
    const ext = meta.geographicExtent
    const swR = projectToMercator(ext.west, ext.south)
    const neR = projectToMercator(ext.east, ext.north)
    const tR = projectToMercator(lon, lat)
    if (!swR.ok || !neR.ok || !tR.ok) throw new Error('夹具坐标投影失败')
    const sw = swR.value
    const ne = neR.value
    const t = tR.value
    return {
      u: (t.x - sw.x) / (ne.x - sw.x),
      v: (ne.y - t.y) / (ne.y - sw.y),
    }
  }

  // 覆盖青藏高原 / 塔里木 / 四川盆地 / 东部平原 / 东海陆架 / 南海深海 / 中部过渡带的抽样点。
  const SAMPLE_POINTS: ReadonlyArray<{ readonly name: string; readonly lon: number; readonly lat: number }> = [
    { name: '青藏高原', lon: 88, lat: 33 },
    { name: '塔里木盆地', lon: 82, lat: 40 },
    { name: '四川盆地', lon: 105, lat: 30 },
    { name: '东部平原', lon: 117, lat: 33 },
    { name: '东海陆架', lon: 125, lat: 28 },
    { name: '南海深海', lon: 115, lat: 15 },
    { name: '中部过渡带', lon: 100, lat: 25 },
    { name: '东北平原', lon: 126, lat: 45 },
  ]

  it('抽样点 CPU 查询高度与 GPU 仿真采样高度一致（容差 0.01m，仿射等价）', () => {
    for (const { name, lon, lat } of SAMPLE_POINTS) {
      const cpu = provider.queryAtLonLat(lon, lat)
      expect(cpu.ok, `${name} CPU 查询应成功`).toBe(true)
      if (!cpu.ok) continue
      const { u, v } = lonLatToUV(lon, lat)
      const gpu = gpuSimulatedMeters(u, v)
      expect(
        Math.abs(cpu.meters - gpu),
        `${name} (${lon},${lat}): CPU ${cpu.meters}m vs GPU ${gpu}m`,
      ).toBeLessThanOrEqual(0.01)
    }
  })

  it('UV 路径与经纬度路径在同一批抽样点上同样一致', () => {
    for (const { name, lon, lat } of SAMPLE_POINTS) {
      const { u, v } = lonLatToUV(lon, lat)
      const cpu = provider.queryAtUV(u, v)
      expect(cpu.ok, `${name} UV 查询应成功`).toBe(true)
      if (!cpu.ok) continue
      expect(Math.abs(cpu.meters - gpuSimulatedMeters(u, v))).toBeLessThanOrEqual(0.01)
    }
  })

  it('世界 y = h·k（k=PRODUCTION 2.0）：位移语义在抽样点上成立', () => {
    const k = PRODUCTION_TERRAIN_CONFIG.exaggeration
    expect(k).toBe(2.0)
    for (const { lon, lat } of SAMPLE_POINTS) {
      const cpu = provider.queryAtLonLat(lon, lat)
      if (!cpu.ok) continue
      expect(displaceElevationToWorldY(cpu.meters, k)).toBeCloseTo(cpu.meters * 2.0, 9)
    }
  })

  it('uRise 插值语义：位移量 = h·k·rise（rise=0 平面、rise=0.5 半高、rise=1 全高）', () => {
    // CPU 侧镜像顶点着色器的 displaced = h·k·rise，验证 0→1 可插值的数学语义。
    const cpu = provider.queryAtLonLat(88, 33)
    expect(cpu.ok).toBe(true)
    if (!cpu.ok) return
    const k = PRODUCTION_TERRAIN_CONFIG.exaggeration
    const full = displaceElevationToWorldY(cpu.meters, k)
    const riseScaled = (rise: number): number => full * rise
    expect(riseScaled(0)).toBe(0)
    expect(riseScaled(0.5)).toBeCloseTo(full / 2, 9)
    expect(riseScaled(1)).toBe(full)
  })
})
