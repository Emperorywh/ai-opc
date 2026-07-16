import fs from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  DEFAULT_LANE_GROUPING_CONFIG,
  DEFAULT_NODE_DIMENSIONS_CONFIG,
  DEFAULT_PATH_RIBBON_CONFIG,
  DEFAULT_SAMPLING_CONFIG,
} from '../src/features/agv-map/config/geometryConfig'
import { ASSET_SHA256_HEX, ASSET_SIZE_BYTES } from '../src/features/agv-map/domain/assetContract'
import { verifyAssetIntegrity } from '../src/features/agv-map/infrastructure/assetIntegrity'
import {
  runMapCompilation,
  type CompilationDeps,
} from '../src/features/agv-map/worker/mapCompilerCore'
import { collectPacketTransferables } from '../src/features/agv-map/worker/packetTransfer'
import type { CompilationEvent } from '../src/features/agv-map/domain/compilerProtocol'

/**
 * 后台地图编译核心验证（SPEC §5.2、§10.1、TASK-007）。
 *
 * 全部用例在 Node 环境运行：用伪造的 fetchBytes 注入真实 map.json 字节并模拟分块进度，
 * 使下载→完整性→解析→校验→编译→成功全流程可在不启动 Worker 与浏览器的情况下验证。
 * SHA-256 校验经 Web Crypto（globalThis.crypto.subtle）在 Node 原生执行。
 */

// 读取根目录 map.json 作为 V76 基线字节来源，与数据契约测试同源。
const mapJsonUrl = new URL('../map.json', import.meta.url)
const rawBuffer = fs.readFileSync(mapJsonUrl)
const REAL_BYTES = Uint8Array.from(rawBuffer)
// 伪造下载的等长篡改字节（翻转首字节），用于触发完整性失败。
const TAMPERED_BYTES = REAL_BYTES.slice()
TAMPERED_BYTES[0] ^= 0xff

// 默认场景编译配置：与 Worker 入口注入的真实配置一致，供 runCore 与自定义依赖用例复用。
const DEFAULT_CONFIGS = {
  sampling: DEFAULT_SAMPLING_CONFIG,
  laneGrouping: DEFAULT_LANE_GROUPING_CONFIG,
  ribbon: DEFAULT_PATH_RIBBON_CONFIG,
  nodeDimensions: DEFAULT_NODE_DIMENSIONS_CONFIG,
}

/**
 * 收集全部编译事件，返回事件序列与终止事件（success/error）。
 *
 * verifyIntegrity 默认注入真实实现（核对 V76 指纹）；传入 bypassIntegrity:true 时
 * 注入直通实现，用于单独驱动解析/校验错误路径——真实场景下任何字节差异都会先被
 * 完整性校验拦截，这两条路径是防御性兜底，需绕过指纹才能直接触发。
 */
async function runCore(
  bytes: Uint8Array<ArrayBuffer>,
  options: {
    abortAfter?: number
    chunkCount?: number
    bypassIntegrity?: boolean
  } = {},
): Promise<CompilationEvent[]> {
  const { abortAfter = Infinity, chunkCount = 8, bypassIntegrity = false } = options
  const events: CompilationEvent[] = []
  const controller = new AbortController()

  const deps: CompilationDeps = {
    fetchBytes: async (_url, signal, onProgress) => {
      const total = bytes.byteLength
      const step = Math.max(1, Math.ceil(total / chunkCount))
      let received = 0
      while (received < total) {
        if (signal.aborted) {
          const err = new Error('aborted')
          err.name = 'AbortError'
          throw err
        }
        if (received >= abortAfter) {
          controller.abort()
        }
        received = Math.min(received + step, total)
        onProgress(received)
        // 让出微任务，保证 await 边界推进。
        await Promise.resolve()
      }
      return bytes
    },
    verifyIntegrity: bypassIntegrity
      ? async (b) => ({
          ok: true,
          expectedSize: b.byteLength,
          actualSize: b.byteLength,
          expectedSha256: '',
          actualSha256: '',
        })
      : verifyAssetIntegrity,
  }

  await runMapCompilation(
    'fake://map.json',
    controller.signal,
    (event) => events.push(event),
    deps,
    DEFAULT_CONFIGS,
  )
  return events
}

