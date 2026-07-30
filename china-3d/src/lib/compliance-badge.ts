/**
 * 合规角标的数据准备（领域层，TASK-014，SPEC §8 / §6）。
 *
 * 角色与依赖方向：
 * - 本模块属于运行时领域层（src/lib），把「来源注册表契约（DataSourceRegistryContract，
 *   TASK-004 共享事实源，由 src/lib/data-source-registry 从 public/geo/data-sources.json
 *   加载并经契约校验）」确定性地变换为「审图号占位 + 必备来源署名 + 完整免责声明」，供渲染层
 *   （src/components/ui/ComplianceBadge 的 DOM overlay）只消费、不再计算。
 * - 单向依赖：配置层 src/config/compliance-badge（必备来源类别策略 + 非官方标注文案）、
 *   静态文案事实源 src/lib/static-copy（§8 法定合规文案：审图号标签 / 占位 / 署名引导词 /
 *   免责声明——逐字受测试保护，已注册进字体子集）、契约层 src/geo-contracts
 *   （DataSourceRegistryContract / DataSourceDeclaration / DataSourceKind 类型）。禁止依赖
 *   React / R3F / Three.js / DOM / 资产 / 场景 / 交互状态——本模块是纯函数，可在 Node 环境
 *   完整断言「审图号占位为未送审形态、三类必备来源齐全、免责声明完整」。合规角标**只消费**
 *   来源注册表与静态文案，不反向控制资产、场景或交互。
 *
 * 来源单一事实源——不复制来源名称（SPEC §8「数据源署名」）：
 * - 三类必备来源（DEM / 行政区边界 / 政治边界补充）的展示名称直接取自来源注册表对应条目的
 *   name 字段，不在角标配置 / 组件 / 静态文案里硬编码来源名（生产 DEM 为 ETOPO1——以注册表
 *   为准）。注册表新增 / 修订来源时角标自动跟随，无第二套来源清单（与 scripts/verify-assets
 *   各 scope 读取的生产注册表同一份资产）。
 * - 来源条目的 isOfficialSurvey 同样取自注册表：当前全部来源 isOfficialSurvey=false（非官方
 *   审图），角标据此如实附加「非官方」标注，不伪造官方审图来源。
 *
 * 审图状态——不得伪装已审图（SPEC §8）：
 * - 审图号占位取自 static-copy 的 COMPLIANCE_REVIEW_NUMBER_PLACEHOLDER（字面
 *   `GS(202x)xxxx 号（待取得）`，含占位字符 x 与「待取得」状态标注，非已批复号码）。本模块
 *   不生成 / 伪造审图号；取得真实审图号后由外部审图流程更新 static-copy 常量。
 *
 * 发布限制——免责声明不得缺失（SPEC §8）：
 * - 完整免责声明取自 static-copy 的 COMPLIANCE_DISCLAIMER（与 SPEC §8 原文逐字一致，受
 *   tests/label-font.test.ts 逐字断言保护）。准备层把它作为产物的必有字段返回，渲染层在
 *   角标底部完整呈现；取得真实审图号前不得删除。
 *
 * 必备来源校验——缺任一类即失败：
 * - 准备入口对来源注册表做硬校验：COMPLIANCE_REQUIRED_SOURCE_KINDS 的每一类
 *   （digitalElevationModel / administrativeBoundary / politicalBoundarySupplement）必须各
 *   至少一条来源，缺任一类即抛 compliance-badge.required-source-kind-missing，绝不静默显示
 *   缺来源的角标（缺来源的角标会把「未署名某类数据」伪装成「成功署名」，违反 SPEC §8）。
 */

import type {
  DataSourceDeclaration,
  DataSourceKind,
  DataSourceRegistryContract,
} from '../geo-contracts'
import { COMPLIANCE_BADGE_CONFIG } from '../config/compliance-badge'
import {
  COMPLIANCE_ATTRIBUTION_LEAD,
  COMPLIANCE_DISCLAIMER,
  COMPLIANCE_REVIEW_NUMBER_LABEL,
  COMPLIANCE_REVIEW_NUMBER_PLACEHOLDER,
} from './static-copy'

/** 来源类别的展示名（角标分组用，按来源类别映射；纯 DOM 界面文案）。 */
const SOURCE_KIND_DISPLAY_NAME: Readonly<Record<DataSourceKind, string>> = Object.freeze({
  digitalElevationModel: '数字高程模型（DEM）',
  administrativeBoundary: '行政区边界',
  politicalBoundarySupplement: '政治边界补充（十段线 / 岛礁 / 争议区）',
  placeGazetteer: '地名目录',
})

/**
 * 准备好的单条来源署名（角标渲染层直接消费）。
 * 名称 / 非官方属性全部来自来源注册表条目，不复制字面量；kindDisplayName 为该类别中文展示名。
 */
export interface PreparedComplianceAttribution {
  /** 来源类别（来自注册表 kind 字段）。 */
  readonly kind: DataSourceKind
  /** 来源类别的中文展示名（按 SOURCE_KIND_DISPLAY_NAME 映射）。 */
  readonly kindDisplayName: string
  /** 来源展示名称（直接取自注册表 name 字段，不复制字面量）。 */
  readonly name: string
  /** 是否官方审图数据（直接取自注册表 isOfficialSurvey 字段；当前全部为 false）。 */
  readonly isOfficialSurvey: boolean
}

