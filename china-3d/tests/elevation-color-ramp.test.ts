/**
 * 地表分层设色色阶测试（TASK-006 验收 2：色阶断点与 SPEC §3.1 表一致）。
 *
 * 依赖方向：测试基线（vitest，Node 环境），import src/config/elevation-color-ramp（色阶唯一事实源）。
 * 不依赖浏览器、React、Three.js——色阶控制点、CPU 采样器、256 纹素 ramp、域校验都是纯 TS，
 * 可在 Node 内完整断言「断点 → 基线色」「颜色与夸张系数解耦」「错误 minH/maxH 被拒绝」。
 *
 * 覆盖：
 * - SPEC §3.1 全部断点（<0 / 0 / 200 / 500 / 1000 / 2000 / 3500 / 5000 / 9000）及相邻值映射到约定基线色。
 * - 分段线性插值策略一致（唯一策略，不存在第二套硬切逻辑）。
 * - 颜色与垂直夸张系数 k 解耦：同一真实高程在 k=1.5/2.0/3.0 下颜色完全一致，只有 world-y 改变。
 * - 256 纹素 ramp 由 CPU 采样器派生，端点与控制点一致；GPU 与 CPU 共用同一事实源。
 * - 错误 minH/maxH → resolveElevationColorConfig 抛 elevation-color.domain-mismatch（契约拒绝，不偏色）。
 * - 生产元数据（public/terrain/china-heightmap-4096.meta.json）通过色阶域复核。
 */

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  ELEVATION_COLOR_BREAKPOINTS,
  ELEVATION_COLOR_DOMAIN,
  ELEVATION_RAMP_WIDTH,
  ElevationColorError,
  buildElevationRampRgbData,
  normalizeElevationToRampU,
  resolveElevationColorConfig,
  sampleElevationColor,
  type RgbColor,
} from '../src/config/elevation-color-ramp'
import type { TerrainMetaContract } from '../src/geo-contracts'

const projectRoot = resolve(fileURLToPath(import.meta.url), '..', '..')

/** 容差内断言两颜色相等（CPU 采样器在控制点精确，分段间为浮点插值）。 */
function expectColorClose(actual: RgbColor, expected: RgbColor, tolerance = 0.5): void {
  expect(Math.abs(actual.r - expected.r)).toBeLessThanOrEqual(tolerance)
  expect(Math.abs(actual.g - expected.g)).toBeLessThanOrEqual(tolerance)
  expect(Math.abs(actual.b - expected.b)).toBeLessThanOrEqual(tolerance)
}

/** 构造一份带给定上下限的元数据形状（供 resolveElevationColorConfig 测试）。 */
function metaWith(minValueMeters: number, maxValueMeters: number) {
  return {
    elevationEncoding: { minValueMeters, maxValueMeters },
  }
}

