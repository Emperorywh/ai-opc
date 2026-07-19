/**
 * 合规角标准备层测试（TASK-021 验证方式 2）。
 *
 * 依赖方向：测试基线（vitest，Node 环境），import src/lib/compliance-badge（合规角标准备层）、
 * src/config/compliance-badge（审图号 / 状态 / 免责声明 / 必备来源类别常量）、src/geo-contracts
 * （validateDataSourceRegistry 契约校验 + DataSourceRegistryContract 类型）。不依赖浏览器 / React / Three.js
 * ——准备层是纯函数，可在 Node 内完整断言「审图号占位为未送审形态」「三类必备来源署名齐全」「完整免责声明
 * 存在」「缺必备来源类别时明确失败」（TASK-021 验证方式 2）。
 *
 * 覆盖（TASK-021 验证方式 2、完成标准「没有虚假审图号、发布限制缺失」）：
 * - 审图号占位：字面 GS(202x)xxxx 号（含占位字母 x，非已批复号码）；状态文字显式标注「未取得」。
 * - 免责声明：与 TASK-021 输出要求逐字一致（非官方 / 仅内部 / 不得正式发布三重门）。
 * - 来源单一事实源：对生产 public/geo/data-sources.json 准备角标，三类必备来源
 *   （DEM / 行政区边界 / 政治边界补充）齐全，名称取自注册表（不复制字面量）。
 * - 失败路径：注册表缺必备来源类别 → required-source-kind-missing；空注册表 → empty-registry。
 */

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  prepareComplianceBadge,
  ComplianceBadgePrepError,
} from '../src/lib/compliance-badge'
import {
  COMPLIANCE_AUDIT_NUMBER_PLACEHOLDER,
  COMPLIANCE_AUDIT_NUMBER_STATUS,
  COMPLIANCE_BADGE_CONFIG,
  COMPLIANCE_DISCLAIMER,
  COMPLIANCE_REQUIRED_SOURCE_KINDS,
} from '../src/config/compliance-badge'
import { validateDataSourceRegistry } from '../src/geo-contracts'
import type { DataSourceRegistryContract } from '../src/geo-contracts'

const projectRoot = resolve(fileURLToPath(import.meta.url), '..', '..')

/** 加载生产来源注册表并经契约校验，返回 DataSourceRegistryContract。 */
function loadProductionRegistry(): DataSourceRegistryContract {
  const assetPath = resolve(projectRoot, 'public', 'geo', 'data-sources.json')
  const payload: unknown = JSON.parse(readFileSync(assetPath, 'utf-8'))
  const outcome = validateDataSourceRegistry(payload)
  expect(outcome.ok, '生产来源注册表应通过 data-source-registry 契约校验').toBe(true)
  return payload as DataSourceRegistryContract
}

/** 深拷贝生产注册表，避免篡改污染。 */
function cloneRegistry(registry: DataSourceRegistryContract): DataSourceRegistryContract {
  return JSON.parse(JSON.stringify(registry)) as DataSourceRegistryContract
}

describe('审图号占位：未送审形态，不伪装已批复（TASK-021 实现约束「不得以占位审图号暗示已经审图」）', () => {
  it('审图号占位为字面 GS(202x)xxxx 号（含占位字母 x，非具体年号 / 编号）', () => {
    // 含 202x（年号含占位 x）与 xxxx（编号全占位 x）——任何把它读作真实审图号的解读都与字面矛盾。
    expect(COMPLIANCE_AUDIT_NUMBER_PLACEHOLDER).toBe('GS(202x)xxxx 号')
    expect(COMPLIANCE_AUDIT_NUMBER_PLACEHOLDER).toContain('202x')
    expect(COMPLIANCE_AUDIT_NUMBER_PLACEHOLDER).toContain('xxxx')
  })

  it('审图状态文字显式标注「未取得审图号 · 仅内部展示」', () => {
    expect(COMPLIANCE_AUDIT_NUMBER_STATUS).toContain('未取得')
    expect(COMPLIANCE_AUDIT_NUMBER_STATUS).toContain('内部展示')
  })

  it('准备产物如实携带未送审审图号占位与状态', () => {
    const badge = prepareComplianceBadge(loadProductionRegistry())
    expect(badge.auditNumberPlaceholder).toBe(COMPLIANCE_AUDIT_NUMBER_PLACEHOLDER)
    expect(badge.auditNumberStatus).toBe(COMPLIANCE_AUDIT_NUMBER_STATUS)
  })
})

