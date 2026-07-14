import { describe, expect, it } from 'vitest'
import {
  LoadSessionController,
  type LoadSessionListener,
} from '../src/features/agv-map/application/loadSession'
import type { LoadStateCommand } from '../src/features/agv-map/application/loadState'
import type { RenderPacket } from '../src/features/agv-map/domain/renderPacket'

/**
 * 加载会话控制器验证（SPEC §5.4、TASK-006）。
 *
 * 全部用例在不启动浏览器的 Node 环境中运行，覆盖单一有效会话、新会话取代旧会话、
 * 取消隔离与过期结果（进度、成功、失败）不得覆盖当前状态等会话规则。
 */

/** 构造一个结构合法的空渲染数据包。 */
function emptyPacket(): RenderPacket {
  return {
    nodeInstances: {
      node: { count: 0, matrices: new Float32Array(0) },
      work: { count: 0, matrices: new Float32Array(0) },
      charge: { count: 0, matrices: new Float32Array(0) },
      park: { count: 0, matrices: new Float32Array(0) },
    },
    pathGeometry: {
      positions: new Float32Array(0),
      normals: new Float32Array(0),
      pathU: new Float32Array(0),
      flowDirections: new Float32Array(0),
      indices: new Uint32Array(0),
      edgeVertexRanges: new Uint32Array(0),
    },
    renderBounds: { min: [0, 0, 0], max: [1, 1, 1] },
    report: { nodeCount: 0, edgeLaneCount: 0, bidirectionalGroupCount: 0, unpairedEdgeCount: 0 },
  }
}

/** 通过控制器把一次加载推进到 ready，返回最终状态。 */
function driveToReady(c: LoadSessionController, id: number): void {
  c.apply({ type: 'report-progress', fraction: 1 }, id)
  c.apply({ type: 'advance', to: 'parsing' }, id)
  c.apply({ type: 'advance', to: 'validating' }, id)
  c.apply({ type: 'report-progress', fraction: 1 }, id)
  c.apply({ type: 'advance', to: 'compiling-nodes' }, id)
  c.apply({ type: 'report-progress', fraction: 1 }, id)
  c.apply({ type: 'advance', to: 'compiling-paths' }, id)
  c.apply({ type: 'report-progress', fraction: 1 }, id)
  c.apply({ type: 'attach-packet', packet: emptyPacket() }, id)
  c.apply({ type: 'report-progress', fraction: 1 }, id)
  c.apply({ type: 'advance', to: 'fading' }, id)
  c.apply({ type: 'report-progress', fraction: 1 }, id)
  c.apply({ type: 'complete' }, id)
}

describe('会话初始状态', () => {
  it('初始状态为 null，requestId 为 0，无活跃会话', () => {
    const c = new LoadSessionController()
    expect(c.getState()).toBeNull()
    expect(c.getCurrentRequestId()).toBe(0)
    expect(c.isActive(0)).toBe(false)
    expect(c.isActive(1)).toBe(false)
  })
})

describe('单一有效会话（SPEC §5.4）', () => {
  it('start 返回新 requestId 并进入 downloading', () => {
    const c = new LoadSessionController()
    const id = c.start()
    expect(id).toBe(1)
    expect(c.getCurrentRequestId()).toBe(1)
    expect(c.isActive(id)).toBe(true)
    const state = c.getState()
    expect(state).toMatchObject({ status: 'loading', stage: 'downloading', progress: 0 })
  })

  it('apply 以正确 requestId 写入状态', () => {
    const c = new LoadSessionController()
    const id = c.start()
    expect(c.apply({ type: 'report-progress', fraction: 0.5 }, id)).toBe('applied')
    expect(c.getState()).toMatchObject({ progress: 0.15 })
  })

  it('apply 以错误 requestId 视为过期（stale），状态不变', () => {
    const c = new LoadSessionController()
    const id = c.start()
    expect(c.apply({ type: 'report-progress', fraction: 0.5 }, id + 999)).toBe('stale')
    expect(c.getState()).toMatchObject({ progress: 0 })
  })

  it('apply 非法转换返回 rejected，状态不变', () => {
    const c = new LoadSessionController()
    const id = c.start()
    // downloading 直接 advance 到 validating（跨阶）非法
    expect(c.apply({ type: 'advance', to: 'validating' }, id)).toBe('rejected')
    expect(c.getState()).toMatchObject({ stage: 'downloading' })
  })

  it('apply start 被拒绝，启动新会话必须经 start()', () => {
    const c = new LoadSessionController()
    const id = c.start()
    const cmd: LoadStateCommand = { type: 'start' }
    expect(c.apply(cmd, id)).toBe('rejected')
    expect(c.getCurrentRequestId()).toBe(id)
  })
})

