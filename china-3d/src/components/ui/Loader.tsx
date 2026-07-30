/**
 * 加载与入场的 DOM 进度 / 错误反馈（TASK-013，SPEC §4.3「加载阶段…进度条（DOM overlay）」）。
 *
 * 角色与依赖方向：
 * - 本组件属于 DOM overlay 层（src/components/ui），独立于 3D 画布。它把「受跟踪资产就绪状态 + 当前
 *   入场阶段」确定性变换为「加载进度条 / 错误诊断 / 入场阶段提示」的可见 DOM。它**只**依赖：领域层
 *   （entrance-state 的 AssetReadiness / EntrancePhase 类型 + isEntranceInteractive）。**不**读取资产
 *   数据、不自取状态、不持有计时器——进度只反映真实受跟踪资产（loadedCount / totalCount），不伪造
 *   计时进度（资产未就绪时进度停在真实值，如 2/4，绝不用计时器虚假推到 99%）。
 * - 单向依赖：本模块不依赖 React Three Fiber / Three.js（纯 DOM），挂在 Canvas 之外。
 *
 * 可见性分阶段（SPEC §4.3）：
 * - loading：全屏覆盖 + 进度条（loadedCount / totalCount）。全屏覆盖以不透明深色底遮住尚未入场的
 *   场景（地形仍在平面态），进度只随真实资产就绪推进。
 * - error：全屏覆盖 + 可诊断错误信息（首个失败资产的 errorMessage），保持交互关闭。App 的红线整页
 *   错误通道优先于本组件（资产加载失败时 App 直接显示整页错误、不挂载本组件的进度态），本分支是
 *   状态机 error 阶段的完整渲染契约，保证本组件是 (readiness, phase) 的完备纯函数。
 * - terrain-rise / labels-fade-in / scene-layers-fade-in：不覆盖画布（让用户看到地形升起 / 标签错峰
 *   淡入 / 水面边界淡入的 3D 动画本身——3D 动画即真实进度，无需再用 DOM 计时百分比复述），仅在底部
 *   显示极简阶段提示。
 * - interactive：无反馈（入场完成，全场景可交互）。
 *
 * 文案边界：本组件文案是 DOM UI 界面文本（系统字体渲染），**不**进入 src/lib/static-copy——该模块
 * 是「需要 CJK 字体子集覆盖的页面静态文案」唯一事实源（字体子集契约只覆盖 3D 标签 / 附图 / 标题区
 * 文案），DOM 进度提示不消费离线子集字体，加入会无谓膨胀子集字符集（TASK-005 资产已冻结哈希锚定）。
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
 * 渲染加载进度 / 错误诊断 / 入场阶段提示（DOM overlay）。
 *
 * loading / error 全屏覆盖（此时画布无可探索内容 / 失败需明确阻断）；动画阶段仅底部极简提示
 * （pointer-events: none 不遮挡画布）；interactive 无输出。进度只来自真实资产状态，无任何计时器伪造。
 */
export function Loader({ readiness, phase }: LoaderProps): ReactNode {
  // interactive：入场完成，无反馈（主场景已可交互，不应再覆盖任何进度）。
  if (isEntranceInteractive(phase)) return null

  // error：全屏覆盖 + 可诊断错误信息，保持交互关闭（不退化为 fallback）。
  if (phase === 'error') {
    const message = readiness.failureMessage ?? '未知资产加载失败。'
    return (
      <div className="entrance-loader entrance-loader--full" role="alert" aria-live="assertive">
        <div className="entrance-loader-title">地图资产加载失败</div>
        <div className="entrance-loader-error">{message}</div>
        <div className="entrance-loader-hint">请检查静态资产完整性后刷新；不会自动降级或重试。</div>
      </div>
    )
  }

  // loading：全屏覆盖 + 真实进度条（loadedCount / totalCount，不伪造计时）。
  if (phase === 'loading') {
    const total = readiness.totalCount > 0 ? readiness.totalCount : 1
    const ratio = Math.max(0, Math.min(1, readiness.loadedCount / total))
    const percent = Math.round(ratio * 100)
    return (
      <div className="entrance-loader entrance-loader--full" role="status" aria-live="polite">
        <div className="entrance-loader-title">正在加载地图资产</div>
        <div className="entrance-loader-bar">
          <div className="entrance-loader-bar-fill" style={{ width: `${percent}%` }} />
        </div>
        <div className="entrance-loader-progress">
          {readiness.loadedCount} / {readiness.totalCount}（{percent}%）
        </div>
      </div>
    )
  }

  // 动画阶段（terrain-rise / labels-fade-in / scene-layers-fade-in）：底部极简阶段提示。
  // 不覆盖画布、不显示伪造计时百分比——让用户直接看到地形升起 / 标签错峰淡入 / 水面边界淡入的 3D
  // 动画本身作为进度反馈。入场完成后自然消失（phase → interactive）。
  const phaseLabel =
    phase === 'terrain-rise'
      ? '地形升起中'
      : phase === 'labels-fade-in'
        ? '标注淡入中'
        : '水面与边界淡入中'
  return (
    <div className="entrance-loader entrance-loader--hint" role="status" aria-live="polite">
      <span className="entrance-loader-phase">{phaseLabel}</span>
    </div>
  )
}
