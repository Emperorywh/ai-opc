import { describe, expect, it } from 'vitest'
import { MAX_FRAME_DELTA_SECONDS, FlowPhaseClock } from '../src/features/agv-map/presentation/scene/flowClock'
import { PATH_VISUAL_THEME } from '../src/features/agv-map/config/visualTheme'

/**
 * 流光相位时钟单元测试（SPEC §7.6、§11.3、TASK-010）。
 * 覆盖：有界相位、钳制超大 delta、负增量丢弃、周期连续性、长时间运行稳定性。
 *
 * 注意：advance 把超过 MAX_FRAME_DELTA_SECONDS 的单帧增量视为隐藏/休眠恢复帧并丢弃。
 * 因此任何需要累计超过 0.5 s 动画的场景必须以多个小于上限的步长推进，模拟真实逐帧。
 */
const FLOW = PATH_VISUAL_THEME.flow

/**
 * 以小于钳制上限的步长累计推进 totalSeconds，等价于真实逐帧渲染该时长。
 * 默认步长 0.25 s 为 2 的幂分数，在浮点下精确累加，避免周期边界处 0.1×N 的舍入误差。
 */
function advanceBySteps(clock: FlowPhaseClock, totalSeconds: number, step = 0.25): number {
  let last = 0
  let remaining = totalSeconds
  while (remaining > 0) {
    const d = Math.min(step, remaining)
    last = clock.advance(d)
    remaining -= d
  }
  return last
}

describe('FlowPhaseClock — 初始相位', () => {
  it('默认从 0 开始，初始偏移为 0', () => {
    const clock = new FlowPhaseClock(FLOW)
    expect(clock.offsetMeters()).toBe(0)
    expect(clock.phaseSeconds()).toBe(0)
  })

  it('可注入非零初始相位，立即反映在偏移上', () => {
    // 半周期 → 半个重复距离。
    const clock = new FlowPhaseClock(FLOW, FLOW.flowPeriodSeconds / 2)
    expect(clock.phaseSeconds()).toBeCloseTo(FLOW.flowPeriodSeconds / 2, 10)
    expect(clock.offsetMeters()).toBeCloseTo(FLOW.flowRepeatM / 2, 10)
  })

  it('初始相位按周期取模，超出周期映射回 [0, period)', () => {
    const clock = new FlowPhaseClock(FLOW, FLOW.flowPeriodSeconds * 2.5)
    expect(clock.phaseSeconds()).toBeCloseTo(FLOW.flowPeriodSeconds * 0.5, 10)
  })
})

describe('FlowPhaseClock — 有界性与周期连续性（§7.6、§11.3）', () => {
  it('偏移始终落在 [0, flowRepeatM)', () => {
    const clock = new FlowPhaseClock(FLOW)
    // 以 60 fps 推进 3 个周期，任意时刻偏移都有界。
    const step = 1 / 60
    for (let i = 0; i < 3 * 60 * FLOW.flowPeriodSeconds; i += 1) {
      const offset = clock.advance(step)
      expect(offset).toBeGreaterThanOrEqual(0)
      expect(offset).toBeLessThan(FLOW.flowRepeatM)
    }
  })

  it('相位始终落在 [0, flowPeriodSeconds)', () => {
    const clock = new FlowPhaseClock(FLOW)
    const step = 0.07
    for (let i = 0; i < 1000; i += 1) {
      clock.advance(step)
      const phase = clock.phaseSeconds()
      expect(phase).toBeGreaterThanOrEqual(0)
      expect(phase).toBeLessThan(FLOW.flowPeriodSeconds)
    }
  })

  it('推进整数个周期后偏移回到 0（动画首尾相接、无跳变）', () => {
    const clock = new FlowPhaseClock(FLOW)
    advanceBySteps(clock, FLOW.flowPeriodSeconds)
    expect(clock.offsetMeters()).toBeCloseTo(0, 8)
  })

  it('半周期时偏移为半个重复距离，周期与速度一致', () => {
    const clock = new FlowPhaseClock(FLOW)
    // 半周期 = 2.5 s；按 speed 0.4 m/s 推进 1.0 m = 半个重复距离。
    advanceBySteps(clock, FLOW.flowPeriodSeconds / 2)
    expect(clock.offsetMeters()).toBeCloseTo(FLOW.flowRepeatM / 2, 8)
  })

  it('相同累计时间的偏移与分步推进一致（线性累加）', () => {
    const whole = new FlowPhaseClock(FLOW)
    whole.advance(0.3)
    const split = new FlowPhaseClock(FLOW)
    for (let i = 0; i < 3; i += 1) split.advance(0.1)
    expect(split.offsetMeters()).toBeCloseTo(whole.offsetMeters(), 10)
  })
})

