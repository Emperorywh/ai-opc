/**
 * Task 11 · AdaptiveQuality 单测（SPEC §8 / D18 验收：掉帧触发降档 / 跨阈值不抖动 /
 * 4K dpr 受控 / 手动覆盖生效）。
 *
 * 覆盖 qualityState 纯函数（脱离 DOM / R3F / drei）：
 *  - initialTierFromGpu（useDetectGPU → 初定档）
 *  - hysteresisDecide（单次滞回候选）
 *  - avgFpsFromDeltas（滑窗平均 FPS）
 *  - stepFpsWindow（持续命中 + 冷却状态机 —— 跨阈值不抖动核心）
 *  - clampDpr（4K dpr 钳制）
 * 以及 config/quality 分档参数与 store 手动覆盖切片。
 */
import { describe, it, expect, beforeEach } from 'vitest'
import {
  qualityConfigs,
  qualityAdaptive,
  QUALITY_TIER_ORDER,
  defaultQualityTier,
} from '../src/config/quality'
import { useStore } from '../src/state/store'
import {
  initialTierFromGpu,
  hysteresisDecide,
  avgFpsFromDeltas,
  initialFpsWindowState,
  stepFpsWindow,
  clampDpr,
} from '../src/three/effects/qualityState'
import type { QualityAdaptiveConfig } from '../src/config/quality'

// ===========================================================================
// config 分档参数
// ===========================================================================

describe('config/quality 分档参数（SPEC §8 高/中/低）', () => {
  it('QUALITY_TIER_ORDER 由低到高', () => {
    expect(QUALITY_TIER_ORDER).toEqual(['low', 'medium', 'high'])
  })
  it('默认档 = high', () => {
    expect(defaultQualityTier).toBe('high')
  })
  it('高档：dpr≤2 / 全波数 / 全标签 / 接触阴影占位开', () => {
    expect(qualityConfigs.high.dprMax).toBe(2)
    expect(qualityConfigs.high.oceanWaves).toBe(5)
    expect(qualityConfigs.high.labelDensity).toBe('all')
    expect(qualityConfigs.high.contactShadow).toBe(true)
  })
  it('中档：dpr≤1.5 / 海洋减波 / 标签密度↓ / 接触阴影关', () => {
    expect(qualityConfigs.medium.dprMax).toBe(1.5)
    expect(qualityConfigs.medium.oceanWaves).toBe(3)
    expect(qualityConfigs.medium.labelDensity).toBe('major')
    expect(qualityConfigs.medium.contactShadow).toBe(false)
  })
  it('低档：dpr≤1 / 正弦波(0) / 仅大洲标签 / 关接触阴影', () => {
    expect(qualityConfigs.low.dprMax).toBe(1)
    expect(qualityConfigs.low.oceanWaves).toBe(0)
    expect(qualityConfigs.low.labelDensity).toBe('continent')
    expect(qualityConfigs.low.contactShadow).toBe(false)
  })
  it('dprMax 单调：low(1) < medium(1.5) < high(2)', () => {
    expect(qualityConfigs.low.dprMax).toBeLessThan(qualityConfigs.medium.dprMax)
    expect(qualityConfigs.medium.dprMax).toBeLessThan(qualityConfigs.high.dprMax)
  })
  it('每档 terrainEffects 含全部 5 个开关键', () => {
    const keys = ['slopeEmphasis', 'watercolorNoise', 'coastline', 'rimOutline', 'detailNormal']
    for (const tier of QUALITY_TIER_ORDER) {
      const fx = qualityConfigs[tier].terrainEffects
      for (const k of keys) expect(fx[k as keyof typeof fx]).toBeTypeOf('number')
    }
  })
  it('terrain 效果随档降低而减弱（高档最强、低档最弱）', () => {
    expect(qualityConfigs.high.terrainEffects.watercolorNoise).toBeGreaterThanOrEqual(
      qualityConfigs.medium.terrainEffects.watercolorNoise,
    )
    expect(qualityConfigs.medium.terrainEffects.watercolorNoise).toBeGreaterThan(
      qualityConfigs.low.terrainEffects.watercolorNoise,
    )
    expect(qualityConfigs.low.terrainEffects.rimOutline).toBe(0)
    expect(qualityConfigs.low.terrainEffects.watercolorNoise).toBe(0)
  })
  it('qualityAdaptive 滞回带：upgradeFps > downgradeFps（防临界震荡）', () => {
    expect(qualityAdaptive.upgradeFps).toBeGreaterThan(qualityAdaptive.downgradeFps)
    expect(qualityAdaptive.fpsWindowSec).toBeGreaterThan(0)
    expect(qualityAdaptive.sustainedWindows).toBeGreaterThanOrEqual(1)
    expect(qualityAdaptive.cooldownSec).toBeGreaterThan(0)
  })
})

