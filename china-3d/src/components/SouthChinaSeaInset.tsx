/**
 * 南海诸岛 2D 标准附图的 SVG DOM overlay 渲染层（TASK-012，SPEC §3.8 / §5.4 / §6）。
 *
 * 角色与依赖方向：
 * - 本组件属于渲染层（src/components，DOM overlay 适配层），只负责「把领域层已准备好的十段线归一化
 *   视口折线（PreparedInsetLine[]）+ 岛礁点位归一化视口坐标与规范名称（PreparedInsetPoint[]）装配成一张
 *   SVG 矩形附图（边框 + 暖琥珀虚线十段线 + 暖琥珀岛礁光点 + 规范名称标注 + 图名）」。它只依赖：配置层
 *   （SOUTH_CHINA_SEA_INSET_CONFIG——四至 / viewBox / 样式 / 锚定阈值的唯一源）、领域层
 *   （prepareSouthChinaSeaInset + PreparedSouthChinaSeaInset 类型）、静态文案事实源 src/lib/static-copy
 *   （SOUTH_CHINA_SEA_INSET_TITLE——附图图名唯一来源，本组件不复制第二份）、React。禁止自行读取政治
 *   边界资产、复制投影 / 红线逻辑、或在组件内补写十段线 / 岛礁坐标（SPEC §5.4 单一事实源）。
 * - 本组件是 DOM overlay，挂在 3D Canvas 之外（SPEC §3.8「DOM overlay，非 3D」）：不 import 任何
 *   R3F / Three.js API、不注册任何帧循环，不进入 3D 渲染循环，不作为 3D mesh 嵌入场景；纯静态呈现，
 *   不参与省级 hover，不接收 hover / click 状态（CSS pointer-events: none，点击穿透到 3D 画布），
 *   也不反向修改 3D 相机 / 地形 / hover。
 *
 * 数据复用与子范围映射（SPEC §3.8「坐标用同一 geoMercator 投影的 2D 子范围」）：
 * - 十段线段序号、岛礁规范名称与坐标全部来自上层（App）已加载的同一份 PoliticalBoundaryContract
 *   （与主图 3D 政治要素层 PoliticalFeaturesLayer fetch 同一份 public/geo/china-political-boundary.json，
 *   模块级单例 Promise 去重）。本组件只接收 contract props，不重复取数、不复制坐标数组。
 * - (u,v) 视口坐标由领域层 prepareSouthChinaSeaInset 经 projectToInset（TASK-002 同一墨卡托投影的 2D
 *   子范围映射）得到，与主图共享同一墨卡托结果、仅视口映射不同。本组件把归一化 (u,v) 线性映射到
 *   SVG (x,y)：x = u · viewboxWidth，y = (1 − v) · viewboxHeight（v 向北递增 → SVG y 向下，故 1−v
 *   翻转；这是「子范围映射」的唯一视口换算，无第二套坐标）。
 *
 * 红线异常语义（SPEC §6「南海诸岛右下 2D 附图作为合规惯例存在」）：
 * - 准备期异常（红线缺项 / 投影失败 / 空契约）按 SPEC §6 红线上报整页错误（onPrepError，与 TASK-011
 *   主图政治要素准备失败同一暴露通道）——不沿用「console.error + 静默跳过」：静默缺失的附图会把
 *   「合规惯例附图不存在」伪装成「成功呈现」，正是 SPEC §6 红线禁止的静默残缺。正常合法资产下不触发
 *   （资产已过 TASK-004 契约 + 深度校验，且测试用生产资产跑通过全量准备）。
 * - 本组件如实呈现，不填审图号、不以任何视觉手段宣称已审图（页面级免责声明 / 审图号占位属 SPEC §8
 *   合规角标职责，由后续外围 UI 任务承载）。
 */

import { useEffect, useMemo } from 'react'
import type { ReactNode } from 'react'
import type { PoliticalBoundaryContract } from '../geo-contracts'
import { SOUTH_CHINA_SEA_INSET_CONFIG } from '../config/south-china-sea-inset'
import {
  prepareSouthChinaSeaInset,
  type PreparedInsetLine,
  type PreparedInsetPoint,
  type PreparedSouthChinaSeaInset,
} from '../lib/south-china-sea-inset'
import { SOUTH_CHINA_SEA_INSET_TITLE } from '../lib/static-copy'
import type { InsetViewportPoint } from '../lib/projection'

/** SouthChinaSeaInset 的 props：上层（App）传入与主图同源的已加载政治边界契约 + 红线错误上报通道。 */
export interface SouthChinaSeaInsetProps {
  /** 与主图 3D 政治要素层同源的 PoliticalBoundaryContract（TASK-004 共享事实源）。 */
  readonly contract: PoliticalBoundaryContract
  /** 准备期红线异常上报（App 的稳定 setState，按 SPEC §6 暴露为整页错误）。 */
  readonly onPrepError: (message: string) => void
}

