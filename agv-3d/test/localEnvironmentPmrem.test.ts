import { beforeEach, describe, expect, it, vi } from 'vitest'
import { PMREMGenerator } from 'three'

/**
 * bakeLocalPmremSession 单元测试（SPEC §8.3 本地程序化 PMREM、§5.4 释放路径，TASK-012）。
 *
 * 用 mock PMREMGenerator 与 mock buildEnvironmentScene 在 Node 环境直接验证 PMREM 会话的生命周期：
 * - 成功路径返回 target.texture，dispose 释放 target → envScene → generator。
 * - dispose 幂等。
 * - fromScene 烘焙失败时显式释放已分配的 envScene 与 generator 后重抛（不留半开放资源），
 *   使调用方 effect 的错误能冒泡到 SceneErrorBoundary 进入统一 error 状态（§1、§10.2）。
 *
 * 该测试补齐 LocalEnvironment effect 内 PMREM 释放链此前缺失的直接自动化覆盖（TASK-012 low #3）。
 */

// vi.mock 工厂在文件顶部提升执行，引用的对象须经 vi.hoisted 提升以保持同一引用。
const mocks = vi.hoisted(() => {
  const generatorInstance = {
    fromScene: vi.fn(),
    dispose: vi.fn(),
  }
  const fakeTarget = {
    texture: { name: 'pmrem-texture', isTexture: true },
    dispose: vi.fn(),
  }
  const envSceneHandle = {
    scene: { name: 'env-scene' },
    dispose: vi.fn(),
  }
  return { generatorInstance, fakeTarget, envSceneHandle }
})

// 局部 mock three 的 PMREMGenerator（构造返回固定实例），其余 three 导出保持原样。
// 注意：实现须为可构造的具名 function（非箭头函数），使源码中的 new PMREMGenerator(gl) 合法。
vi.mock('three', async (importOriginal) => {
  const actual = await importOriginal<typeof import('three')>()
  return {
    ...actual,
    PMREMGenerator: vi.fn(function () {
      return mocks.generatorInstance
    }),
  }
})

// mock 程序化场景构建，避免在 Node 环境构造真实 SphereGeometry/材质。
vi.mock('../src/features/agv-map/presentation/scene/localEnvironmentScene', () => ({
  buildEnvironmentScene: vi.fn(() => mocks.envSceneHandle),
}))

const { bakeLocalPmremSession } = await import(
  '../src/features/agv-map/presentation/scene/localEnvironmentPmrem'
)
const { buildEnvironmentScene } = await import(
  '../src/features/agv-map/presentation/scene/localEnvironmentScene'
)

const MockedPmremGenerator = vi.mocked(PMREMGenerator)

/** 任意有限输入：gl 被 mock 构造器忽略，gradient 被 mock 场景构建忽略。 */
const FAKE_GL = {} as Parameters<typeof bakeLocalPmremSession>[0]
const OPTIONS = {
  gradient: { bottom: { h: 225, s: 0.5, l: 0.03 }, top: { h: 210, s: 0.6, l: 0.18 } },
  sceneRadiusM: 10,
  blurSigma: 0,
  nearM: 0.1,
  farM: 100,
  resolution: 128,
}

describe('bakeLocalPmremSession — 成功路径（SPEC §8.3）', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.generatorInstance.fromScene.mockReturnValue(mocks.fakeTarget)
  })

  it('返回 target.texture，并用程序化场景 + 分辨率调用 fromScene', () => {
    const session = bakeLocalPmremSession(FAKE_GL, OPTIONS)
    expect(session.texture).toBe(mocks.fakeTarget.texture)
    expect(mocks.generatorInstance.fromScene).toHaveBeenCalledOnce()
    // fromScene 入参：程序化场景、模糊半径、近远面、分辨率。
    expect(mocks.generatorInstance.fromScene).toHaveBeenCalledWith(
      mocks.envSceneHandle.scene,
      OPTIONS.blurSigma,
      OPTIONS.nearM,
      OPTIONS.farM,
      { size: OPTIONS.resolution },
    )
  })

  it('dispose 释放 target → envScene → generator（完整释放链）', () => {
    const session = bakeLocalPmremSession(FAKE_GL, OPTIONS)
    session.dispose()
    expect(mocks.fakeTarget.dispose).toHaveBeenCalledOnce()
    expect(mocks.envSceneHandle.dispose).toHaveBeenCalledOnce()
    expect(mocks.generatorInstance.dispose).toHaveBeenCalledOnce()
  })

  it('dispose 幂等：重复调用不二次释放', () => {
    const session = bakeLocalPmremSession(FAKE_GL, OPTIONS)
    session.dispose()
    session.dispose()
    expect(mocks.fakeTarget.dispose).toHaveBeenCalledOnce()
    expect(mocks.envSceneHandle.dispose).toHaveBeenCalledOnce()
    expect(mocks.generatorInstance.dispose).toHaveBeenCalledOnce()
  })
})

describe('bakeLocalPmremSession — 烘焙失败路径（SPEC §1、§5.4、§10.2）', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.generatorInstance.fromScene.mockImplementation(() => {
      throw new Error('pmrem bake failed')
    })
  })

  it('fromScene 抛错时释放已分配的 envScene 与 generator 后重抛', () => {
    expect(() => bakeLocalPmremSession(FAKE_GL, OPTIONS)).toThrow('pmrem bake failed')
    // generator 与 envScene 在 fromScene 前已分配，失败时必须释放，避免半开放资源泄漏（§5.4）。
    expect(mocks.envSceneHandle.dispose).toHaveBeenCalledOnce()
    expect(mocks.generatorInstance.dispose).toHaveBeenCalledOnce()
  })

  it('target 尚未创建，失败时不调用 target.dispose', () => {
    try {
      bakeLocalPmremSession(FAKE_GL, OPTIONS)
    } catch {
      // 预期抛错
    }
    expect(mocks.fakeTarget.dispose).not.toHaveBeenCalled()
  })

  it('重抛的错误可被调用方捕获（供 effect 冒泡到场景错误边界）', () => {
    let caught: unknown = null
    try {
      bakeLocalPmremSession(FAKE_GL, OPTIONS)
    } catch (error) {
      caught = error
    }
    expect(caught).toBeInstanceOf(Error)
    expect((caught as Error).message).toBe('pmrem bake failed')
  })
})

describe('bakeLocalPmremSession — 构造与场景构建（SPEC §8.3 程序化）', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.generatorInstance.fromScene.mockReturnValue(mocks.fakeTarget)
  })

  it('使用传入的 gl 与 gradient/radius 构造生成器与程序化场景', () => {
    bakeLocalPmremSession(FAKE_GL, OPTIONS)
    // PMREMGenerator（mock）以 gl 为入参构造。
    expect(MockedPmremGenerator).toHaveBeenCalledWith(FAKE_GL)
    // 程序化场景以 gradient 与半径构建。
    expect(buildEnvironmentScene).toHaveBeenCalledWith(OPTIONS.gradient, OPTIONS.sceneRadiusM)
  })
})
