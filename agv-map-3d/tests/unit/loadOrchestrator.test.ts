/*
 * 应用加载状态机自动化验证（TASK-016，SPEC 4.2 / 4.3 / 13 / 14.1 / 15.3）。
 *
 * 设计（任务“以可控 worker、资源和字体端口启动请求，不启动浏览器”）：
 *   - 注入三类纯内存端口：FakeWorkerPort（按需 emit progress / success / failure）、
 *     FakeResourceFactory（延迟 resolve / reject 资源）、FakeFontPort（延迟 resolve / reject 字体回调）。
 *   - 正常路径：状态严格经历 idle → loading → preparing → ready，ready 同时持有 model + 资源。
 *   - 门禁顺序：资源与字体完成顺序互换，最后一道门禁完成前始终保持 preparing，且只提交一次 ready。
 *   - 竞态：连续发起两个请求，旧请求在新请求之后返回 success / failure / 字体回调，全部被忽略；
 *     旧 worker 被终止、过期资源被释放、当前状态不被覆盖。
 *   - 各阶段错误：worker fetch / data 失败、资源创建失败、字体缺字 / 加载失败 → 对应稳定错误码的 error，
 *     且释放部分资源、不保留部分地图。
 *   - 生命周期：20 次启动 → ready → 卸载，worker / 资源 / 订阅计数不单调增长；
 *     重新加载使用更大的 requestId 并可正常 ready。
 *
 * 不启动浏览器：全部经注入端口在 node 驱动；不创建真实 Worker / Three / Troika / React 对象。
 */
import { describe, test, expect, beforeEach } from 'vitest'
import { LoadOrchestrator } from '../../src/application/loadOrchestrator'
import type {
  LoadFontConfig,
  MapResourceFactoryPort,
  SceneBuildWorkerPort,
} from '../../src/application/loadPorts'
import type {
  DisposableResource,
  LoadState,
} from '../../src/application/loadState'
import type { LabelFontPreloadPort } from '../../src/labels/fontPreload'
import type { SceneModel } from '../../src/workers/buildSceneModel'
import type {
  SceneBuildMessage,
  SceneBuildRequestId,
} from '../../src/workers/sceneBuildProtocol'
import {
  SCENE_BUILD_PHASE,
  SCENE_BUILD_STAGE,
} from '../../src/workers/sceneBuildProtocol'
import { MapErrorCode } from '../../src/domain/mapDataError'

// ─── 测试基础设施（可控端口与资源桩）──────────────────────────────────────────

/*
 * 可释放资源桩：记录 dispose 次数，用于断言“部分资源已释放 / 不泄漏”。
 */
class FakeResource implements DisposableResource {
  static created = 0
  static disposed = 0
  readonly id: number
  constructor() {
    this.id = ++FakeResource.created
  }
  dispose(): void {
    FakeResource.disposed++
  }
}

/*
 * 可控 worker 端口：捕获 onMessage，暴露 emit 按需投递消息，统计 start / terminate 次数。
 * 不发起真实 fetch、不创建 Worker；terminate 后不再向旧 onMessage 投递（模拟 worker 终止）。
 */
class FakeWorkerPort implements SceneBuildWorkerPort {
  private handler: ((message: SceneBuildMessage) => void) | null = null
  startCount = 0
  terminateCount = 0
  lastRequestId: SceneBuildRequestId | null = null

  start(
    requestId: SceneBuildRequestId,
    onMessage: (message: SceneBuildMessage) => void,
  ): void {
    // 模拟“创建新 worker 前旧 worker 已被 terminate”：复用同一 handler 槽位。
    this.handler = onMessage
    this.lastRequestId = requestId
    this.startCount++
  }
  terminate(): void {
    if (this.handler !== null) {
      this.handler = null
      this.terminateCount++
    }
  }
  get isRunning(): boolean {
    return this.handler !== null
  }
  emit(message: SceneBuildMessage): void {
    if (this.handler === null) return
    this.handler(message)
  }
}

/*
 * 可控资源工厂：create 返回受控 Promise，允许测试择机 resolve / reject。
 */
class FakeResourceFactory implements MapResourceFactoryPort<FakeResource> {
  createCount = 0
  private pending: Array<{
    readonly resolve: (r: FakeResource) => void
    readonly reject: (e: unknown) => void
  }> = []

  create(_model: SceneModel): Promise<FakeResource> {
    this.createCount++
    return new Promise<FakeResource>((resolve, reject) => {
      this.pending.push({ resolve, reject })
    })
  }
  resolveLast(): FakeResource {
    const resource = new FakeResource()
    this.pending.pop()?.resolve(resource)
    return resource
  }
  rejectLast(err: unknown): void {
    this.pending.pop()?.reject(err)
  }
  get pendingCount(): number {
    return this.pending.length
  }
}

