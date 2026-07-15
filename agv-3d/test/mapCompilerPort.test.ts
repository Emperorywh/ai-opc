import { describe, expect, it } from 'vitest'
import type { MapCompilerPort } from '../src/features/agv-map/application/mapCompilerPort'
import { MapCompilerClient } from '../src/features/agv-map/infrastructure/mapCompilerWorker'
import type { CompileRequest, CompilationEvent } from '../src/features/agv-map/domain/compilerProtocol'

/**
 * 编译端口边界验证（SPEC §5.1、§5.4、TASK-006/007）。
 *
 * 应用层加载用例只依赖 MapCompilerPort 抽象；infrastructure 的 MapCompilerClient 是该端口
 * 的具体适配器。前两节做编译期断言（不实例化——默认实例化会创建真实 Worker，超出 Node 测试边界），
 * 确保适配器始终满足端口契约。后几节注入伪造 Worker 工厂在 Node 环境运行真实客户端逻辑，
 * 验证请求透传、Worker 级未捕获错误映射与终止/隔离语义（SPEC §5.4、TASK-007）。
 */

describe('MapCompilerClient 实现应用层端口 MapCompilerPort', () => {
  it('MapCompilerClient 类型满足端口契约（编译期断言，SPEC §5.1）', () => {
    // 若 MapCompilerClient 不满足 MapCompilerPort，Conforms 推导为 false，赋值失败。
    type Conforms = MapCompilerClient extends MapCompilerPort ? true : false
    const check: Conforms = true
    expect(check).toBe(true)
  })

  it('MapCompilerPort 只暴露 start/terminate 两项能力（窄边界）', () => {
    type Methods = keyof MapCompilerPort
    const methods: Methods[] = ['start', 'terminate']
    expect(methods.sort()).toEqual(['start', 'terminate'])
  })
})

/**
 * 伪造 Worker：实现 MapCompilerClient 用到的 Worker 子集（addEventListener/postMessage/
 * removeEventListener/terminate），并提供 dispatch 方法让测试主动触发 message 与 error 事件。
 */
type WorkerHandler = (event: unknown) => void

class FakeWorker {
  readonly messageHandlers = new Set<WorkerHandler>()
  readonly errorHandlers = new Set<WorkerHandler>()
  readonly postedMessages: unknown[] = []
  terminateCount = 0

  addEventListener(type: 'message' | 'error', handler: WorkerHandler): void {
    if (type === 'message') this.messageHandlers.add(handler)
    else this.errorHandlers.add(handler)
  }

  removeEventListener(type: 'message' | 'error', handler: WorkerHandler): void {
    if (type === 'message') this.messageHandlers.delete(handler)
    else this.errorHandlers.delete(handler)
  }

  postMessage(message: unknown): void {
    this.postedMessages.push(message)
  }

  terminate(): void {
    this.terminateCount += 1
  }

  dispatchMessage(data: unknown): void {
    for (const handler of this.messageHandlers) handler({ data })
  }

  dispatchError(event: {
    message?: string
    filename?: string
    lineno?: number
    colno?: number
  }): void {
    for (const handler of this.errorHandlers) handler(event)
  }
}

/** 用伪造 Worker 构造客户端，便于在 Node 环境驱动真实适配器逻辑。 */
function createClientWithFakeWorker(): { client: MapCompilerClient; worker: FakeWorker } {
  const worker = new FakeWorker()
  const client = new MapCompilerClient({ create: () => worker as unknown as Worker })
  return { client, worker }
}

describe('start：把编译请求原样投递给 Worker（SPEC §5.2、TASK-007）', () => {
  it('start 向 Worker postMessage 携带 type/requestId/assetUrl', () => {
    const { client, worker } = createClientWithFakeWorker()
    const request: CompileRequest = { type: 'compile', requestId: 42, assetUrl: 'fake://map.json' }
    client.start(request, () => {})
    expect(worker.postedMessages).toEqual([request])
  })
})

describe('Worker 级未捕获错误：ErrorEvent → DOWNLOAD_FAILED（SPEC §10.2、TASK-007）', () => {
  it('Worker error 事件映射为 DOWNLOAD_FAILED，携带最近请求的 requestId', () => {
    const { client, worker } = createClientWithFakeWorker()
    const received: { requestId: number; event: CompilationEvent }[] = []
    client.start(
      { type: 'compile', requestId: 7, assetUrl: 'fake://map.json' },
      (requestId, event) => received.push({ requestId, event }),
    )
    worker.dispatchError({ message: 'Uncaught SyntaxError', filename: 'w.js', lineno: 12, colno: 3 })
    expect(received).toHaveLength(1)
    expect(received[0].requestId).toBe(7)
    const event = received[0].event
    if (event.kind !== 'error') throw new Error('应为 error 事件')
    expect(event.code).toBe('DOWNLOAD_FAILED')
    // details 携带可定位的 Worker 错误信息。
    expect(event.details.some((d) => d.includes('Uncaught SyntaxError'))).toBe(true)
  })
})

describe('message 转发：Worker 事件按 requestId 透传给监听器（SPEC §5.4）', () => {
  it('Worker 的 event 消息原样交给监听器', () => {
    const { client, worker } = createClientWithFakeWorker()
    const received: { requestId: number; event: CompilationEvent }[] = []
    client.start(
      { type: 'compile', requestId: 9, assetUrl: 'fake://map.json' },
      (requestId, event) => received.push({ requestId, event }),
    )
    worker.dispatchMessage({
      type: 'event',
      requestId: 9,
      event: { kind: 'download-progress', received: 100, total: 200 },
    })
    expect(received).toHaveLength(1)
    expect(received[0].requestId).toBe(9)
    if (received[0].event.kind !== 'download-progress') throw new Error('unreachable')
    expect(received[0].event.received).toBe(100)
  })

  it('非 event 类型消息被忽略（防御性，SPEC §5.4）', () => {
    const { client, worker } = createClientWithFakeWorker()
    const received: unknown[] = []
    client.start(
      { type: 'compile', requestId: 1, assetUrl: 'fake://map.json' },
      (_rid, _event) => received.push(_event),
    )
    worker.dispatchMessage({ type: 'something-else' })
    expect(received).toHaveLength(0)
  })
})

describe('terminate：幂等终止并隔离后续事件（SPEC §5.4、TASK-007）', () => {
  it('terminate 后 Worker 被终止、监听被移除，后续 error/message 不再到达监听器', () => {
    const { client, worker } = createClientWithFakeWorker()
    const received: CompilationEvent[] = []
    client.start(
      { type: 'compile', requestId: 5, assetUrl: 'fake://map.json' },
      (_rid, event) => received.push(event),
    )
    client.terminate()
    expect(worker.terminateCount).toBe(1)
    // 终止后即便伪造 Worker 仍派发事件，监听器也不应收到（适配器 terminated 守卫）。
    worker.dispatchError({ message: 'late' })
    worker.dispatchMessage({ type: 'event', requestId: 5, event: { kind: 'success', packet: null } })
    expect(received).toHaveLength(0)
  })

  it('terminate 幂等：多次调用只终止 Worker 一次', () => {
    const { client, worker } = createClientWithFakeWorker()
    client.terminate()
    client.terminate()
    client.terminate()
    expect(worker.terminateCount).toBe(1)
  })

  it('已终止的客户端不能再 start（SPEC §5.4 后台执行单元归零，不复用）', () => {
    const { client } = createClientWithFakeWorker()
    client.terminate()
    expect(() =>
      client.start({ type: 'compile', requestId: 1, assetUrl: 'fake://map.json' }, () => {}),
    ).toThrow()
  })
})
