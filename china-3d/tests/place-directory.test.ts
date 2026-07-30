/**
 * 地点目录加载器测试（TASK-010 验收 1、2 的数据链路前提）。
 *
 * 依赖方向：测试基线（vitest，Node 环境），import src/lib/place-directory（loadPlaceDirectory）。
 * fetch 以 vi.stubGlobal 注入 stub，不触网；有效载荷直接读生产资产
 * public/geo/china-places.json（与运行时同一份）。
 *
 * 覆盖：
 * - 成功路径：stub fetch 返回生产资产 JSON → 返回经契约校验的 contract（kind / 68 entries，
 *   34 省 × 2 角色）。
 * - fetch 抛错（网络层失败）→ PlaceDirectoryLoadError(fetch-failed)。
 * - HTTP 非 2xx → PlaceDirectoryLoadError(fetch-failed)。
 * - 载荷未通过 place-directory 契约（kind 错 / entries 非数组 / 角色非法）→ contract-invalid，
 *   绝不返回部分 / 伪造地点目录（SPEC §6 台湾 / 港澳标注红线）。
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadPlaceDirectory, PlaceDirectoryLoadError } from '../src/lib/place-directory'

const projectRoot = resolve(fileURLToPath(import.meta.url), '..', '..')

/** 生产资产的有效载荷（与运行时 fetch 的 JSON 同一份）。 */
function loadProductionPayload(): unknown {
  const assetPath = resolve(projectRoot, 'public', 'geo', 'china-places.json')
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

describe('loadPlaceDirectory：成功路径', () => {
  it('stub fetch 返回生产资产 JSON → 返回经契约校验的 contract（68 entries = 34 省 × 2 角色）', async () => {
    const payload = loadProductionPayload()
    vi.stubGlobal('fetch', async () => stubResponse({ ok: true, json: async () => payload }))
    const contract = await loadPlaceDirectory()
    expect(contract.kind).toBe('place-directory')
    expect(contract.crs).toBe('EPSG:4326')
    expect(contract.entries.length).toBe(68)
    const roles = new Set(contract.entries.map((e) => e.role))
    expect(roles.has('provinceNameAnchor')).toBe(true)
    expect(roles.has('administrativeCapital')).toBe(true)
  })

  it('港澳台条目齐全（SPEC §6 红线最小集，不缺失）', async () => {
    const payload = loadProductionPayload()
    vi.stubGlobal('fetch', async () => stubResponse({ ok: true, json: async () => payload }))
    const contract = await loadPlaceDirectory()
    const admins = new Set(contract.entries.map((e) => e.adminId))
    for (const id of ['CN-710000', 'CN-810000', 'CN-820000']) {
      expect(admins.has(id), `${id} 应有地点条目`).toBe(true)
    }
  })
})

describe('loadPlaceDirectory：失败路径（绝不静默退化为空 / 伪造地点目录）', () => {
  it('fetch 抛错（网络层失败）→ fetch-failed', async () => {
    vi.stubGlobal('fetch', async () => {
      throw new Error('network down')
    })
    try {
      await loadPlaceDirectory()
      expect.unreachable('网络失败应抛 PlaceDirectoryLoadError')
    } catch (e) {
      expect(e).toBeInstanceOf(PlaceDirectoryLoadError)
      expect((e as PlaceDirectoryLoadError).code).toBe('place-directory.fetch-failed')
    }
  })

  it('HTTP 非 2xx → fetch-failed', async () => {
    vi.stubGlobal('fetch', async () => stubResponse({ ok: false, status: 404 }))
    try {
      await loadPlaceDirectory()
      expect.unreachable('HTTP 404 应抛 PlaceDirectoryLoadError')
    } catch (e) {
      expect(e).toBeInstanceOf(PlaceDirectoryLoadError)
      expect((e as PlaceDirectoryLoadError).code).toBe('place-directory.fetch-failed')
      expect((e as PlaceDirectoryLoadError).message).toContain('404')
    }
  })

  it('载荷 kind 错误 → contract-invalid', async () => {
    vi.stubGlobal('fetch', async () =>
      stubResponse({ ok: true, json: async () => ({ kind: 'wrong-kind', entries: [] }) }),
    )
    try {
      await loadPlaceDirectory()
      expect.unreachable('kind 错误应抛 PlaceDirectoryLoadError')
    } catch (e) {
      expect(e).toBeInstanceOf(PlaceDirectoryLoadError)
      expect((e as PlaceDirectoryLoadError).code).toBe('place-directory.contract-invalid')
    }
  })

  it('载荷 entries 非数组 → contract-invalid（不返回部分目录）', async () => {
    vi.stubGlobal('fetch', async () =>
      stubResponse({
        ok: true,
        json: async () => ({ kind: 'place-directory', version: '1.0.0', crs: 'EPSG:4326', entries: 42 }),
      }),
    )
    try {
      await loadPlaceDirectory()
      expect.unreachable('entries 非数组应抛 PlaceDirectoryLoadError')
    } catch (e) {
      expect(e).toBeInstanceOf(PlaceDirectoryLoadError)
      expect((e as PlaceDirectoryLoadError).code).toBe('place-directory.contract-invalid')
    }
  })

  it('载荷角色非法 → contract-invalid', async () => {
    const payload = loadProductionPayload() as { entries: Array<Record<string, unknown>> }
    const tampered = {
      ...payload,
      entries: payload.entries.map((entry, index) =>
        index === 0 ? { ...entry, role: 'mayorOffice' } : entry,
      ),
    }
    vi.stubGlobal('fetch', async () => stubResponse({ ok: true, json: async () => tampered }))
    try {
      await loadPlaceDirectory()
      expect.unreachable('角色非法应抛 PlaceDirectoryLoadError')
    } catch (e) {
      expect(e).toBeInstanceOf(PlaceDirectoryLoadError)
      expect((e as PlaceDirectoryLoadError).code).toBe('place-directory.contract-invalid')
    }
  })
})