describe('新会话取代旧会话：旧会话结果不得覆盖当前状态（SPEC §5.4）', () => {
  it('旧会话的进度结果被隔离', () => {
    const c = new LoadSessionController()
    const oldId = c.start()
    c.apply({ type: 'report-progress', fraction: 0.5 }, oldId)
    const newId = c.start()
    expect(newId).toBe(oldId + 1)
    // 新会话重置为 downloading/0
    expect(c.getState()).toMatchObject({ stage: 'downloading', progress: 0 })
    // 旧会话再报进度 → 过期，不影响新会话
    expect(c.apply({ type: 'report-progress', fraction: 0.9 }, oldId)).toBe('stale')
    expect(c.getState()).toMatchObject({ progress: 0 })
    expect(c.isActive(oldId)).toBe(false)
    expect(c.isActive(newId)).toBe(true)
  })

  it('旧会话的成功结果（ready）被隔离，不覆盖新会话', () => {
    const c = new LoadSessionController()
    const oldId = c.start()
    driveToReady(c, oldId)
    expect(c.getState()!.status).toBe('ready')
    const newId = c.start()
    // 新会话从 downloading 重新开始，旧的 ready 不覆盖
    expect(c.getState()).toMatchObject({ status: 'loading', stage: 'downloading' })
    expect(c.isActive(newId)).toBe(true)
    // 旧会话再发 complete → 过期
    expect(c.apply({ type: 'complete' }, oldId)).toBe('stale')
    expect(c.getState()!.status).toBe('loading')
  })

  it('旧会话的失败结果（error）被隔离，不覆盖新会话', () => {
    const c = new LoadSessionController()
    const oldId = c.start()
    // 新会话启动后，旧会话才报错
    const newId = c.start()
    expect(c.apply({ type: 'fail', code: 'JSON_PARSE_FAILED' }, oldId)).toBe('stale')
    expect(c.getState()!.status).toBe('loading')
    expect(c.getState()).toMatchObject({ stage: 'downloading' })
    expect(c.isActive(newId)).toBe(true)
  })

  it('多次 start 只保留最新会话，中间会话全部失效', () => {
    const c = new LoadSessionController()
    const id1 = c.start()
    const id2 = c.start()
    const id3 = c.start()
    expect(c.isActive(id1)).toBe(false)
    expect(c.isActive(id2)).toBe(false)
    expect(c.isActive(id3)).toBe(true)
    c.apply({ type: 'report-progress', fraction: 1 }, id3)
    expect(c.getState()).toMatchObject({ progress: 0.3 })
  })
})

