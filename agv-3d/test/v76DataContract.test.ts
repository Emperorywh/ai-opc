import fs from 'node:fs'
import { describe, expect, it } from 'vitest'
import { ASSET_SHA256_HEX, ASSET_SIZE_BYTES } from '../src/features/agv-map/domain/assetContract'
import { auditDataIntegrity, auditRawMap, normalizeMap } from '../src/features/agv-map/domain/normalize'
import type { RawMapAsset, RawMapPayload } from '../src/features/agv-map/domain/rawDto'
import { extractMapPayload, validateRawMap } from '../src/features/agv-map/domain/validation'
import { verifyAssetIntegrity } from '../src/features/agv-map/infrastructure/assetIntegrity'
import { MAP_ASSET_URL } from '../src/features/agv-map/infrastructure/mapAssetUrl'

// 直接读取根目录 map.json 源文件，作为 V76 数据基线的事实来源。
const mapJsonUrl = new URL('../map.json', import.meta.url)
const rawBytes = fs.readFileSync(mapJsonUrl)
const mapAsset = JSON.parse(rawBytes.toString('utf8')) as RawMapAsset

const extraction = extractMapPayload(mapAsset)
if (!extraction.ok) {
  throw new Error(`提取 V76 载荷失败：${extraction.problems.map((p) => p.path).join(', ')}`)
}
const payload = extraction.payload as RawMapPayload
const problems = validateRawMap(payload)

describe('V76 资产指纹', () => {
  it('字节数与 SHA-256 匹配契约（SPEC §4.1）', async () => {
    const result = await verifyAssetIntegrity(Uint8Array.from(rawBytes))
    expect(result.actualSize).toBe(ASSET_SIZE_BYTES)
    expect(result.actualSha256).toBe(ASSET_SHA256_HEX)
    expect(result.ok).toBe(true)
  })
})

describe('V76 资产自托管', () => {
  it('资产 URL 为同源相对路径，加载不请求 CDN（SPEC §4.1、TASK-001）', () => {
    // SPEC §4.1：资产随构建产物自托管，不使用 CDN。
    // Vite `?url` 把 map.json 原样输出到 dist/assets，开发与构建期均返回同源路径；
    // 自托管 URL 必然以 "/" 起首（path-absolute，同源），且不含 http/https scheme。
    // 任何绝对外链（http(s)://）都意味着脱离构建产物走 CDN，违反契约——
    // 该断言作为回归护栏，防止后续把资产 URL 改为 CDN。
    expect(typeof MAP_ASSET_URL).toBe('string')
    expect(MAP_ASSET_URL.length).toBeGreaterThan(0)
    expect(MAP_ASSET_URL.startsWith('/')).toBe(true)
    expect(/^https?:\/\//i.test(MAP_ASSET_URL)).toBe(false)
  })
})

describe('V76 数据契约', () => {
  it('严格校验通过，无任何问题（SPEC §4.4）', () => {
    expect(problems, problems.map((p) => `${p.path}:${p.code}`).join('\n')).toEqual([])
  })

  it('审计统计符合 SPEC §4.2', () => {
    const audit = auditRawMap(payload)
    expect(audit.nodeCount).toBe(1768)
    expect(audit.edgeCount).toBe(3045)
    expect(audit.zoneCount).toBe(0)
    expect(audit.nodeEdgeGroupCount).toBe(0)
    expect(audit.nodeTypeCount).toEqual({ node: 1304, work: 389, charge: 11, park: 64 })
    expect(audit.edgeTypeCount).toEqual({ LINE: 2936, BEZIER: 109 })
    expect(audit.isBackEdgeCount).toBe(879)
  })

  it('规范化产生 1768 节点与 3045 有向边', () => {
    const model = normalizeMap(payload)
    expect(model.nodes).toHaveLength(1768)
    expect(model.edges).toHaveLength(3045)
  })

  it('规范化无损保留边自身端点坐标，不吸附节点坐标（SPEC §4.2）', () => {
    const model = normalizeMap(payload)
    // 逐条核对规范化端点与原始边坐标完全一致，证明规范化没有把端点改写或吸附到节点坐标。
    // 结合下方完整性审计（483 条边端点与节点坐标不一致），可推出规范化结果同样保持偏差。
    model.edges.forEach((edge, index) => {
      const raw = payload.edges[index]
      expect(edge.path.start.x).toBe(raw.sx)
      expect(edge.path.start.y).toBe(raw.sy)
      expect(edge.path.end.x).toBe(raw.ex)
      expect(edge.path.end.y).toBe(raw.ey)
    })
  })
})

describe('V76 数据完整性基线', () => {
  // SPEC §4.2 末两行：把“校验通过”拆解为可逐项核对的缺陷计数与端点偏差基线。
  // 这些断言固定数据基线，资产有意变更时必须同步更新 SPEC §4.2 与本测试。
  const integrity = auditDataIntegrity(payload)

  it('无重复 id、无非法坐标、无缺失节点引用（SPEC §4.2）', () => {
    expect(integrity.duplicateNodeIdCount).toBe(0)
    expect(integrity.duplicateEdgeIdCount).toBe(0)
    expect(integrity.invalidNodeCoordinateCount).toBe(0)
    expect(integrity.invalidEdgeCoordinateCount).toBe(0)
    expect(integrity.missingNodeReferenceCount).toBe(0)
  })

  it('483 条边端点与节点坐标不完全一致，最大差异 0.03 m（SPEC §4.2）', () => {
    expect(integrity.endpointNodeMismatchCount).toBe(483)
    expect(integrity.maxEndpointNodeDistanceM).toBeCloseTo(0.03, 5)
  })
})
