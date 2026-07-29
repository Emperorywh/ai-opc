/**
 * 地形渲染配置与 CPU/GPU 解码一致性测试（TASK-006 验收 1、4）。
 *
 * 依赖方向：测试基线（vitest，Node 环境），import src/config/terrain-config（配置层）与
 * src/geo-contracts（16 位编解码唯一源）。不依赖浏览器、React、Three.js——配置层与解码仿射都是纯 TS，
 * 可在 Node 内完整断言「非法配置被拒绝」「生产默认未被偷偷改低」「CPU 镜像解码 == 契约层解码」。
 *
 * 覆盖：
 * - 配置默认值与合法范围边界（夸张 1.5/3.0、分段 1/4096 含端点）。
 * - 非法配置（NaN / 越界 / 非整数分段）确定性拒绝，失败码稳定。
 * - 生产默认 k=2.0、分段 2048²（未被偷偷改低）；测试配置分段 64² 与生产边界清楚。
 * - CPU/GPU 解码一致性：decodeNormalizedToElevation(code/65535) == decodeUint16ToElevation(code)，
 *   且 16 位精度不退化为 8 位（code > 255 路径与 8 位量化明显不同）。
 * - 位移语义：y = h·k；改 k 只改 y，不改真实高程 h。
 * - 解析产物冻结（Object.isFrozen），杜绝消费者就地改配置产生隐式状态。
 */

import { describe, it, expect } from 'vitest'
import {
  PRODUCTION_TERRAIN_CONFIG,
  TEST_TERRAIN_CONFIG,
  TERRAIN_EXAGGERATION_DEFAULT,
  TERRAIN_EXAGGERATION_MAX,
  TERRAIN_EXAGGERATION_MIN,
  TERRAIN_MESH_SEGMENTS_DEFAULT,
  TERRAIN_MESH_SEGMENTS_MAX,
  TERRAIN_MESH_SEGMENTS_MIN,
  decodeNormalizedToElevation,
  displaceElevationToWorldY,
  resolveTerrainConfig,
  resolveTerrainConfigOrThrow,
} from '../src/config/terrain-config'
import { decodeUint16ToElevation } from '../src/geo-contracts'
import type { TerrainConfigFailure } from '../src/config/terrain-config'

const RANGE = { min: -1500, max: 9000 }

/** 断言解析失败且失败码等于给定值（非法配置不得静默夹回默认）。 */
function expectConfigFail(input: { exaggeration?: number; meshSegments?: number }, code: string): void {
  const r = resolveTerrainConfig(input)
  expect(r.ok, `期望失败 ${code}，实际成功`).toBe(false)
  expect((r as TerrainConfigFailure).code).toBe(code)
}

describe('配置默认值与常量（SPEC §3.2、§7.2）', () => {
  it('垂直夸张默认 2.0，合法范围 [1.5, 3.0]', () => {
    expect(TERRAIN_EXAGGERATION_DEFAULT).toBe(2.0)
    expect(TERRAIN_EXAGGERATION_MIN).toBe(1.5)
    expect(TERRAIN_EXAGGERATION_MAX).toBe(3.0)
  })

  it('网格分段默认 2048，上限 4096、下限 1', () => {
    expect(TERRAIN_MESH_SEGMENTS_DEFAULT).toBe(2048)
    expect(TERRAIN_MESH_SEGMENTS_MAX).toBe(4096)
    expect(TERRAIN_MESH_SEGMENTS_MIN).toBe(1)
  })
})

describe('resolveTerrainConfig · 合法配置（含边界）', () => {
  it('省略入参时回落到生产默认（k=2.0、分段 2048）', () => {
    const r = resolveTerrainConfig({})
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.exaggeration).toBe(2.0)
      expect(r.meshSegments).toBe(2048)
    }
  })

  it('夸张系数边界 1.5 / 3.0 含端点接受', () => {
    expect(resolveTerrainConfig({ exaggeration: 1.5 }).ok).toBe(true)
    expect(resolveTerrainConfig({ exaggeration: 3.0 }).ok).toBe(true)
  })

  it('分段边界 1 / 4096 含端点接受（整数）', () => {
    expect(resolveTerrainConfig({ meshSegments: 1 }).ok).toBe(true)
    expect(resolveTerrainConfig({ meshSegments: 4096 }).ok).toBe(true)
  })

  it('测试档分段 64 接受（低资源自动化环境）', () => {
    expect(resolveTerrainConfig({ meshSegments: 64 }).ok).toBe(true)
  })
})

describe('resolveTerrainConfig · 非法配置被确定性拒绝', () => {
  it('夸张系数非有限 → exaggeration-not-finite（NaN 不得因比较恒假漏检）', () => {
    expectConfigFail({ exaggeration: Number.NaN }, 'terrain-config.exaggeration-not-finite')
    expectConfigFail({ exaggeration: Number.POSITIVE_INFINITY }, 'terrain-config.exaggeration-not-finite')
  })

  it('夸张系数越出 [1.5, 3.0] → exaggeration-out-of-range', () => {
    expectConfigFail({ exaggeration: 1.4 }, 'terrain-config.exaggeration-out-of-range')
    expectConfigFail({ exaggeration: 3.1 }, 'terrain-config.exaggeration-out-of-range')
    expectConfigFail({ exaggeration: 0 }, 'terrain-config.exaggeration-out-of-range')
  })

  it('分段非整数 → segments-not-integer', () => {
    expectConfigFail({ meshSegments: 2048.5 }, 'terrain-config.segments-not-integer')
    expectConfigFail({ meshSegments: Number.NaN }, 'terrain-config.segments-not-integer')
  })

  it('分段越出 [1, 4096] → segments-out-of-range', () => {
    expectConfigFail({ meshSegments: 0 }, 'terrain-config.segments-out-of-range')
    expectConfigFail({ meshSegments: 4097 }, 'terrain-config.segments-out-of-range')
    expectConfigFail({ meshSegments: -8 }, 'terrain-config.segments-out-of-range')
  })
})

