/**
 * 省级行政区几何加载器测试（TASK-009 验收 1 的数据链路前提）。
 *
 * 依赖方向：测试基线（vitest，Node 环境），import src/lib/province-geometry（loadProvinceGeometry）。
 * fetch 以 vi.stubGlobal 注入 stub，不触网；有效载荷直接读生产资产
 * public/geo/china-provinces-geometry.json（与运行时同一份）。
 *
 * 覆盖：
 * - 成功路径：stub fetch 返回生产资产 JSON → 返回经契约校验的 contract（kind / 34 features）。
 * - fetch 抛错（网络层失败）→ ProvinceGeometryLoadError(fetch-failed)。
 * - HTTP 非 2xx → ProvinceGeometryLoadError(fetch-failed)。
 * - 载荷未通过 administrative-geometry 契约（kind 错 / features 非数组）→ contract-invalid，
 *   绝不返回部分 / 伪造几何（SPEC §6 政治边界红线）。
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadProvinceGeometry, ProvinceGeometryLoadError } from '../src/lib/province-geometry'

const projectRoot = resolve(fileURLToPath(import.meta.url), '..', '..')

/** 生产资产的有效载荷（与运行时 fetch 的 JSON 同一份）。 */
function loadProductionPayload(): unknown {
  const assetPath = resolve(projectRoot, 'public', 'geo', 'china-provinces-geometry.json')
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

describe('loadProvinceGeometry：成功路径', () => {
  it('stub fetch 返回生产资产 JSON → 返回经契约校验的 contract（34 features）', async () => {
    const payload = loadProductionPayload()
    vi.stubGlobal('fetch', async () => stubResponse({ ok: true, json: async () => payload }))
    const contract = await loadProvinceGeometry()
    expect(contract.kind).toBe('administrative-geometry')
    expect(contract.crs).toBe('EPSG:4326')
    expect(contract.features.length).toBe(34)
    // adminId 唯一性（契约已校验，抽首尾断言形态）。
    expect(contract.features[0].adminId).toMatch(/^CN-/)
  })
})

describe('loadProvinceGeometry：失败路径（绝不静默退化为空 / 伪造几何）', () => {
  it('fetch 抛错（网络层失败）→ fetch-failed', async () => {
    vi.stubGlobal('fetch', async () => {
      throw new Error('network down')
    })
    try {
      await loadProvinceGeometry()
      expect.unreachable('网络失败应抛 ProvinceGeometryLoadError')
    } catch (e) {
      expect(e).toBeInstanceOf(ProvinceGeometryLoadError)
      expect((e as ProvinceGeometryLoadError).code).toBe('province-geometry.fetch-failed')
    }
  })

  it('HTTP 非 2xx → fetch-failed', async () => {
    vi.stubGlobal('fetch', async () => stubResponse({ ok: false, status: 404 }))
    try {
      await loadProvinceGeometry()
      expect.unreachable('HTTP 404 应抛 ProvinceGeometryLoadError')
    } catch (e) {
      expect(e).toBeInstanceOf(ProvinceGeometryLoadError)
      expect((e as ProvinceGeometryLoadError).code).toBe('province-geometry.fetch-failed')
      expect((e as ProvinceGeometryLoadError).message).toContain('404')
    }
  })

  it('载荷 kind 错误 → contract-invalid', async () => {
    vi.stubGlobal('fetch', async () =>
      stubResponse({ ok: true, json: async () => ({ kind: 'wrong-kind', features: [] }) }),
    )
    try {
      await loadProvinceGeometry()
      expect.unreachable('kind 错误应抛 ProvinceGeometryLoadError')
    } catch (e) {
      expect(e).toBeInstanceOf(ProvinceGeometryLoadError)
      expect((e as ProvinceGeometryLoadError).code).toBe('province-geometry.contract-invalid')
    }
  })

  it('载荷 features 非数组 → contract-invalid（不返回部分几何）', async () => {
    vi.stubGlobal('fetch', async () =>
      stubResponse({
        ok: true,
        json: async () => ({ kind: 'administrative-geometry', version: '1.0.0', crs: 'EPSG:4326', features: 42 }),
      }),
    )
    try {
      await loadProvinceGeometry()
      expect.unreachable('features 非数组应抛 ProvinceGeometryLoadError')
    } catch (e) {
      expect(e).toBeInstanceOf(ProvinceGeometryLoadError)
      expect((e as ProvinceGeometryLoadError).code).toBe('province-geometry.contract-invalid')
    }
  })
})
