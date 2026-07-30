/**
 * 数据来源注册表运行时加载器测试（TASK-014，SPEC §8）。
 *
 * fetch 以 vi.stubGlobal 注入 stub，不触网；有效载荷直接读生产资产
 * public/geo/data-sources.json（与运行时 fetch 的 JSON 同一份）。
 *
 * 覆盖：
 * - 成功路径：stub fetch 返回生产注册表 JSON → 返回经契约校验的 contract（四份来源声明，
 *   三类必备类别齐全）；默认 URL 指向生产资产 /geo/data-sources.json。
 * - fetch 抛错（网络层失败）→ DataSourceRegistryLoadError(fetch-failed)。
 * - HTTP 非 2xx → DataSourceRegistryLoadError(fetch-failed)。
 * - 契约不合法（kind 错误 / 非官方来源缺免责声明）→ DataSourceRegistryLoadError(contract-invalid)，
 *   绝不返回部分 / 伪造注册表。
 *
 * 依赖方向：测试基线（vitest，Node 环境），import src/lib/data-source-registry 加载器与契约层。
 */

import { describe, it, expect, afterEach, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  DataSourceRegistryLoadError,
  loadDataSourceRegistry,
} from '../src/lib/data-source-registry'
import type { DataSourceRegistryContract } from '../src/geo-contracts'

const projectRoot = resolve(fileURLToPath(import.meta.url), '..', '..')

/** 生产资产的有效载荷（与运行时 fetch 的 JSON 同一份）。 */
function loadProductionPayload(): unknown {
  const assetPath = resolve(projectRoot, 'public', 'geo', 'data-sources.json')
  return JSON.parse(readFileSync(assetPath, 'utf-8')) as unknown
}

/** 构造一个最小 fetch stub 响应。 */
function stubResponse(init: { ok: boolean; status?: number; json?: () => Promise<unknown> }): Response {
  return {
    ok: init.ok,
    status: init.status ?? (init.ok ? 200 : 500),
    json: init.json ?? (async () => ({})),
  } as unknown as Response
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('loadDataSourceRegistry：成功路径', () => {
  it('stub fetch 返回生产注册表 JSON → 返回经契约校验的 contract（四份来源，三类必备齐全）', async () => {
    const payload = loadProductionPayload()
    vi.stubGlobal('fetch', async () => stubResponse({ ok: true, json: async () => payload }))
    const contract = await loadDataSourceRegistry()
    expect(contract.kind).toBe('data-source-registry')
    expect(contract.sources.length).toBe(4)
    const kinds = new Set(contract.sources.map((source) => source.kind))
    expect(kinds.has('digitalElevationModel')).toBe(true)
    expect(kinds.has('administrativeBoundary')).toBe(true)
    expect(kinds.has('politicalBoundarySupplement')).toBe(true)
    // 非官方审图红线：全部来源 isOfficialSurvey=false 且免责声明非空（契约层强制）。
    for (const source of contract.sources) {
      expect(source.isOfficialSurvey).toBe(false)
      expect(typeof source.disclaimer).toBe('string')
      expect((source.disclaimer as string).length).toBeGreaterThan(0)
    }
  })

  it('默认 URL 指向生产资产 /geo/data-sources.json（与其它 geo 资产加载器同一目录约定）', async () => {
    const payload = loadProductionPayload()
    const requested: string[] = []
    vi.stubGlobal('fetch', async (url: unknown) => {
      requested.push(String(url))
      return stubResponse({ ok: true, json: async () => payload })
    })
    await loadDataSourceRegistry()
    expect(requested).toEqual(['/geo/data-sources.json'])
  })
})

describe('loadDataSourceRegistry：失败语义（绝不静默退化为空 / 伪造注册表）', () => {
  it('fetch 抛错（网络层失败）→ fetch-failed', async () => {
    vi.stubGlobal('fetch', async () => {
      throw new Error('network down')
    })
    let caught: unknown
    try {
      await loadDataSourceRegistry()
    } catch (e) {
      caught = e
    }
    expect(caught).toBeInstanceOf(DataSourceRegistryLoadError)
    expect((caught as DataSourceRegistryLoadError).code).toBe('data-source-registry.fetch-failed')
  })

  it('HTTP 非 2xx → fetch-failed', async () => {
    vi.stubGlobal('fetch', async () => stubResponse({ ok: false, status: 404 }))
    let caught: unknown
    try {
      await loadDataSourceRegistry()
    } catch (e) {
      caught = e
    }
    expect(caught).toBeInstanceOf(DataSourceRegistryLoadError)
    expect((caught as DataSourceRegistryLoadError).code).toBe('data-source-registry.fetch-failed')
  })

  it('kind 错误（非 data-source-registry）→ contract-invalid', async () => {
    const payload = { ...(loadProductionPayload() as object), kind: 'wrong-kind' }
    vi.stubGlobal('fetch', async () => stubResponse({ ok: true, json: async () => payload }))
    let caught: unknown
    try {
      await loadDataSourceRegistry()
    } catch (e) {
      caught = e
    }
    expect(caught).toBeInstanceOf(DataSourceRegistryLoadError)
    expect((caught as DataSourceRegistryLoadError).code).toBe('data-source-registry.contract-invalid')
  })

  it('非官方来源缺免责声明 → contract-invalid（SPEC §8 红线由契约层强制）', async () => {
    const production = loadProductionPayload() as DataSourceRegistryContract
    const payload = {
      ...production,
      sources: production.sources.map((source, index) =>
        index === 0 ? { ...source, disclaimer: '' } : source,
      ),
    }
    vi.stubGlobal('fetch', async () => stubResponse({ ok: true, json: async () => payload }))
    let caught: unknown
    try {
      await loadDataSourceRegistry()
    } catch (e) {
      caught = e
    }
    expect(caught).toBeInstanceOf(DataSourceRegistryLoadError)
    expect((caught as DataSourceRegistryLoadError).code).toBe('data-source-registry.contract-invalid')
  })
})
