/**
 * 合规角标测试（TASK-014，SPEC §8 / §6）。
 *
 * 覆盖验收条件 2、3、4：
 * - 验收 2「审图号占位角标（GS(202x)xxxx 号样式）存在」：准备产物审图号占位以
 *   `GS(202x)xxxx 号` 起首（含占位字符 x 与「待取得」状态标注，非已批复号码），且与
 *   static-copy 的 COMPLIANCE_REVIEW_NUMBER_PLACEHOLDER 是同一引用（单一事实源）。
 * - 验收 3「数据源署名角标内容来自 data-sources.json（DEM/边界/九段线补全来源）并含
 *   「非官方审图数据，仅供内部展示」免责声明」：以生产注册表（public/geo/data-sources.json）
 *   逐条断言署名名称 / 非官方属性全部来自注册表条目（不复制字面量）；三类必备来源
 *   （digitalElevationModel / administrativeBoundary / politicalBoundarySupplement）齐全；
 *   免责声明逐字等于 SPEC §8 原文（static-copy 单一事实源）。
 * - 验收 4「角标低调叠加不成完整底部栏」：样式源码扫描锁定左下角限宽面板（max-width、
 *   无 right:0 / width:100% 全宽形态）、半透明深色 + 发光描边、指针穿透。
 * - 失败语义：空注册表 / 缺任一必备来源类别 → 稳定错误码，绝不产出缺来源的角标。
 * - 单一事实源源码扫描：组件 / 配置 / 领域层均无来源名称与免责声明字面量；static-copy 收集器
 *   不含来源名称字面量（来源名称只存在于注册表资产）。
 *
 * 依赖方向：测试基线（vitest，Node 环境），读生产注册表资产 + import src/ 领域层纯函数 +
 * 读源码文本扫描。运行时视觉验收另有有界无头验证覆盖。
 */

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  validateDataSourceRegistry,
  type DataSourceDeclaration,
  type DataSourceRegistryContract,
} from '../src/geo-contracts'
import { COMPLIANCE_BADGE_CONFIG } from '../src/config/compliance-badge'
import {
  ComplianceBadgePrepError,
  prepareComplianceBadge,
} from '../src/lib/compliance-badge'
import {
  COMPLIANCE_ATTRIBUTION_LEAD,
  COMPLIANCE_DISCLAIMER,
  COMPLIANCE_REVIEW_NUMBER_LABEL,
  COMPLIANCE_REVIEW_NUMBER_PLACEHOLDER,
  collectStaticCopyStrings,
} from '../src/lib/static-copy'

const projectRoot = resolve(fileURLToPath(import.meta.url), '..', '..')

/** 读取 src 下某个源码文件文本（源码扫描用）。 */
function readSource(relativePath: string): string {
  return readFileSync(resolve(projectRoot, 'src', relativePath), 'utf-8')
}

/**
 * 剥除注释后的代码文本（字面量扫描用）：先剥块注释（含 JSX 的 {/* *\/}），再剥整行 // 注释。
 * 文档注释可以提及占位格式 / 来源示例（设计说明），字面量扫描只针对代码本体——与仓库既有
 * 「引号包裹字面量」扫描惯例同义（不允许第二份可执行展示文案副本）。
 */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((line) => !/^\s*\/\//.test(line))
    .join('\n')
}

/** 生产来源注册表（与运行时 fetch 的 public/geo/data-sources.json 同一份），已过契约校验。 */
function loadProductionRegistry(): DataSourceRegistryContract {
  const payload: unknown = JSON.parse(
    readFileSync(resolve(projectRoot, 'public', 'geo', 'data-sources.json'), 'utf-8'),
  )
  const outcome = validateDataSourceRegistry(payload)
  expect(outcome.ok).toBe(true)
  return payload as DataSourceRegistryContract
}