/**
 * 以自定义依赖运行核心，用于隔离下载失败、不可预期错误等无法经字节输入驱动的路径。
 * fetchBytes / verifyIntegrity 由调用方注入；其余与 runCore 一致。
 */
async function runWithDeps(deps: CompilationDeps): Promise<CompilationEvent[]> {
  const events: CompilationEvent[] = []
  await runMapCompilation(
    'fake://map.json',
    new AbortController().signal,
    (event) => events.push(event),
    deps,
    DEFAULT_CONFIGS,
  )
  return events
}

/** 提取某类事件的序列，便于断言进度单调与阶段顺序。 */
function eventsOf(events: CompilationEvent[], kind: CompilationEvent['kind']): CompilationEvent[] {
  return events.filter((e) => e.kind === kind)
}

describe('成功路径：真实 V76 字节编译为完整 RenderPacket（SPEC §5.2、TASK-007）', () => {
  it('最终事件为 success，packet 报告 1768 节点、3045 车道、998 双向组、1049 单向边', async () => {
    const events = await runCore(REAL_BYTES)
    const last = events[events.length - 1]
    expect(last?.kind).toBe('success')
    if (last.kind !== 'success') throw new Error('unreachable')
    expect(last.packet.report.nodeCount).toBe(1768)
    expect(last.packet.report.edgeLaneCount).toBe(3045)
    expect(last.packet.report.bidirectionalGroupCount).toBe(998)
    expect(last.packet.report.unpairedEdgeCount).toBe(1049)
  })

  it('packet 各 TypedArray 为非空 ArrayBuffer 支撑（可转移，SPEC §5.4）', async () => {
    const events = await runCore(REAL_BYTES)
    const success = events.find((e) => e.kind === 'success')
    if (success?.kind !== 'success') throw new Error('应成功')
    const { packet } = success
    expect(packet.nodeInstances.node.matrices.buffer).toBeInstanceOf(ArrayBuffer)
    expect(packet.pathGeometry.positions.buffer).toBeInstanceOf(ArrayBuffer)
    expect(packet.pathGeometry.indices.buffer).toBeInstanceOf(ArrayBuffer)
    // 节点矩阵总量 = 1768 × 16。
    let total = 0
    for (const t of ['node', 'work', 'charge', 'park'] as const) total += packet.nodeInstances[t].matrices.length
    expect(total).toBe(1768 * 16)
    // 路径顶点非空。
    expect(packet.pathGeometry.positions.length).toBeGreaterThan(0)
    expect(packet.pathGeometry.indices.length).toBeGreaterThan(0)
  })

  it('真实编译产物的 10 个可转移 ArrayBuffer 互不重叠（避免 postMessage DataCloneError，SPEC §5.4、TASK-007）', async () => {
    // packetTransfer.test.ts 用手工构造的合成数据包验证收集函数；本用例以真实 V76 编译产物
    // 断言 10 个底层缓冲互不重叠。若几何层未来出现复用同一 ArrayBuffer 的字段，Worker
    // 成功事件 postMessage 会因重复转移同一缓冲而静默抛 DataCloneError 使加载挂起，
    // 此断言可在集成层捕获该回归。
    const events = await runCore(REAL_BYTES)
    const success = events.find((e) => e.kind === 'success')
    if (success?.kind !== 'success') throw new Error('应成功')
    const buffers = collectPacketTransferables(success.packet)
    expect(buffers).toHaveLength(10)
    expect(new Set(buffers).size).toBe(10)
    // 每个缓冲均已分离前为非零字节（真实产物不应为空）。
    for (const buf of buffers) {
      expect(buf.byteLength).toBeGreaterThan(0)
    }
  })
})

