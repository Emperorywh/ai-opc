/**
 * 合规角标的数据准备（领域层，TASK-021，SPEC §8 / §6）。
 *
 * 角色与依赖方向：
 * - 本模块属于运行时访问层（src/lib），把「来源注册表契约（DataSourceRegistryContract，TASK-001 共享事实源，
 *   由 src/lib/data-source-registry 从 public/geo/data-sources.json 加载）」确定性地变换为「审图号占位 +
 *   审图状态 + 三类必备来源署名 + 完整免责声明」，供渲染层（src/components/ui/ComplianceBadge 的 DOM overlay）
 *   只消费、不再计算。
 * - 单向依赖：配置层 src/config/compliance-badge（审图号占位 / 状态 / 免责声明 / 必备来源类别文案与样式）、
 *   契约层 src/geo-contracts（DataSourceRegistryContract / DataSourceDeclaration / DataSourceKind 类型）。禁止依赖
 *   React / R3F / Three.js / DOM / 资产 / 场景 / 交互状态——本模块是纯函数，可在 Node 环境完整断言「审图号占位
 *   为未送审形态、三类必备来源齐全、免责声明完整」（TASK-021 验证方式 2）。合规角标**只消费**来源注册表与
 *   审图状态，不反向控制资产、场景或交互（TASK-021 实现约束）。
 *
 * 来源单一事实源——不复制来源名称 / 免责声明（SPEC §8「数据源署名」、TASK-021 实现约束「合规角标只消费
 *   来源 / 审图状态」）：
 * - 三类必备来源（DEM / 行政区边界 / 政治边界补充）的展示名称直接取自来源注册表对应条目的 name 字段，
 *   不在角标配置 / 组件里硬编码「Copernicus DEM」「DataV.GeoAtlas」等字面量。来源注册表新增 / 修订来源时，
 *   角标自动跟随——无第二套来源清单（与 scripts/verify-assets 各 scope 读取的生产注册表同一份资产）。
 * - 来源条目的 isOfficialSurvey / disclaimer 同样取自注册表：当前全部来源 isOfficialSurvey=false（非官方审图），
 *   角标据此如实呈现「非官方」属性，不伪造官方审图来源。
 *
 * 审图状态——不得伪装已审图（SPEC §8、TASK-021 实现约束「不得以占位审图号暗示已经审图」）：
 * - 审图号占位与审图状态文字取自配置层（COMPLIANCE_AUDIT_NUMBER_PLACEHOLDER / COMPLIANCE_AUDIT_NUMBER_STATUS），
 *   占位为字面 `GS(202x)xxxx 号`（含占位字母 x，非已批复号码），状态文字显式标注「未取得审图号 · 仅内部展示」。
 *   本模块不生成 / 伪造审图号；取得真实审图号后由外部审图流程更新配置层常量。
 *
 * 发布限制——免责声明不得缺失（SPEC §8、TASK-021 实现约束「不得删除『非官方、仅内部展示、不得正式发布』
 *   的限制」）：
 * - 完整免责声明取自配置层 COMPLIANCE_DISCLAIMER（与 TASK-021 输出要求逐字一致）。准备层把它作为产物的
 *   必有字段返回，渲染层在角标底部完整呈现。取得真实审图号前该限制不得删除。
 *
 * 必备来源校验——缺任一类即失败（TASK-021 验证方式 2「DEM、边界、项目补充数据三类署名……均存在；缺少
 *   任一项时失败」）：
 * - 准备入口对来源注册表做硬校验：COMPLIANCE_REQUIRED_SOURCE_KINDS 的每一类（digitalElevationModel /
 *   administrativeBoundary / politicalBoundarySupplement）必须各至少一条来源，缺任一类即抛
 *   compliance-badge.required-source-kind-missing，绝不静默显示缺来源的角标（缺来源的角标会把「未署名某类
 *   数据」伪装成「成功署名」，违反 SPEC §8）。
 */

import type {
  DataSourceDeclaration,
  DataSourceKind,
  DataSourceRegistryContract,
} from '../geo-contracts'
import { COMPLIANCE_BADGE_CONFIG } from '../config/compliance-badge'

/** 来源类别的展示名（用于角标分组标题，按必备类别映射）。 */
const SOURCE_KIND_DISPLAY_NAME: Readonly<Record<DataSourceKind, string>> = Object.freeze({
  digitalElevationModel: '数字高程模型（DEM）',
  administrativeBoundary: '行政区边界',
  politicalBoundarySupplement: '政治边界补充（十段线 / 岛礁 / 争议区）',
  placeGazetteer: '地名目录',
})

/**
 * 准备好的单条来源署名（角标渲染层直接消费）。
 *
 * 名称 / 非官方属性全部来自来源注册表条目，不复制字面量。kindDisplayName 为该类别的中文展示名（分组用）。
 */
export interface PreparedComplianceAttribution {
  /** 来源类别（来自注册表 kind 字段）。 */
  readonly kind: DataSourceKind
  /** 来源类别的中文展示名（分组标题，按 SOURCE_KIND_DISPLAY_NAME 映射）。 */
  readonly kindDisplayName: string
  /** 来源展示名称（直接取自注册表 name 字段，不复制字面量）。 */
  readonly name: string
  /** 是否官方审图数据（直接取自注册表 isOfficialSurvey 字段；当前全部为 false）。 */
  readonly isOfficialSurvey: boolean
}

