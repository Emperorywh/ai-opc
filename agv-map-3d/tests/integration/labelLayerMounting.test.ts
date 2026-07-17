// @vitest-environment jsdom
/*
 * 按需标签图层 React 级集成断言（TASK-022，SPEC 11.3 / 11.4 / 13 / 4.3 / 任务约束，jsdom 环境）。
 *
 * 设计（任务验证方式第 3、4 项，不启动浏览器）：
 *   - 通过 vi.mock 替换 @react-three/fiber 的 useThree / useFrame 与 scene/labelText 工厂，
 *     在 react-dom/client 下挂载 LazyLabelLayer，手动驱动捕获的 useFrame 回调模拟逐帧。
 *   - 字体门禁：fontReady=false 时帧协调器不查询、不挂载任何标签；fontReady=true 后按可见集挂载。
 *   - 差量挂载：可见集目标变化时只对差集 create / destroy（经 createLabelText / dispose 计数验证）。
 *   - 400 上限：可见集截断到 400 后挂载数恒 <= 400。
 *   - 朝向协调：每帧把 camera quaternion 批量写入已登记 Text，不触发额外 React setState。
 *   - 清理：卸载时全部已挂载 Text 被 dispose；StrictMode 二次创建的每份都被释放。
 *
 * 不启动浏览器：react-dom/client + jsdom；computeLabelVisibilitySet 经 vi.mock 返回受控结果，
 *   隔离 LazyLabelLayer 的协调与 React 装配（可见集纯数学已由 TASK-021 覆盖）。
 */
import { describe, test, expect, beforeEach, vi } from 'vitest'
import { createElement as h } from 'react'
import { createRoot } from 'react-dom/client'
import { StrictMode, act } from 'react'
import { PerspectiveCamera } from 'three'
import type { LabelDescriptor } from '../../src/labels/labelDescriptor'
import type { LabelVisibilityResult } from '../../src/labels/labelVisibilitySet'
import type { Text } from 'troika-three-text'
// React 19 act 需显式声明测试环境，避免“update not wrapped in act”告警污染断言。
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

// ─── 受控相机与帧回调 ──────────────────────────────────────────────────────────

/*
 * 测试用相机（Three PerspectiveCamera，jsdom 下构造无需 WebGL）。
 * LazyLabelLayer 在 useFrame 内调用 cam.updateMatrixWorld / 读取 position/quaternion/
 * projectionMatrix/matrixWorldInverse；此处给一组有限值。
 */
const testCamera = new PerspectiveCamera(50, 16 / 9, 0.1, 1000)
testCamera.position.set(0, 0, 5)

/*
 * 受控可见集结果：测试按帧切换返回值，隔离 LazyLabelLayer 的协调逻辑。
 */
let visibilityResult: LabelVisibilityResult = {
  targetIds: [],
  createIds: [],
  destroyIds: [],
  candidateCount: 0,
  mountedAfter: 0,
}

// 经 vi.hoisted 提升的追踪器：在 vi.mock 工厂（提升到文件顶部）中可安全引用。
const tracker = vi.hoisted(() => ({
  created: 0,
  disposed: 0,
  liveTexts: new Map<string, { dispose(): void; sync(cb?: () => void): void }>(),
}))

// 帧回调句柄：useFrame 把回调写入此处，测试手动调用以模拟逐帧。
let frameCallback: (() => void) | null = null
const invalidateSpy = vi.fn()

// 受控单调时钟（毫秒）：planLabelFrame 经 performance.now() 读取；测试按帧推进以通过 10Hz 节流。
let mockNow = 0
vi.spyOn(performance, 'now').mockImplementation(() => mockNow)

// 受控 R3F store：useThree 选择器读取 camera / size / invalidate。
const mockStore = {
  camera: testCamera,
  size: { width: 1920, height: 1080 },
  invalidate: invalidateSpy,
}

vi.mock('@react-three/fiber', () => ({
  // useThree(selector) → selector(store)，与 R3F 选择器约定一致。
  useThree: (selector: (s: typeof mockStore) => unknown) => selector(mockStore),
  // useFrame(cb)：捕获最新回调，测试手动调用模拟 demand 帧。
  useFrame: (cb: () => void) => {
    frameCallback = cb
  },
}))

vi.mock('../../src/labels/labelVisibilitySet', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/labels/labelVisibilitySet')>()
  return {
    ...actual,
    // 可见集计算替换为受控结果，隔离协调逻辑（可见集纯数学由 TASK-021 覆盖）。
    computeLabelVisibilitySet: () => visibilityResult,
  }
})

