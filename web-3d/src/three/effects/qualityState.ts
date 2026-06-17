/**
 * 自适应质量状态机 —— 纯函数（SPEC §8 / D18，Task 11）。
 *
 * 把所有档位判定 / FPS 滑窗 / 滞回 / dpr 钳制逻辑抽成纯函数，便于 vitest 脱离
 * DOM / R3F / drei 单测（AdaptiveQuality.tsx 仅作薄 R3F 胶水调用这些函数）。
 *
 * 设计要点（SPEC §8「跨阈值平滑切换不抖动」）：
 *  - 三重防抖：滞回带（upgradeFps>downgradeFps）+ 持续命中（sustainedWindows）+ 冷却（cooldownSec）。
 *  - 升降档沿 QUALITY_TIER_ORDER 相邻移动一档（不跳档）。
 */
import type {
  QualityTier,
  QualityAdaptiveConfig,
} from '../../config/quality'
import { QUALITY_TIER_ORDER } from '../../config/quality'

/** useDetectGPU 返回的 tier（drei / detect-gpu：0 低 ~ 3 高，探测未就绪时 undefined）。 */
export type GpuTier = number | undefined

// ===========================================================================
// 初定档（useDetectGPU → QualityTier）
// ===========================================================================

/**
 * 由 drei useDetectGPU 的 { tier, isMobile } 映射初定档（SPEC §8 首次按设备探测初定档）。
 *  - 移动端 / tier<1：低或中
 *  - tier≥2 且非移动：高
 *  - tier undefined（探测未就绪）：中（保守，FPS 循环 ~2s 内会纠正）
 *
 * 导出纯函数，组件侧 useDetectGPU 调用与此分离 → 可单测映射逻辑。
 */
export function initialTierFromGpu(gpuTier: GpuTier, isMobile: boolean): QualityTier {
  if (gpuTier === undefined) return 'medium'
  if (isMobile) return gpuTier >= 2 ? 'medium' : 'low'
  return gpuTier >= 2 ? 'high' : gpuTier >= 1 ? 'medium' : 'low'
}

// ===========================================================================
// 滞回档位候选（单次评估）
// ===========================================================================

/**
 * 单次评估的滞回判定：据当前档位 + 平均 FPS 给出候选档位（可能=当前）。
 *  - fps < downgradeFps → 下一低档（已是最低则保持）
 *  - fps > upgradeFps   → 下一高档（已是最高则保持）
 *  - 否则保持当前（滞回带内不动作）
 */
export function hysteresisDecide(
  current: QualityTier,
  fps: number,
  cfg: QualityAdaptiveConfig,
): QualityTier {
  const idx = QUALITY_TIER_ORDER.indexOf(current)
  if (fps < cfg.downgradeFps && idx > 0) return QUALITY_TIER_ORDER[idx - 1]
  if (fps > cfg.upgradeFps && idx < QUALITY_TIER_ORDER.length - 1) return QUALITY_TIER_ORDER[idx + 1]
  return current
}

// ===========================================================================
// FPS 滑动窗口
// ===========================================================================

/** 由一组帧间隔（秒）算平均 FPS = 帧数 / 总时长。空数组返回 0。 */
export function avgFpsFromDeltas(deltasSec: readonly number[]): number {
  if (deltasSec.length === 0) return 0
  const sum = deltasSec.reduce((a, b) => a + b, 0)
  if (sum <= 0) return 0
  return deltasSec.length / sum
}

// ===========================================================================
// 档位状态机（持续命中 + 冷却）
// ===========================================================================

export type FpsWindowState = {
  /** 当前生效档位。 */
  tier: QualityTier
  /** 上次滞回产出的候选档位（用于连续命中计数）。 */
  candidate: QualityTier
  /** 候选连续命中次数（达 sustainedWindows 才提交）。 */
  candidateStreak: number
  /** 上次提交切换的评估序号（单调递增），用于冷却判定。 */
  lastSwitchEval: number
  /** 已进行的评估次数（单调递增）。 */
  evalCount: number
}

/** 初始状态：生效档 = 初定档，无候选，未切换。 */
export function initialFpsWindowState(tier: QualityTier): FpsWindowState {
  return {
    tier,
    candidate: tier,
    candidateStreak: 0,
    lastSwitchEval: -Infinity,
    evalCount: 0,
  }
}

/**
 * 推进一次评估窗口后的状态（纯函数）。
 *
 * @param state 当前状态
 * @param fps   本窗口平均 FPS
 * @param cfg   自适应参数（含阈值 / 持续窗口数 / 冷却）
 * @returns 新状态（tier 若变化则组件侧写 store）
 *
 * 冷却用「评估次数差」表达（等价于时间，因每窗口 ~fpsWindowSec 秒）：
 *  距上次切换不足 cooldownSec 个窗口（ceil）不提交。
 */
export function stepFpsWindow(
  state: FpsWindowState,
  fps: number,
  cfg: QualityAdaptiveConfig,
): FpsWindowState {
  const evalCount = state.evalCount + 1
  const desired = hysteresisDecide(state.tier, fps, cfg)

  // 连续命中计数（候选变化则重置为 1）
  const candidate =
    desired === state.tier
      ? state.tier
      : desired === state.candidate
        ? state.candidate
        : desired
  const candidateStreak = desired === state.tier ? 0 : candidate === state.candidate ? state.candidateStreak + 1 : 1

  // 冷却窗口数（向上取整，保证不少于一个窗口）
  const cooldownEvals = Math.max(1, Math.ceil(cfg.cooldownSec / cfg.fpsWindowSec))

  const canSwitch =
    desired !== state.tier &&
    candidateStreak >= cfg.sustainedWindows &&
    evalCount - state.lastSwitchEval >= cooldownEvals

  if (canSwitch) {
    return {
      tier: desired,
      candidate: desired,
      candidateStreak: 0,
      lastSwitchEval: evalCount,
      evalCount,
    }
  }
  return { tier: state.tier, candidate, candidateStreak, lastSwitchEval: state.lastSwitchEval, evalCount }
}

// ===========================================================================
// dpr 钳制
// ===========================================================================

/**
 * 由设备像素比 + 档位 dpr 上限算实际 dpr（SPEC §8：4K 下 dpr 受控防爆显存）。
 *  - deviceDpr 通常 = window.devicePixelRatio（4K 屏可达 2~4）
 *  - dprMax 由 qualityConfigs[tier].dprMax 给出（高≤2 / 中≤1.5 / 低≤1）
 */
export function clampDpr(deviceDpr: number, dprMax: number): number {
  if (!Number.isFinite(deviceDpr) || deviceDpr <= 0) return 1
  if (!Number.isFinite(dprMax) || dprMax <= 0) return Math.max(1, deviceDpr)
  return Math.min(deviceDpr, dprMax)
}