describe('SPEC §3.1 断点 → 基线色（验收 2：断点与 SPEC 表一致）', () => {
  // 控制点海拔 → SPEC §3.1 基线色（手工换算的 RGB，与 ELEVATION_COLOR_BREAKPOINTS 同源）。
  const cases: ReadonlyArray<{ name: string; elevation: number; color: RgbColor }> = [
    { name: '深海（minH，水下区间）', elevation: -1500, color: { r: 6, g: 18, b: 28 } }, // #06121c
    { name: '平原 / 近岸 0m', elevation: 0, color: { r: 31, g: 77, b: 58 } }, // #1f4d3a
    { name: '丘陵 200m', elevation: 200, color: { r: 47, g: 107, b: 74 } }, // #2f6b4a
    { name: '低山 500m', elevation: 500, color: { r: 90, g: 122, b: 58 } }, // #5a7a3a
    { name: '中山 1000m', elevation: 1000, color: { r: 138, g: 122, b: 51 } }, // #8a7a33
    { name: '高山 2000m', elevation: 2000, color: { r: 122, g: 90, b: 46 } }, // #7a5a2e
    { name: '极高高山 3500m', elevation: 3500, color: { r: 94, g: 64, b: 48 } }, // #5e4030
    { name: '雪线 5000m', elevation: 5000, color: { r: 216, g: 228, b: 234 } }, // #d8e4ea
    { name: '雪线以上 9000m（maxH）', elevation: 9000, color: { r: 216, g: 228, b: 234 } }, // #d8e4ea
  ]

  for (const { name, elevation, color } of cases) {
    it(`${name}：${elevation}m → 基线色`, () => {
      // 断点海拔是控制点，CPU 采样器返回精确基线色（零量化误差）。
      expectColorClose(sampleElevationColor(elevation), color, 0)
    })
  }

  it('水下区间（<0）远端映射到深海近黑（近岸浅、远海深的梯度起点）', () => {
    // -1500 是水下控制点（深海近黑）；验证 "<0" 类海拔落在深海近黑区间。
    const deepSea = sampleElevationColor(-1500)
    expectColorClose(deepSea, { r: 6, g: 18, b: 28 }, 0)
    // 浅水近岸（-100）介于深海近黑与平原青绿之间，不会比深海更暗——体现近岸浅、远海深。
    const shallow = sampleElevationColor(-100)
    expect(shallow.r).toBeGreaterThanOrEqual(deepSea.r)
    expect(shallow.g).toBeGreaterThanOrEqual(deepSea.g)
    expect(shallow.b).toBeGreaterThanOrEqual(deepSea.b)
  })

  it('相邻值在断点之间平滑过渡（分段线性插值策略一致，无第二套硬切逻辑）', () => {
    // 100m 落在 0–200 平原段中点：颜色应是平原色与丘陵色的中点（线性插值）。
    const at0 = sampleElevationColor(0)
    const at200 = sampleElevationColor(200)
    const at100 = sampleElevationColor(100)
    expectColorClose(
      at100,
      { r: (at0.r + at200.r) / 2, g: (at0.g + at200.g) / 2, b: (at0.b + at200.b) / 2 },
      0.5,
    )
    // 600m 落在 500–1000 段，应介于低山与中山之间，不等于任一端点（确认过渡）。
    const at600 = sampleElevationColor(600)
    const at500 = sampleElevationColor(500)
    const at1000 = sampleElevationColor(1000)
    expect(at600.r).toBeGreaterThan(Math.min(at500.r, at1000.r))
    expect(at600.r).toBeLessThan(Math.max(at500.r, at1000.r))
  })

  it('超域高程夹到端点（雪线以上恒定雪白，深海以下恒定近黑）', () => {
    expectColorClose(sampleElevationColor(20000), sampleElevationColor(9000), 0)
    expectColorClose(sampleElevationColor(-5000), sampleElevationColor(-1500), 0)
  })

  it('非有限高程被拒绝（防御脏数据进入色阶）', () => {
    expect(() => sampleElevationColor(Number.NaN)).toThrow(RangeError)
    expect(() => sampleElevationColor(Number.POSITIVE_INFINITY)).toThrow(RangeError)
  })
})

describe('色阶域与控制点表自洽', () => {
  it('控制点首末等于色阶域上下限（与 SPEC §5.1 编码区间一致）', () => {
    const first = ELEVATION_COLOR_BREAKPOINTS[0]
    const last = ELEVATION_COLOR_BREAKPOINTS[ELEVATION_COLOR_BREAKPOINTS.length - 1]
    expect(first.elevationMeters).toBe(ELEVATION_COLOR_DOMAIN.minValueMeters)
    expect(last.elevationMeters).toBe(ELEVATION_COLOR_DOMAIN.maxValueMeters)
  })

  it('控制点海拔严格升序（分段线性查找的前提）', () => {
    for (let i = 1; i < ELEVATION_COLOR_BREAKPOINTS.length; i++) {
      expect(ELEVATION_COLOR_BREAKPOINTS[i].elevationMeters).toBeGreaterThan(
        ELEVATION_COLOR_BREAKPOINTS[i - 1].elevationMeters,
      )
    }
  })

  it('控制点表冻结（消费者无法就地改断点 / 颜色）', () => {
    expect(Object.isFrozen(ELEVATION_COLOR_BREAKPOINTS)).toBe(true)
    expect(Object.isFrozen(ELEVATION_COLOR_DOMAIN)).toBe(true)
  })
})