describe('取消会话：不再接收结果，不进入就绪（SPEC §5.4）', () => {
  it('cancel 后即使 requestId 匹配也不再写入', () => {
    const c = new LoadSessionController()
    const id = c.start()
    c.apply({ type: 'report-progress', fraction: 0.3 }, id)
    const frozen = c.getState()
    c.cancel()
    expect(c.isActive(id)).toBe(false)
    expect(c.apply({ type: 'report-progress', fraction: 0.9 }, id)).toBe('stale')
    // 状态冻结在取消前的位置
    expect(c.getState()).toBe(frozen)
  })

  it('cancel 后无法进入 ready', () => {
    const c = new LoadSessionController()
    const id = c.start()
    c.apply({ type: 'report-progress', fraction: 1 }, id)
    c.apply({ type: 'advance', to: 'parsing' }, id)
    c.apply({ type: 'advance', to: 'validating' }, id)
    c.apply({ type: 'report-progress', fraction: 1 }, id)
    c.apply({ type: 'advance', to: 'compiling-nodes' }, id)
    c.apply({ type: 'report-progress', fraction: 1 }, id)
    c.apply({ type: 'advance', to: 'compiling-paths' }, id)
    c.apply({ type: 'report-progress', fraction: 1 }, id)
    c.apply({ type: 'attach-packet', packet: emptyPacket() }, id)
    c.apply({ type: 'report-progress', fraction: 1 }, id)
    c.apply({ type: 'advance', to: 'fading' }, id)
    c.cancel()
    // 取消后 complete 被隔离，不会进入 ready
    expect(c.apply({ type: 'complete' }, id)).toBe('stale')
    expect(c.getState()!.status).toBe('preparing')
    expect(c.getState()).not.toHaveProperty('status', 'ready')
  })

  it('cancel 后新 start 可以开启新有效会话', () => {
    const c = new LoadSessionController()
    const oldId = c.start()
    c.cancel()
    expect(c.isActive(oldId)).toBe(false)
    const newId = c.start()
    expect(newId).toBe(oldId + 1)
    expect(c.isActive(newId)).toBe(true)
    expect(c.getState()).toMatchObject({ stage: 'downloading', progress: 0 })
    c.apply({ type: 'report-progress', fraction: 1 }, newId)
    expect(c.getState()).toMatchObject({ progress: 0.3 })
  })
})

describe('订阅与重复挂载安全（SPEC §5.4）', () => {
  it('subscribe 在状态写入时回调，unsubscribe 后停止', () => {
    const c = new LoadSessionController()
    const events: Array<string | null> = []
    const listener: LoadSessionListener = (s) => {
      events.push(s === null ? null : s.status)
    }
    const unsubscribe = c.subscribe(listener)
    c.start() // loading
    c.apply({ type: 'fail', code: 'ASSET_DOWNLOAD_FAILED' }, c.getCurrentRequestId()) // error
    unsubscribe()
    c.start() // 不应再触发已取消的监听器
    expect(events).toEqual(['loading', 'error'])
  })

  it('subscribe 不立即回调当前状态（契合 useSyncExternalStore 语义）', () => {
    const c = new LoadSessionController()
    c.start()
    let calls = 0
    c.subscribe(() => { calls += 1 })
    expect(calls).toBe(0)
    c.apply({ type: 'report-progress', fraction: 0.5 }, c.getCurrentRequestId())
    expect(calls).toBe(1)
  })

  it('重复订阅同一监听器引用只回调一次（StrictMode 重复挂载安全）', () => {
    const c = new LoadSessionController()
    let calls = 0
    const listener: LoadSessionListener = () => { calls += 1 }
    const u1 = c.subscribe(listener)
    const u2 = c.subscribe(listener)
    c.start()
    expect(calls).toBe(1)
    u1()
    c.apply({ type: 'report-progress', fraction: 0.5 }, c.getCurrentRequestId())
    // u1/u2 指向同一引用，Set 中只有一个；u1 移除后不再回调
    expect(calls).toBe(1)
    u2()
  })

  it('多实例控制器互不干扰（无隐式全局状态）', () => {
    const a = new LoadSessionController()
    const b = new LoadSessionController()
    const idA = a.start()
    const idB = b.start()
    expect(idA).toBe(1)
    expect(idB).toBe(1)
    a.apply({ type: 'report-progress', fraction: 1 }, idA)
    expect(a.getState()).toMatchObject({ progress: 0.3 })
    expect(b.getState()).toMatchObject({ progress: 0 })
    b.cancel()
    // b 取消不影响 a
    expect(a.isActive(idA)).toBe(true)
    expect(b.isActive(idB)).toBe(false)
  })
})