/*
 * 可控字体端口（LabelFontPreloadPort）：捕获调用，允许测试择机 fire 成功 / 失败回调。
 */
class FakeFontPort implements LabelFontPreloadPort {
  callCount = 0
  private pending: Array<(err: unknown | null) => void> = []

  preloadFont(
    _options: { readonly font: string; readonly characters: string; readonly sdfGlyphSize: number },
    onDone: (err: unknown | null) => void,
  ): void {
    this.callCount++
    this.pending.push(onDone)
  }
  resolveLast(): void {
    this.pending.pop()?.(null)
  }
  rejectLast(err: unknown): void {
    this.pending.pop()?.(err)
  }
  get pendingCount(): number {
    return this.pending.length
  }
}

/*
 * 构造最小 SceneModel：资源工厂为桩，不校验内部；orchestrator 只读 model.labels。
 * 标签文本默认 'A'（U+0041），manifest 覆盖之，确保字体门禁不因缺字失败。
 */
function makeModel(
  labels: ReadonlyArray<{ readonly id: string; readonly text: string }> = [
    { id: 'l1', text: 'A' },
  ],
): SceneModel {
  return {
    metadata: { mapId: 'synth-map', mapName: '合成地图', version: 'V1' },
    transform: { absoluteWorldOriginX: 0, absoluteWorldOriginZ: 0 },
    nodeMatrices: new Float32Array(0),
    nodeColors: new Float32Array(0),
    nodeArrowMatrices: new Float32Array(0),
    nodeArrowColors: new Float32Array(0),
    edgeArrowMatrices: new Float32Array(0),
    edgeArrowColors: new Float32Array(0),
    ribbonPositions: new Float32Array(0),
    ribbonColors: new Float32Array(0),
    labels: labels.map((l) => ({
      id: l.id,
      ownerId: l.id,
      kind: 'node' as const,
      text: l.text,
      anchorX: 0,
      anchorY: 0.25,
      anchorZ: 0,
      localOffsetX: 0,
      localOffsetY: 0,
    })),
    contentBounds: {
      minX: 0,
      minY: 0,
      minZ: 0,
      maxX: 0,
      maxY: 0,
      maxZ: 0,
    },
    diagnostics: {
      nodeCount: 0,
      nodeArrowCount: 0,
      edgeArrowCount: 0,
      ribbonVertexCount: 0,
      labelCandidateCount: labels.length,
      pairedTrackCount: 0,
    },
  }
}

/*
 * 覆盖给定标签文本码点的 manifest 集合（保证字体覆盖门禁通过）。
 */
function manifestFor(texts: readonly string[]): Set<number> {
  const set = new Set<number>()
  for (const t of texts) {
    for (const ch of t) set.add(ch.codePointAt(0) as number)
  }
  return set
}

/*
 * 测试夹具：聚合三类端口 + 一个新建编排器，统一 fontConfig。
 */
function makeFixture(texts: readonly string[] = ['A']): {
  readonly worker: FakeWorkerPort
  readonly factory: FakeResourceFactory
  readonly font: FakeFontPort
  readonly orchestrator: LoadOrchestrator<FakeResource>
} {
  const worker = new FakeWorkerPort()
  const factory = new FakeResourceFactory()
  const font = new FakeFontPort()
  const fontConfig: LoadFontConfig = {
    manifestCodePoints: manifestFor(texts),
    fontUrl: '/fonts/NotoSansSC-Bold.sample.woff',
    sdfGlyphSize: 64,
  }
  const orchestrator = new LoadOrchestrator<FakeResource>({
    workerPort: worker,
    resourceFactory: factory,
    fontPort: font,
    fontConfig,
  })
  return { worker, factory, font, orchestrator }
}

/*
 * 等待一个微任务轮次，让 Promise.then / preloadLabelFont 的异步回调落地。
 */
function flushMicrotasks(): Promise<void> {
  return Promise.resolve()
}

// ─── 正常路径 · idle → loading → preparing → ready（SPEC 4.2）──────────────────

// 每个用例前重置资源桩静态计数器，避免跨用例累计污染（created / disposed 在文件内是共享静态字段）。
beforeEach(() => {
  FakeResource.created = 0
  FakeResource.disposed = 0
})

