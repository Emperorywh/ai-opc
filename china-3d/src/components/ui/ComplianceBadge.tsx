/**
 * 合规角标的 DOM overlay 渲染层（TASK-014，SPEC §8 / §6）。
 *
 * 角色与依赖方向：
 * - 本组件属于 DOM overlay 层（src/components/ui），独立于 3D 画布。它只负责「把领域层已准备
 *   好的审图号占位 + 必备来源署名 + 完整免责声明装配成一块低调角标」。它只依赖：领域层
 *   （prepareComplianceBadge + PreparedComplianceBadge 类型——审图号 / 署名 / 免责声明全部
 *   由其从 static-copy 法定文案与来源注册表派生）、契约层（DataSourceRegistryContract 类型）、
 *   React。禁止自行读取来源资产、复制来源名称 / 免责声明字面量、或在组件内补写审图号。
 * - 本组件是 DOM overlay，挂在 3D Canvas 之外（与 TASK-012 附图、TASK-013 Loader 同层）：
 *   不 import 任何 R3F / Three.js API、不注册帧循环、不进入 3D 渲染循环；纯静态呈现，不参与
 *   省级 hover、不接收 hover / click 状态（CSS pointer-events: none，指针穿透到 3D 画布），
 *   也不反向修改 3D 相机 / 地形 / hover / 资产。
 *
 * 审图状态——未送审、仅内部展示（SPEC §8「发布前由审图流程填入」）：
 * - 审图号占位为字面 `GS(202x)xxxx 号（待取得）`（含占位字符 x 与「待取得」状态标注，非已
 *   批复号码）。本组件如实呈现该未审图状态，不伪造已审图视觉（不打勾、不写「已通过审图」）。
 *   取得真实审图号后由外部审图流程更新 static-copy 常量，本组件随之呈现真实号码。
 *
 * 来源单一事实源——不复制来源名称（SPEC §8「数据源署名」）：
 * - 必备来源（DEM / 行政区边界 / 政治边界补充）的展示名称直接取自领域层
 *   prepareComplianceBadge 从来源注册表派生的 attributions（注册表条目 name 字段），本组件
 *   不硬编码来源名字面量。注册表新增 / 修订来源时角标自动跟随，无第二套来源清单。
 *
 * 布局分区（SPEC §8「低调角标」「如右下 / 左下」、「不做成完整底部栏」）：
 * - 角标固定在左下角（CSS .compliance-badge），低调半透明面板、限宽不横贯底部。不遮挡主图
 *   核心（中央地形）、不与右下南海附图（.scs-inset）冲突、不与左侧竖向图例
 *   （.elevation-legend，纵向居中）重叠——图例在左侧纵向居中、角标在左下角，垂直方向分离。
 */

import { useMemo } from 'react'
import type { ReactNode } from 'react'
import type { DataSourceRegistryContract } from '../../geo-contracts'
import {
  prepareComplianceBadge,
  type PreparedComplianceAttribution,
} from '../../lib/compliance-badge'

/** ComplianceBadge 的 props：上层（App）传入已加载并经契约校验的来源注册表。 */
export interface ComplianceBadgeProps {
  /** 与各资产 provenance 同源的数据来源注册表（TASK-004 共享事实源）。 */
  readonly registry: DataSourceRegistryContract
}

/**
 * 合规角标（左下角低调 DOM overlay）：审图号占位 + 必备来源署名 + 完整免责声明。
 *
 * 来源注册表就绪后挂载。审图号 / 署名 / 免责声明全部从领域准备层派生（static-copy 法定文案
 * + 来源注册表），本组件不复制来源名称、不伪造审图号、不删除发布限制。准备失败（缺必备
 * 来源类别）抛错——由上层在挂载期暴露，绝不静默显示缺来源的角标。
 */
export function ComplianceBadge({ registry }: ComplianceBadgeProps): ReactNode {
  // 准备产物（审图号占位 + 来源署名 + 免责声明）。registry 引用稳定（App 单例加载就绪后注入），
  // memo 只在 registry 就绪时计算一次。
  const badge = useMemo(() => prepareComplianceBadge(registry), [registry])

  return (
    <div className="compliance-badge" role="contentinfo" aria-label="审图号与数据来源角标">
      {/*
        审图号占位（未送审形态）：字面 GS(202x)xxxx 号（待取得）。不打勾、不写「已通过」——
        如实呈现未审图状态（SPEC §8「不得以占位暗示已经审图」）。
      */}
      <div className="compliance-badge-row">
        <span className="compliance-badge-label">{badge.reviewNumberLabel}</span>
        <span className="compliance-badge-audit">{badge.reviewNumberPlaceholder}</span>
      </div>
      {/*
        来源署名：名称全部取自来源注册表（经领域层 prepareComplianceBadge 派生），不复制字面量。
        三类必备来源（DEM / 行政区边界 / 政治边界补充）齐全；非官方来源如实标注「非官方」。
      */}
      <div className="compliance-badge-row compliance-badge-sources">
        <span className="compliance-badge-label">{badge.attributionLead}</span>
        <ul className="compliance-badge-source-list">
          {badge.attributions.map((attr: PreparedComplianceAttribution) => (
            <li key={`${attr.kind}:${attr.name}`} className="compliance-badge-source">
              <span className="compliance-badge-source-kind">{attr.kindDisplayName}</span>
              <span className="compliance-badge-source-name">{attr.name}</span>
              {!attr.isOfficialSurvey && (
                <span className="compliance-badge-source-unofficial">
                  {badge.unofficialSourceLabel}
                </span>
              )}
            </li>
          ))}
        </ul>
      </div>
      {/*
        完整免责声明（SPEC §8 原文：非官方 / 仅内部 / 不得正式出版发布三重限制）。
        取得真实审图号前不得删除。
      */}
      <div className="compliance-badge-disclaimer">{badge.disclaimer}</div>
    </div>
  )
}