describe('完整免责声明：发布限制三重门不得缺失（TASK-021 实现约束「不得删除非官方/仅内部/不得正式发布限制」）', () => {
  it('免责声明与 TASK-021 输出要求逐字一致', () => {
    expect(COMPLIANCE_DISCLAIMER).toBe(
      '本图边界数据为非官方审图数据，仅供内部展示，不得作为正式出版 / 发布用途',
    )
  })

  it('免责声明含三重限制：非官方 / 仅内部展示 / 不得正式发布', () => {
    expect(COMPLIANCE_DISCLAIMER).toContain('非官方')
    expect(COMPLIANCE_DISCLAIMER).toContain('内部展示')
    expect(COMPLIANCE_DISCLAIMER).toContain('不得')
    expect(COMPLIANCE_DISCLAIMER).toContain('发布')
  })

  it('准备产物携带完整免责声明', () => {
    const badge = prepareComplianceBadge(loadProductionRegistry())
    expect(badge.disclaimer).toBe(COMPLIANCE_DISCLAIMER)
  })
})

describe('三类必备来源署名齐全（TASK-021 验证方式 2「DEM、边界、项目补充数据三类署名均存在」）', () => {
  it('配置声明三类必备来源类别：DEM / 行政区边界 / 政治边界补充', () => {
    expect(COMPLIANCE_REQUIRED_SOURCE_KINDS).toStrictEqual([
      'digitalElevationModel',
      'administrativeBoundary',
      'politicalBoundarySupplement',
    ])
  })

  it('对生产注册表准备角标，三类必备来源各至少一条', () => {
    const badge = prepareComplianceBadge(loadProductionRegistry())
    const presentKinds = new Set(badge.attributions.map((a) => a.kind))
    for (const kind of COMPLIANCE_REQUIRED_SOURCE_KINDS) {
      expect(presentKinds.has(kind), `必备来源类别 ${kind} 应在角标署名中`).toBe(true)
    }
  })

  it('来源名称取自注册表条目（不复制字面量）：DEM = 生产 DEM 来源名、边界 = DataV、政治补充 = 项目自补', () => {
    const registry = loadProductionRegistry()
    const badge = prepareComplianceBadge(registry)
    // 每条署名的 name 必须能在注册表中找到对应条目（证明名称派生自注册表，非硬编码）。
    const registryNames = new Set(registry.sources.map((s) => s.name))
    for (const attr of badge.attributions) {
      expect(registryNames.has(attr.name), `署名「${attr.name}」应来自来源注册表`).toBe(true)
    }
    // 三类必备来源各自的注册表条目名出现在角标署名中。
    const badgeNames = badge.attributions.map((a) => a.name)
    const demSource = registry.sources.find((s) => s.kind === 'digitalElevationModel')!
    const boundarySource = registry.sources.find((s) => s.kind === 'administrativeBoundary')!
    const politicalSource = registry.sources.find((s) => s.kind === 'politicalBoundarySupplement')!
    expect(badgeNames).toContain(demSource.name)
    expect(badgeNames).toContain(boundarySource.name)
    expect(badgeNames).toContain(politicalSource.name)
  })

  it('非官方来源如实标注 isOfficialSurvey=false（当前全部来源非官方审图）', () => {
    const badge = prepareComplianceBadge(loadProductionRegistry())
    for (const attr of badge.attributions) {
      expect(attr.isOfficialSurvey, `来源「${attr.name}」应为非官方审图`).toBe(false)
    }
  })

  it('必备来源按配置顺序优先输出（DEM / 边界 / 政治补充在前）', () => {
    const badge = prepareComplianceBadge(loadProductionRegistry())
    const kinds = badge.attributions.map((a) => a.kind)
    const firstDem = kinds.indexOf('digitalElevationModel')
    const firstBoundary = kinds.indexOf('administrativeBoundary')
    const firstPolitical = kinds.indexOf('politicalBoundarySupplement')
    expect(firstDem).toBeGreaterThanOrEqual(0)
    expect(firstBoundary).toBeGreaterThan(firstDem)
    expect(firstPolitical).toBeGreaterThan(firstBoundary)
  })
})