describe('正常路径 · 状态严格经历 idle → loading → preparing → ready（SPEC 4.2）', () => {
  test('start 后进入 loading，worker 消息驱动到 preparing，三道门禁齐备后进入 ready', async () => {
    const { worker, factory, font, orchestrator } = makeFixture()
    const states: LoadState<FakeResource>[] = []
    orchestrator.subscribe((s) => states.push(s.kind))

    expect(orchestrator.getState().kind).toBe('idle')
    orchestrator.start()
    expect(orchestrator.getState().kind).toBe('loading')
    expect(worker.startCount).toBe(1)

    worker.emit({
      type: 'progress',
      requestId: 1,
      phase: SCENE_BUILD_PHASE.LOADING,
      stage: null,
    })
    expect(orchestrator.getState().kind).toBe('loading')

    worker.emit({
      type: 'progress',
      requestId: 1,
      phase: SCENE_BUILD_PHASE.PREPARING,
      stage: SCENE_BUILD_STAGE.PARSING,
    })
    const preparing = orchestrator.getState()
    expect(preparing.kind).toBe('preparing')
    if (preparing.kind === 'preparing') {
      expect(preparing.stage).toBe(SCENE_BUILD_STAGE.PARSING)
      expect(preparing.model).toBeNull()
      expect(preparing.resources).toBeNull()
      expect(preparing.fontReady).toBe(false)
    }

    const model = makeModel()
    worker.emit({ type: 'success', requestId: 1, model, timings: { fetch: 0, parse: 0, validate: 0, build: 0 } })
    await flushMicrotasks()
    // model 已到达，资源 / 字体两道门禁已并发启动但尚未完成 → 仍 preparing。
    expect(orchestrator.getState().kind).toBe('preparing')
    expect(factory.createCount).toBe(1)
    expect(font.callCount).toBe(1)

    // 先完成资源门禁：仍 preparing（字体未就绪）。
    const resource = factory.resolveLast()
    await flushMicrotasks()
    expect(orchestrator.getState().kind).toBe('preparing')

    // 再完成字体门禁：三道齐备 → ready。
    font.resolveLast()
    await flushMicrotasks()
    const ready = orchestrator.getState()
    expect(ready.kind).toBe('ready')
    if (ready.kind === 'ready') {
      expect(ready.model).toBe(model)
      expect(ready.resources).toBe(resource)
      expect(ready.requestId).toBe(1)
    }

    // 状态序列严格经历 idle → loading → preparing → ready（preparing 期间多次通知）。
    expect(states[0]).toBe('loading')
    expect(states.includes('preparing')).toBe(true)
    expect(states[states.length - 1]).toBe('ready')
    expect(states.includes('error')).toBe(false)
  })
})

// ─── 门禁顺序 · 资源与字体完成顺序互换（任务约束）──────────────────────────────

describe('门禁顺序 · 最后一道门禁完成前始终保持 preparing（任务约束）', () => {
  test('字体先就绪、资源后完成：仍只提交一次 ready', async () => {
    const { worker, factory, font, orchestrator } = makeFixture()
    let readyCount = 0
    orchestrator.subscribe((s) => {
      if (s.kind === 'ready') readyCount++
    })

    orchestrator.start()
    worker.emit({ type: 'progress', requestId: 1, phase: SCENE_BUILD_PHASE.PREPARING, stage: SCENE_BUILD_STAGE.BUILDING })
    worker.emit({ type: 'success', requestId: 1, model: makeModel(), timings: { fetch: 0, parse: 0, validate: 0, build: 0 } })
    await flushMicrotasks()
    expect(orchestrator.getState().kind).toBe('preparing')

    // 字体先就绪：仍 preparing（资源未就绪）。
    font.resolveLast()
    await flushMicrotasks()
    expect(orchestrator.getState().kind).toBe('preparing')

    // 资源后完成：三道齐备 → ready。
    factory.resolveLast()
    await flushMicrotasks()
    expect(orchestrator.getState().kind).toBe('ready')
    expect(readyCount).toBe(1)
  })

  test('资源与字体同时挂起时，任一单独完成都不会越门禁进入 ready', async () => {
    const { worker, factory, font, orchestrator } = makeFixture()
    orchestrator.start()
    worker.emit({ type: 'progress', requestId: 1, phase: SCENE_BUILD_PHASE.PREPARING, stage: null })
    worker.emit({ type: 'success', requestId: 1, model: makeModel(), timings: { fetch: 0, parse: 0, validate: 0, build: 0 } })
    await flushMicrotasks()

    factory.resolveLast()
    await flushMicrotasks()
    expect(orchestrator.getState().kind).toBe('preparing')
    font.resolveLast()
    await flushMicrotasks()
    expect(orchestrator.getState().kind).toBe('ready')
  })
})