describe('FlowPhaseClock — 钳制超大与负增量（§11.3 不累计超大时间差）', () => {
  it('单帧增量超过 MAX_FRAME_DELTA_SECONDS 视为隐藏/休眠恢复帧，按 0 计入', () => {
    const clock = new FlowPhaseClock(FLOW)
    advanceBySteps(clock, 1.0)
    const before = clock.offsetMeters()
    const offset = clock.advance(MAX_FRAME_DELTA_SECONDS + 5)
    expect(offset).toBe(before) // 未推进
  })

  it('恰好等于上限的增量照常推进（边界含等）', () => {
    const clock = new FlowPhaseClock(FLOW)
    clock.advance(MAX_FRAME_DELTA_SECONDS)
    expect(clock.phaseSeconds()).toBeCloseTo(MAX_FRAME_DELTA_SECONDS, 10)
  })

  it('负增量丢弃，相位不倒流', () => {
    const clock = new FlowPhaseClock(FLOW)
    advanceBySteps(clock, 1.0)
    const before = clock.phaseSeconds()
    clock.advance(-2.0)
    expect(clock.phaseSeconds()).toBe(before)
  })

  it('NaN/Infinity 增量按 0 处理，不污染相位', () => {
    const clock = new FlowPhaseClock(FLOW)
    advanceBySteps(clock, 0.5)
    const before = clock.phaseSeconds()
    clock.advance(Number.NaN)
    clock.advance(Number.POSITIVE_INFINITY)
    expect(clock.phaseSeconds()).toBe(before)
  })

  it('模拟隐藏恢复：隐藏期间不 advance，恢复首帧超大 delta 被丢弃、动画续接', () => {
    const clock = new FlowPhaseClock(FLOW)
    advanceBySteps(clock, 1.0) // 推进 1 s → 偏移 0.4 m
    const pausedAt = clock.offsetMeters()
    expect(pausedAt).toBeCloseTo(0.4, 6)
    // 模拟页面隐藏 10 秒：期间不调用 advance（PathLayer 已暂停）；恢复首帧 delta=10s。
    const afterResume = clock.advance(10)
    expect(afterResume).toBeCloseTo(pausedAt, 10) // 续接，未跳过多个周期
  })
})

describe('FlowPhaseClock — 长时间运行稳定性（§11.3 浸泡）', () => {
  it('模拟 24 小时连续推进：相位恒有界、偏移恒有限', () => {
    const clock = new FlowPhaseClock(FLOW)
    // 用钳制上限步长模拟逐帧，覆盖 24 h；不逐帧断言以保持单测快速。
    const step = MAX_FRAME_DELTA_SECONDS
    const frames = Math.floor((24 * 3600) / step)
    let last = 0
    let phase = 0
    for (let i = 0; i < frames; i += 1) {
      last = clock.advance(step)
      phase = clock.phaseSeconds()
    }
    expect(Number.isFinite(last)).toBe(true)
    expect(Number.isFinite(phase)).toBe(true)
    expect(last).toBeGreaterThanOrEqual(0)
    expect(last).toBeLessThan(FLOW.flowRepeatM)
    expect(phase).toBeGreaterThanOrEqual(0)
    expect(phase).toBeLessThan(FLOW.flowPeriodSeconds)
  })
})