/** 构造一条来源声明（缺省值为最小合法非官方来源）。 */
function makeSource(overrides: Partial<DataSourceDeclaration>): DataSourceDeclaration {
  return {
    id: 'src-test',
    name: '测试来源',
    originUrl: 'offline://test',
    kind: 'digitalElevationModel',
    isOfficialSurvey: false,
    version: 'v1',
    license: '内部',
    disclaimer: '非官方审图数据，仅供内部展示。',
    ...overrides,
  }
}

/** 构造一个来源注册表（kind / version 合法）。 */
function makeRegistry(sources: readonly DataSourceDeclaration[]): DataSourceRegistryContract {
  return { kind: 'data-source-registry', version: '1.0.0', sources }
}

/** 生产注册表中按类别取来源名称（断言角标名称与注册表逐字一致用）。 */
function productionNamesByKind(kind: DataSourceDeclaration['kind']): readonly string[] {
  return loadProductionRegistry()
    .sources.filter((source) => source.kind === kind)
    .map((source) => source.name)
}

describe('合规角标准备（生产注册表，SPEC §8 署名内容）', () => {
  it('三类必备来源（DEM / 行政区边界 / 政治边界补充）齐全且按必备顺序优先，地名目录随后', () => {
    const badge = prepareComplianceBadge(loadProductionRegistry())
    expect(badge.attributions.map((attr) => attr.kind)).toEqual([
      'digitalElevationModel',
      'administrativeBoundary',
      'politicalBoundarySupplement',
      'placeGazetteer',
    ])
  })

  it('署名名称逐字来自注册表条目（DEM=ETOPO1 / 边界=DataV / 九段线补全=项目自补，不复制字面量）', () => {
    const badge = prepareComplianceBadge(loadProductionRegistry())
    expect(badge.attributions.map((attr) => attr.name)).toEqual([
      ...productionNamesByKind('digitalElevationModel'),
      ...productionNamesByKind('administrativeBoundary'),
      ...productionNamesByKind('politicalBoundarySupplement'),
      ...productionNamesByKind('placeGazetteer'),
    ])
    // 生产事实锚点：DEM 署名确为 ETOPO1（非 SPEC §8 举例的 Copernicus），边界为 DataV.GeoAtlas。
    expect(badge.attributions[0].name).toContain('ETOPO1')
    expect(badge.attributions[1].name).toContain('DataV.GeoAtlas')
    expect(badge.attributions[2].name).toContain('九段线')
  })

  it('每条署名携带类别展示名与非官方属性（生产注册表全部 isOfficialSurvey=false）', () => {
    const badge = prepareComplianceBadge(loadProductionRegistry())
    for (const attr of badge.attributions) {
      expect(attr.kindDisplayName.length).toBeGreaterThan(0)
      expect(attr.isOfficialSurvey).toBe(false)
    }
    expect(badge.attributions[0].kindDisplayName).toContain('DEM')
    expect(badge.unofficialSourceLabel).toBe('非官方')
  })

  it('审图号占位为 GS(202x)xxxx 号样式（未送审形态），与 static-copy 同一引用', () => {
    const badge = prepareComplianceBadge(loadProductionRegistry())
    expect(badge.reviewNumberPlaceholder.startsWith('GS(202x)xxxx 号')).toBe(true)
    expect(badge.reviewNumberPlaceholder).toBe(COMPLIANCE_REVIEW_NUMBER_PLACEHOLDER)
    // 不伪装已批复：含「待取得」状态标注，不含任何真实年份 / 编号形态。
    expect(badge.reviewNumberPlaceholder).toContain('待取得')
    expect(badge.reviewNumberPlaceholder).not.toMatch(/GS\(20[0-9]{2}\)[0-9]+/)
  })

  it('免责声明逐字等于 SPEC §8 原文（含「非官方审图数据，仅供内部展示」与发布限制）', () => {
    const badge = prepareComplianceBadge(loadProductionRegistry())
    expect(badge.disclaimer).toBe(COMPLIANCE_DISCLAIMER)
    expect(badge.disclaimer).toBe(
      '本图边界数据为非官方审图数据，仅供内部展示，不得作为正式出版/发布用途',
    )
    expect(badge.disclaimer).toContain('非官方审图数据')
    expect(badge.disclaimer).toContain('仅供内部展示')
  })

  it('审图号标签与署名引导词来自 static-copy 单一事实源', () => {
    const badge = prepareComplianceBadge(loadProductionRegistry())
    expect(badge.reviewNumberLabel).toBe(COMPLIANCE_REVIEW_NUMBER_LABEL)
    expect(badge.reviewNumberLabel).toBe('审图号')
    expect(badge.attributionLead).toBe(COMPLIANCE_ATTRIBUTION_LEAD)
    expect(badge.attributionLead).toBe('数据来源')
  })
})