// ─── 竞态 · 过期 worker / 资源 / 字体结果被忽略（SPEC 4.2 / 任务约束）──────────

describe('竞态 · 旧请求在新请求之后返回的结果全部被忽略（SPEC 4.2 / 任务约束）', () => {
  test('旧 worker success / failure / 字体回调均不覆盖当前请求；旧 worker 被终止', async () => {
    const { worker, factory, font, orchestrator } = makeFixture()
    orchestrator.start() // requestId = 1
    expect(worker.startCount).toBe(1)
    worker.emit({ type: 'progress', requestId: 1, phase: SCENE_BUILD_PHASE.PREPARING, stage: null })
    worker.emit({ type: 'success', requestId: 1, model: makeModel(), timings: { fetch: 0, parse: 0, validate: 0, build: 0 } })
    await flushMicrotasks()
    // 请求 1 的资源 / 字体门禁挂起中。
    expect(factory.pendingCount).toBe(1)
    expect(font.pendingCount).toBe(1)

    // 发起第二个请求：旧 worker 终止、新 worker 启动。
    orchestrator.start() // requestId = 2
    expect(worker.startCount).toBe(2)
    expect(worker.terminateCount).toBe(1)

    // 旧请求 1 的资源 resolve：过期 → 直接释放，不进入状态。
    const staleResource = factory.resolveLast()
    await flushMicrotasks()
    expect(staleResource.id).toBeGreaterThanOrEqual(1)
    // 过期资源被直接 dispose（任务不变量：过期成功结果不得进入资源适配或状态）。
    expect(FakeResource.disposed).toBe(1)
    // 当前状态仍为 loading（请求 2 尚未到达 model）。
    expect(orchestrator.getState().kind).toBe('loading')

    // 旧请求 1 的字体 resolve：过期 → 忽略。
    font.resolveLast()
    await flushMicrotasks()
    expect(orchestrator.getState().kind).toBe('loading')

    // 旧 worker 投递过期 success（requestId=1）：忽略，不存储 model、不启动准备。
    worker.emit({ type: 'success', requestId: 1, model: makeModel(), timings: { fetch: 0, parse: 0, validate: 0, build: 0 } })
    await flushMicrotasks()
    expect(factory.createCount).toBe(1) // 未因过期 success 再次创建资源
    expect(orchestrator.getState().kind).toBe('loading')

    // 旧 worker 投递过期 failure（requestId=1）：忽略，不进入 error。
    worker.emit({
      type: 'failure',
      requestId: 1,
      code: MapErrorCode.SAMPLE_FETCH_FAILED,
      phase: SCENE_BUILD_PHASE.LOADING,
      failureStage: 'fetch',
      message: '过期失败',
      jsonPath: '$',
      entityId: null,
      context: null,
    })
    expect(orchestrator.getState().kind).toBe('loading')

    // 当前请求 2 正常推进到 ready。
    worker.emit({ type: 'progress', requestId: 2, phase: SCENE_BUILD_PHASE.PREPARING, stage: null })
    worker.emit({ type: 'success', requestId: 2, model: makeModel(), timings: { fetch: 0, parse: 0, validate: 0, build: 0 } })
    await flushMicrotasks()
    factory.resolveLast()
    font.resolveLast()
    await flushMicrotasks()
    const ready = orchestrator.getState()
    expect(ready.kind).toBe('ready')
    if (ready.kind === 'ready') {
      expect(ready.requestId).toBe(2) // 当前请求，未被旧请求覆盖
    }
  })

  test('过期 worker success 的 model 不进入资源适配（引用脱离状态、可被回收）', async () => {
    const { worker, factory, orchestrator } = makeFixture()
    orchestrator.start() // requestId = 1
    orchestrator.start() // requestId = 2（取代请求 1）
    // 为请求 1 投递过期 success：不应触发资源创建。
    worker.emit({ type: 'success', requestId: 1, model: makeModel(), timings: { fetch: 0, parse: 0, validate: 0, build: 0 } })
    await flushMicrotasks()
    expect(factory.createCount).toBe(0)
    expect(orchestrator.getState().kind).toBe('loading')
  })
})

// ─── 兜底安全 · error 后迟到回调 / dispose 后在途回调（任务约束）──────────────────

