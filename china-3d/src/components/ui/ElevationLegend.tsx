/**
 * 海拔色阶图例的 DOM overlay 渲染层（TASK-014，SPEC §9）。
 *
 * 角色与依赖方向：
 * - 本组件属于 DOM overlay 层（src/components/ui），独立于 3D 画布。它只负责「把领域层已准备
 *   好的色条 color stop 序列 + 关键刻度（位置 / 颜色 / 文字）装配成一张竖向色阶图例（色条
 *   CSS 渐变 + 刻度标注 + 标题 + 单位 + 海平面注释）」。它只依赖：配置层
 *   （ELEVATION_LEGEND_CONFIG——呈现常量与色阶域引用的唯一源）、领域层
 *   （prepareElevationLegend + buildElevationLegendBarGradientCss + PreparedElevationLegend
 *   类型）、React。禁止自行采样色阶、复制断点 / 颜色、或在组件内硬编码刻度海拔。
 * - 本组件是 DOM overlay，挂在 3D Canvas 之外（与 TASK-012 附图、TASK-013 Loader 同层）：
 *   不 import 任何 R3F / Three.js API、不注册帧循环、不进入 3D 渲染循环；纯静态呈现，不参与
 *   省级 hover、不接收任何 hover / click 状态（CSS pointer-events: none，指针穿透到 3D 画布），
 *   也不反向修改 3D 相机 / 地形 / hover。
 *
 * 色阶复用（SPEC §9、验收「图例配色与地表 ramp 同源」）：
 * - 色条 color stop 与关键刻度的颜色 / 位置全部来自领域层 prepareElevationLegend，该函数对
 *   每个海拔调 sampleElevationColor（与地表片元着色器同一采样器）与 normalizeElevationToRampU
 *   （与 shader 片元归一化同一公式）派生。故「色条上某海拔的颜色」≡「地表真实海拔处的颜色」，
 *   单一事实源由自动化测试逐刻度断言。
 * - 本组件不接收任何 props（呈现常量全部来自配置层冻结常量），挂载即稳定呈现、不依赖 3D
 *   资产加载状态——色阶域是 elevation-color-ramp 的冻结常量（与 shader 经
 *   resolveElevationColorConfig 复核 meta 上下限所对照的同一域），图例无需等待 heightmap。
 *
 * 布局分区（SPEC §9「不遮挡主图核心区域（如左侧竖向贴边）」）：
 * - 图例固定在左侧竖向贴边、纵向居中（CSS .elevation-legend），不遮挡主图核心（中央地形），
 *   不与右下南海附图（.scs-inset）/ 左下合规角标（.compliance-badge，TASK-014）/ 底部居中
 *   入场提示（.entrance-loader--hint）重叠——垂直与水平方向均分离。
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
 * 挂载即稳定呈现（不依赖 3D 资产加载）。色条渐变与刻度颜色 / 位置全部从 TASK-006 色阶唯一
 * 事实源派生（prepareElevationLegend → sampleElevationColor / normalizeElevationToRampU），
 * 本组件不复制断点 / 颜色。
 */
export function ElevationLegend(): ReactNode {
  // 准备产物（色条 color stop + 关键刻度）。配置层冻结常量引用稳定，memo 只在挂载时计算一次。
  const legend = useMemo(() => prepareElevationLegend(), [])
  // 色条 CSS 渐变字符串：低海拔在底、高海拔在顶（to top），与读图直觉一致。
  const gradientCss = useMemo(
    () => buildElevationLegendBarGradientCss(legend.barStops),
    [legend.barStops],
  )

  const { barHeightPixels, barWidthPixels, caption, unitLabel, seaLevelLabel } =
    ELEVATION_LEGEND_CONFIG

  // 色条样式：CSS linear-gradient（颜色来自色阶唯一采样器）；几何尺寸来自配置层。
  const barStyle: CSSProperties = {
    height: `${barHeightPixels}px`,
    width: `${barWidthPixels}px`,
    background: gradientCss,
  }

  return (
    <div className="elevation-legend" role="img" aria-label="海拔色阶图例">
      <div className="elevation-legend-caption">{caption}</div>
      <div className="elevation-legend-body">
        <div className="elevation-legend-bar" style={barStyle} />
        {/*
          刻度列：每项含色块（该海拔颜色，来自色阶唯一采样器）+ 海拔数值 + 单位。
          positionFraction（0=色条底、1=色条顶）决定刻度纵向位置，与色条渐变同一归一化；
          刻度列高度随 flex 拉伸与色条一致，top 百分比相对该高度定位。
          0m 刻度附加「海平面」注释，使色条下方水下色段有读图含义（近岸浅、远海深，SPEC §3.5）。
        */}
        <ul className="elevation-legend-ticks">
          {legend.ticks.map((tick: LegendTick) => (
            <li
              key={tick.label}
              className="elevation-legend-tick"
              style={{ top: `${(1 - tick.positionFraction) * 100}%` }}
            >
              <span
                className="elevation-legend-tick-swatch"
                style={{ background: tick.colorHex }}
                aria-hidden="true"
              />
              <span className="elevation-legend-tick-value">
                {tick.label}
                {unitLabel}
              </span>
              {tick.elevationMeters === 0 && (
                <span className="elevation-legend-sea-level">{seaLevelLabel}</span>
              )}
            </li>
          ))}
        </ul>
      </div>
    </div>
  )
}