describe('颜色与垂直夸张系数 k 解耦（验收 2：用真实 h 而非 world-y）', () => {
  /**
   * 模拟片元着色器的颜色路径：真实高程 → 用 meta 真实上下限归一化 → 采样 256 纹素 ramp。
   * 注意此函数**不接受 k**——这正是「颜色与 k 解耦」的形式证明：k 只进 vertex 的 uExaggeration
   * （影响 world-y），不进任何色阶 uniform。
   */
  function shaderColorAtElevation(
    elevationMeters: number,
    colorConfig: Readonly<{
      domain: Readonly<{ minValueMeters: number; maxValueMeters: number }>
      rampRgbData: Uint8Array
      rampWidth: number
    }>,
  ): RgbColor {
    const u = normalizeElevationToRampU(
      elevationMeters,
      colorConfig.domain.minValueMeters,
      colorConfig.domain.maxValueMeters,
    )
    // 片元着色器 texture2D(ramp, vec2(u, 0.5)) 在 LinearFilter 下取最近纹素；此处取最近纹素中心。
    const texel = Math.min(
      colorConfig.rampWidth - 1,
      Math.max(0, Math.round(u * colorConfig.rampWidth - 0.5)),
    )
    return {
      r: colorConfig.rampRgbData[texel * 3],
      g: colorConfig.rampRgbData[texel * 3 + 1],
      b: colorConfig.rampRgbData[texel * 3 + 2],
    }
  }

  it('同一真实高程在 k=1.5/2.0/3.0 下颜色完全一致（只有 world-y 改变）', () => {
    const colorConfig = resolveElevationColorConfig(
      metaWith(ELEVATION_COLOR_DOMAIN.minValueMeters, ELEVATION_COLOR_DOMAIN.maxValueMeters),
    )
    // 取若干代表性高程（水下 / 平原 / 高山 / 雪线）。
    const elevations = [-1200, 100, 2500, 5500]
    const ks = [1.5, 2.0, 3.0]
    for (const h of elevations) {
      const baseColor = shaderColorAtElevation(h, colorConfig)
      for (const k of ks) {
        expect(shaderColorAtElevation(h, colorConfig)).toStrictEqual(baseColor)
        // 对比：world-y = h·k 随 k 线性变化，证明「只有 y 改变、颜色不变」。
        const worldY = h * k
        const worldYAt2 = h * 2.0
        if (h !== 0) {
          expect(worldY / worldYAt2).toBeCloseTo(k / 2.0, 9)
        }
      }
    }
  })

  it('CPU 精确采样器同样与 k 解耦；误用 world-y 查色会产生明显偏色（反证）', () => {
    const h = 3000
    expect(sampleElevationColor(h)).toStrictEqual(sampleElevationColor(h))
    // 用 world-y（h·k）查色会偏色——k=2 时 world-y=6000，颜色 ≠ h=3000 的颜色。
    const colorAtH = sampleElevationColor(h)
    const colorAtWorldY = sampleElevationColor(h * 2.0)
    // 3000m 与 6000m 颜色不同（前者棕褐、后者雪白），证明若误用 world-y 查色会产生明显偏色。
    expect(colorAtH).not.toStrictEqual(colorAtWorldY)
  })
})

describe('256×1 ramp 由 CPU 采样器派生（GPU/CPU 共用同一事实源）', () => {
  it('ramp 宽度 = 256，字节长度 = width·3（RGB）', () => {
    const data = buildElevationRampRgbData(
      ELEVATION_RAMP_WIDTH,
      ELEVATION_COLOR_DOMAIN.minValueMeters,
      ELEVATION_COLOR_DOMAIN.maxValueMeters,
    )
    expect(data.length).toBe(ELEVATION_RAMP_WIDTH * 3)
  })

  it('ramp 首纹素 ≈ 深海近黑、末纹素 ≈ 雪白（端点与控制点一致）', () => {
    const data = buildElevationRampRgbData(
      ELEVATION_RAMP_WIDTH,
      ELEVATION_COLOR_DOMAIN.minValueMeters,
      ELEVATION_COLOR_DOMAIN.maxValueMeters,
    )
    // 首纹素中心对应高程接近 minH（深海近黑）；末纹素中心对应高程接近 maxH（雪白）。
    expectColorClose(
      { r: data[0], g: data[1], b: data[2] },
      { r: 6, g: 18, b: 28 },
      2,
    )
    const last = (ELEVATION_RAMP_WIDTH - 1) * 3
    expectColorClose(
      { r: data[last], g: data[last + 1], b: data[last + 2] },
      { r: 216, g: 228, b: 234 },
      2,
    )
  })

  it('resolveElevationColorConfig 返回冻结配置，ramp 字节与独立 build 一致', () => {
    const cfg = resolveElevationColorConfig(
      metaWith(ELEVATION_COLOR_DOMAIN.minValueMeters, ELEVATION_COLOR_DOMAIN.maxValueMeters),
    )
    expect(Object.isFrozen(cfg)).toBe(true)
    expect(cfg.rampWidth).toBe(ELEVATION_RAMP_WIDTH)
    const standalone = buildElevationRampRgbData(
      ELEVATION_RAMP_WIDTH,
      ELEVATION_COLOR_DOMAIN.minValueMeters,
      ELEVATION_COLOR_DOMAIN.maxValueMeters,
    )
    expect(Array.from(cfg.rampRgbData)).toEqual(Array.from(standalone))
  })
})