// 包裹 labelText 工厂：返回带 position/quaternion/sync/dispose 的假 Text，并登记创建/释放计数。
vi.mock('../../src/scene/labelText', () => ({
  createLabelText: (params: { descriptor: LabelDescriptor }) => {
    const id = params.descriptor.id
    const fake: Text = {
      // Object3D 可变属性：由协调器每帧写入。
      position: { set: vi.fn(), x: 0, y: 0, z: 0 } as never,
      quaternion: { set: vi.fn(), copy: vi.fn() } as never,
      renderOrder: 50,
      // Text 专属字段（工厂已写入，测试不校验具体值）。
      text: params.descriptor.text,
      font: '/fonts/NotoSansSC-Bold.sample.woff',
      fontSize: 0.2,
      sdfGlyphSize: 64,
      gpuAccelerateSDF: false,
      whiteSpace: 'nowrap',
      color: '#FFFFFF',
      anchorX: params.descriptor.kind === 'edge' ? 'center' : 'left',
      anchorY: 'top',
      depthTest: false,
      depthWrite: false,
      toneMapped: false,
      sync: vi.fn((cb?: () => void) => {
        // 模拟 Troika 同步完成回调（同步调用）。
        if (cb !== undefined) cb()
      }),
      dispose: vi.fn(() => {
        tracker.disposed++
        tracker.liveTexts.delete(id)
      }),
    } as unknown as Text
    tracker.created++
    tracker.liveTexts.set(id, fake as never)
    return fake
  },
}))

// 在 vi.mock 提升之后导入被测组件，使其拿到包裹后的工厂与受控 R3F hooks。
import { LazyLabelLayer } from '../../src/scene/layers/LazyLabelLayer'

// ─── 测试工具 ───────────────────────────────────────────────────────────────

function descriptor(id: string, kind: LabelDescriptor['kind'] = 'operational-node'): LabelDescriptor {
  return {
    id,
    ownerId: id,
    kind,
    text: id,
    anchorX: Number(id.replace(/\D/g, '')) || 0,
    anchorY: 0.25,
    anchorZ: 0,
    localOffsetX: kind === 'edge' ? 0 : 0.225,
    localOffsetY: kind === 'edge' ? 0 : -0.225,
  }
}

function setVisibility(targetIds: readonly string[]): void {
  visibilityResult = {
    targetIds,
    createIds: targetIds,
    destroyIds: [],
    candidateCount: targetIds.length,
    mountedAfter: targetIds.length,
  }
}

beforeEach(() => {
  tracker.created = 0
  tracker.disposed = 0
  tracker.liveTexts.clear()
  frameCallback = null
  invalidateSpy.mockClear()
  mockNow = 0
  // 重置相机位姿到固定起点，避免上一条用例的位移残留影响首帧签名。
  testCamera.position.set(0, 0, 5)
  visibilityResult = {
    targetIds: [],
    createIds: [],
    destroyIds: [],
    candidateCount: 0,
    mountedAfter: 0,
  }
})

/*
 * 推进一帧：推进受控时钟（超过 10Hz 节流窗口 100ms），可选移动相机使签名变化以触发
 * 'controls-change' 查询；然后在 act 内调用捕获的 useFrame 回调。
 */
async function tickFrame(moveCamera: boolean): Promise<void> {
  mockNow += 200 // 超过 100ms，使 'controls-change' 通过 10Hz 节流。
  if (moveCamera) {
    // 沿 +Z 微调相机位置，保证签名逐帧不同 → 'controls-change'。
    testCamera.position.z += 0.5
  }
  await act(async () => {
    frameCallback?.()
  })
}

// ─── 字体门禁接入（任务“字体门禁接入”）──────────────────────────────────────────

describe('LazyLabelLayer · 字体门禁未通过不挂载任何标签（SPEC 11.1 / 4.2 / 任务约束）', () => {
  test('fontReady=false：可见集非空也不创建 Text', async () => {
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    // 即使可见集目标非空，fontReady=false 时帧协调器不查询、不挂载。
    setVisibility(['n1', 'n2'])
    await act(async () => {
      root.render(h(LazyLabelLayer, { descriptors: [descriptor('n1'), descriptor('n2')], fontReady: false }))
    })
    await act(async () => {
      frameCallback?.()
    })
    expect(tracker.created).toBe(0)
    await act(async () => {
      root.unmount()
    })
    container.remove()
  })
})

// ─── 差量挂载与朝向协调（SPEC 11.3 第 7 项 / 11.4）──────────────────────────────

