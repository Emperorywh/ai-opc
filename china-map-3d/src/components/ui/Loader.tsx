/**
 * 加载与入场的 DOM 进度 / 错误反馈（TASK-020）。
 *
 * 角色与依赖方向：
 * - 本组件属于 DOM overlay 层（src/components/ui），独立于 3D 画布。它把「受跟踪资产就绪状态 + 当前入场
 *   阶段」确定性变换为「加载进度条 / 错误诊断 / 入场阶段提示」的可见 DOM。它**只**依赖：领域层
 *   （entrance-state 的 AssetReadiness / EntrancePhase 类型 + isEntranceInteractive / totalEntranceSeconds）、
 *   配置层（ENTRANCE_DURATIONS）。**不**读取资产数据、不自取状态、不持有计时器——进度只反映真实受跟踪资产
 *   （loadedCount / totalCount），不伪造计时进度（TASK-020 输出约束「DOM 加载进度反馈只反映真实受跟踪资产，
 *   不伪造计时进度」「加载失败不会永久卡在假进度」）。
 * - 单向依赖：本模块不依赖 React Three Fiber / Three.js（纯 DOM），故可在 Node 之外由人工验收直接观察。
 *
 * 可见性分阶段（SPEC §4.3「加载阶段进度条」、TASK-020 可验证结果）：
 * - loading：全屏覆盖 + 进度条（loadedCount / totalCount）。进度只随真实资产就绪推进，资产未就绪时停在
 *   真实值（如 3/5），绝不用计时器虚假推到 99%（TASK-020 验证方式 2「永远 99%」不可达）。
 * - error：全屏覆盖 + 可诊断错误信息（首个失败资产的 errorMessage），保持交互关闭。绝不退化为低清 / 平面 /
 *   旧资产 / 远程请求（TASK-020 实现约束「加载失败必须显式终止状态机并保留诊断」）。
 * - terrain-rise / labels-fade-in / scene-layers-fade-in：不覆盖画布（让用户看到地形升起 / 标签错峰淡入 /
 *   水面边界淡入的 3D 动画），仅在底部显示极简阶段提示 + 入场总进度（基于真实 elapsed / 总时长，非伪造）。
 * - interactive：无反馈（入场完成，全场景可交互）。
 *
 * 主场景与附图 / 合规 UI 的竞态（TASK-020 实现约束「2D 附图和合规 UI 的加载不能造成主场景已经可交互却仍
 *   覆盖假进度的竞态」）：本组件的可见性只由「资产就绪 + 入场阶段」决定。SouthChinaSeaInset（TASK-019）
 *   在 political 契约就绪时挂载——political 是五个受跟踪资产之一，故附图挂载必然发生在 readiness.ready
 *   之前或同时；interactive 仅在全部资产就绪 + 入场完成后到达，故不存在「主场景已可交互却仍覆盖假进度」。
 */

import type { ReactNode } from 'react'
import {
  isEntranceInteractive,
  type AssetReadiness,
  type EntrancePhase,
} from '../../lib/entrance-state'

/** Loader 的 props：资产就绪状态 + 当前入场阶段（决定覆盖 / 提示 / 无反馈三态）。 */
export interface LoaderProps {
  /** 受跟踪资产的聚合就绪状态（loadedCount / totalCount / failed / failureMessage）。 */
  readonly readiness: AssetReadiness
  /** 当前入场阶段（决定覆盖 / 提示 / 无反馈三态）。 */
  readonly phase: EntrancePhase
}

/**
 * 渲染加载进度 / 错误诊断 / 入场阶段提示（DOM overlay，pointer-events: none 不阻挡 3D 交互）。
 *
 * loading / error 全屏覆盖（此时画布无可探索内容 / 失败需明确阻断）；动画阶段仅底部极简提示（不遮画布）；
 * interactive 无输出。进度只来自真实资产状态，无任何计时器伪造。
 */
export function Loader({ readiness, phase }: LoaderProps): ReactNode {
  // interactive：入场完成，无反馈（主场景已可交互，不应再覆盖任何进度）。
  if (isEntranceInteractive(phase)) return null

  // error：全屏覆盖 + 可诊断错误信息，保持交互关闭（不退化为 fallback）。
  if (phase === 'error') {
    const message = readiness.failureMessage ?? '未知资产加载失败。'
    return (
      <div className="china-map-loader china-map-loader--full" role="alert" aria-live="assertive">
        <div className="china-map-loader-title">地图资产加载失败</div>
        <div className="china-map-loader-error">{message}</div>
        <div className="china-map-loader-hint">请检查静态资产完整性后刷新；不会自动降级或重试。</div>
      </div>
    )
  }

  // loading：全屏覆盖 + 真实进度条（loadedCount / totalCount，不伪造计时）。
  if (phase === 'loading') {
    const total = readiness.totalCount > 0 ? readiness.totalCount : 1
    const ratio = Math.max(0, Math.min(1, readiness.loadedCount / total))
    const percent = Math.round(ratio * 100)
    return (
      <div className="china-map-loader china-map-loader--full" role="status" aria-live="polite">
        <div className="china-map-loader-title">正在加载地图资产</div>
        <div className="china-map-loader-bar">
          <div className="china-map-loader-bar-fill" style={{ width: `${percent}%` }} />
        </div>
        <div className="china-map-loader-progress">
          {readiness.loadedCount} / {readiness.totalCount}（{percent}%）
        </div>
      </div>
    )
  }

  // 动画阶段（terrain-rise / labels-fade-in / scene-layers-fade-in）：底部极简阶段提示。
  // 不覆盖画布、不显示伪造计时百分比——让用户直接看到地形升起 / 标签错峰淡入 / 水面边界淡入的 3D 动画
  // 本身作为进度反馈（3D 动画即真实进度，无需再用 DOM 计时百分比复述）。入场完成后自然消失
  // （phase → interactive）。
  const phaseLabel =
    phase === 'terrain-rise'
      ? '地形升起中'
      : phase === 'labels-fade-in'
        ? '标注淡入中'
        : '水面与边界淡入中'
  return (
    <div className="china-map-loader china-map-loader--hint" role="status" aria-live="polite">
      <span className="china-map-loader-phase">{phaseLabel}</span>
    </div>
  )
}