// ===========================================================================
// initialTierFromGpu
// ===========================================================================

describe('initialTierFromGpu（useDetectGPU → 初定档）', () => {
  it('探测未就绪 → 中（保守）', () => {
    expect(initialTierFromGpu(undefined, false)).toBe('medium')
  })
  it('桌面 tier≥2 → 高', () => {
    expect(initialTierFromGpu(2, false)).toBe('high')
    expect(initialTierFromGpu(3, false)).toBe('high')
  })
  it('桌面 tier=1 → 中', () => {
    expect(initialTierFromGpu(1, false)).toBe('medium')
  })
  it('桌面 tier=0 → 低', () => {
    expect(initialTierFromGpu(0, false)).toBe('low')
  })
  it('移动端封顶中（tier≥2 → medium，不轻易给高）', () => {
    expect(initialTierFromGpu(3, true)).toBe('medium')
    expect(initialTierFromGpu(2, true)).toBe('medium')
  })
  it('移动端 tier<2 → 低', () => {
    expect(initialTierFromGpu(1, true)).toBe('low')
    expect(initialTierFromGpu(0, true)).toBe('low')
  })
})

// ===========================================================================
// hysteresisDecide
// ===========================================================================

describe('hysteresisDecide（单次滞回候选）', () => {
  it('FPS 低于降档阈值 → 下一低档', () => {
    expect(hysteresisDecide('high', 30, qualityAdaptive)).toBe('medium')
    expect(hysteresisDecide('medium', 30, qualityAdaptive)).toBe('low')
  })
  it('极低 FPS 也只降一档（不跳档）', () => {
    expect(hysteresisDecide('high', 1, qualityAdaptive)).toBe('medium')
  })
  it('FPS 高于升档阈值 → 下一高档', () => {
    expect(hysteresisDecide('medium', 60, qualityAdaptive)).toBe('high')
    expect(hysteresisDecide('low', 60, qualityAdaptive)).toBe('medium')
  })
  it('已是最高 / 最低则保持（不越界）', () => {
    expect(hysteresisDecide('high', 120, qualityAdaptive)).toBe('high')
    expect(hysteresisDecide('low', 1, qualityAdaptive)).toBe('low')
  })
  it('滞回带内（45 ≤ fps ≤ 57）保持当前档', () => {
    for (const fps of [45, 50, 57]) {
      expect(hysteresisDecide('high', fps, qualityAdaptive)).toBe('high')
      expect(hysteresisDecide('medium', fps, qualityAdaptive)).toBe('medium')
      expect(hysteresisDecide('low', fps, qualityAdaptive)).toBe('low')
    }
  })
})

// ===========================================================================
// avgFpsFromDeltas
// ===========================================================================

describe('avgFpsFromDeltas（滑窗平均 FPS）', () => {
  it('60 帧 × 1/60s = 60 fps', () => {
    const deltas = Array.from({ length: 60 }, () => 1 / 60)
    expect(avgFpsFromDeltas(deltas)).toBeCloseTo(60, 5)
  })
  it('空数组 → 0', () => {
    expect(avgFpsFromDeltas([])).toBe(0)
  })
  it('2 帧 × 0.5s = 2 fps', () => {
    expect(avgFpsFromDeltas([0.5, 0.5])).toBeCloseTo(2, 5)
  })
})

// ===========================================================================
// stepFpsWindow（状态机：持续命中 + 冷却）
// ===========================================================================

