import { describe, it, expect, vi, afterEach } from 'vitest'
import type { LoadingStage } from '../src/state/store'
import {
  STAGE_PROGRESS,
  STAGE_ORDER,
  STAGE_LABELS,
  isReady,
  clamp01,
  byteFraction,
  stageProgress,
  fetchWithProgress,
} from '../src/ui/loading'

describe('STAGE_PROGRESS / STAGE_ORDER（阶段区间）', () => {
  it('STAGE_ORDER 覆盖全部 LoadingStage', () => {
    const all: LoadingStage[] = ['init', 'meta', 'terrain', 'decode', 'ready']
    for (const s of all) expect(STAGE_ORDER).toContain(s)
    expect(STAGE_ORDER).toHaveLength(all.length)
  })

  it('各阶段 start≤end，且整体随阶段顺序单调递增', () => {
    let prevEnd = -1
    for (const s of STAGE_ORDER) {
      const [start, end] = STAGE_PROGRESS[s]
      expect(start).toBeLessThanOrEqual(end)
      expect(start).toBeGreaterThanOrEqual(prevEnd)
      prevEnd = end
    }
  })

  it('ready 收敛到 1.0', () => {
    expect(STAGE_PROGRESS.ready[0]).toBe(1)
    expect(STAGE_PROGRESS.ready[1]).toBe(1)
  })

  it('STAGE_LABELS 覆盖全部阶段且非空中文文案', () => {
    for (const s of STAGE_ORDER) {
      expect(STAGE_LABELS[s].length).toBeGreaterThan(0)
    }
  })

  it('terrain 占主体（区间跨度最大）', () => {
    const span = (s: LoadingStage) => STAGE_PROGRESS[s][1] - STAGE_PROGRESS[s][0]
    for (const s of STAGE_ORDER) {
      if (s !== 'terrain') expect(span('terrain')).toBeGreaterThan(span(s))
    }
  })
})

describe('isReady', () => {
  it('ready → true', () => {
    expect(isReady('ready')).toBe(true)
  })
  it('其余阶段 → false', () => {
    for (const s of STAGE_ORDER) {
      if (s !== 'ready') expect(isReady(s)).toBe(false)
    }
  })
})

describe('clamp01', () => {
  it('范围内不变', () => {
    expect(clamp01(0)).toBe(0)
    expect(clamp01(0.5)).toBe(0.5)
    expect(clamp01(1)).toBe(1)
  })
  it('超下界 → 0', () => {
    expect(clamp01(-0.3)).toBe(0)
  })
  it('超上界 → 1', () => {
    expect(clamp01(1.7)).toBe(1)
  })
  it('非有限数 → 0', () => {
    expect(clamp01(NaN)).toBe(0)
    expect(clamp01(Infinity)).toBe(0)
    expect(clamp01(-Infinity)).toBe(0)
  })
})

describe('byteFraction', () => {
  it('正常比例', () => {
    expect(byteFraction(0, 10)).toBe(0)
    expect(byteFraction(5, 10)).toBe(0.5)
    expect(byteFraction(10, 10)).toBe(1)
  })
  it('loaded>total 钳到 1', () => {
    expect(byteFraction(15, 10)).toBe(1)
  })
  it('total≤0 → 0（防除零）', () => {
    expect(byteFraction(5, 0)).toBe(0)
    expect(byteFraction(5, -3)).toBe(0)
  })
  it('非有限 → 0', () => {
    expect(byteFraction(NaN, 10)).toBe(0)
    expect(byteFraction(5, NaN)).toBe(0)
    expect(byteFraction(Infinity, 10)).toBe(0)
  })
})