describe('合规角标准备（合成注册表：顺序与失败语义）', () => {
  const dem = makeSource({ id: 'src-dem', kind: 'digitalElevationModel', name: '合成 DEM' })
  const admin = makeSource({ id: 'src-admin', kind: 'administrativeBoundary', name: '合成边界' })
  const political = makeSource({
    id: 'src-political',
    kind: 'politicalBoundarySupplement',
    name: '合成政治补充',
  })
  const gazetteer = makeSource({ id: 'src-places', kind: 'placeGazetteer', name: '合成地名' })

  it('必备类别按配置顺序优先输出，其它类别（地名目录）随后——与注册表出现顺序无关', () => {
    const badge = prepareComplianceBadge(makeRegistry([gazetteer, political, admin, dem]))
    expect(badge.attributions.map((attr) => attr.name)).toEqual([
      '合成 DEM',
      '合成边界',
      '合成政治补充',
      '合成地名',
    ])
  })

  it('官方来源不附加非官方标注语义（isOfficialSurvey 如实透传）', () => {
    const official = makeSource({
      id: 'src-official',
      kind: 'placeGazetteer',
      name: '合成官方来源',
      isOfficialSurvey: true,
    })
    const badge = prepareComplianceBadge(makeRegistry([dem, admin, political, official]))
    const officialAttr = badge.attributions.find((attr) => attr.name === '合成官方来源')
    expect(officialAttr?.isOfficialSurvey).toBe(true)
  })

  it('空注册表 → compliance-badge.empty-registry', () => {
    let caught: unknown
    try {
      prepareComplianceBadge(makeRegistry([]))
    } catch (e) {
      caught = e
    }
    expect(caught).toBeInstanceOf(ComplianceBadgePrepError)
    expect((caught as ComplianceBadgePrepError).code).toBe('compliance-badge.empty-registry')
  })

  it.each([
    ['digitalElevationModel', [admin, political]],
    ['administrativeBoundary', [dem, political]],
    ['politicalBoundarySupplement', [dem, admin]],
  ] as const)('缺必备类别 %s → required-source-kind-missing（绝不产出缺来源的角标）', (missing, kept) => {
    let caught: unknown
    try {
      prepareComplianceBadge(makeRegistry(kept))
    } catch (e) {
      caught = e
    }
    expect(caught).toBeInstanceOf(ComplianceBadgePrepError)
    expect((caught as ComplianceBadgePrepError).code).toBe(
      'compliance-badge.required-source-kind-missing',
    )
    expect((caught as ComplianceBadgePrepError).message).toContain(missing)
  })
})

