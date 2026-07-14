import { useEffect, useRef } from 'react'
import type { ErrorDisplay } from './loadDisplay'

/**
 * 错误界面组件（SPEC §10.2、TASK-008）。
 *
 * 展示稳定错误码、发生阶段名与简短中文说明；详细字段路径（details）不进入可见区，
 * 而是在开发模式下写入 console，供开发者按错误码与阶段定位（SPEC §10.2）。
 *
 * 不变量（TASK-008 验收）：
 * - 不展示节点、路径或半成品场景：错误卡片覆盖整个视口，画布区域无任何拓扑。
 * - 不自动重试、不跳过坏数据、不展示兼容或降级入口：无重试按钮、无 fallback 链接。
 *
 * 组件保持无逻辑薄壳：展示模型由 getErrorDisplay 派生，此处只渲染 DOM + 写开发日志。
 */
export interface MapErrorViewProps {
  readonly display: ErrorDisplay
}

export function MapErrorView({ display }: MapErrorViewProps) {
  // 开发日志：把结构化错误的详细字段路径写入 console，便于在开发期定位。
  // 仅在 Vite 开发模式下输出，生产构建经 import.meta.env.DEV 静态剔除。
  // 用 ref 守卫，避免 StrictMode 重复挂载时重复打印（仅首次出现的错误记一次）。
  const loggedRef = useRef(false)
  useEffect(() => {
    if (loggedRef.current) return
    loggedRef.current = true
    if (import.meta.env.DEV) {
      // 结构化字段路径与错误码一同输出，便于按阶段与字段定位（SPEC §10.2）。
      console.error('[agv-map] 加载失败', {
        code: display.code,
        stage: display.stage,
        message: display.message,
        details: display.details,
      })
    }
  }, [display.code, display.stage, display.message, display.details])

  return (
    <div
      className="agv-map-error"
      role="alert"
      aria-live="assertive"
      data-error-code={display.code}
      data-error-stage={display.stage}
    >
      <div className="agv-map-error__code">{display.code}</div>
      <div className="agv-map-error__stage">发生阶段：{display.stageLabel}</div>
      <p className="agv-map-error__message">{display.message}</p>
    </div>
  )
}