describe('缺必备来源类别 / 空注册表 → 角标准备明确失败（TASK-021 验证方式 2「缺少任一项时失败」）', () => {
  it('删除 DEM 来源 → required-source-kind-missing', () => {
    const registry = cloneRegistry(loadProductionRegistry())
    registry.sources = registry.sources.filter((s) => s.kind !== 'digitalElevationModel')
    try {
      prepareComplianceBadge(registry)
      expect.unreachable('缺 DEM 来源应阻断角标准备')
    } catch (e) {
      expect((e as ComplianceBadgePrepError).code).toBe('compliance-badge.required-source-kind-missing')
      expect((e as Error).message).toContain('digitalElevationModel')
    }
  })

  it('删除行政区边界来源 → required-source-kind-missing', () => {
    const registry = cloneRegistry(loadProductionRegistry())
    registry.sources = registry.sources.filter((s) => s.kind !== 'administrativeBoundary')
    try {
      prepareComplianceBadge(registry)
      expect.unreachable('缺行政区边界来源应阻断角标准备')
    } catch (e) {
      expect((e as ComplianceBadgePrepError).code).toBe('compliance-badge.required-source-kind-missing')
    }
  })

  it('删除政治边界补充来源 → required-source-kind-missing', () => {
    const registry = cloneRegistry(loadProductionRegistry())
    registry.sources = registry.sources.filter((s) => s.kind !== 'politicalBoundarySupplement')
    try {
      prepareComplianceBadge(registry)
      expect.unreachable('缺政治边界补充来源应阻断角标准备')
    } catch (e) {
      expect((e as ComplianceBadgePrepError).code).toBe('compliance-badge.required-source-kind-missing')
    }
  })

  it('空注册表 → empty-registry', () => {
    const registry = cloneRegistry(loadProductionRegistry())
    registry.sources = []
    try {
      prepareComplianceBadge(registry)
      expect.unreachable('空注册表应阻断角标准备')
    } catch (e) {
      expect((e as ComplianceBadgePrepError).code).toBe('compliance-badge.empty-registry')
    }
  })
})

describe('配置不变量：审图 / 来源 / 样式常量有限非空、配置冻结', () => {
  it('审图号 / 状态 / 免责声明 / 标签 / 路径非空', () => {
    expect(COMPLIANCE_BADGE_CONFIG.auditNumberPlaceholder.length).toBeGreaterThan(0)
    expect(COMPLIANCE_BADGE_CONFIG.auditNumberStatus.length).toBeGreaterThan(0)
    expect(COMPLIANCE_BADGE_CONFIG.disclaimer.length).toBeGreaterThan(0)
    expect(COMPLIANCE_BADGE_CONFIG.caption.length).toBeGreaterThan(0)
    expect(COMPLIANCE_BADGE_CONFIG.auditNumberLabel.length).toBeGreaterThan(0)
    expect(COMPLIANCE_BADGE_CONFIG.sourcesLabel.length).toBeGreaterThan(0)
    expect(COMPLIANCE_BADGE_CONFIG.dataSourcesPath.length).toBeGreaterThan(0)
  })

  it('样式字号为正有限、必备来源类别冻结', () => {
    expect(COMPLIANCE_BADGE_CONFIG.fontSizePx).toBeGreaterThan(0)
    expect(COMPLIANCE_BADGE_CONFIG.captionFontSizePx).toBeGreaterThan(0)
    expect(COMPLIANCE_BADGE_CONFIG.disclaimerFontSizePx).toBeGreaterThan(0)
    expect(COMPLIANCE_BADGE_CONFIG.panelMaxWidthPx).toBeGreaterThan(0)
    expect(Object.isFrozen(COMPLIANCE_BADGE_CONFIG)).toBe(true)
    expect(Object.isFrozen(COMPLIANCE_REQUIRED_SOURCE_KINDS)).toBe(true)
  })
})