describe('下载进度：按已读字节映射（SPEC §10.1，0%～30%）', () => {
  it('按分块上报 download-progress，末次 received=total=资产字节数', async () => {
    const events = await runCore(REAL_BYTES, { chunkCount: 8 })
    const dl = eventsOf(events, 'download-progress')
    expect(dl.length).toBeGreaterThanOrEqual(2)
    const last = dl[dl.length - 1]
    if (last.kind !== 'download-progress') throw new Error('unreachable')
    expect(last.received).toBe(ASSET_SIZE_BYTES)
    expect(last.total).toBe(ASSET_SIZE_BYTES)
    // 第一次上报 received > 0（不是 0 字节空报）。
    const first = dl[0]
    if (first.kind !== 'download-progress') throw new Error('unreachable')
    expect(first.received).toBeGreaterThan(0)
  })

  it('download-progress 的 received 与 total 始终单调不下降', async () => {
    const events = await runCore(REAL_BYTES, { chunkCount: 16 })
    const dl = eventsOf(events, 'download-progress')
    for (let i = 1; i < dl.length; i += 1) {
      const prev = dl[i - 1] as { received: number; total: number }
      const curr = dl[i] as { received: number; total: number }
      expect(curr.received).toBeGreaterThanOrEqual(prev.received)
      expect(curr.total).toBeGreaterThanOrEqual(prev.total)
    }
  })
})

describe('解析：离散开始/完成，不伪造连续进度（SPEC §10.1）', () => {
  it('恰好一次 parse-start 与一次 parse-done，且 start 在 done 之前', async () => {
    const events = await runCore(REAL_BYTES)
    const parse = events.filter((e) => e.kind === 'parse')
    expect(parse.length).toBe(2)
    expect((parse[0] as { stage: string }).stage).toBe('parse-start')
    expect((parse[1] as { stage: string }).stage).toBe('parse-done')
  })
})

describe('校验进度：按节点+边记录数映射（SPEC §10.1，30%～40%）', () => {
  it('末次 validate-progress processed=total=1768+3045=4813，且单调', async () => {
    const events = await runCore(REAL_BYTES)
    const vp = eventsOf(events, 'validate-progress')
    expect(vp.length).toBeGreaterThanOrEqual(2)
    const last = vp[vp.length - 1]
    if (last.kind !== 'validate-progress') throw new Error('unreachable')
    expect(last.total).toBe(1768 + 3045)
    expect(last.processed).toBe(last.total)
    for (let i = 1; i < vp.length; i += 1) {
      const prev = vp[i - 1] as { processed: number }
      const curr = vp[i] as { processed: number }
      expect(curr.processed).toBeGreaterThanOrEqual(prev.processed)
    }
  })
})

describe('编译进度：节点(40%~55%)→路径(55%~90%)，按记录数映射（SPEC §10.1）', () => {
  it('先全部 nodes 进度，再全部 paths 进度；末次分别到 1768 与 3045', async () => {
    const events = await runCore(REAL_BYTES)
    const cp = eventsOf(events, 'compile-progress').map((e) => {
      if (e.kind !== 'compile-progress') throw new Error('unreachable')
      return e.report
    })
    expect(cp.length).toBeGreaterThan(0)
    // nodes 在 paths 之前：找到首个 paths 的下标，此前应全为 nodes。
    const firstPathsIdx = cp.findIndex((r) => r.phase === 'paths')
    expect(firstPathsIdx).toBeGreaterThan(0)
    for (let i = 0; i < firstPathsIdx; i += 1) {
      expect(cp[i].phase).toBe('nodes')
    }
    for (let i = firstPathsIdx; i < cp.length; i += 1) {
      expect(cp[i].phase).toBe('paths')
    }
    // 末次 nodes = 1768、末次 paths = 3045。
    const lastNodes = [...cp].reverse().find((r) => r.phase === 'nodes')
    const lastPaths = [...cp].reverse().find((r) => r.phase === 'paths')
    expect(lastNodes?.processed).toBe(1768)
    expect(lastNodes?.total).toBe(1768)
    expect(lastPaths?.processed).toBe(3045)
    expect(lastPaths?.total).toBe(3045)
  })

  it('节点与路径各自 processed 单调不下降', async () => {
    const events = await runCore(REAL_BYTES)
    const reports = eventsOf(events, 'compile-progress').map((e) => {
      if (e.kind !== 'compile-progress') throw new Error('unreachable')
      return e.report
    })
    for (const phase of ['nodes', 'paths'] as const) {
      const seq = reports.filter((r) => r.phase === phase)
      for (let i = 1; i < seq.length; i += 1) {
        expect(seq[i].processed).toBeGreaterThanOrEqual(seq[i - 1].processed)
      }
    }
  })
})

