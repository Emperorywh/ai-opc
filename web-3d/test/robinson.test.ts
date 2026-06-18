/**
 * Task 26 · Robinson 投影 pipeline 单测（M9 风险验证 #2「全矢量对齐」的基石）。
 *
 * 核心断言：前端 `src/config/projection.ts:project()` 与 pipeline
 * `scripts/data-pipeline/lib/robinson.mjs:projectRobinson()` **逐点同源** ——
 * pipeline 烘焙的 Robinson 像素网格（heightmap 像素中心 = PlaneGeometry 顶点）
 * 必须与前端 project() 输出的 worldXY 严格对齐，否则矢量/地形错位。
 *
 * 另验证：Robinson heightmap 产物（重投影后）已知点正确（陆地>海/海洋<海），
 * 端到端覆盖「project(Robinson) + Robinson 网格 + sampleHeight 走 project」对齐链路。
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import {
  project,
  unproject,
  PLANE_WIDTH,
  PLANE_HEIGHT,
  ROBINSON_MAX_X as FE_MAX_X,
  ROBINSON_MAX_Y as FE_MAX_Y,
  ROBINSON_DEF as FE_DEF,
  heightToMeters,
} from '../src/config/projection'
import {
  projectRobinson,
  unprojectRobinson,
  ROBINSON_MAX_X,
  ROBINSON_MAX_Y,
  ROBINSON_DEF,
} from '../scripts/data-pipeline/lib/robinson.mjs'
import { decodePng } from '../scripts/data-pipeline/lib/png-reader.mjs'
import { parseMeta, sampleHeight } from '../src/data/assets'

const SAMPLES: Array<[number, number]> = [
  [0, 0],
  [180, 0],
  [-180, 0],
  [0, 90],
  [0, -90],
  [116.4, 39.9],
  [-74, 40.7],
  [-70, -15],
  [120, 60],
  [-150, -80],
  [45, 0],
]

describe('Robinson 投影数学（pipeline robinson.mjs）', () => {
  it('projectRobinson 边界 → [-1,1]×[-0.5,0.5]（与 equirect 同范围）', () => {
    expect(projectRobinson(180, 0)[0]).toBe(1)
    expect(projectRobinson(-180, 0)[0]).toBe(-1)
    expect(projectRobinson(0, 90)[1]).toBeCloseTo(-0.5, 10)
    expect(projectRobinson(0, -90)[1]).toBeCloseTo(0.5, 10)
    // proj4 robin 对 (0,0) 返回极小浮点残留（~2.6e-18），用容差比较
    expect(projectRobinson(0, 0)[0]).toBeCloseTo(0, 10)
    expect(projectRobinson(0, 0)[1]).toBeCloseTo(0, 10)
  })

  it('unprojectRobinson 是 projectRobinson 的反函数', () => {
    // ±180 边缘经度在 Robinson 是矩形左右边（同一条经线，反投影返回 ±180 之一，环绕歧义非 bug），
    // 故 round-trip 用内部点验证；极点经度 0 无歧义可保留。
    const inner = SAMPLES.filter(([lon]) => Math.abs(lon) < 180)
    for (const [lon, lat] of inner) {
      const [x, z] = projectRobinson(lon, lat)
      const [lon2, lat2] = unprojectRobinson(x, z)
      expect(lon2).toBeCloseTo(lon, 6)
      expect(lat2).toBeCloseTo(lat, 6)
    }
  })

  it('极区压缩：高纬经线收敛', () => {
    expect(projectRobinson(180, 85)[0]).toBeLessThan(0.6)
    expect(projectRobinson(180, -85)[0]).toBeLessThan(0.6)
    const antSpan = projectRobinson(180, -80)[0] - projectRobinson(-180, -80)[0]
    expect(antSpan).toBeLessThan(1.5) // 南极洲跨度 < 1.5（equirect 恒 2.0）
  })
})

describe('前端 project 与 pipeline projectRobinson 同源（M9 对齐基石）', () => {
  it('投影定义串一致', () => {
    expect(ROBINSON_DEF).toBe(FE_DEF)
  })

  it('Robinson 归一化常数严格相等（同一 proj4 表达式）', () => {
    expect(ROBINSON_MAX_X).toBe(FE_MAX_X)
    expect(ROBINSON_MAX_Y).toBe(FE_MAX_Y)
    expect(PLANE_WIDTH).toBe(2.0)
    expect(PLANE_HEIGHT).toBe(1.0)
  })

  it('project(lon,lat) === projectRobinson(lon,lat)（逐点对齐）', () => {
    for (const [lon, lat] of SAMPLES) {
      const fe = project(lon, lat)
      const pl = projectRobinson(lon, lat)
      expect(fe[0]).toBeCloseTo(pl[0], 9)
      expect(fe[1]).toBeCloseTo(pl[1], 9)
    }
  })

  it('unproject(x,z) === unprojectRobinson(x,z)（逐点对齐）', () => {
    for (const [lon, lat] of SAMPLES) {
      const [x, z] = project(lon, lat)
      const fe = unproject(x, z)
      const pl = unprojectRobinson(x, z)
      expect(fe[0]).toBeCloseTo(pl[0], 9)
      expect(fe[1]).toBeCloseTo(pl[1], 9)
    }
  })
})

describe('Robinson heightmap 产物对齐（真实重投影 DEM · 端到端）', () => {
  // 解码真实 Robinson heightmap（Task 26 重烘焙产物）
  const PUBLIC_DATA = resolve('public/data')
  const metaRaw = JSON.parse(readFileSync(resolve(PUBLIC_DATA, 'meta.json'), 'utf8'))
  const png = decodePng(readFileSync(resolve(PUBLIC_DATA, 'heightmap.png')))
  const raw = new Uint16Array(png.width * png.height)
  for (let i = 0; i < raw.length; i++) raw[i] = (png.data[i * 2] << 8) | png.data[i * 2 + 1]
  const elev = { width: png.width, height: png.height, data: raw }
  const meta = parseMeta(metaRaw)

  it('产物声明 Robinson 投影', () => {
    expect(meta.projection).toBe('robinson')
  })

  it('已知陆地高于海平面（sampleHeight 走 project 采样 Robinson 网格）', () => {
    const land: ReadonlyArray<readonly [string, number, number]> = [
      ['北京', 116.4, 39.9],
      ['喜马拉雅', 86.9, 27.9],
      ['安第斯', -70, -15],
      ['南极内陆', 0, -80],
      ['澳洲中部', 134, -25],
    ]
    for (const [, lon, lat] of land) {
      expect(heightToMeters(sampleHeight(elev, lon, lat), meta)).toBeGreaterThan(meta.seaLevelMeters)
    }
  })

  it('已知海洋低于海平面', () => {
    const ocean: ReadonlyArray<readonly [string, number, number]> = [
      ['太平洋中部', -160, 0],
      ['大西洋中部', -30, 0],
      ['印度洋', 80, -20],
      ['北冰洋', 0, 85],
    ]
    for (const [, lon, lat] of ocean) {
      expect(heightToMeters(sampleHeight(elev, lon, lat), meta)).toBeLessThan(meta.seaLevelMeters)
    }
  })

  it('喜马拉雅为高山（>3000m，区分真实地形与平坦合成）', () => {
    expect(heightToMeters(sampleHeight(elev, 86.9, 27.9), meta)).toBeGreaterThan(3000)
  })
})
