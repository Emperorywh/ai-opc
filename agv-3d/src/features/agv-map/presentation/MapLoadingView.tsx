import type { LoadingDisplay } from './loadDisplay'

/**
 * 加载界面组件（SPEC §10.1、TASK-008）。
 *
 * 只展示当前阶段的简体中文名称与整数百分比，以及与百分比同步的进度条；
 * 不承载错误、重试或业务叠层（SPEC §10.1：UI 只显示阶段名称和整数百分比）。
 *
 * 组件保持无逻辑薄壳：所有派生（阶段名、百分比）由 getLoadingDisplay 完成，
 * 此处仅把展示模型渲染为 DOM，便于在不启动浏览器的前提下验证派生逻辑。
 */
export interface MapLoadingViewProps {
  readonly display: LoadingDisplay
}

export function MapLoadingView({ display }: MapLoadingViewProps) {
  // 进度条宽度直接使用整数百分比，与显示数字同源，不引入额外平滑。
  const barStyle = { width: `${display.percent}%` } as const
  return (
    <div
      className="agv-map-loading"
      role="status"
      aria-live="polite"
      data-load-stage={display.stage}
      data-load-percent={display.percent}
    >
      <div className="agv-map-loading__label">{display.stageLabel}</div>
      <div className="agv-map-loading__bar" aria-hidden="true">
        <div className="agv-map-loading__fill" style={barStyle} />
      </div>
      <div className="agv-map-loading__percent">{display.percent}%</div>
    </div>
  )
}