describe('合规角标单一事实源与低调布局结构不变量（源码扫描）', () => {
  it('组件 / 配置 / 领域层均无来源名称字面量（名称只存在于注册表资产）', () => {
    for (const path of [
      'components/ui/ComplianceBadge.tsx',
      'config/compliance-badge.ts',
      'lib/compliance-badge.ts',
    ]) {
      const code = stripComments(readSource(path))
      expect(code).not.toContain('ETOPO1')
      expect(code).not.toContain('DataV')
      expect(code).not.toContain('NOAA')
      expect(code).not.toContain('Copernicus')
    }
  })

  it('static-copy 收集器不含来源名称字面量（署名名称由运行时注册表派生，不维护第二份清单）', () => {
    const copy = collectStaticCopyStrings()
    for (const text of copy) {
      expect(text).not.toContain('ETOPO1')
      expect(text).not.toContain('Copernicus')
      expect(text).not.toContain('DataV')
    }
  })

  it('免责声明与审图号占位字面量只存在于 static-copy（组件 / 配置 / 领域层不复制）', () => {
    for (const path of [
      'components/ui/ComplianceBadge.tsx',
      'config/compliance-badge.ts',
      'lib/compliance-badge.ts',
    ]) {
      const code = stripComments(readSource(path))
      expect(code).not.toContain('本图边界数据为非官方审图数据')
      expect(code).not.toContain('GS(202x)')
    }
    // 领域层从 static-copy 取法定文案（单一事实源）。
    const lib = readSource('lib/compliance-badge.ts')
    expect(lib).toContain("from './static-copy'")
    expect(lib).toContain('COMPLIANCE_DISCLAIMER')
    expect(lib).toContain('COMPLIANCE_REVIEW_NUMBER_PLACEHOLDER')
  })

  it('组件是 DOM overlay：不进入 3D 渲染循环、不取数，只消费领域准备层', () => {
    const source = readSource('components/ui/ComplianceBadge.tsx')
    expect(source).not.toContain('@react-three')
    expect(source).not.toContain("from 'three'")
    expect(source).not.toContain('useFrame')
    expect(source).not.toContain('fetch(')
    expect(source).toContain('prepareComplianceBadge')
    expect(source).toContain("from '../../lib/compliance-badge'")
  })

  it('App 总装接线：注册表单例加载、失败进整页错误通道、角标挂载在 </Canvas> 之外', () => {
    const source = readSource('App.tsx')
    expect(source).toContain('loadDataSourceRegistryOnce')
    expect(source).toContain('数据来源注册表加载失败')
    const canvasClose = source.indexOf('</Canvas>')
    const badgeMount = source.indexOf('<ComplianceBadge')
    expect(canvasClose).toBeGreaterThan(-1)
    expect(badgeMount).toBeGreaterThan(-1)
    expect(badgeMount).toBeGreaterThan(canvasClose)
  })

  it('角标样式：左下角限宽低调面板，不成完整底部栏（无全宽形态），指针穿透', () => {
    const css = readSource('index.css')
    const ruleStart = css.indexOf('.compliance-badge {')
    expect(ruleStart).toBeGreaterThan(-1)
    const rule = css.slice(ruleStart, css.indexOf('}', ruleStart))
    expect(rule).toContain('position: absolute')
    expect(rule).toContain('bottom: 24px')
    expect(rule).toContain('left: 24px')
    // 低调限宽叠加：有 max-width，无 right:0 / width:100% 等全宽底部栏形态。
    expect(rule).toContain('max-width')
    expect(rule).not.toContain('right: 0')
    expect(rule).not.toContain('width: 100%')
    expect(rule).toContain('rgba(14, 20, 36, 0.62)')
    expect(rule).toContain('rgba(159, 232, 216')
    expect(rule).toContain('pointer-events: none')
  })

  it('配置层只声明必备来源类别策略（DEM / 边界 / 政治补充三类），配置冻结', () => {
    expect([...COMPLIANCE_BADGE_CONFIG.requiredSourceKinds]).toEqual([
      'digitalElevationModel',
      'administrativeBoundary',
      'politicalBoundarySupplement',
    ])
    expect(Object.isFrozen(COMPLIANCE_BADGE_CONFIG)).toBe(true)
    expect(Object.isFrozen(COMPLIANCE_BADGE_CONFIG.requiredSourceKinds)).toBe(true)
  })
})