describe('兜底安全 · error 后迟到回调与 dispose 后在途回调不破坏状态、不泄漏资源（任务约束）', () => {
  test('资源失败进入 error 后，迟到的字体回调（同 requestId）不覆盖 error 状态', async () => {
    const { worker, factory, font, orchestrator } = makeFixture()
    let errorCount = 0
    let lastErrorPhase: string | null = null
    orchestrator.subscribe((s) => {
      if (s.kind === 'error') {
        errorCount++
        lastErrorPhase = s.phase
      }
    })

    orchestrator.start()
    worker.emit({ type: 'progress', requestId: 1, phase: SCENE_BUILD_PHASE.PREPARING, stage: null })
    worker.emit({ type: 'success', requestId: 1, model: makeModel(), timings: { fetch: 0, parse: 0, validate: 0, build: 0 } })
    await flushMicrotasks()
    // 资源 / 字体两道门禁挂起中。

    // 资源先失败 → error（preparing / resource）。
    factory.rejectLast(new Error('boom'))
    await flushMicrotasks()
    expect(orchestrator.getState().kind).toBe('error')

    // 字体随后 resolve（requestId 仍为当前）：reducer 对非 preparing 状态忽略，不覆盖 error。
    font.resolveLast()
    await flushMicrotasks()
    const s = orchestrator.getState()
    expect(s.kind).toBe('error')
    if (s.kind === 'error') {
      expect(s.failureStage).toBe('resource') // 仍是资源失败的阶段，未被字体回调改写
      expect(s.phase).toBe(SCENE_BUILD_PHASE.PREPARING)
    }
    expect(errorCount).toBe(1) // 只提交一次 error
    expect(lastErrorPhase).toBe(SCENE_BUILD_PHASE.PREPARING)
  })

  test('dispose 后在途资源 resolve：资源被直接释放，不进入状态、不泄漏', async () => {
    const { worker, factory, font, orchestrator } = makeFixture()
    orchestrator.start()
    worker.emit({ type: 'progress', requestId: 1, phase: SCENE_BUILD_PHASE.PREPARING, stage: null })
    worker.emit({ type: 'success', requestId: 1, model: makeModel(), timings: { fetch: 0, parse: 0, validate: 0, build: 0 } })
    await flushMicrotasks()
    // 资源 / 字体两道门禁挂起中。
    const createdBeforeDispose = FakeResource.created
    const disposedBeforeDispose = FakeResource.disposed

    // 卸载：abort 回到 idle，listeners 清空；此时资源 Promise 仍在途。
    orchestrator.dispose()
    expect(orchestrator.getState().kind).toBe('idle')

    // 在途资源随后 resolve：disposed 检查命中 → 直接 dispose，不进入状态、不派发事件。
    factory.resolveLast()
    await flushMicrotasks()
    expect(FakeResource.created).toBe(createdBeforeDispose + 1)
    expect(FakeResource.disposed).toBe(disposedBeforeDispose + 1) // 卸载后在途资源被释放
    expect(orchestrator.getState().kind).toBe('idle')

    // 在途字体回调随后到达：同样被忽略，不改变 idle 状态。
    font.resolveLast()
    await flushMicrotasks()
    expect(orchestrator.getState().kind).toBe('idle')
  })

  test('dispose 后在途资源 reject：静默忽略，不为已卸载编排器派发 error', async () => {
    const { worker, factory, orchestrator } = makeFixture()
    orchestrator.start()
    worker.emit({ type: 'progress', requestId: 1, phase: SCENE_BUILD_PHASE.PREPARING, stage: null })
    worker.emit({ type: 'success', requestId: 1, model: makeModel(), timings: { fetch: 0, parse: 0, validate: 0, build: 0 } })
    await flushMicrotasks()

    orchestrator.dispose()
    expect(orchestrator.getState().kind).toBe('idle')

    // 在途资源 reject：disposed 检查命中 → 忽略，不进入 error。
    factory.rejectLast(new Error('late failure'))
    await flushMicrotasks()
    expect(orchestrator.getState().kind).toBe('idle')
  })
})

// ─── 各阶段错误 · 进入带稳定错误码的 error（SPEC 14.1 / 任务约束）──────────────