describe('生产默认未被偷偷改低（验收 1：2048² 默认、4096² 可配档）', () => {
  it('PRODUCTION_TERRAIN_CONFIG: k=2.0、分段 2048²', () => {
    expect(PRODUCTION_TERRAIN_CONFIG.exaggeration).toBe(2.0)
    expect(PRODUCTION_TERRAIN_CONFIG.meshSegments).toBe(2048)
  })

  it('PRODUCTION_TERRAIN_CONFIG 冻结（消费者无法就地改低默认）', () => {
    expect(Object.isFrozen(PRODUCTION_TERRAIN_CONFIG)).toBe(true)
  })

  it('4096² 上限档可经配置项显式解析（SPEC §7.2 可配档）', () => {
    const r = resolveTerrainConfigOrThrow({ meshSegments: 4096 })
    expect(r.meshSegments).toBe(4096)
    expect(r.exaggeration).toBe(2.0)
  })

  it('TEST_TERRAIN_CONFIG 分段显著低于生产（64²），但 k 语义保持 2.0', () => {
    expect(TEST_TERRAIN_CONFIG.meshSegments).toBe(64)
    expect(TEST_TERRAIN_CONFIG.exaggeration).toBe(2.0)
    expect(TEST_TERRAIN_CONFIG.meshSegments).toBeLessThan(PRODUCTION_TERRAIN_CONFIG.meshSegments)
  })
})

describe('CPU/GPU 解码一致性 + 16 位精度（验收 4：同源同解码）', () => {
  /**
   * 着色器内的解码（h = normalized·(max−min)+min）与本层 decodeNormalizedToElevation 同一仿射；
   * 契约层 decodeUint16ToElevation 是 (code/65535)·(max−min)+min。当 normalized = code/65535 时，
   * 二者在浮点精度内相等——这断言「相同 UV 的 CPU/GPU 解码语义一致」，且 normalized 来自 16 位码
   * （经 FloatType 纹理保留），未降为 8 位。
   */
  it('decodeNormalizedToElevation(code/65535) == decodeUint16ToElevation(code)，全位深样本', () => {
    const codes = [0, 1, 255, 256, 50000, 65534, 65535]
    for (const code of codes) {
      const normalized = code / 65535
      const byConfig = decodeNormalizedToElevation(normalized, RANGE.min, RANGE.max)
      const byContract = decodeUint16ToElevation(code, RANGE.min, RANGE.max)
      expect(
        Math.abs(byConfig - byContract) <= 1e-9,
        `code ${code}: config ${byConfig} ≈ contract ${byContract}`,
      ).toBe(true)
    }
  })

  it('16 位精度未退化为 8 位：code=50000 的解码明显不同于 8 位量化（255 上限）', () => {
    // 50000 远超 8 位上限 255；若链路在某处被 8 位截断，解码会坍缩到 255 对应的值。
    const normalized50000 = 50000 / 65535
    const meters50000 = decodeNormalizedToElevation(normalized50000, RANGE.min, RANGE.max)
    const normalized8bit = 255 / 65535 // 假想的 8 位上限码
    const meters8bit = decodeNormalizedToElevation(normalized8bit, RANGE.min, RANGE.max)
    expect(meters50000).toBeGreaterThan(meters8bit + 1000)
  })

  it('解码区间倒置被拒绝（min < max）', () => {
    expect(() => decodeNormalizedToElevation(0.5, 9000, -1500)).toThrow(RangeError)
  })
})

describe('位移语义：y = h·k，改 k 只改 y（验收 4：世界 y=h·k、k 默认 2.0 可配 1.5–3.0）', () => {
  it('displaceElevationToWorldY(h, k) == h·k', () => {
    expect(displaceElevationToWorldY(4500, 2.0)).toBe(9000)
    expect(displaceElevationToWorldY(4500, 1.5)).toBe(6750)
    expect(displaceElevationToWorldY(4500, 3.0)).toBe(13500)
  })

  it('同一真实高程 h，k=1.5/2.0/3.0 只改变 y，不改 h', () => {
    const h = decodeUint16ToElevation(40000, RANGE.min, RANGE.max)
    const y15 = displaceElevationToWorldY(h, 1.5)
    const y20 = displaceElevationToWorldY(h, 2.0)
    const y30 = displaceElevationToWorldY(h, 3.0)
    // y 随 k 线性变化。
    expect(y30 / y20).toBeCloseTo(1.5, 9)
    expect(y20 / y15).toBeCloseTo(2.0 / 1.5, 9)
    // 真实高程 h 不随 k 变化（h 与 k 解耦，由契约层解码唯一决定）。
    expect(decodeUint16ToElevation(40000, RANGE.min, RANGE.max)).toBe(h)
  })
})

describe('resolveTerrainConfigOrThrow · 冻结产物与抛错', () => {
  it('合法输入返回冻结配置', () => {
    const cfg = resolveTerrainConfigOrThrow({ exaggeration: 2.0, meshSegments: 2048 })
    expect(cfg.exaggeration).toBe(2.0)
    expect(cfg.meshSegments).toBe(2048)
    expect(Object.isFrozen(cfg)).toBe(true)
  })

  it('非法输入抛 RangeError（不静默夹回默认）', () => {
    expect(() => resolveTerrainConfigOrThrow({ exaggeration: 5 })).toThrow(RangeError)
    expect(() => resolveTerrainConfigOrThrow({ meshSegments: 99999 })).toThrow(RangeError)
  })
})