/**
 * 把单段十段线的归一化视口 (u,v) 折线序列转换为 SVG polyline points 字符串。
 *
 * 子范围映射（唯一视口换算）：x = u · viewboxWidth，y = (1 − v) · viewboxHeight。v 向北递增，SVG y 向下，
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
 * 接收与主图同源的 PoliticalBoundaryContract，经 prepareSouthChinaSeaInset（领域层，红线完整性 + 同一
 * 墨卡托投影 2D 子范围）得到十段线归一化折线 + 岛礁点位 + 规范名称，再装配成 SVG 矩形附图。准备失败
 * 按 SPEC §6 红线上报整页错误并渲染 null（不静默显示残缺附图）。
 */
export function SouthChinaSeaInset({ contract, onPrepError }: SouthChinaSeaInsetProps): ReactNode {
  const extent = SOUTH_CHINA_SEA_INSET_CONFIG.extent

  // 显式判别联合：准备成功携带 inset，失败携带 error（供 useEffect 上报与渲染分支收窄）。
  // contract / extent 引用稳定（contract 由 App 的单例加载就绪后注入，extent 冻结），memo 在二者不变时
  // 不重算；本组件是 DOM overlay，不进入 3D 渲染循环，准备开销只在契约就绪时发生一次。
  const result = useMemo<
    | { readonly ok: true; readonly inset: PreparedSouthChinaSeaInset }
    | { readonly ok: false; readonly error: string }
  >(() => {
    try {
      return {
        ok: true,
        inset: prepareSouthChinaSeaInset(contract, extent, {
          viewboxWidth: SOUTH_CHINA_SEA_INSET_CONFIG.viewboxWidth,
          viewboxHeight: SOUTH_CHINA_SEA_INSET_CONFIG.viewboxHeight,
          labelFontSize: SOUTH_CHINA_SEA_INSET_CONFIG.labelFontSize,
          pointRadius: SOUTH_CHINA_SEA_INSET_CONFIG.pointRadius,
          labelOffsetX: SOUTH_CHINA_SEA_INSET_CONFIG.labelOffsetX,
          frameMargin: SOUTH_CHINA_SEA_INSET_CONFIG.frameStrokeWidth,
        }),
      }
    } catch (cause) {
      return { ok: false, error: cause instanceof Error ? cause.message : String(cause) }
    }
  }, [contract, extent])

  // 准备失败（红线缺段 / 缺点、投影失败、空契约）→ 上报整页错误（SPEC §6 红线，见模块头注释）；
  // onPrepError 是 App 的稳定 setState，同值重复上报幂等。
  useEffect(() => {
    if (!result.ok) onPrepError(result.error)
  }, [result, onPrepError])

  if (!result.ok) return null

  const { lines, points } = result.inset
  const W = SOUTH_CHINA_SEA_INSET_CONFIG.viewboxWidth
  const H = SOUTH_CHINA_SEA_INSET_CONFIG.viewboxHeight

  return (
    <div className="scs-inset" aria-label={`${SOUTH_CHINA_SEA_INSET_TITLE}附图`}>
      <div className="scs-inset-caption">{SOUTH_CHINA_SEA_INSET_TITLE}</div>
      <svg
        className="scs-inset-svg"
        viewBox={`0 0 ${W} ${H}`}
        preserveAspectRatio="xMidYMid meet"
        role="img"
        aria-label={`${SOUTH_CHINA_SEA_INSET_TITLE}十段线与岛礁点位`}
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
          十段线各段（暖琥珀虚线，与主图同一基线色事实源；按段独立 polyline 可逐段审计、台湾东侧段
          segmentIndex=10 可独立定位）。子范围映射由 uvPolylineToSvgPoints 完成（唯一视口换算）。
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
          岛礁点位（暖琥珀光点 + 规范名称标注）。规范名称与坐标全部来自同一份政治边界契约，不复制；
          标注摆放（右 / 左 / 上 / 下锚定）由领域准备层确定性裁决（框内且不互叠——钓鱼岛 / 赤尾屿
          这类同纬度相邻的贴东缘点位不会越框裁剪或互叠），本层只做坐标映射、零决策。
        */}
        {points.map((point: PreparedInsetPoint) => {
          const cx = point.u * W
          const cy = (1 - point.v) * H
          // 标注摆放（锚点 + 偏移）由领域准备层裁决（右 / 左 / 上 / 下，框内不互叠），此处纯映射。
          return (
            <g key={`island-${point.name}`}>
              <circle
                cx={cx}
                cy={cy}
                r={SOUTH_CHINA_SEA_INSET_CONFIG.pointRadius}
                fill={SOUTH_CHINA_SEA_INSET_CONFIG.pointFillHex}
              />
              <text
                x={cx + point.labelDx}
                y={cy + point.labelDy}
                fill={SOUTH_CHINA_SEA_INSET_CONFIG.labelFillHex}
                fontSize={SOUTH_CHINA_SEA_INSET_CONFIG.labelFontSize}
                textAnchor={point.labelAnchor}
              >
                {point.name}
              </text>
            </g>
          )
        })}
      </svg>
    </div>
  )
}