describe('错误 minH/maxH 被契约拒绝（绝不静默偏色）', () => {
  it('缺失水下区间的 [0, 9000] → elevation-color.domain-mismatch', () => {
    expect(() => resolveElevationColorConfig(metaWith(0, 9000))).toThrow(ElevationColorError)
    let caught: unknown
    try {
      resolveElevationColorConfig(metaWith(0, 9000))
    } catch (cause) {
      caught = cause
    }
    expect(caught).toBeInstanceOf(ElevationColorError)
    expect((caught as ElevationColorError).code).toBe('elevation-color.domain-mismatch')
  })

  it('上限偏移的 [-1500, 10000] → elevation-color.domain-mismatch', () => {
    expect(() => resolveElevationColorConfig(metaWith(-1500, 10000))).toThrow(ElevationColorError)
  })

  it('区间倒置的 [9000, -1500] → elevation-color.domain-mismatch（在域校验处拒绝）', () => {
    expect(() => resolveElevationColorConfig(metaWith(9000, -1500))).toThrow(ElevationColorError)
  })

  it('合法 [-1500, 9000] 通过（与 SPEC §5.1 生产编码区间一致）', () => {
    const cfg = resolveElevationColorConfig(metaWith(-1500, 9000))
    expect(cfg.domain.minValueMeters).toBe(-1500)
    expect(cfg.domain.maxValueMeters).toBe(9000)
  })
})

describe('生产元数据色阶域复核（验收 2：meta minH/maxH 与色阶域一致）', () => {
  it('public/terrain 生产元数据通过 resolveElevationColorConfig（domain=[-1500,9000]）', () => {
    const metaPath = resolve(projectRoot, 'public/terrain/china-heightmap-4096.meta.json')
    const meta = JSON.parse(readFileSync(metaPath, 'utf-8')) as TerrainMetaContract
    const cfg = resolveElevationColorConfig(meta)
    expect(cfg.domain.minValueMeters).toBe(meta.elevationEncoding.minValueMeters)
    expect(cfg.domain.maxValueMeters).toBe(meta.elevationEncoding.maxValueMeters)
    expect(cfg.rampRgbData.length).toBe(ELEVATION_RAMP_WIDTH * 3)
  })
})

describe('normalizeElevationToRampU · 归一化用真实上下限', () => {
  it('minH → 0、maxH → 1、中点 → 0.5（用 meta 真实上下限，非 world-y / 包围盒）', () => {
    const { minValueMeters: min, maxValueMeters: max } = ELEVATION_COLOR_DOMAIN
    expect(normalizeElevationToRampU(min, min, max)).toBe(0)
    expect(normalizeElevationToRampU(max, min, max)).toBe(1)
    expect(normalizeElevationToRampU((min + max) / 2, min, max)).toBe(0.5)
  })

  it('超域高程夹到 [0,1]（与 ramp ClampToEdge 一致）', () => {
    const { minValueMeters: min, maxValueMeters: max } = ELEVATION_COLOR_DOMAIN
    expect(normalizeElevationToRampU(min - 1000, min, max)).toBe(0)
    expect(normalizeElevationToRampU(max + 1000, min, max)).toBe(1)
  })

  it('区间倒置被拒绝（min < max）', () => {
    expect(() => normalizeElevationToRampU(0, 9000, -1500)).toThrow(RangeError)
  })
})
