/*
 * 加载 / 错误覆盖层（ui 层，SPEC 4.2 / 13 / 14.1 / 任务约束）。
 *
 * 定位（TASK-018）：
 *   - 本组件把 application 加载状态机投影为用户可见的加载提示或稳定错误信息；
 *     不渲染部分地图、不 second-guess 状态、不维护第二套加载布尔（SPEC 4.2 / 14.1）。
 *   - ui 层禁止依赖 application（SPEC 3.3 分层），故 app-root 把 LoadState 投影为本组件的
 *     OverlayView（纯字符串视图）后传入；本组件不接触 MapDataError / SceneModel / Three。
 *
 * 错误呈现不变量（SPEC 14.1 / 任务约束）：
 *   - error 显示稳定错误码、阶段名、简体中文消息；开发态附带 JSON path 与实体 ID（由 app-root 注入）。
 *   - 不用 console.error 后留下空白画布：error / loading 期间覆盖层显式占位，ready 时不渲染覆盖层。
 *
 * 依赖方向（SPEC 3.3）：本层自身 + react；外部仅 react。
 *   不依赖 three / r3f / application / workers / domain；只消费纯字符串视图。
 */

/*
 * 覆盖层只读视图：app-root 把 LoadState 投影为本类型后传入。
 *   - loading：显示加载阶段名（loading / preparing 子阶段）。
 *   - error：稳定错误码 + 简体中文消息 + 可选开发态定位（jsonPath / entityId）。
 *   - hidden：ready 或 idle，不渲染覆盖层（地图或空容器负责画面）。
 */
export type OverlayView =
  | { readonly kind: 'loading'; readonly stageLabel: string }
  | {
      readonly kind: 'error'
      readonly code: string
      readonly message: string
      readonly phaseLabel: string
      readonly jsonPath?: string
      readonly entityId?: string | null
    }
  | { readonly kind: 'hidden' }

/*
 * 覆盖层入参：投影后的视图 + 可选文件名（加载提示用）。
 */
export interface LoadOrErrorOverlayProps {
  readonly view: OverlayView
  readonly sampleFileName?: string
}

/*
 * 加载 / 错误覆盖层主组件。
 * hidden 时返回 null（不占位、不遮挡已 ready 的地图）；loading / error 时全屏占位。
 */
export function LoadOrErrorOverlay({
  view,
  sampleFileName,
}: LoadOrErrorOverlayProps): React.JSX.Element | null {
  if (view.kind === 'hidden') {
    // ready / idle：不渲染覆盖层，画面交给 Canvas 或空容器。
    return null
  }

  if (view.kind === 'loading') {
    return (
      <div className="map-overlay map-overlay--loading" role="status" aria-live="polite">
        <p className="map-overlay__title">地图加载中</p>
        <p className="map-overlay__stage">{view.stageLabel}</p>
        {sampleFileName ? (
          <p className="map-overlay__file">样本：{sampleFileName}</p>
        ) : null}
      </div>
    )
  }

  // error：稳定错误码 + 阶段 + 简体中文消息 + 开发态定位。
  return (
    <div className="map-overlay map-overlay--error" role="alert" aria-live="assertive">
      <p className="map-overlay__title">地图加载失败</p>
      <p className="map-overlay__code">错误码：{view.code}</p>
      <p className="map-overlay__phase">阶段：{view.phaseLabel}</p>
      <p className="map-overlay__message">{view.message}</p>
      {view.jsonPath ? (
        <p className="map-overlay__detail">位置：{view.jsonPath}</p>
      ) : null}
      {view.entityId ? (
        <p className="map-overlay__detail">实体：{view.entityId}</p>
      ) : null}
    </div>
  )
}