describe('stepFpsWindow（掉帧触发降档 / 跨阈值不抖动）', () => {
  it('单次掉帧不立即降档（sustainedWindows=2 防误判）', () => {
    let s = initialFpsWindowState('high')
    s = stepFpsWindow(s, 30, qualityAdaptive) // 窗口1：30fps
    expect(s.tier).toBe('high') // 未达持续次数，不切
    expect(s.candidate).toBe('medium')
    expect(s.candidateStreak).toBe(1)
  })

  it('连续 2 个低 FPS 窗口 → 降档到 medium（SPEC §8 掉帧触发降档）', () => {
    let s = initialFpsWindowState('high')
    s = stepFpsWindow(s, 30, qualityAdaptive)
    expect(s.tier).toBe('high')
    s = stepFpsWindow(s, 28, qualityAdaptive) // 窗口2：仍低
    expect(s.tier).toBe('medium')
  })

  it('单次掉帧后恢复 → 不降档（跨阈值不抖动）', () => {
    let s = initialFpsWindowState('high')
    s = stepFpsWindow(s, 30, qualityAdaptive) // 候选 medium streak1
    s = stepFpsWindow(s, 60, qualityAdaptive) // 恢复高 FPS → 回到 current，streak 清零
    expect(s.tier).toBe('high')
    expect(s.candidateStreak).toBe(0)
  })

  it('连续 2 个高 FPS 窗口 → 从 medium 升档回 high', () => {
    let s = initialFpsWindowState('medium')
    s = stepFpsWindow(s, 60, qualityAdaptive)
    expect(s.tier).toBe('medium')
    s = stepFpsWindow(s, 62, qualityAdaptive)
    expect(s.tier).toBe('high')
  })

  it('滞回带内（50fps）无论多少窗口都不切换', () => {
    let s = initialFpsWindowState('high')
    for (let i = 0; i < 5; i++) s = stepFpsWindow(s, 50, qualityAdaptive)
    expect(s.tier).toBe('high')
  })

  it('冷却期内不切换（自定义 cfg：sustained=1 / cooldown=3 窗）', () => {
    const cfg: QualityAdaptiveConfig = {
      fpsWindowSec: 1,
      downgradeFps: 45,
      upgradeFps: 57,
      cooldownSec: 3,
      sustainedWindows: 1,
    }
    let s = initialFpsWindowState('high')
    // 窗1：30fps → sustained=1 立即降档到 medium（无冷却限制因上次切换在 -Inf）
    s = stepFpsWindow(s, 30, cfg)
    expect(s.tier).toBe('medium')
    // 窗2：70fps → 候选 high，sustained=1 达标，但距上次切换仅 1 窗 < cooldown(3) → 不切
    s = stepFpsWindow(s, 70, cfg)
    expect(s.tier).toBe('medium')
    // 窗3：仍 70fps → 距上次切换 2 窗 < 3 → 不切
    s = stepFpsWindow(s, 70, cfg)
    expect(s.tier).toBe('medium')
    // 窗4：70fps → 距上次切换 3 窗 ≥ 3 → 升档
    s = stepFpsWindow(s, 70, cfg)
    expect(s.tier).toBe('high')
  })

  it('候选档切换方向变化时重置连续计数', () => {
    // high → 候选 medium(streak1) → 又想升 high（不可能因 fps 高时 current=high 不动），
    // 改用 medium 起步：候选 high(streak1) → 掉帧候选 low（方向变）→ streak 重置为 1。
    let s = initialFpsWindowState('medium')
    s = stepFpsWindow(s, 60, qualityAdaptive) // 候选 high streak1
    expect(s.candidate).toBe('high')
    s = stepFpsWindow(s, 20, qualityAdaptive) // 方向变 → 候选 low streak1
    expect(s.candidate).toBe('low')
    expect(s.candidateStreak).toBe(1)
    expect(s.tier).toBe('medium')
  })
})

// ===========================================================================
// clampDpr
// ===========================================================================

describe('clampDpr（4K dpr 受控，SPEC §8）', () => {
  it('4K 屏 dpr=3 受高档上限 2 钳制', () => {
    expect(clampDpr(3, 2)).toBe(2)
  })
  it('dpr 低于上限原样返回', () => {
    expect(clampDpr(1.5, 2)).toBe(1.5)
    expect(clampDpr(1, 2)).toBe(1)
  })
  it('低档 dprMax=1 强制降到 1', () => {
    expect(clampDpr(2, 1)).toBe(1)
    expect(clampDpr(3, 1)).toBe(1)
  })
  it('无效 deviceDpr 回退 1', () => {
    expect(clampDpr(0, 2)).toBe(1)
    expect(clampDpr(-1, 2)).toBe(1)
    expect(clampDpr(NaN, 2)).toBe(1)
  })
})

// ===========================================================================
// store 手动覆盖切片
// ===========================================================================

describe('store qualityTierOverride（手动覆盖生效）', () => {
  beforeEach(() => {
    useStore.setState({ qualityTier: 'high', qualityTierOverride: null })
  })
  it('初始 override=null（自适应）', () => {
    expect(useStore.getState().qualityTierOverride).toBeNull()
  })
  it('setQualityTierOverride 锁定档位', () => {
    useStore.getState().setQualityTierOverride('low')
    expect(useStore.getState().qualityTierOverride).toBe('low')
  })
  it('setQualityTierOverride(null) 恢复自适应', () => {
    useStore.getState().setQualityTierOverride('low')
    useStore.getState().setQualityTierOverride(null)
    expect(useStore.getState().qualityTierOverride).toBeNull()
  })
  it('qualityTier / setQualityTier 切片可用（渲染层订阅）', () => {
    useStore.getState().setQualityTier('medium')
    expect(useStore.getState().qualityTier).toBe('medium')
  })
})
