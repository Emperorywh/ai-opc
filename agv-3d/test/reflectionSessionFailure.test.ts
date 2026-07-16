import { describe, expect, it, vi } from 'vitest'
import { REFLECTION_TARGET_SIZE_PIXELS } from '../src/features/agv-map/config/performanceConfig'

/**
 * 平面反射会话创建失败路径测试（SPEC §5.4，TASK-013 输出"创建失败时确定释放"、关键异常路径
 * "反射资源创建中断"）。
 *
 * 与 localEnvironmentPmrem.test.ts 的"烘焙失败路径"同构：使最后分配的 BlurPass 构造抛错
 * （此时 reflectTarget、深度纹理、blurTarget 已分配），断言三者连同深度纹理在重抛前被显式释放、
 * 不留半开放 RenderTarget（SPEC §5.4"创建失败时必须释放已经创建的 GPU 资源"）。
 *
 * 实现：mock three 的 WebGLRenderTarget 与 DepthTexture 为可观测 dispose 的构造器（登记全部实例），
 * 保留 three 其余导出原样——本测试只触达构造期，不进入 renderReflection（其 Matrix4/Vector3 等仍由
 * 真实实现承载，但因构造抛错不会执行）。mock drei BlurPass 构造直接抛错。
 */

const mocks = vi.hoisted(() => {
  /** 登记所有 mock 资源实例，供断言其 dispose 是否被调用。 */
  const renderTargets: Array<{ disposed: boolean }> = []
  const depthTextures: Array<{ disposed: boolean }> = []
  return { renderTargets, depthTextures }
})

// 局部 mock three 的 WebGLRenderTarget 与 DepthTexture（构造登记实例、dispose 置标记），其余 three
// 导出保持原样。实现中以 new WebGLRenderTarget(w,h)/new DepthTexture(w,h) 调用，须为可构造具名类。
vi.mock('three', async (importOriginal) => {
  const actual = await importOriginal<typeof import('three')>()
  class MockRenderTarget {
    readonly width: number
    readonly height: number
    depthBuffer = false
    depthTexture: unknown = null
    texture = { dispose: vi.fn() }
    disposed = false
    constructor(width: number, height: number) {
      this.width = width
      this.height = height
      mocks.renderTargets.push(this)
    }
    dispose(): void {
      this.disposed = true
    }
  }
  class MockDepthTexture {
    format = 0
    type = 0
    disposed = false
    constructor() {
      mocks.depthTextures.push(this)
    }
    dispose(): void {
      this.disposed = true
    }
  }
  return {
    ...actual,
    WebGLRenderTarget: MockRenderTarget as unknown as typeof import('three').WebGLRenderTarget,
    DepthTexture: MockDepthTexture as unknown as typeof import('three').DepthTexture,
  }
})

// mock drei BlurPass 构造直接抛错——它是会话最后分配的资源，抛错前 reflectTarget/深度纹理/blurTarget
// 均已分配，进入创建失败清理路径。
vi.mock('@react-three/drei/materials/BlurPass', () => ({
  BlurPass: vi.fn(function () {
    throw new Error('blurpass construct failed')
  }),
}))

const { createReflectionSession } = await import(
  '../src/features/agv-map/presentation/scene/reflectionSession'
)

/** 任意 fake renderer（mock 之下真实 gl 不被触达）。 */
const FAKE_GL = {} as Parameters<typeof createReflectionSession>[0]['gl']

/** 单次创建尝试：清空登记后调用会话构造（预期抛错）。 */
function attemptCreate(): void {
  mocks.renderTargets.length = 0
  mocks.depthTextures.length = 0
  try {
    createReflectionSession({
      gl: FAKE_GL,
      resolution: REFLECTION_TARGET_SIZE_PIXELS,
      blurWidth: 400,
      blurHeight: 100,
    })
  } catch {
    /* 预期抛错 */
  }
}

describe('createReflectionSession — 创建失败路径（SPEC §5.4，TASK-013 关键异常路径）', () => {
  it('BlurPass 构造抛错时会话重抛该错误（经 effect 冒泡到场景错误边界，§1、§10.2）', () => {
    mocks.renderTargets.length = 0
    mocks.depthTextures.length = 0
    expect(() =>
      createReflectionSession({
        gl: FAKE_GL,
        resolution: REFLECTION_TARGET_SIZE_PIXELS,
        blurWidth: 400,
        blurHeight: 100,
      }),
    ).toThrow('blurpass construct failed')
  })

  it('创建失败前已分配两个 RenderTarget（反射 + 模糊）', () => {
    attemptCreate()
    // BlurPass 抛错前 reflectTarget 与 blurTarget 已构造；登记的 RenderTarget 实例恰为 2。
    expect(mocks.renderTargets).toHaveLength(2)
  })

  it('创建失败时已分配的两个 RenderTarget 均被释放（不遗留半开放 RenderTarget）', () => {
    attemptCreate()
    expect(mocks.renderTargets).toHaveLength(2)
    for (const rt of mocks.renderTargets) {
      expect(rt.disposed).toBe(true)
    }
  })

  it('创建失败时已分配的深度纹理被释放（WebGLRenderTarget.dispose 不自动释放 depthTexture）', () => {
    attemptCreate()
    expect(mocks.depthTextures).toHaveLength(1)
    expect(mocks.depthTextures[0].disposed).toBe(true)
  })

  it('多次创建失败不累积未释放资源（模拟重复挂载/卸载的创建失败瞬态）', () => {
    for (let i = 0; i < 3; i += 1) {
      attemptCreate()
      // 每次失败后全部当次资源已释放，不随失败次数累积。
      expect(mocks.renderTargets).toHaveLength(2)
      expect(mocks.depthTextures).toHaveLength(1)
      for (const rt of mocks.renderTargets) expect(rt.disposed).toBe(true)
      for (const dt of mocks.depthTextures) expect(dt.disposed).toBe(true)
    }
  })
})
