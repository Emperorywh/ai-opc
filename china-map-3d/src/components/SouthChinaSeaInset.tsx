/**
 * 南海诸岛 2D 标准附图的 SVG DOM overlay 渲染层（TASK-019，SPEC §3.8 / §5.4）。
 *
 * 角色与依赖方向：
 * - 本组件属于渲染层（src/components，DOM overlay 适配层），只负责「把领域层已准备好的十段线归一化
 *   视口折线（PreparedInsetLine[]）+ 岛礁点位归一化视口坐标与规范名称（PreparedInsetPoint[]）装配成一张
 *   SVG 矩形附图（边框 + 暖琥珀虚线十段线 + 暖琥珀岛礁光点 + 规范名称标注 + 图名 + 非审图免责声明）」。
 *   它只依赖：配置层（SOUTH_CHINA_SEA_INSET_CONFIG —— 四至 / viewBox / 样式 / 文案的唯一源）、领域层
 *   （prepareSouthChinaSeaInset + PreparedSouthChinaSeaInset 类型）、React。禁止自行读取政治边界资产、
 *   复制投影 / 红线逻辑、或在组件内补写十段线 / 岛礁坐标（TASK-019 实现约束「不得反向修改领域资产」
 *   「禁止复制一份专用十段线、岛礁或名称数组」「不得作为 3D mesh 嵌入场景」）。
 * - 本组件是 DOM overlay，挂在 3D Canvas 之外的 .china-map-overlay 内（SPEC §3.8「DOM overlay，非 3D」，
 *   TASK-019 输出约束「右下角 DOM overlay 形式的 2D 矩形附图...不得作为 3D mesh 嵌入场景」）。它不参与
 *   省级 hover（TASK-019 实现约束「不要求附图参与省级 hover」），不接收任何 hover / click 状态，纯静态
 *   呈现；也不反向修改 3D 相机 / 地形 / hover（TASK-019 实现约束「不得反向修改 3D 相机、地形、hover 或
 *   领域资产」）。
 *
 * 数据复用与子范围映射（TASK-019 实现约束「主图与附图数据、投影单一事实源」）：
 * - 十段线段序号、岛礁规范名称与坐标全部来自上层（ChinaMapScreen）已加载的同一份 PoliticalBoundaryContract
 *   （与主图 3D 政治要素层 PoliticalFeaturesLayer fetch 同一份 public/geo/china-political-boundary.json）。
 *   本组件只接收 contract props，不重复取数、不复制坐标数组。
 * - (u,v) 视口坐标由领域层 prepareSouthChinaSeaInset 经 projectToInset（TASK-007 同一墨卡托投影）得到，
 *   与主图共享同一墨卡托结果、仅视口映射不同。本组件把归一化 (u,v) 线性映射到 SVG (x,y)：
 *     x = u * viewboxWidth，y = (1 − v) * viewboxHeight
 *   （v 向北递增 → SVG y 向下，故 1−v 翻转；这是「子范围映射」的唯一视口换算，无第二套坐标）。
 *
 * 非官方审图限制（SPEC §6 / §8 / §13、TASK-019 实现约束「本 TASK 不声称获得审图号，仍只能内部展示」）：
 * - 附图如实标注「非官方审图数据，仅供内部展示」（文案来自配置层 disclaimer，与政治边界补充事实源的
 *   provenance disclaimer 一致），不填审图号、不以任何视觉手段宣称已审图。正式发布由 TASK-021 的合规
 *   状态与外部审图流程约束。
 * - 准备期异常（红线缺项 / 投影失败 / 空契约）被捕获、console.error 记录后渲染 null——不崩溃页面
 *   （主 3D 图完整保留，符合 TASK-019 回退边界「回退本 TASK 只会移除右下 2D 附图」）。
 */

import { useMemo } from 'react'
import type { ReactNode } from 'react'
import type { PoliticalBoundaryContract } from '../geo-contracts'
import { SOUTH_CHINA_SEA_INSET_CONFIG } from '../config/south-china-sea-inset'
import {
  prepareSouthChinaSeaInset,
  type PreparedInsetLine,
  type PreparedInsetPoint,
} from '../lib/south-china-sea-inset'
import type { InsetViewportPoint } from '../lib/projection'

/** SouthChinaSeaInset 的 props：上层（ChinaMapScreen）传入与主图同源的已加载政治边界契约。 */
export interface SouthChinaSeaInsetProps {
  /** 与主图 3D 政治要素层同源的 PoliticalBoundaryContract（TASK-006 共享事实源）。 */
  readonly contract: PoliticalBoundaryContract
}

/**
 * 把单段十段线的归一化视口 (u,v) 折线序列转换为 SVG polyline points 字符串。
 *
 * 子范围映射（唯一视口换算）：x = u * viewboxWidth，y = (1 − v) * viewboxHeight。v 向北递增，SVG y 向下，
 * 故对 v 取 1− 翻转。保留两位小数足够 SVG 渲染精度，避免过长 points 字符串。
 */
