/**
 * Task 02b · 真实 DEM 数据源（GEBCO）双线性采样单测。
 *
 * 验证 bilinearSampleElev 的采样约定严格对齐 src/data/assets.ts 的 sampleHeight
 * （像素中心 floor(sx-0.5)、经度方向环绕、纬度方向钳制）——保证 R3 同源（CPU 查询 / GPU
 * LINEAR / 数据源三处一致）。用合成小栅格，不依赖 GB 级 GEBCO 文件。
 */
import { describe, it, expect } from 'vitest'
import {
  bilinearSampleElev,
  ELEVATION_MIN,
  ELEVATION_MAX,
} from '../scripts/data-pipeline/lib/real-dem-source.mjs'

// 4×2 全球栅格：W=4（经度每像素 90°）、H=2（纬度每像素 90°）
// 像素中心 lon: x=0..3 → -135,-45,45,135；像素中心 lat: y=0..1 → 45,-45
function makeGrid() {
  const grid = new Float32Array([
    // y=0 (lat~45)
    1000, 2000, 3000, 4000,
    // y=1 (lat~-45)
    500, 600, 700, 800,
  ])
  return { grid, W: 4, H: 2 }
}

describe('bilinearSampleElev（约定对齐 assets.ts sampleHeight）', () => {
  it('精确命中像素中心返回该像素值', () => {
    const { grid, W, H } = makeGrid()
    expect(bilinearSampleElev(grid, W, H, -135, 45)).toBe(1000) // x=0, y=0
    expect(bilinearSampleElev(grid, W, H, 135, -45)).toBe(800) // x=3, y=1
  })

  it('经度中点双线性插值', () => {
    const { grid, W, H } = makeGrid()
    // lon=-90 是 x=0(1000) 与 x=1(2000) 在 lat=45 行的中点
    expect(bilinearSampleElev(grid, W, H, -90, 45)).toBe(1500)
  })

  it('经度环绕（180 与 -180 为同一经线，x=3 与 x=0 插值）', () => {
    const { grid, W, H } = makeGrid()
    // lon=180 → sx=4, x0=3, x1=wrap(4)=0；lat=45 → y0=0, fy=0
    // a = grid[0,3]=4000 + (grid[0,0]=1000 − 4000) × 0.5 = 2500
    expect(bilinearSampleElev(grid, W, H, 180, 45)).toBe(2500)
    expect(bilinearSampleElev(grid, W, H, -180, 45)).toBe(2500)
  })

  it('纬度钳制到极点（lat=±90 不外推到栅格外行）', () => {
    const { grid, W, H } = makeGrid()
    // lat=90 → sy=0, y0=-1 钳制到 0，取 y=0 行
    expect(bilinearSampleElev(grid, W, H, -135, 90)).toBe(1000)
    // lat=-90 → sy=2, y1 钳制到 1，取 y=1 行
    expect(bilinearSampleElev(grid, W, H, -135, -90)).toBe(500)
  })

  it('二维中点 = 四角双线性平均', () => {
    const { grid, W, H } = makeGrid()
    // lon=-90（x0=0,x1=1 中点）、lat=0（y0=0,y1=1 中点）
    // 四角 1000/2000(y=0)、500/600(y=1) → 中点 = (1000+2000+500+600)/4 = 1025
    expect(bilinearSampleElev(grid, W, H, -90, 0)).toBe(1025)
  })
})

describe('GEBCO 高程映射范围', () => {
  it('ELEVATION_MIN/MAX 覆盖真实高程并保持 16-bit 精度', () => {
    expect(ELEVATION_MIN).toBeLessThanOrEqual(-10000) // 覆盖海沟
    expect(ELEVATION_MAX).toBeGreaterThanOrEqual(8848) // 覆盖珠峰
    const span = ELEVATION_MAX - ELEVATION_MIN
    expect(span).toBeLessThan(65535) // 16-bit 步长 >0.29m/级
  })
})
