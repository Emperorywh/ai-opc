/**
 * 几何编译集中配置（SPEC §7、§12）。
 *
 * 配置按职责集中、所有参数携带单位后缀。本文件随任务推进逐步补充：
 * 当前（TASK-002）仅落地路径采样相关常量；车道偏移、扁带宽度与节点尺寸
 * 由后续任务在同一文件追加，避免散落常量。
 */

/**
 * 贝塞尔递归细分的采样参数（SPEC §7.3）。
 *
 * 这些参数为纯函数输入，不依赖运行时状态；相同取值必须产生字节级稳定的采样。
 */
export interface SamplingConfig {
  /** 相邻采样点的最大弦长，单位米。 */
  readonly maxChordLengthM: number
  /** 子段曲线相对弦的最大平坦度误差，单位米。 */
  readonly maxFlatnessErrorM: number
  /** 递归细分的安全深度上限，保证有限细分。 */
  readonly maxRecursionDepth: number
}

/** 初始采样配置（SPEC §7.3：0.25 m 弦长、0.01 m 平坦度、深度上限 12）。 */
export const DEFAULT_SAMPLING_CONFIG: SamplingConfig = {
  maxChordLengthM: 0.25,
  maxFlatnessErrorM: 0.01,
  maxRecursionDepth: 12,
}
