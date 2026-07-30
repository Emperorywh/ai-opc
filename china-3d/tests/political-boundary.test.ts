/**
 * 政治边界补充数据加载器测试（TASK-011 验收 4 的数据链路前提）。
 *
 * 依赖方向：测试基线（vitest，Node 环境），import src/lib/political-boundary（loadPoliticalBoundary）。
 * fetch 以 vi.stubGlobal 注入 stub，不触网；有效载荷直接读生产资产
 * public/geo/china-political-boundary.json（与运行时同一份）。
 *
 * 覆盖：
 * - 成功路径：stub fetch 返回生产资产 JSON → 返回经契约校验的 contract（kind / 十段 + 岛礁点位）。
 * - fetch 抛错（网络层失败）→ PoliticalBoundaryLoadError(fetch-failed)。
 * - HTTP 非 2xx → PoliticalBoundaryLoadError(fetch-failed)。
 * - 载荷未通过 political-boundary 契约（kind 错 / features 非数组）→ contract-invalid，
 *   绝不返回部分 / 伪造政治边界（SPEC §6 政治边界红线）。
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadPoliticalBoundary, PoliticalBoundaryLoadError } from '../src/lib/political-boundary'

const projectRoot = resolve(fileURLToPath(import.meta.url), '..', '..')

/** 生产资产的有效载荷（与运行时 fetch 的 JSON 同一份）。 */
function loadProductionPayload(): unknown {
  const assetPath = resolve(projectRoot, 'public', 'geo', 'china-political-boundary.json')
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

describe('loadPoliticalBoundary：成功路径', () => {
  it('stub fetch 返回生产资产 JSON → 返回经契约校验的 contract（十段 + 岛礁点位）', async () => {
    const payload = loadProductionPayload()
    vi.stubGlobal('fetch', async () => stubResponse({ ok: true, json: async () => payload }))
    const contract = await loadPoliticalBoundary()
    expect(contract.kind).toBe('political-boundary')
    expect(contract.crs).toBe('EPSG:4326')
    const segments = contract.features.filter((f) => f.type === 'nineDashLineSegment')
    const points = contract.features.filter((f) => f.type === 'islandOrReefPoint')
    // 十段画法（含台湾东侧第 10 段）+ 5 岛礁点位（钓鱼岛 / 赤尾屿 / 曾母暗沙 / 黄岩岛 / 永兴岛）。
    expect(segments.length).toBe(10)
    expect(points.length).toBe(5)
  })
})

describe('loadPoliticalBoundary：失败路径（绝不静默退化为空 / 伪造政治边界）', () => {
  it('fetch 抛错（网络层失败）→ fetch-failed', async () => {
    vi.stubGlobal('fetch', async () => {
      throw new Error('network down')
    })
    try {
      await loadPoliticalBoundary()
      expect.unreachable('网络失败应抛 PoliticalBoundaryLoadError')
    } catch (e) {
      expect(e).toBeInstanceOf(PoliticalBoundaryLoadError)
      expect((e as PoliticalBoundaryLoadError).code).toBe('political-boundary.fetch-failed')
    }
  })

  it('HTTP 非 2xx → fetch-failed', async () => {
    vi.stubGlobal('fetch', async () => stubResponse({ ok: false, status: 404 }))
    try {
      await loadPoliticalBoundary()
      expect.unreachable('HTTP 404 应抛 PoliticalBoundaryLoadError')
    } catch (e) {
      expect(e).toBeInstanceOf(PoliticalBoundaryLoadError)
      expect((e as PoliticalBoundaryLoadError).code).toBe('political-boundary.fetch-failed')
      expect((e as PoliticalBoundaryLoadError).message).toContain('404')
    }
  })

  it('载荷 kind 错误 → contract-invalid', async () => {
    vi.stubGlobal('fetch', async () =>
      stubResponse({ ok: true, json: async () => ({ kind: 'wrong-kind', features: [] }) }),
    )
    try {
      await loadPoliticalBoundary()
      expect.unreachable('kind 错误应抛 PoliticalBoundaryLoadError')
    } catch (e) {
      expect(e).toBeInstanceOf(PoliticalBoundaryLoadError)
      expect((e as PoliticalBoundaryLoadError).code).toBe('political-boundary.contract-invalid')
    }
  })

  it('载荷 features 非数组 → contract-invalid（不返回部分政治边界）', async () => {
    vi.stubGlobal('fetch', async () =>
      stubResponse({
        ok: true,
        json: async () => ({ kind: 'political-boundary', version: '1.0.0', crs: 'EPSG:4326', features: 42 }),
      }),
    )
    try {
      await loadPoliticalBoundary()
      expect.unreachable('features 非数组应抛 PoliticalBoundaryLoadError')
    } catch (e) {
      expect(e).toBeInstanceOf(PoliticalBoundaryLoadError)
      expect((e as PoliticalBoundaryLoadError).code).toBe('political-boundary.contract-invalid')
    }
  })
})
