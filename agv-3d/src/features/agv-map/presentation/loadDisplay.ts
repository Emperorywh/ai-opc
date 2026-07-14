import type { ActiveStage, MapSceneState } from '../application/loadState'
import { STAGE_DISPLAY_LABELS } from './loadStageLabels'

/**
 * 加载/错误界面的展示模型与派生函数（SPEC §10.1、§10.2、TASK-008）。
 *
 * 该模块把显式加载状态（MapSceneState）翻译为展示层只读的"展示模型"：
 * 加载态携带阶段名与整数百分比，错误态携带稳定错误码、发生阶段名与简短中文说明。
 * 所有派生为纯函数，不读取系统时间、DOM 或 React 状态，可在 Node 环境完整验证，
 * 使展示组件保持无逻辑的薄壳（仅把展示模型渲染为 DOM）。
 *
 * 不变量：
 * - 百分比始终为 0～100 的整数且与状态 progress 单调一致：派生只做 round 与钳制，
 *   不引入额外的平滑或回退，保证"显示值与加载状态一致且从不倒退"（TASK-008 验收）。
 * - 终态封闭：ready 不产生任何覆盖层展示模型（返回 null），由调用方据此移除覆盖层，
 *   露出后续任务接入的场景画布；错误态恒返回 ErrorDisplay，永不回到加载态。
 * - 空状态归一：state 为 null（尚未启动）时归一为 downloading/0% 加载展示，
 *   与紧随其后的真实 downloading/0% 衔接而不回退，避免外壳首帧出现空白闪烁。
 */

/**
 * 加载界面展示模型（SPEC §10.1）。
 *
 * - stage：状态机活跃阶段字面量，供 data 属性与测试断言。
 * - stageLabel：该阶段的简体中文展示名称。
 * - percent：0～100 的整数百分比，来自状态 progress 的四舍五入与钳制。
 */
export interface LoadingDisplay {
  readonly kind: 'loading'
  readonly stage: ActiveStage
  readonly stageLabel: string
  readonly percent: number
}

/**
 * 错误界面展示模型（SPEC §10.2）。
 *
 * - code：稳定错误码（如 ASSET_DOWNLOAD_FAILED），直接展示用于稳定定位。
 * - stage：错误发生时的活跃阶段字面量。
 * - stageLabel：该阶段的简体中文展示名称。
 * - message：错误码对应的简短中文说明。
 * - details：仅供开发定位的详细字段路径，不直接展示在错误卡片可见区，
 *   由错误组件写入开发日志（console）。
 */
export interface ErrorDisplay {
  readonly kind: 'error'
  readonly code: string
  readonly stage: ActiveStage
  readonly stageLabel: string
  readonly message: string
  readonly details: readonly string[]
}

/** 覆盖层展示模型：加载态、错误态或无（ready 时为 null）。 */
export type OverlayDisplay = LoadingDisplay | ErrorDisplay | null

/**
 * 把 0～1 的状态进度映射为 0～100 的整数百分比（SPEC §10.1）。
 *
 * NaN 视作 0；越界值钳制到 [0, 100]。使用 round 而非 floor/trunc，
 * 使 0.985 这类接近满值的状态能显示为 99，避免进度卡在 98 给人停滞错觉。
 */
export function formatPercent(progress: number): number {
  if (Number.isNaN(progress)) return 0
  const ratio = progress < 0 ? 0 : progress > 1 ? 1 : progress
  return Math.round(ratio * 100)
}

/**
 * 由 loading 或 preparing 状态构造加载展示模型。
 *
 * 传入前应已确认状态为 loading/preparing；该函数不做状态校验，仅做展示派生。
 */
export function getLoadingDisplay(
  state: Extract<MapSceneState, { status: 'loading' | 'preparing' }>,
): LoadingDisplay {
  return {
    kind: 'loading',
    stage: state.stage,
    stageLabel: STAGE_DISPLAY_LABELS[state.stage],
    percent: formatPercent(state.progress),
  }
}

/**
 * 由 error 状态构造错误展示模型（SPEC §10.2）。
 *
 * 错误码、发生阶段与中文说明均取自结构化错误对象，保证展示与状态一致；
 * details 透传，供错误组件写入开发日志而不在可见区展示。
 */
export function getErrorDisplay(state: Extract<MapSceneState, { status: 'error' }>): ErrorDisplay {
  const error = state.error
  return {
    kind: 'error',
    code: error.code,
    stage: error.stage,
    stageLabel: STAGE_DISPLAY_LABELS[error.stage],
    message: error.message,
    details: error.details,
  }
}

/**
 * 由当前加载状态派生覆盖层展示模型（TASK-008 核心）。
 *
 * - null（尚未启动）：归一为 downloading/0% 加载展示，与即将到达的真实初始态无缝衔接。
 * - loading / preparing：加载展示，阶段名与百分比随状态单调推进。
 * - error：错误展示，进入后不再回到加载态（SPEC §10.2 终态封闭）。
 * - ready：返回 null，调用方据此卸载覆盖层，露出后续任务接入的场景画布。
 *
 * 状态机已保证 progress 单调不下降；本函数不再做二次单调守卫，仅忠实映射。
 */
export function getOverlayDisplay(state: MapSceneState | null): OverlayDisplay {
  if (state === null) {
    return { kind: 'loading', stage: 'downloading', stageLabel: STAGE_DISPLAY_LABELS.downloading, percent: 0 }
  }
  switch (state.status) {
    case 'loading':
    case 'preparing':
      return getLoadingDisplay(state)
    case 'error':
      return getErrorDisplay(state)
    case 'ready':
      return null
  }
}
