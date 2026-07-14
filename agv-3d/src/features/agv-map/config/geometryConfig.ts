/**
 * 几何编译集中配置（SPEC §7、§12）。
 *
 * 配置按职责集中、所有参数携带单位后缀。本文件随任务推进逐步补充：
 * - TASK-002 落地路径采样参数；
 * - TASK-003 追加车道分组参数（反向配对容差、等参数采样数、中心偏移）；
 * - TASK-004 追加扁带宽度、离地高度与斜接上限；
 * - 节点尺寸由后续任务在同一文件追加，避免散落常量。
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

/**
 * 车道分组参数（SPEC §7.4）。
 *
 * 双向车道由互为反向拓扑且几何等价的边组成。这些参数决定配对判定与侧向偏移，
 * 同样为纯函数输入，确保相同数据产生稳定的车道布局，且与渲染自适应采样相互独立。
 */
export interface LaneGroupingConfig {
  /** 反向候选中心线在统一方向后的最大允许对应点偏差，单位米。 */
  readonly laneGroupToleranceM: number
  /** 反向中心线比较时沿弧长等参数采样的点数。 */
  readonly lanePairSampleCount: number
  /** 双向车道相对共享中心线的侧向偏移，单位米。 */
  readonly laneCenterOffsetM: number
}

/** 初始车道分组配置（SPEC §7.4：0.02 m 容差、33 点比较、0.18 m 偏移）。 */
export const DEFAULT_LANE_GROUPING_CONFIG: LaneGroupingConfig = {
  laneGroupToleranceM: 0.02,
  lanePairSampleCount: 33,
  laneCenterOffsetM: 0.18,
}

/**
 * 路径扁带编译参数（SPEC §7.4、§7.5）。
 *
 * 扁带在地图 XY 平面完成侧向偏移与带宽展开后统一映射到世界 XZ 平面。
 * 这些参数为纯函数输入，确保相同车道分组产生字节级稳定的扁带几何，
 * 且不引入对展示状态、相机或系统时间的依赖（SPEC §7.1）。
 */
export interface PathRibbonConfig {
  /** 扁带宽度，单位米。扁带以此宽度沿中心线法向两侧展开。 */
  readonly ribbonWidthM: number
  /** 扁带离地高度，单位米。映射到世界坐标时作为 Y 分量。 */
  readonly ribbonHeightM: number
  /**
   * 斜接长度上限，以半带宽的倍数表达（SPEC §7.5：上限为半带宽的 2 倍）。
   * 当斜接比例超过该值时折角切换为斜切（bevel）连接，避免尖刺。
   */
  readonly miterLimitRatio: number
}

/** 初始扁带配置（SPEC §7.4、§7.5：0.22 m 带宽、0.015 m 离地、斜接上限 2 倍）。 */
export const DEFAULT_PATH_RIBBON_CONFIG: PathRibbonConfig = {
  ribbonWidthM: 0.22,
  ribbonHeightM: 0.015,
  miterLimitRatio: 2.0,
}
