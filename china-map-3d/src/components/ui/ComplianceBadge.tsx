/**
 * 合规角标的 DOM overlay 渲染层（TASK-021，SPEC §8 / §6）。
 *
 * 角色与依赖方向：
 * - 本组件属于 DOM overlay 层（src/components/ui），独立于 3D 画布。它只负责「把领域层已准备好的审图号占位 +
 *   审图状态 + 三类必备来源署名 + 完整免责声明装配成一块低调角标」。它只依赖：配置层
 *   （COMPLIANCE_BADGE_CONFIG —— 审图号 / 状态 / 免责声明 / 样式的唯一源）、领域层（prepareComplianceBadge +
 *   PreparedComplianceBadge 类型）、契约层（DataSourceRegistryContract 类型）、React。禁止自行读取来源资产、
 *   复制来源名称 / 免责声明、或在组件内补写审图号（TASK-021 实现约束「合规角标只消费来源 / 审图状态，
 *   不得反向控制资产、场景或交互」「不得以占位审图号暗示已经审图」「不得删除『非官方、仅内部展示、
 *   不得正式发布』的限制」）。
 * - 本组件是 DOM overlay，挂在 3D Canvas 之外的 .china-map-overlay 内（SPEC §8「角标式」）。它不参与省级
 *   hover、不接收任何 hover / click 状态，纯静态呈现；也不反向修改 3D 相机 / 地形 / hover / 资产
 *   （TASK-021 实现约束「只消费，不反向控制」）。
 *
 * 审图状态——未送审、仅内部展示（SPEC §8「发布前必须取得审图号」、TASK-021 实现约束）：
 * - 审图号占位为字面 `GS(202x)xxxx 号`（含占位字母 x，非已批复号码），状态文字显式标注「未取得审图号 ·
 *   仅内部展示」。本组件如实呈现该未审图状态，不伪造已审图视觉（如不打绿勾、不写「已通过审图」）。
 *   取得真实审图号后由外部审图流程更新配置层常量，本组件随之呈现真实号码。
 *
 * 来源单一事实源——不复制来源名称（SPEC §8「数据源署名」、TASK-021 实现约束）：
 * - 三类必备来源（DEM / 行政区边界 / 政治边界补充）的展示名称直接取自领域层 prepareComplianceBadge 从来源
 *   注册表派生的 attributions（注册表条目 name 字段），本组件不硬编码「Copernicus DEM」「DataV.GeoAtlas」
 *   等字面量。注册表新增 / 修订来源时角标自动跟随，无第二套来源清单。
 *
 * 布局分区（SPEC §8「低调角标」「右下 / 左下」、TASK-021 实现约束「必须同时避让主图核心和右下附图」）：
 * - 角标固定在左下角（CSS .china-map-compliance），低调半透明面板。不遮挡主图核心（中央地形）、不与右下
 *   南海附图（.china-map-inset）冲突、不与左侧竖向图例（.china-map-legend，纵向居中）重叠——图例在
 *   左侧纵向居中、角标在左下角，垂直方向分离。
 */

import { useMemo } from 'react'
import type { CSSProperties, ReactNode } from 'react'
import type { DataSourceRegistryContract } from '../../geo-contracts'
import { COMPLIANCE_BADGE_CONFIG } from '../../config/compliance-badge'
import {
  prepareComplianceBadge,
  type PreparedComplianceAttribution,
} from '../../lib/compliance-badge'

/** ComplianceBadge 的 props：上层（ChinaMapScreen）传入已加载并经契约校验的来源注册表。 */
export interface ComplianceBadgeProps {
  /** 与各资产 provenance 同源的数据来源注册表（TASK-001 共享事实源）。 */
  readonly registry: DataSourceRegistryContract
}

/**
 * 合规角标（左下角低调 DOM overlay）：审图号占位 + 状态 + 三类必备来源署名 + 完整免责声明。
 *
 * 来源注册表就绪后挂载。审图号 / 状态 / 免责声明 / 来源署名全部从配置层 + 领域层派生，本组件不复制
 * 来源名称、不伪造审图号、不删除发布限制。
 */
export function ComplianceBadge({ registry }: ComplianceBadgeProps): ReactNode {
  // 准备产物（审图号占位 + 状态 + 来源署名 + 免责声明）。registry 引用稳定（ChinaMapScreen 就绪后注入），
  // 故 memo 在 registry 不变时不重算。准备失败（缺必备来源类别）抛错——由上层在挂载期暴露，绝不静默
  // 显示缺来源的角标。
  const badge = useMemo(() => prepareComplianceBadge(registry), [registry])

  const {
    caption,
    auditNumberLabel,
    sourcesLabel,
    textHex,
    captionHex,
    fontSizePx,
    captionFontSizePx,
    disclaimerFontSizePx,
    panelBgRgba,
    panelStrokeHex,
    panelStrokeWidthPx,
    panelMaxWidthPx,
  } = COMPLIANCE_BADGE_CONFIG

  const panelStyle: CSSProperties = {
    background: panelBgRgba,
    border: `${panelStrokeWidthPx}px solid ${panelStrokeHex}`,
    maxWidth: `${panelMaxWidthPx}px`,
    color: textHex,
    fontSize: `${fontSizePx}px`,
  }

  return (
    <div className="china-map-compliance" style={panelStyle} role="contentinfo" aria-label="审图号与数据来源角标">
      <div
        className="china-map-compliance-caption"
        style={{ color: captionHex, fontSize: `${captionFontSizePx}px` }}
      >
        {caption}
      </div>
      {/*
        审图号占位（未送审形态）：字面 GS(202x)xxxx 号 + 状态文字「未取得审图号 · 仅内部展示」。
        不打绿勾、不写「已通过」——如实呈现未审图状态（SPEC §8、TASK-021 实现约束「不得以占位审图号
        暗示已经审图」）。
      */}
      <div className="china-map-compliance-row">
        <span className="china-map-compliance-label">{auditNumberLabel}</span>
        <span className="china-map-compliance-audit">{badge.auditNumberPlaceholder}</span>
        <span className="china-map-compliance-status">{badge.auditNumberStatus}</span>
      </div>
      {/*
        来源署名：名称全部取自来源注册表（经领域层 prepareComplianceBadge 派生），不复制字面量。
        三类必备来源（DEM / 行政区边界 / 政治边界补充）齐全；非官方来源如实标注「非官方」。
      */}
      <div className="china-map-compliance-row china-map-compliance-sources">
        <span className="china-map-compliance-label">{sourcesLabel}</span>
        <ul className="china-map-compliance-source-list">
          {badge.attributions.map((attr: PreparedComplianceAttribution) => (
            <li key={`${attr.kind}:${attr.name}`} className="china-map-compliance-source">
              <span className="china-map-compliance-source-name">{attr.name}</span>
              {!attr.isOfficialSurvey && (
                <span className="china-map-compliance-source-unofficial">非官方</span>
              )}
            </li>
          ))}
        </ul>
      </div>
      {/*
        完整免责声明（发布限制三重门：非官方 / 仅内部 / 不得正式发布）。
        取得真实审图号前不得删除（SPEC §8、TASK-021 实现约束「不得删除『非官方、仅内部展示、不得正式发布』
        的限制」）。
      */}
      <div
        className="china-map-compliance-disclaimer"
        style={{ fontSize: `${disclaimerFontSizePx}px` }}
      >
        {badge.disclaimer}
      </div>
    </div>
  )
}
