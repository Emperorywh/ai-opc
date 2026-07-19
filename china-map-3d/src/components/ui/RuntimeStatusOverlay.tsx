/**
 * 运行时恢复状态的 DOM 诊断 overlay（TASK-022 输出约束「恢复失败时显示可诊断状态」）。
 *
 * 角色与依赖方向：
 * - 本组件属于 DOM overlay 层（src/components/ui），独立于 3D 画布。它把「集中编排器产出的运行时阶段 +
 *   失败诊断」确定性变换为「context 丢失 / 恢复中 / 恢复失败」的可见 DOM 反馈。它**只**依赖：领域层
 *   （runtime-lifecycle 的 RuntimeLifecyclePhase 类型）。**不**读取资产数据、不监听 context 事件（监听集中在
 *   RuntimeLifecycleController）、不持有计时器——阶段只来自集中编排器（TASK-022 实现约束「场景层和 UI 只
 *   消费状态」）。
 *
 * 可见性分阶段（TASK-022 输出约束）：
 * - running：无输出（正常运行，不干扰画布）。
 * - context-lost：全屏半透明覆盖 + 「图形上下文丢失，正在等待恢复」提示。此时画布可能已空白 / 冻结，
 *   覆盖层告知用户「在恢复」而非「坏了」，避免运维误判。
 * - restoring：全屏半透明覆盖 + 「正在恢复图形资源」提示。GPU 重建通常 < 1 秒，覆盖层平滑过渡到 running。
 * - restore-failed：全屏覆盖 + 可诊断错误信息（context 恢复超时 / GPU 重建失败的具体原因）+ 「请刷新」指引。
 *   不进入空白死循环、不自动请求外部资源 / 回退旧实现（TASK-022 实现约束「恢复失败必须显式暴露，不提供
 *   低清、平面、旧资产或远程 fallback」）。
 *
 * 与 Loader 的关系（TASK-020 加载 / 入场反馈）：Loader 反映「资产加载 / 入场编排」状态（loading / error /
 * 入场动画 / interactive），RuntimeStatusOverlay 反映「运行时 context 生命周期」状态（context-lost /
 * restoring / restore-failed）。二者正交——加载期 context 不太可能丢失（context 尚未大量使用），运行期
 * （interactive 后）Loader 已无输出，由 RuntimeStatusOverlay 接管「运行中 context 异常」反馈。两个 overlay
 * 都用半透明深色面板，视觉风格一致。
 */

import type { ReactNode } from 'react'
import type { RuntimeLifecyclePhase } from '../../lib/runtime-lifecycle'

/** RuntimeStatusOverlay 的 props：当前运行时阶段 + 失败诊断（restore-failed 时非空）。 */
export interface RuntimeStatusOverlayProps {
  /** 当前运行时生命周期阶段（来自集中编排器）。 */
  readonly phase: RuntimeLifecyclePhase
  /** 恢复失败诊断（restore-failed 时非空，供 DOM 显示；其余态为 null）。 */
  readonly failureMessage: string | null
}

/**
 * 渲染 context 丢失 / 恢复中 / 恢复失败的 DOM 诊断（pointer-events: none 不阻挡画布交互，恢复后自消失）。
 *
 * running 无输出（正常运行）；context-lost / restoring 全屏半透明覆盖 + 状态提示；restore-failed 全屏覆盖 +
 * 可诊断错误 + 刷新指引。阶段切换由集中编排器驱动，本组件只消费。
 */
export function RuntimeStatusOverlay({
  phase,
  failureMessage,
}: RuntimeStatusOverlayProps): ReactNode {
  // running：正常运行，无输出（不干扰画布）。
  if (phase === 'running') return null

  // context-lost：画布可能空白 / 冻结，覆盖层告知「在等待恢复」而非「坏了」。
  if (phase === 'context-lost') {
    return (
      <div
        className="china-map-runtime china-map-runtime--full"
        role="status"
        aria-live="polite"
      >
        <div className="china-map-runtime-title">图形上下文丢失</div>
        <div className="china-map-runtime-detail">正在等待浏览器恢复 WebGL 上下文…</div>
      </div>
    )
  }

  // restoring：GPU 资源重建中（通常 < 1 秒），平滑过渡到 running。
  if (phase === 'restoring') {
    return (
      <div
        className="china-map-runtime china-map-runtime--full"
        role="status"
        aria-live="polite"
      >
        <div className="china-map-runtime-title">正在恢复图形资源</div>
        <div className="china-map-runtime-detail">重建地形 / 海面 / 边界纹理，请稍候…</div>
      </div>
    )
  }

  // restore-failed：显式终态 + 可诊断错误 + 刷新指引。不自动重试 / 不回退旧实现（需人工刷新）。
  const message = failureMessage ?? '未知恢复失败原因。'
  return (
    <div
      className="china-map-runtime china-map-runtime--full china-map-runtime--failed"
      role="alert"
      aria-live="assertive"
    >
      <div className="china-map-runtime-title">图形资源恢复失败</div>
      <div className="china-map-runtime-error">{message}</div>
      <div className="china-map-runtime-hint">请检查 GPU 资源后刷新页面；不会自动降级或重试。</div>
    </div>
  )
}