describe('阶段顺序：事件按 downloading→parsing→validating→nodes→paths→success 出现', () => {
  it('事件 kind 序列首尾与阶段先后正确', async () => {
    const events = await runCore(REAL_BYTES)
    const kinds = events.map((e) => e.kind)
    // 首个是下载进度，末个是 success。
    expect(kinds[0]).toBe('download-progress')
    expect(kinds[kinds.length - 1]).toBe('success')
    // parse-start 在 validate-progress 之前；compile-progress 在 validate 之后。
    const parseStart = kinds.indexOf('parse')
    const validateIdx = kinds.indexOf('validate-progress')
    const compileIdx = kinds.indexOf('compile-progress')
    expect(parseStart).toBeGreaterThanOrEqual(0)
    expect(validateIdx).toBeGreaterThan(parseStart)
    expect(compileIdx).toBeGreaterThan(validateIdx)
  })
})

describe('完整性失败：解析前核对字节数与 SHA-256（SPEC §10.1、TASK-007）', () => {
  it('内容被篡改（SHA 不符）→ INTEGRITY_FAILED，不进入解析', async () => {
    const events = await runCore(TAMPERED_BYTES)
    const last = events[events.length - 1]
    expect(last?.kind).toBe('error')
    if (last?.kind !== 'error') throw new Error('unreachable')
    expect(last.code).toBe('INTEGRITY_FAILED')
    // 完整性失败在解析前：不应出现 parse 事件。
    expect(events.some((e) => e.kind === 'parse')).toBe(false)
    // details 携带期望与实际指纹信息。
    expect(last.details.some((d) => d.includes(ASSET_SHA256_HEX))).toBe(true)
  })

  it('字节数不符（截断）→ INTEGRITY_FAILED', async () => {
    const truncated = REAL_BYTES.slice(0, ASSET_SIZE_BYTES - 10)
    const events = await runCore(truncated)
    const last = events[events.length - 1]
    if (last?.kind !== 'error') throw new Error('应失败')
    expect(last.code).toBe('INTEGRITY_FAILED')
  })
})

describe('解析失败：非法 JSON → PARSE_FAILED（SPEC §10.2）', () => {
  it('非 JSON 字节 → PARSE_FAILED', async () => {
    const badBytes = Uint8Array.from(Buffer.from('not-json{'))
    // 绕过完整性校验，直接驱动解析阶段错误路径。
    const events = await runCore(badBytes, { bypassIntegrity: true })
    const last = events[events.length - 1]
    if (last?.kind !== 'error') throw new Error('应失败')
    expect(last.code).toBe('PARSE_FAILED')
    // 解析失败前应已 emit parse-start。
    expect(events.some((e) => e.kind === 'parse')).toBe(true)
  })
})

describe('校验失败：结构非法 → VALIDATION_FAILED（SPEC §10.2）', () => {
  it('载荷缺少必需结构 → VALIDATION_FAILED', async () => {
    // 构造合法 JSON 但 mapJson 结构不满足契约（nodes 非数组）。
    const badAsset = { data: { currentMapInfoVersion: { mapJson: { nodes: 'oops', edges: [] } } } }
    const badBytes = Uint8Array.from(Buffer.from(JSON.stringify(badAsset)))
    // 绕过完整性校验，直接驱动严格校验错误路径。
    const events = await runCore(badBytes, { bypassIntegrity: true })
    const last = events[events.length - 1]
    if (last?.kind !== 'error') throw new Error('应失败')
    expect(last.code).toBe('VALIDATION_FAILED')
    expect(last.details.length).toBeGreaterThan(0)
  })
})

