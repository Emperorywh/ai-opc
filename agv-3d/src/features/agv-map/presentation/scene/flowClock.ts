import type { PathFlowConfig } from '../../config/visualTheme'

/**
 * 流光相位时钟（SPEC §7.6、§11.3、TASK-010）。
 *
 * 职责：把逐帧时间增量映射为一个有界的"流光偏移（米）"标量，供路径着色器
 * 的 uFlowOffsetM uniform 使用。偏移沿每条车道弧长 aPathU 减去，配合 aFlowDirection
 * 表达从源节点流向目标节点的方向（见 pathShader）。
 *
 * 不变量：
 * - 相位有界：内部只维护 [0, flowPeriodSeconds) 的相位秒数，取模吸收任意长时间运行，
 *   不会因 24 小时浸泡使浮点精度退化（§11.3）。
 * - 不累计超大 delta：单帧增量超过 MAX_FRAME_DELTA_SECONDS 视为页面隐藏后的恢复帧
 *   或系统休眠，直接丢弃（按 0 计入），避免恢复可见时一次跳过多个周期（§11.3）。
 * - 负增量丢弃：rAF 时间戳在极少数情况下可能回退，保守按 0 处理，避免相位倒流。
 * - 动画连续：正常帧增量照常累加（仅做上限钳制），帧率波动不改变平均流光速度；
 *   隐藏期间 PathLayer 停止调用 advance（visibilitychange 暂停），恢复后从暂停处
 *   平滑续接，无可见跳变。
 *
 * 纯时间数学：不依赖 Three.js、React 或浏览器对象，可在 Node 环境完整验证相位、
 * 钳制与连续性。页面可见性监听由 PathLayer 负责，本类只提供推进语义。
 */

/**
 * 单帧时间增量上限，单位秒。超过该值的增量视为隐藏/休眠恢复帧并丢弃。
 * 取 0.5 s 兼容低至 2 fps 的偶发卡顿仍按真实速度推进；隐藏恢复产生的秒级以上
 * 增量被识别为非连续帧。
 */
export const MAX_FRAME_DELTA_SECONDS = 0.5

/**
 * 有界流光相位时钟。
 *
 * 用法：每可见帧调用 advance(deltaSeconds) 得到当前偏移（米）并写入 uniform。
 * 页面隐藏时由 PathLayer 停止调用 advance，恢复后继续；超大增量在 advance 内部
 * 被钳制丢弃，二者共同保证"恢复可见时不累计超大时间差"。
 */
export class FlowPhaseClock {
  private readonly config: PathFlowConfig
  private elapsedSeconds: number

  /**
   * @param config 流光参数（重复距离与周期）。
   * @param initialPhaseSeconds 初始相位秒数，默认 0；测试可注入非零起点。
   */
  constructor(
    config: PathFlowConfig,
    initialPhaseSeconds = 0,
  ) {
    this.config = config
    this.elapsedSeconds = boundedPhase(initialPhaseSeconds, config.flowPeriodSeconds)
  }

  /**
   * 推进一帧并返回当前流光偏移（米），范围 [0, flowRepeatM)。
   *
   * 增量经钳制后累加到内部相位（取模周期），偏移 = 相位/周期 × 重复距离，
   * 与 SPEC §7.6 `phase = (elapsed % period) / period` 一致。
   */
  advance(deltaSeconds: number): number {
    const delta = clampFrameDelta(deltaSeconds)
    this.elapsedSeconds = boundedPhase(this.elapsedSeconds + delta, this.config.flowPeriodSeconds)
    return this.offsetMeters()
  }

  /** 当前流光偏移（米），不推进相位。 */
  offsetMeters(): number {
    return (this.elapsedSeconds / this.config.flowPeriodSeconds) * this.config.flowRepeatM
  }

  /** 当前相位秒数（[0, period)），供测试断言有界性。 */
  phaseSeconds(): number {
    return this.elapsedSeconds
  }
}

/**
 * 把相位秒数限制到 [0, period)。
 *
 * 对负值取模结果为正（JS % 保持符号，故先加一个周期再取模），保证任意输入落入区间。
 */
function boundedPhase(seconds: number, period: number): number {
  if (!Number.isFinite(seconds) || !Number.isFinite(period) || period <= 0) return 0
  const mod = seconds % period
  return mod < 0 ? mod + period : mod
}

/**
 * 钳制单帧增量：负值或超大值归零，正常值原样通过（§11.3 不累计超大时间差）。
 */
function clampFrameDelta(deltaSeconds: number): number {
  if (!Number.isFinite(deltaSeconds)) return 0
  if (deltaSeconds < 0) return 0
  if (deltaSeconds > MAX_FRAME_DELTA_SECONDS) return 0
  return deltaSeconds
}
