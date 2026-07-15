import { describe, expect, it } from 'vitest'
import { DEFAULT_SAMPLING_CONFIG } from '../src/features/agv-map/config/geometryConfig'

/**
 * 路径采样配置契约测试（SPEC §7.3、§12，TASK-002）。
 *
 * SPEC §12 要求：几何和数据契约参数变更必须同步更新测试。
 * SPEC §7.3 规定贝塞尔递归细分的三个初始参数为：
 * 最大弦长 0.25 m、最大平坦度误差 0.01 m、最大递归深度 12。
 *
 * 本测试锁定这三个取值，作为回归护栏——任一参数被无意调整都会立即在此失败，
 * 迫使变更方同步修订规格与测试。行为层面的约束（弦长、平坦度）由
 * pathSampling.test.ts 与 samplingIntegration.test.ts 覆盖；此处只守护契约取值。
 */

describe('DEFAULT_SAMPLING_CONFIG — 采样参数契约（SPEC §7.3）', () => {
  it('最大弦长为 0.25 m', () => {
    expect(DEFAULT_SAMPLING_CONFIG.maxChordLengthM).toBe(0.25)
  })

  it('最大平坦度误差为 0.01 m', () => {
    expect(DEFAULT_SAMPLING_CONFIG.maxFlatnessErrorM).toBe(0.01)
  })

  it('最大递归深度为 12', () => {
    expect(DEFAULT_SAMPLING_CONFIG.maxRecursionDepth).toBe(12)
  })

  it('三个参数均为有限正数（保证递归细分可终止且度量有意义）', () => {
    for (const v of [
      DEFAULT_SAMPLING_CONFIG.maxChordLengthM,
      DEFAULT_SAMPLING_CONFIG.maxFlatnessErrorM,
      DEFAULT_SAMPLING_CONFIG.maxRecursionDepth,
    ]) {
      expect(Number.isFinite(v)).toBe(true)
      expect(v).toBeGreaterThan(0)
    }
  })
})