describe('LazyLabelLayer · 差量挂载：0 → 若干 → 变化（SPEC 11.3 第 7 项 / 任务验证方式第 3 项）', () => {
  test('初始 0；可见集变化后只为差集 create / destroy Text', async () => {
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    const descs = [descriptor('n1'), descriptor('n2'), descriptor('n3')]
    await act(async () => {
      root.render(h(LazyLabelLayer, { descriptors: descs, fontReady: true }))
    })

    // 帧推进 1：首帧 + 可见集为空 → 挂载 0。
    await tickFrame(true)
    expect(tracker.created).toBe(0)

    // 帧推进 2：可见集 → [n1, n2]，创建 2 个 Text（差量 create）。
    setVisibility(['n1', 'n2'])
    await tickFrame(true)
    expect(tracker.created).toBe(2)
    expect(tracker.liveTexts.size).toBe(2)

    // 帧推进 3：可见集 → [n2, n3]，destroy n1、create n3；n2 保留不重建。
    const createdBefore = tracker.created
    setVisibility(['n2', 'n3'])
    await tickFrame(true)
    expect(tracker.created).toBe(createdBefore + 1) // 只新增 n3
    expect(tracker.disposed).toBe(1) // 只销毁 n1
    expect(tracker.liveTexts.size).toBe(2)
    expect([...tracker.liveTexts.keys()]).toEqual(['n2', 'n3'])

    await act(async () => {
      root.unmount()
    })
    container.remove()
  })

  test('朝向协调：每帧把 camera quaternion 写入已登记 Text（SPEC 11.4）', async () => {
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    await act(async () => {
      root.render(h(LazyLabelLayer, { descriptors: [descriptor('n1')], fontReady: true }))
    })
    setVisibility(['n1'])
    await tickFrame(true)
    // n1 已挂载；下一帧 quaternion 写入应被调用。
    const fakeText = tracker.liveTexts.get('n1') as unknown as { quaternion: { set: ReturnType<typeof vi.fn> } }
    const setSpy = fakeText.quaternion.set
    setSpy.mockClear()
    await tickFrame(true)
    expect(setSpy).toHaveBeenCalledTimes(1)
    // 写入的四元数 = 相机世界四元数（testCamera 单位四元数 → 0,0,0,1）。
    expect(setSpy).toHaveBeenCalledWith(0, 0, 0, 1)

    await act(async () => {
      root.unmount()
    })
    container.remove()
  })
})

// ─── 400 上限（SPEC 11.3 表格 / 任务约束）──────────────────────────────────────

describe('LazyLabelLayer · 可见集截断到 400 后挂载数恒 <= 400（SPEC 11.3 表格 / 任务约束）', () => {
  test('可见集返回 400 个目标 → 恰好创建 400 个 Text', async () => {
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    const descs: LabelDescriptor[] = []
    for (let i = 0; i < 500; i++) descs.push(descriptor('L' + String(i).padStart(3, '0')))
    await act(async () => {
      root.render(h(LazyLabelLayer, { descriptors: descs, fontReady: true }))
    })
    // 可见集截断到 400。
    const target = descs.slice(0, 400).map((d) => d.id)
    setVisibility(target)
    await tickFrame(true)
    expect(tracker.created).toBe(400)
    expect(tracker.liveTexts.size).toBe(400)
    await act(async () => {
      root.unmount()
    })
    container.remove()
  })
})

// ─── 清理（SPEC 4.3 / 任务“卸载只调用既有所有者的幂等释放边界”）──────────────────

describe('LazyLabelLayer · 卸载时全部 Text 被 dispose（SPEC 4.3）', () => {
  test('已挂载 2 个 → 卸载后 dispose 计数 = 创建计数', async () => {
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    await act(async () => {
      root.render(h(LazyLabelLayer, { descriptors: [descriptor('n1'), descriptor('n2')], fontReady: true }))
    })
    setVisibility(['n1', 'n2'])
    await tickFrame(true)
    expect(tracker.created).toBe(2)
    await act(async () => {
      root.unmount()
    })
    // 卸载触发全部已挂载 Text 的 LabelTextItem cleanup dispose。
    expect(tracker.disposed).toBe(tracker.created)
    expect(tracker.liveTexts.size).toBe(0)
    container.remove()
  })
})

// ─── StrictMode 二次创建幂等（SPEC 4.3 / 15.3）──────────────────────────────────

describe('LazyLabelLayer · StrictMode 二次创建的每份 Text 均被 dispose（SPEC 4.3 / 15.3）', () => {
  test('StrictMode setup→cleanup→setup：每份 Text 成对释放', async () => {
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    setVisibility(['n1'])
    await act(async () => {
      root.render(h(StrictMode, null, h(LazyLabelLayer, { descriptors: [descriptor('n1')], fontReady: true })))
    })
    await tickFrame(true)
    // StrictMode 下每份 Text 由其 LabelTextItem 的 cleanup 成对释放；最终留存的也随卸载释放。
    await act(async () => {
      root.unmount()
    })
    expect(tracker.disposed).toBe(tracker.created)
    container.remove()
  })
})

// ─── demand 帧调度：invalidate 触发（SPEC 13 / 任务约束）────────────────────────

describe('LazyLabelLayer · demand 帧调度显式 invalidate（SPEC 13 / 任务约束）', () => {
  test('首帧与可见集变化后各触发一次 invalidate', async () => {
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    await act(async () => {
      root.render(h(LazyLabelLayer, { descriptors: [descriptor('n1')], fontReady: true }))
    })
    invalidateSpy.mockClear()
    // 首帧：planLabelFrame 标记 invalidate=true（prevSignature=null）。
    await tickFrame(true)
    expect(invalidateSpy).toHaveBeenCalled()
    // 可见集变化（差量挂载）：差量更新后再次 invalidate。
    invalidateSpy.mockClear()
    setVisibility(['n1'])
    await tickFrame(true)
    expect(invalidateSpy).toHaveBeenCalled()
    await act(async () => {
      root.unmount()
    })
    container.remove()
  })
})