describe('stageProgress（阶段内比例 → 整体进度）', () => {
  it('fraction=0 → 阶段起点', () => {
    expect(stageProgress('terrain', 0)).toBe(STAGE_PROGRESS.terrain[0])
  })
  it('fraction=1 → 阶段终点（容浮点累积误差）', () => {
    expect(stageProgress('terrain', 1)).toBeCloseTo(STAGE_PROGRESS.terrain[1], 10)
  })
  it('中点线性插值', () => {
    const [s, e] = STAGE_PROGRESS.meta
    expect(stageProgress('meta', 0.5)).toBeCloseTo((s + e) / 2, 10)
  })
  it('fraction 超界钳制', () => {
    expect(stageProgress('terrain', -1)).toBe(STAGE_PROGRESS.terrain[0])
    expect(stageProgress('terrain', 2)).toBeCloseTo(STAGE_PROGRESS.terrain[1], 10)
  })
  it('非有限 fraction → 阶段起点（clamp01→0）', () => {
    expect(stageProgress('terrain', NaN)).toBe(STAGE_PROGRESS.terrain[0])
  })
  it('ready 始终 1', () => {
    expect(stageProgress('ready', 0)).toBe(1)
    expect(stageProgress('ready', 1)).toBe(1)
  })
  it('整体随阶段递进单调（meta末 < terrain中 < decode末）', () => {
    const a = stageProgress('meta', 1)
    const b = stageProgress('terrain', 0.5)
    const c = stageProgress('decode', 1)
    expect(a).toBeLessThan(b)
    expect(b).toBeLessThan(c)
  })
})

describe('fetchWithProgress', () => {
  afterEach(() => vi.unstubAllGlobals())

  /** 构造 mock Response（带分块 ReadableStream body + content-length 头）。 */
  function makeResponse(opts: {
    ok?: boolean
    status?: number
    data?: Uint8Array
    withStream?: boolean
    withLength?: boolean
  }) {
    const data = opts.data ?? new Uint8Array(0)
    const headers = new Map<string, string>()
    if (opts.withLength !== false) headers.set('content-length', String(data.length))
    let body: ReadableStream<Uint8Array> | null = null
    if (opts.withStream !== false) {
      const half = Math.ceil(data.length / 2)
      body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(data.subarray(0, half))
          if (data.length > 1) controller.enqueue(data.subarray(half))
          controller.close()
        },
      })
    }
    return {
      ok: opts.ok ?? true,
      status: opts.status ?? 200,
      headers,
      body,
      arrayBuffer: async () => data.buffer.slice(0),
    }
  }

  it('流式读取 + 字节进度回调 + 合并 buffer', async () => {
    const data = new Uint8Array([10, 20, 30, 40, 50, 60])
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(makeResponse({ data })))
    const seen: Array<[number, number]> = []
    const buf = await fetchWithProgress('http://x/heightmap.png', (l, t) => seen.push([l, t]))
    expect(new Uint8Array(buf)).toEqual(data)
    // half=3 → [10,20,30]；再 [40,50,60]
    expect(seen).toEqual([
      [3, 6],
      [6, 6],
    ])
    expect(vi.mocked(fetch)).toHaveBeenCalledWith('http://x/heightmap.png')
  })

  it('单字节边界：整块一次回调', async () => {
    const data = new Uint8Array([7])
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(makeResponse({ data })))
    const seen: Array<[number, number]> = []
    const buf = await fetchWithProgress('http://x', (l, t) => seen.push([l, t]))
    expect(new Uint8Array(buf)).toEqual(data)
    // half=1 → enqueue [7]；length>1 false 不再分块
    expect(seen).toEqual([[1, 1]])
  })

  it('非 2xx → 抛错（含状态码）', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(makeResponse({ ok: false, status: 404, data: new Uint8Array(0) })),
    )
    await expect(fetchWithProgress('http://x')).rejects.toThrow(/404/)
  })

  it('无 ReadableStream body → 回退整体读取（首尾各回调一次）', async () => {
    const data = new Uint8Array([1, 2, 3])
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(makeResponse({ data, withStream: false })),
    )
    const seen: Array<[number, number]> = []
    const buf = await fetchWithProgress('http://x', (l, t) => seen.push([l, t]))
    expect(new Uint8Array(buf)).toEqual(data)
    expect(seen).toEqual([
      [0, 0],
      [3, 3],
    ])
  })

  it('无 content-length → 回退整体读取', async () => {
    const data = new Uint8Array([9, 9])
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(makeResponse({ data, withLength: false })),
    )
    const seen: Array<[number, number]> = []
    await fetchWithProgress('http://x', (l, t) => seen.push([l, t]))
    // 无 total → 走 arrayBuffer 路径
    expect(seen).toEqual([
      [0, 0],
      [2, 2],
    ])
  })
})
