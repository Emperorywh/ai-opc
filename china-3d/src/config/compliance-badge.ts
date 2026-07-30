/**
 * 合规角标配置——审图来源覆盖策略与角标呈现常量的唯一事实源（TASK-014，SPEC §8 / §6）。
 *
 * 角色与依赖方向：
 * - 本模块属于运行时配置层（src/config），只承载「合规角标展示所需的呈现与策略常量」：必须
 *   覆盖的数据来源类别、非官方来源标注文案。**审图号占位 / 免责声明等 §8 法定合规文案不在
 *   本模块**——其唯一事实源是 src/lib/static-copy（逐字受测试保护、已注册进字体子集），由
 *   角标准备层（src/lib/compliance-badge）消费。**数据来源署名的具体名称也不在本模块**——
 *   来源详情唯一来自 public/geo/data-sources.json 来源注册表（TASK-004 来源声明契约），
 *   本模块只声明「角标必须覆盖哪几类来源」，准备层从注册表派生具体署名，绝不复制来源
 *   名称 / 免责声明字面量。
 * - 单向依赖：本模块只依赖契约层 src/geo-contracts（DataSourceKind 类型），不依赖 React /
 *   R3F / Three.js / DOM，故自动化测试可在 Node 环境断言「必须覆盖的来源类别齐全、配置冻结、
 *   无来源名称字面量」。
 *
 * 审图状态——不得伪装已审图（SPEC §8「发布前由审图流程填入」、SPEC §6 红线「程序生成 /
 * 拼装的地图公开发布前依法须送审」）：
 * - 当前页面未取得自然资源主管部门审图号（见 docs/political-review-record.md §4）。审图号
 *   占位文案取自 static-copy 的 COMPLIANCE_REVIEW_NUMBER_PLACEHOLDER——字面
 *   `GS(202x)xxxx 号（待取得）`：`202x` 的 `x` 与 `xxxx` 均为占位字符（非已批复年号 / 编号），
 *   「待取得」显式标注未审图状态，任何「已批复」的解读都与字面矛盾。取得真实审图号后由外部
 *   审图流程替换该常量——本模块与准备层都不生成 / 伪造号码。
 *
 * 来源类别覆盖（SPEC §8「标注 DEM…、边界…、九段线/岛礁…来源」）：
 * - 角标必须覆盖三类来源：数字高程模型（digitalElevationModel，TASK-003 ETOPO1 DEM）、
 *   行政区边界（administrativeBoundary，TASK-004 DataV 省级边界）、政治边界补充
 *   （politicalBoundarySupplement，TASK-004 项目自补十段线 / 岛礁 / 争议区修正）。来源注册表
 *   还可能含其它类别（如地名目录 placeGazetteer），角标一并展示（透明署名），但「三类必备」
 *   是准备层硬校验的下限——缺任一类即抛错，绝不静默显示缺来源的角标。
 */

import type { DataSourceKind } from '../geo-contracts'

/**
 * 合规角标必须覆盖的数据来源类别（SPEC §8 三类来源署名：DEM / 边界 / 九段线补全）。
 *
 * 准备层对来源注册表做硬校验：这三类必须各至少一条来源，缺任一类即抛
 * compliance-badge.required-source-kind-missing，绝不静默显示缺来源的角标。
 */
export const COMPLIANCE_REQUIRED_SOURCE_KINDS: readonly DataSourceKind[] = Object.freeze([
  'digitalElevationModel',
  'administrativeBoundary',
  'politicalBoundarySupplement',
])

/**
 * 非官方来源的角标标注（SPEC §8「非官方」属性呈现）。
 *
 * 来源注册表中 isOfficialSurvey=false 的条目在角标上附此标注，如实呈现非官方审图属性——
 * 不伪造官方审图来源。当前生产注册表全部来源均为非官方审图数据。
 */
export const COMPLIANCE_UNOFFICIAL_SOURCE_LABEL = '非官方'

/** 合规角标全部呈现与策略参数（冻结）。准备层读取必备来源类别与非官方标注文案。 */
export const COMPLIANCE_BADGE_CONFIG = Object.freeze({
  /** 角标必须覆盖的来源类别（缺任一类准备即失败）。 */
  requiredSourceKinds: COMPLIANCE_REQUIRED_SOURCE_KINDS,
  /** 非官方来源标注文案。 */
  unofficialSourceLabel: COMPLIANCE_UNOFFICIAL_SOURCE_LABEL,
})