describe('中止：取消下载后静默返回，不 emit 错误（SPEC §5.4、TASK-007）', () => {
  it('下载途中中止 → 无 success/error，仅此前的进度事件', async () => {
    const events = await runCore(REAL_BYTES, { abortAfter: 1, chunkCount: 8 })
    // 中止后不应到达 success 或 error。
    expect(events.some((e) => e.kind === 'success' || e.kind === 'error')).toBe(false)
    // 至少有部分下载进度事件。
    expect(events.some((e) => e.kind === 'download-progress')).toBe(true)
  })
})

describe('下载失败：fetchBytes 非中止拒绝 → DOWNLOAD_FAILED（SPEC §10.2、TASK-007）', () => {
  it('网络错误拒绝 → DOWNLOAD_FAILED，不进入解析，无成功数据包', async () => {
    const events = await runWithDeps({
      fetchBytes: async () => {
        throw new Error('网络中断：ETIMEDOUT')
      },
      verifyIntegrity: verifyAssetIntegrity,
    })
    const last = events[events.length - 1]
    expect(last?.kind).toBe('error')
    if (last?.kind !== 'error') throw new Error('unreachable')
    expect(last.code).toBe('DOWNLOAD_FAILED')
    // 下载失败不进入解析；不产生成功数据包或半成品。
    expect(events.some((e) => e.kind === 'parse')).toBe(false)
    expect(events.some((e) => e.kind === 'success')).toBe(false)
  })
})

describe('几何编译失败：超长贝塞尔触发细分上限 → COMPILE_FAILED（SPEC §10.2、TASK-007）', () => {
  it('通过校验但无法在深度上限内平坦化的贝塞尔 → COMPILE_FAILED，携带边定位', async () => {
    // 构造结构合法但几何病理的载荷：单条贝塞尔跨度 10000 m。默认采样配置
    // （最大弦长 0.25 m、递归深度上限 12）最多平坦化约 1024 m（2^12 × 0.25），远不足以覆盖，
    // 因此 sampleEdges 在深度耗尽时抛出 BEZIER_SUBDIVISION_LIMIT_REACHED。
    const asset = {
      data: {
        currentMapInfoVersion: {
          mapJson: {
            nodes: [
              { id: 'n1', type: 'work', x: 0, y: 0, angle: 0 },
              { id: 'n2', type: 'work', x: 10000, y: 0, angle: 0 },
            ],
            edges: [
              {
                id: 'e-long',
                edgeType: 'BEZIER',
                sx: 0,
                sy: 0,
                ex: 10000,
                ey: 0,
                cx: 3000,
                cy: 500,
                dx: 7000,
                dy: -500,
                snodeId: 'n1',
                enodeId: 'n2',
                isBackEdge: false,
              },
            ],
            zones: [],
            nodeEdgeGroups: [],
          },
        },
      },
    }
    const bytes = Uint8Array.from(Buffer.from(JSON.stringify(asset)))
    // 绕过完整性校验，直接驱动到几何编译错误路径。
    const events = await runCore(bytes, { bypassIntegrity: true })
    const last = events[events.length - 1]
    expect(last?.kind).toBe('error')
    if (last?.kind !== 'error') throw new Error('unreachable')
    expect(last.code).toBe('COMPILE_FAILED')
    // 几何错误携带可定位的边 id。
    expect(last.details.some((d) => d.includes('e-long'))).toBe(true)
    // 校验阶段已通过（出现过 validate-progress），但无成功数据包。
    expect(events.some((e) => e.kind === 'validate-progress')).toBe(true)
    expect(events.some((e) => e.kind === 'success')).toBe(false)
    // 进入编译段后先发 processed=0 的节点进度再采样，故采样期失败时事件流已含 compile-progress，
    // 应用层状态机会处于 compiling-nodes 而非 validating——error.code(GEOMETRY_COMPILE_FAILED)
    // 与诊断阶段保持一致（SPEC §10.2、TASK-007）。
    const compileBeforeError = events.slice(0, events.indexOf(last))
    expect(compileBeforeError.some((e) => e.kind === 'compile-progress')).toBe(true)
  })
})