describe('各阶段错误 · 进入带稳定错误码的 error 并释放部分资源（SPEC 14.1）', () => {
  test('worker fetch 失败 → SAMPLE_FETCH_FAILED, 阶段 loading / fetch', () => {
    const { worker, orchestrator } = makeFixture()
    orchestrator.start()
    worker.emit({
      type: 'failure',
      requestId: 1,
      code: MapErrorCode.SAMPLE_FETCH_FAILED,
      phase: SCENE_BUILD_PHASE.LOADING,
      failureStage: 'fetch',
      message: '样本请求失败',
      jsonPath: '$',
      entityId: null,
      context: { status: 500 },
    })
    const s = orchestrator.getState()
    expect(s.kind).toBe('error')
    if (s.kind === 'error') {
      expect(s.error.code).toBe(MapErrorCode.SAMPLE_FETCH_FAILED)
      expect(s.error.message).toContain('样本请求失败')
      // worker 失败原样透传 phase / failureStage（SPEC 14.1 overlay 据此显示阶段）。
      expect(s.phase).toBe(SCENE_BUILD_PHASE.LOADING)
      expect(s.failureStage).toBe('fetch')
    }
  })

  test('worker 数据校验失败 → MAP_ENTITY_INVALID, 保留 entityId 与 preparing / validate 阶段', () => {
    const { worker, orchestrator } = makeFixture()
    orchestrator.start()
    worker.emit({
      type: 'failure',
      requestId: 1,
      code: MapErrorCode.MAP_ENTITY_INVALID,
      phase: SCENE_BUILD_PHASE.PREPARING,
      failureStage: 'validate',
      message: '未知节点类型',
      jsonPath: '$.nodes[2].type',
      entityId: 'bad',
      context: null,
    })
    const s = orchestrator.getState()
    expect(s.kind).toBe('error')
    if (s.kind === 'error') {
      expect(s.error.code).toBe(MapErrorCode.MAP_ENTITY_INVALID)
      expect(s.error.entityId).toBe('bad')
      expect(s.error.jsonPath).toContain('type')
      expect(s.phase).toBe(SCENE_BUILD_PHASE.PREPARING)
      expect(s.failureStage).toBe('validate')
    }
  })

  test('资源创建失败 → MAP_GEOMETRY_INVALID, 不保留部分地图资源', async () => {
    const { worker, factory, orchestrator } = makeFixture()
    orchestrator.start()
    worker.emit({ type: 'progress', requestId: 1, phase: SCENE_BUILD_PHASE.PREPARING, stage: null })
    worker.emit({ type: 'success', requestId: 1, model: makeModel(), timings: { fetch: 0, parse: 0, validate: 0, build: 0 } })
    await flushMicrotasks()

    factory.rejectLast(new Error('geometry upload failed'))
    await flushMicrotasks()
    const s = orchestrator.getState()
    expect(s.kind).toBe('error')
    if (s.kind === 'error') {
      expect(s.error.code).toBe(MapErrorCode.MAP_GEOMETRY_INVALID)
      // 资源失败补登记统一阶段：preparing / resource（SPEC 14.1 overlay 不必凭 code 反推阶段）。
      expect(s.phase).toBe(SCENE_BUILD_PHASE.PREPARING)
      expect(s.failureStage).toBe('resource')
      // error 状态不携带可展示的部分地图资源（结构上无 resources 字段）。
      expect((s as { resources?: unknown }).resources).toBeUndefined()
    }
  })

  test('字体缺字 → FONT_GLYPH_MISSING, 字体端口不被调用', async () => {
    // manifest 故意不覆盖文本字符，触发字形覆盖门禁。
    const worker = new FakeWorkerPort()
    const factory = new FakeResourceFactory()
    const font = new FakeFontPort()
    const orchestrator = new LoadOrchestrator<FakeResource>({
      workerPort: worker,
      resourceFactory: factory,
      fontPort: font,
      fontConfig: {
        manifestCodePoints: new Set<number>([0x41]), // 只覆盖 A
        fontUrl: '/fonts/NotoSansSC-Bold.sample.woff',
        sdfGlyphSize: 64,
      },
    })
    orchestrator.start()
    worker.emit({ type: 'progress', requestId: 1, phase: SCENE_BUILD_PHASE.PREPARING, stage: null })
    // 标签含未覆盖的 'B'（U+0042）。
    worker.emit({
      type: 'success',
      requestId: 1,
      model: makeModel([{ id: 'l1', text: 'AB' }]),
      timings: { fetch: 0, parse: 0, validate: 0, build: 0 },
    })
    await flushMicrotasks()
    // 覆盖门禁先于端口：字体端口未被调用。
    expect(font.callCount).toBe(0)
    const s = orchestrator.getState()
    expect(s.kind).toBe('error')
    if (s.kind === 'error') {
      expect(s.error.code).toBe(MapErrorCode.FONT_GLYPH_MISSING)
      // 字体失败统一登记 preparing / font 阶段；细粒度 coverage 已写入 error.context。
      expect(s.phase).toBe(SCENE_BUILD_PHASE.PREPARING)
      expect(s.failureStage).toBe('font')
    }
  })

  test('字体资产加载失败 → FONT_ASSET_FAILED, 不切换系统/远端字体', async () => {
    const { worker, font, orchestrator } = makeFixture()
    orchestrator.start()
    worker.emit({ type: 'progress', requestId: 1, phase: SCENE_BUILD_PHASE.PREPARING, stage: null })
    worker.emit({ type: 'success', requestId: 1, model: makeModel(), timings: { fetch: 0, parse: 0, validate: 0, build: 0 } })
    await flushMicrotasks()

    font.rejectLast(new Error('woff parse failure'))
    await flushMicrotasks()
    const s = orchestrator.getState()
    expect(s.kind).toBe('error')
    if (s.kind === 'error') {
      expect(s.error.code).toBe(MapErrorCode.FONT_ASSET_FAILED)
      expect(s.phase).toBe(SCENE_BUILD_PHASE.PREPARING)
      expect(s.failureStage).toBe('font')
    }
  })
})