function uvPolylineToSvgPoints(
  polyline: readonly InsetViewportPoint[],
  viewboxWidth: number,
  viewboxHeight: number,
): string {
  return polyline
    .map((point) => {
      const x = point.u * viewboxWidth
      const y = (1 - point.v) * viewboxHeight
      return `${x.toFixed(2)},${y.toFixed(2)}`
    })
    .join(' ')
}

/**
 * 南海诸岛 2D 标准附图（右下角 SVG DOM overlay）。
 *
 * 接收与主图同源的 PoliticalBoundaryContract，经 prepareSouthChinaSeaInset（领域层，红线完整性 + 同一墨卡托
 * 投影）得到十段线归一化折线 + 岛礁点位 + 规范名称，再装配成 SVG 矩形附图。准备失败时渲染 null（主 3D 图
 * 不受影响）。
 */
export function SouthChinaSeaInset({ contract }: SouthChinaSeaInsetProps): ReactNode {
  const extent = SOUTH_CHINA_SEA_INSET_CONFIG.extent

  // 准备期异常（红线缺项 / 投影失败 / 空契约）被捕获、console 记录后渲染 null——不崩溃页面。
  // contract / extent 引用稳定（contract 由 ChinaMapScreen 的 usePoliticalBoundary 就绪后注入，extent 冻结），
  // 故 memo 在二者不变时不重算。
  const result = useMemo(() => {
    try {
      return { ok: true as const, inset: prepareSouthChinaSeaInset(contract, extent) }
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause)
      // eslint-disable-next-line no-console
      console.error(`[SouthChinaSeaInset] 南海附图准备失败：${message}`)
      return { ok: false as const }
    }
  }, [contract, extent])

  if (!result.ok) return null

  const { lines, points } = result.inset
  const W = SOUTH_CHINA_SEA_INSET_CONFIG.viewboxWidth
  const H = SOUTH_CHINA_SEA_INSET_CONFIG.viewboxHeight

  return (
    <div className="china-map-inset" aria-label="南海诸岛附图（非官方审图数据，仅供内部展示）">
      <div className="china-map-inset-caption">{SOUTH_CHINA_SEA_INSET_CONFIG.caption}</div>
      <svg
        className="china-map-inset-svg"
        viewBox={`0 0 ${W} ${H}`}
        preserveAspectRatio="xMidYMid meet"
        role="img"
        aria-label="南海诸岛十段线与岛礁点位"
      >
        {/* 矩形边框：勾勒「标准南海诸岛附图」的矩形构图（SPEC §3.8「2D 矩形附图」）。 */}
        <rect
          x={SOUTH_CHINA_SEA_INSET_CONFIG.frameStrokeWidth / 2}
          y={SOUTH_CHINA_SEA_INSET_CONFIG.frameStrokeWidth / 2}
          width={W - SOUTH_CHINA_SEA_INSET_CONFIG.frameStrokeWidth}
          height={H - SOUTH_CHINA_SEA_INSET_CONFIG.frameStrokeWidth}
          fill="none"
          stroke={SOUTH_CHINA_SEA_INSET_CONFIG.frameStrokeHex}
          strokeWidth={SOUTH_CHINA_SEA_INSET_CONFIG.frameStrokeWidth}
        />
        {/*
          十段线各段（暖琥珀虚线，与主图同色；按段独立 polyline 可逐段审计、台湾东侧段 segmentIndex=10 可
          独立定位）。子范围映射由 uvPolylineToSvgPoints 完成（唯一视口换算）。
        */}
        {lines.map((line: PreparedInsetLine) => (
          <polyline
            key={`dash-${line.segmentIndex}`}
            points={uvPolylineToSvgPoints(line.uvPolyline, W, H)}
            fill="none"
            stroke={SOUTH_CHINA_SEA_INSET_CONFIG.lineColorHex}
            strokeWidth={SOUTH_CHINA_SEA_INSET_CONFIG.lineStrokeWidth}
            strokeDasharray={SOUTH_CHINA_SEA_INSET_CONFIG.lineDash}
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        ))}
        {/*
          岛礁点位（暖琥珀光点 + 规范名称标注）。规范名称与坐标全部来自同一份政治边界契约，不复制。
        */}
        {points.map((point: PreparedInsetPoint) => {
          const cx = point.u * W
          const cy = (1 - point.v) * H
          return (
            <g key={`island-${point.name}`}>
              <circle
                cx={cx}
                cy={cy}
                r={SOUTH_CHINA_SEA_INSET_CONFIG.pointRadius}
                fill={SOUTH_CHINA_SEA_INSET_CONFIG.pointFillHex}
              />
              <text
                x={cx + SOUTH_CHINA_SEA_INSET_CONFIG.pointRadius + SOUTH_CHINA_SEA_INSET_CONFIG.labelOffsetX}
                y={cy + SOUTH_CHINA_SEA_INSET_CONFIG.labelFontSize / 3}
                fill={SOUTH_CHINA_SEA_INSET_CONFIG.labelFillHex}
                fontSize={SOUTH_CHINA_SEA_INSET_CONFIG.labelFontSize}
              >
                {point.name}
              </text>
            </g>
          )
        })}
      </svg>
      <div className="china-map-inset-disclaimer">{SOUTH_CHINA_SEA_INSET_CONFIG.disclaimer}</div>
    </div>
  )
}
