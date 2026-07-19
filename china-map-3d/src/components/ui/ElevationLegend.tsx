/**
 * 海拔色阶图例的 DOM overlay 渲染层（TASK-021，SPEC §9）。
 *
 * 角色与依赖方向：
 * - 本组件属于 DOM overlay 层（src/components/ui），独立于 3D 画布。它只负责「把领域层已准备好的色条
 *   color stop 序列 + 关键刻度（位置 / 颜色 / 文字）装配成一张竖向色阶图例（色条 CSS 渐变 + 刻度标注 +
 *   标题 + 单位 + 海平面注释）」。它只依赖：配置层（ELEVATION_LEGEND_CONFIG —— 呈现常量与色阶域引用的
 *   唯一源）、领域层（prepareElevationLegend + buildElevationLegendBarGradientCss + PreparedElevationLegend 类型）、
 *   React。禁止自行采样色阶、复制断点 / 颜色、或在组件内硬编码刻度海拔（TASK-021 实现约束「图例不得复制
 *   色阶断点和颜色，必须从 TASK-010 的单一事实源派生」）。
 * - 本组件是 DOM overlay，挂在 3D Canvas 之外的 .china-map-overlay 内（SPEC §9「DOM overlay」）。它不参与
 *   省级 hover、不接收任何 hover / click 状态，纯静态呈现；也不反向修改 3D 相机 / 地形 / hover
 *   （TASK-021 实现约束「合规角标 / 图例只消费，不反向控制场景或交互」——图例同此约束）。
 *
 * 色阶复用（SPEC §9「直接消费地表唯一色阶配置」、TASK-021 完成标准「图例与 shader 色阶单一事实源可由
 *   自动化证明」）：
 * - 色条 color stop 与关键刻度的颜色 / 位置全部来自领域层 prepareElevationLegend，该函数对每个海拔调
 *   sampleElevationColor（与地表片元着色器同一采样器）与 normalizeElevationToRampU（与 shader 片元归一化
 *   同一公式）派生。故「色条上某海拔的颜色」≡「地表真实海拔处的颜色」，单一事实源可由自动化证明。
 * - 本组件不接收任何 props（呈现常量全部来自配置层冻结常量），故挂载即稳定呈现、不依赖 3D 资产加载
 *   状态——色阶域是 elevation-color-ramp 的冻结常量（与 shader 经 resolveElevationColorConfig 复核 meta 上下限
 *   所对照的同一域），图例无需等待 heightmap 加载即可读图。
 *
 * 布局分区（SPEC §9「不遮挡主图核心区域（如左侧竖向贴边）」、TASK-021 实现约束「必须同时避让主图核心
 *   和右下附图」）：
 * - 图例固定在左侧竖向贴边、纵向居中（CSS .china-map-legend），不遮挡主图核心（中央地形）与右下南海附图
 *   （.china-map-inset 在右下角）。k 控件在左上角（.china-map-kcontrol），图例纵向居中与其在垂直方向上
 *   分离，互不重叠。
 */

import { useMemo } from 'react'
import type { CSSProperties, ReactNode } from 'react'
import { ELEVATION_LEGEND_CONFIG } from '../../config/elevation-legend'
import {
  buildElevationLegendBarGradientCss,
  prepareElevationLegend,
  type LegendTick,
} from '../../lib/elevation-legend'

/**
 * 海拔色阶图例（左侧竖向贴边 DOM overlay）。
 *
 * 挂载即稳定呈现（不依赖 3D 资产加载）。色条渐变与刻度颜色 / 位置全部从 TASK-010 色阶唯一事实源派生
 * （prepareElevationLegend → sampleElevationColor / normalizeElevationToRampU），本组件不复制断点 / 颜色。
 */
export function ElevationLegend(): ReactNode {
  // 准备产物（色条 color stop + 关键刻度）。配置层冻结常量引用稳定，故 memo 在配置不变时不重算。
  const legend = useMemo(() => prepareElevationLegend(), [])
  // 色条 CSS 渐变字符串：低海拔在底、高海拔在顶（to top），与读图直觉一致。
  const gradientCss = useMemo(
    () => buildElevationLegendBarGradientCss(legend.barStops),
    [legend.barStops],
  )

  const {
    barHeightPixels,
    barWidthPixels,
    barStrokeHex,
    barStrokeWidthPx,
    caption,
    unitLabel,
    seaLevelLabel,
    tickLabelHex,
    tickLabelFontSizePx,
    captionHex,
    captionFontSizePx,
    panelBgRgba,
  } = ELEVATION_LEGEND_CONFIG

  // 色条样式：CSS linear-gradient（颜色来自色阶唯一采样器）+ 描边抗深色背景糊化。
  const barStyle: CSSProperties = {
    height: `${barHeightPixels}px`,
    width: `${barWidthPixels}px`,
    background: gradientCss,
    border: `${barStrokeWidthPx}px solid ${barStrokeHex}`,
    borderRadius: '3px',
  }

  return (
    <div
      className="china-map-legend"
      style={{ background: panelBgRgba }}
      aria-label="海拔色阶图例"
      role="img"
    >
      <div className="china-map-legend-caption" style={{ color: captionHex, fontSize: `${captionFontSizePx}px` }}>
        {caption}
      </div>
      <div className="china-map-legend-body">
        <div className="china-map-legend-bar" style={barStyle} />
        {/*
          刻度行：每项含色块（该海拔颜色，来自色阶唯一采样器）+ 海拔数值 + 单位。
          positionFraction（0=色条底、1=色条顶）决定刻度纵向位置，与色条渐变同一归一化。
          0m 刻度附加「海平面」注释，使色条下方水下色段有读图含义（近岸浅、远海深，SPEC §3.5）。
        */}
        <ul className="china-map-legend-ticks" style={{ color: tickLabelHex, fontSize: `${tickLabelFontSizePx}px` }}>
          {legend.ticks.map((tick: LegendTick) => {
            const isSeaLevel = tick.elevationMeters === 0
            return (
              <li
                key={tick.label}
                className="china-map-legend-tick"
                style={{ top: `${(1 - tick.positionFraction) * 100}%` }}
              >
                <span
                  className="china-map-legend-tick-swatch"
                  style={{ background: tick.colorHex }}
                  aria-hidden="true"
                />
                <span className="china-map-legend-tick-value">
                  {tick.label}
                  {unitLabel}
                </span>
                {isSeaLevel && <span className="china-map-legend-sea-level">{seaLevelLabel}</span>}
              </li>
            )
          })}
        </ul>
      </div>
    </div>
  )
}