describe('不可预期错误：依赖抛异常 → UNEXPECTED_ERROR（SPEC §10.2、TASK-007）', () => {
  it('verifyIntegrity 抛出（非返回 ok:false）→ UNEXPECTED_ERROR', async () => {
    const events = await runWithDeps({
      fetchBytes: async (_url, _signal, onProgress) => {
        onProgress(REAL_BYTES.byteLength)
        return REAL_BYTES
      },
      verifyIntegrity: async () => {
        throw new Error('crypto.subtle 不可用')
      },
    })
    const last = events[events.length - 1]
    expect(last?.kind).toBe('error')
    if (last?.kind !== 'error') throw new Error('unreachable')
    expect(last.code).toBe('UNEXPECTED_ERROR')
    expect(events.some((e) => e.kind === 'success')).toBe(false)
  })
})

describe('恒不 reject：所有错误经 emit 上报，Promise 恒为已决（SPEC §5.4、TASK-007）', () => {
  it('依赖抛错时 runMapCompilation 仍 resolve（不产生未处理拒绝），错误经事件上报', async () => {
    const events: CompilationEvent[] = []
    await expect(
      runMapCompilation(
        'fake://map.json',
        new AbortController().signal,
        (e) => events.push(e),
        {
          fetchBytes: async () => {
            throw new Error('网络中断')
          },
          verifyIntegrity: verifyAssetIntegrity,
        },
        DEFAULT_CONFIGS,
      ),
    ).resolves.toBeUndefined()
    expect(events[events.length - 1]?.kind).toBe('error')
  })
})

describe('下载边界：分母固定为契约字节数，不依赖 Content-Length（SPEC §10.1、TASK-007）', () => {
  it('多分块响应：每条 download-progress 的 total 恒为 ASSET_SIZE_BYTES', async () => {
    const events = await runCore(REAL_BYTES, { chunkCount: 32 })
    const dl = eventsOf(events, 'download-progress')
    expect(dl.length).toBeGreaterThanOrEqual(2)
    for (const e of dl) {
      if (e.kind !== 'download-progress') throw new Error('unreachable')
      // 分母固定为契约字节数，不随分块大小或运行时 Content-Length 变化。
      expect(e.total).toBe(ASSET_SIZE_BYTES)
    }
    const last = dl[dl.length - 1]
    if (last.kind !== 'download-progress') throw new Error('unreachable')
    expect(last.received).toBe(ASSET_SIZE_BYTES)
  })

  it('首块不被误报为 100%：首块占比远小于 1（排除 Content-Length 缺失把首块当全量的回归）', async () => {
    const events = await runCore(REAL_BYTES, { chunkCount: 8 })
    const first = events.find((e) => e.kind === 'download-progress')
    if (first?.kind !== 'download-progress') throw new Error('unreachable')
    // 首块约占 1/8 ≈ 0.125，绝非 1.0。
    expect(first.received).toBeGreaterThan(0)
    expect(first.received / first.total).toBeLessThan(0.2)
  })

  it('实际字节数少于契约基线时进度永不达 1，最终由完整性校验裁决失败', async () => {
    // 截断字节：下载完成（received 达截断长度）但少于契约字节数，完整性校验失败。
    const truncated = REAL_BYTES.slice(0, ASSET_SIZE_BYTES - 1000)
    const events = await runCore(truncated)
    const dl = eventsOf(events, 'download-progress')
    for (const e of dl) {
      if (e.kind !== 'download-progress') throw new Error('unreachable')
      // 分母仍为契约基线，故进度 < 1。
      expect(e.received / e.total).toBeLessThan(1)
    }
    const last = events[events.length - 1]
    if (last?.kind !== 'error') throw new Error('应失败')
    expect(last.code).toBe('INTEGRITY_FAILED')
  })
})