/** 准备好的合规角标全部内容（渲染层 DOM overlay 直接消费的稳定产物）。 */
export interface PreparedComplianceBadge {
  /** 审图号字段标签（static-copy：「审图号」）。 */
  readonly reviewNumberLabel: string
  /** 审图号占位（未送审形态，字面 `GS(202x)xxxx 号（待取得）`，含占位字符 x）。 */
  readonly reviewNumberPlaceholder: string
  /** 数据源署名引导词（static-copy：「数据来源」）。 */
  readonly attributionLead: string
  /** 完整免责声明（SPEC §8 原文：非官方 / 仅内部 / 不得正式出版发布三重限制）。 */
  readonly disclaimer: string
  /** 非官方来源标注文案（配置层：「非官方」）。 */
  readonly unofficialSourceLabel: string
  /** 来源署名列表（三类必备来源齐全，按必备类别顺序优先、其后其它类别）。 */
  readonly attributions: readonly PreparedComplianceAttribution[]
}

/** 准备失败的稳定错误码（供自动化测试精确断言「缺必备来源类别 → 角标准备明确失败」）。 */
export type ComplianceBadgePrepFailureCode =
  | 'compliance-badge.required-source-kind-missing'
  | 'compliance-badge.empty-registry'

/**
 * 合规角标准备错误：携带稳定 code 与简体中文说明。
 * 来源注册表缺必备类别或为空时抛出，使整条准备明确失败、不产出缺来源的角标。
 */
export class ComplianceBadgePrepError extends Error {
  readonly code: ComplianceBadgePrepFailureCode
  constructor(code: ComplianceBadgePrepFailureCode, message: string) {
    super(message)
    this.name = 'ComplianceBadgePrepError'
    this.code = code
  }
}

/** 把来源注册表条目派生为角标署名（只取展示所需字段，不复制名称字面量）。 */
function toAttribution(source: DataSourceDeclaration): PreparedComplianceAttribution {
  return {
    kind: source.kind,
    kindDisplayName: SOURCE_KIND_DISPLAY_NAME[source.kind],
    name: source.name,
    isOfficialSurvey: source.isOfficialSurvey,
  }
}

/**
 * 把数据来源注册表确定性地准备为合规角标内容（审图号占位 + 必备来源署名 + 完整免责声明）。
 *
 * 流水线：
 * 1. 入参校验：注册表 sources 非空（空注册表 → empty-registry）。
 * 2. 必备来源校验：COMPLIANCE_REQUIRED_SOURCE_KINDS 的每一类各至少一条来源，缺任一类 →
 *    required-source-kind-missing（绝不静默显示缺来源的角标）。
 * 3. 来源署名：按「必备类别顺序优先、其后其它类别（如 placeGazetteer）」输出，每条只取展示
 *    所需字段，名称 / 非官方属性全部来自注册表条目（不复制字面量）。
 * 4. 审图号标签 / 占位 / 署名引导词 / 免责声明：直接取自 static-copy 冻结常量（未送审形态 +
 *    完整发布限制）；非官方标注取自配置层。
 *
 * @param registry 数据来源注册表契约（TASK-004 共享事实源，已经 data-source-registry 契约校验）。
 * @returns 审图号占位 + 必备来源署名 + 完整免责声明（渲染层 DOM overlay 直接消费）。
 * @throws {ComplianceBadgePrepError} 注册表为空或缺必备来源类别时。
 */
export function prepareComplianceBadge(
  registry: DataSourceRegistryContract,
): PreparedComplianceBadge {
  if (registry.sources.length === 0) {
    throw new ComplianceBadgePrepError(
      'compliance-badge.empty-registry',
      '合规角标准备需要至少一条来源声明，实际来源注册表 sources 为空。',
    )
  }

  // 必备来源类别校验：每类各至少一条来源，缺任一类即抛错（绝不静默显示缺来源的角标）。
  const presentKinds = new Set(registry.sources.map((source) => source.kind))
  for (const requiredKind of COMPLIANCE_BADGE_CONFIG.requiredSourceKinds) {
    if (!presentKinds.has(requiredKind)) {
      throw new ComplianceBadgePrepError(
        'compliance-badge.required-source-kind-missing',
        `合规角标必须覆盖来源类别「${requiredKind}」，但来源注册表中缺失该类来源——拒绝准备缺来源的角标。`,
      )
    }
  }

  // 来源署名：必备类别按配置顺序优先输出，其后追加其它类别（透明署名、不遗漏）。
  const attributions: PreparedComplianceAttribution[] = []
  const consumed = new Set<string>()
  for (const kind of COMPLIANCE_BADGE_CONFIG.requiredSourceKinds) {
    for (const source of registry.sources) {
      if (source.kind === kind) {
        attributions.push(toAttribution(source))
        consumed.add(source.id)
      }
    }
  }
  for (const source of registry.sources) {
    if (!consumed.has(source.id)) {
      attributions.push(toAttribution(source))
      consumed.add(source.id)
    }
  }

  return {
    reviewNumberLabel: COMPLIANCE_REVIEW_NUMBER_LABEL,
    reviewNumberPlaceholder: COMPLIANCE_REVIEW_NUMBER_PLACEHOLDER,
    attributionLead: COMPLIANCE_ATTRIBUTION_LEAD,
    disclaimer: COMPLIANCE_DISCLAIMER,
    unofficialSourceLabel: COMPLIANCE_BADGE_CONFIG.unofficialSourceLabel,
    attributions,
  }
}