// ─── 重试 · 从 error 以新的 requestId 重新进入 loading（任务约束）────────────────

describe('重试 · 不复用失败请求的可变对象，使用新的 requestId（任务约束）', () => {
  test('error 后 retry 重新进入 loading 并可正常 ready', async () => {
    const { worker, factory, font, orchestrator } = makeFixture()
    orchestrator.start()
    worker.emit({
      type: 'failure',
      requestId: 1,
      code: MapErrorCode.SAMPLE_FETCH_FAILED,
      phase: SCENE_BUILD_PHASE.LOADING,
      failureStage: 'fetch',
      message: '失败',
      jsonPath: '$',
      entityId: null,
      context: null,
    })
    expect(orchestrator.getState().kind).toBe('error')

    orchestrator.retry() // 新 requestId = 2
    expect(worker.startCount).toBe(2)
    expect(orchestrator.getState().kind).toBe('loading')
    const loading = orchestrator.getState()
    if (loading.kind === 'loading') {
      expect(loading.requestId).toBe(2)
    }

    worker.emit({ type: 'progress', requestId: 2, phase: SCENE_BUILD_PHASE.PREPARING, stage: null })
    worker.emit({ type: 'success', requestId: 2, model: makeModel(), timings: { fetch: 0, parse: 0, validate: 0, build: 0 } })
    await flushMicrotasks()
    factory.resolveLast()
    font.resolveLast()
    await flushMicrotasks()
    const ready = orchestrator.getState()
    expect(ready.kind).toBe('ready')
    if (ready.kind === 'ready') {
      expect(ready.requestId).toBe(2)
    }
  })
})

// ─── 生命周期 · 20 次挂载/卸载计数不增长 + 重新加载（SPEC 4.3 / 任务约束）──────