/** 准备好的合规角标全部内容（渲染层 DOM overlay 直接消费的稳定产物）。 */
export interface PreparedComplianceBadge {
  /** 审图号占位（未送审形态，字面 `GS(202x)xxxx 号`，含占位字母 x）。 */
  readonly auditNumberPlaceholder: string
  /** 审图状态文字（显式标注「未取得审图号 · 仅内部展示」）。 */
  readonly auditNumberStatus: string
  /** 完整免责声明（发布限制三重门：非官方 / 仅内部 / 不得正式发布）。 */
  readonly disclaimer: string
  /** 来源署名列表（三类必备来源齐全，按必备类别顺序优先、其后其它类别）。 */
  readonly attributions: readonly PreparedComplianceAttribution[]
}

/** 准备失败的稳定错误码（供自动化测试精确断言「缺必备来源类别 → 角标准备明确失败」）。 */
export type ComplianceBadgePrepFailureCode =
  | 'compliance-badge.required-source-kind-missing'
  | 'compliance-badge.empty-registry'

/**
 * 合规角标准备错误：携带稳定 code 与简体中文说明。
 * 来源注册表缺必备类别或为空时抛出，使整条准备明确失败、不产出缺来源的角标（TASK-021 验证方式 2）。
 */
export class ComplianceBadgePrepError extends Error {
  readonly code: ComplianceBadgePrepFailureCode
  constructor(code: ComplianceBadgePrepFailureCode, message: string) {
    super(message)
    this.name = 'ComplianceBadgePrepError'
    this.code = code
  }
}

/**
 * 把来源注册表条目派生为角标署名（只取展示所需字段，不复制名称字面量）。
 */
function toAttribution(source: DataSourceDeclaration): PreparedComplianceAttribution {
  return {
    kind: source.kind,
    kindDisplayName: SOURCE_KIND_DISPLAY_NAME[source.kind],
    name: source.name,
    isOfficialSurvey: source.isOfficialSurvey,
  }
}

/**
 * 把数据来源注册表确定性地准备为合规角标内容（审图号占位 + 状态 + 三类必备来源署名 + 完整免责声明）。
 *
 * 流水线：
 * 1. 入参校验：注册表 sources 非空（空注册表 → empty-registry）。
 * 2. 必备来源校验：COMPLIANCE_REQUIRED_SOURCE_KINDS 的每一类各至少一条来源，缺任一类 →
 *    required-source-kind-missing（绝不静默显示缺来源的角标）。
 * 3. 来源署名：按「必备类别顺序优先、其后其它类别（如 placeGazetteer）」输出，每条只取展示所需字段，
 *    名称 / 非官方属性全部来自注册表条目（不复制字面量）。
 * 4. 审图号占位 / 状态 / 免责声明：直接取自配置层冻结常量（未送审形态 + 完整发布限制）。
 *
 * @param registry 数据来源注册表契约（TASK-001 共享事实源，已通过 data-source-registry 契约校验）。
 * @returns 审图号占位 + 状态 + 三类必备来源署名 + 完整免责声明（渲染层 DOM overlay 直接消费）。
 * @throws {ComplianceBadgePrepError} 注册表为空或缺必备来源类别时。
 */
export function prepareComplianceBadge(registry: DataSourceRegistryContract): PreparedComplianceBadge {
  if (registry.sources.length === 0) {
    throw new ComplianceBadgePrepError(
      'compliance-badge.empty-registry',
      '合规角标准备需要至少一条来源声明，实际来源注册表 sources 为空。',
    )
  }

  // 必备来源类别校验：每类各至少一条来源，缺任一类即抛错（TASK-021 验证方式 2）。
  const presentKinds = new Set(registry.sources.map((source) => source.kind))
  for (const requiredKind of COMPLIANCE_BADGE_CONFIG.requiredSourceKinds) {
    if (!presentKinds.has(requiredKind)) {
      throw new ComplianceBadgePrepError(
        'compliance-badge.required-source-kind-missing',
        `合规角标必须覆盖来源类别「${requiredKind}」，但来源注册表中缺失该类来源——拒绝准备缺来源的角标。`,
      )
    }
  }

  // 来源署名：必备类别按配置顺序优先输出，其后追加其它类别（如地点目录），透明署名、不遗漏。
  const requiredOrder = COMPLIANCE_BADGE_CONFIG.requiredSourceKinds
  const attributions: PreparedComplianceAttribution[] = []
  const consumed = new Set<string>()
  // 先按必备类别顺序收集（同类别多条来源按注册表出现顺序）。
  for (const kind of requiredOrder) {
    for (const source of registry.sources) {
      if (source.kind === kind) {
        attributions.push(toAttribution(source))
        consumed.add(source.id)
      }
    }
  }
  // 再收集非必备类别来源（透明署名：注册表中还有哪些来源，角标一并呈现）。
  for (const source of registry.sources) {
    if (!consumed.has(source.id)) {
      attributions.push(toAttribution(source))
      consumed.add(source.id)
    }
  }

  return {
    auditNumberPlaceholder: COMPLIANCE_BADGE_CONFIG.auditNumberPlaceholder,
    auditNumberStatus: COMPLIANCE_BADGE_CONFIG.auditNumberStatus,
    disclaimer: COMPLIANCE_BADGE_CONFIG.disclaimer,
    attributions,
  }
}