describe('生命周期 · 20 次启动/卸载计数不单调增长 + 重新加载（SPEC 4.3 / 任务约束）', () => {
  test('20 次（启动 → ready → 卸载）：worker / 资源 / 订阅计数平衡，无泄漏', async () => {
    // 共享端口与计数器：跨 20 个独立编排器实例累计观察“不单调增长”。
    const sharedWorker = new FakeWorkerPort()
    const sharedFactory = new FakeResourceFactory()
    const sharedFont = new FakeFontPort()
    const fontConfig: LoadFontConfig = {
      manifestCodePoints: manifestFor(['A']),
      fontUrl: '/fonts/NotoSansSC-Bold.sample.woff',
      sdfGlyphSize: 64,
    }

    for (let i = 0; i < 20; i++) {
      const orchestrator = new LoadOrchestrator<FakeResource>({
        workerPort: sharedWorker,
        resourceFactory: sharedFactory,
        fontPort: sharedFont,
        fontConfig,
      })
      orchestrator.start()
      sharedWorker.emit({ type: 'progress', requestId: 1, phase: SCENE_BUILD_PHASE.PREPARING, stage: null })
      sharedWorker.emit({ type: 'success', requestId: 1, model: makeModel(), timings: { fetch: 0, parse: 0, validate: 0, build: 0 } })
      await flushMicrotasks()
      sharedFactory.resolveLast()
      sharedFont.resolveLast()
      await flushMicrotasks()
      expect(orchestrator.getState().kind).toBe('ready')
      orchestrator.dispose()
      expect(orchestrator.getState().kind).toBe('idle')
    }

    // 每个周期恰好 1 次 start、1 次 terminate、1 个资源创建并被释放。
    expect(sharedWorker.startCount).toBe(20)
    expect(sharedWorker.terminateCount).toBe(20)
    expect(sharedFactory.createCount).toBe(20)
    expect(FakeResource.created).toBe(20)
    expect(FakeResource.disposed).toBe(20) // 资源全部释放，无泄漏
  })

  test('StrictMode 风格重复清理：dispose 幂等，重复调用不增长 terminate / 释放计数', () => {
    const { worker, factory, font, orchestrator } = makeFixture()
    orchestrator.start()
    const beforeTerminate = worker.terminateCount
    orchestrator.dispose()
    expect(worker.terminateCount).toBe(beforeTerminate + 1)
    expect(orchestrator.getState().kind).toBe('idle')

    // 重复 dispose：幂等，不再增长 terminate、不抛异常。
    orchestrator.dispose()
    orchestrator.dispose()
    expect(worker.terminateCount).toBe(beforeTerminate + 1)
    expect(orchestrator.getState().kind).toBe('idle')

    // dispose 为终态：同一实例 start 被硬性拒绝（不再启动 worker、不分配 requestId）。
    // 集成层（TASK-017）必须为 StrictMode 的 setup→cleanup→setup 在第二次 setup 时
    // new 全新实例（见下一用例），不得在同一实例上 dispose→start，否则加载被静默吞掉。
    const beforeStart = worker.startCount
    orchestrator.start()
    expect(worker.startCount).toBe(beforeStart)
    expect(orchestrator.getState().kind).toBe('idle')
    // 引用 factory / font 仅用于夹具完整性，避免未使用告警。
    expect(factory).toBeDefined()
    expect(font).toBeDefined()
  })

  test('StrictMode setup→cleanup→setup：第二次 setup 必须 new 全新实例，旧实例 dispose 后不复活', () => {
    // 模拟 TASK-017 的 StrictMode 集成：effect 持有当前 orchestrator，cleanup 调 dispose，
    // re-setup 不复用旧实例而是 new 一个新的（共享同一组端口实例）。
    const { worker, factory, font } = makeFixture()
    const first = new LoadOrchestrator<FakeResource>({
      workerPort: worker,
      resourceFactory: factory,
      fontPort: font,
      fontConfig: {
        manifestCodePoints: manifestFor(['A']),
        fontUrl: '/fonts/NotoSansSC-Bold.sample.woff',
        sdfGlyphSize: 64,
      },
    })
    first.start()
    expect(worker.startCount).toBe(1)

    // cleanup：终结第一个实例（终态），不再被复用。
    first.dispose()
    expect(first.getState().kind).toBe('idle')

    // re-setup：new 第二个实例；其 requestId 从自身计数器重新起步，重新进入 loading。
    const second = new LoadOrchestrator<FakeResource>({
      workerPort: worker,
      resourceFactory: factory,
      fontPort: font,
      fontConfig: {
        manifestCodePoints: manifestFor(['A']),
        fontUrl: '/fonts/NotoSansSC-Bold.sample.woff',
        sdfGlyphSize: 64,
      },
    })
    second.start()
    expect(worker.startCount).toBe(2)
    expect(second.getState().kind).toBe('loading')
    // 旧实例上的 start 仍被拒绝，不影响新实例。
    first.start()
    expect(worker.startCount).toBe(2)
  })

  test('重新加载（ready 后再次 start）使用更大的 requestId 并释放旧资源', async () => {
    const { worker, factory, font, orchestrator } = makeFixture()
    orchestrator.start() // requestId = 1
    worker.emit({ type: 'progress', requestId: 1, phase: SCENE_BUILD_PHASE.PREPARING, stage: null })
    worker.emit({ type: 'success', requestId: 1, model: makeModel(), timings: { fetch: 0, parse: 0, validate: 0, build: 0 } })
    await flushMicrotasks()
    factory.resolveLast()
    font.resolveLast()
    await flushMicrotasks()
    expect(orchestrator.getState().kind).toBe('ready')

    // ready 后重新加载：requestId 递增、旧 worker 终止、旧资源释放。
    orchestrator.start() // requestId = 2
    expect(worker.startCount).toBe(2)
    expect(worker.terminateCount).toBe(1)
    // 旧 ready 资源（firstResource）被新 start 取代后立即释放。
    expect(FakeResource.disposed).toBe(1)
    expect(orchestrator.getState().kind).toBe('loading')

    // 新请求正常推进到 ready，使用更大的 requestId。
    worker.emit({ type: 'progress', requestId: 2, phase: SCENE_BUILD_PHASE.PREPARING, stage: null })
    worker.emit({ type: 'success', requestId: 2, model: makeModel(), timings: { fetch: 0, parse: 0, validate: 0, build: 0 } })
    await flushMicrotasks()
    factory.resolveLast()
    font.resolveLast()
    await flushMicrotasks()
    const ready = orchestrator.getState()
    expect(ready.kind).toBe('ready')
    if (ready.kind === 'ready') {
      expect(ready.requestId).toBe(2)
    }
  })
})
