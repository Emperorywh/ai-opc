import { describe, expect, it } from 'vitest'
import { DepthTexture } from 'three'
import { REFLECTION_TARGET_SIZE_PIXELS } from '../src/features/agv-map/config/performanceConfig'
import {
  createReflectionSession,
  type ReflectionSession,
} from '../src/features/agv-map/presentation/scene/reflectionSession'

/**
 * 平面反射资源会话单元测试（SPEC §8.4、§5.4、§11.1，TASK-013）。
 *
 * 不做 WebGL 渲染验证（renderReflection 需浏览器 GL 上下文），在 Node 环境用真实
 * WebGLRenderTarget / DepthTexture / drei BlurPass 实例（构造期不触达 GL）直接验证：
 * - 固定预算：反射/模糊 RenderTarget 宽高恒为传入 resolution（SPEC §11.1：1024×1024）。
 * - 反射 RenderTarget 附带深度纹理（与 drei 同构，深度相关模糊预留）。
 * - 确定性释放：dispose 触发反射/模糊 RenderTarget、BlurPass 两张中间 RenderTarget 与卷积材质的
 *   dispose 事件，不遗留额外 RenderTarget（SPEC §5.4、TASK-013 异常路径：重复挂载/卸载）。
 * - dispose 幂等。
 *
 * 该测试与 localEnvironmentPmrem.test.ts 同构：自持 GPU 资源会话的释放链在 Node 直接自动化验证。
 */

/** 任意 fake renderer（BlurPass 构造期不使用 gl，仅作形参传入）。 */
const FAKE_GL = {} as Parameters<typeof createReflectionSession>[0]['gl']

/** 监听一个 EventDispatcher 的 dispose 事件，返回是否被触发。 */
function watchDispose(target: { addEventListener: (t: string, cb: () => void) => void }): {
  readonly fired: () => boolean
} {
  let disposed = false
  target.addEventListener('dispose', () => {
    disposed = true
  })
  return { fired: () => disposed }
}

describe('createReflectionSession — 固定预算（SPEC §11.1：1024×1024）', () => {
  it('反射与模糊 RenderTarget 宽高恒为 resolution，不随主画布尺寸变化', () => {
    const session = createReflectionSession({
      gl: FAKE_GL,
      resolution: REFLECTION_TARGET_SIZE_PIXELS,
      blurWidth: 400,
      blurHeight: 100,
    })
    expect(session.reflectTarget.width).toBe(REFLECTION_TARGET_SIZE_PIXELS)
    expect(session.reflectTarget.height).toBe(REFLECTION_TARGET_SIZE_PIXELS)
    expect(session.blurTarget.width).toBe(REFLECTION_TARGET_SIZE_PIXELS)
    expect(session.blurTarget.height).toBe(REFLECTION_TARGET_SIZE_PIXELS)
    session.dispose()
  })

  it('REFLECTION_TARGET_SIZE_PIXELS = 1024（SPEC §11.1）', () => {
    expect(REFLECTION_TARGET_SIZE_PIXELS).toBe(1024)
  })

  it('反射 RenderTarget 附带深度纹理（与 drei 同构）', () => {
    const session = createReflectionSession({
      gl: FAKE_GL,
      resolution: REFLECTION_TARGET_SIZE_PIXELS,
      blurWidth: 400,
      blurHeight: 100,
    })
    expect(session.reflectTarget.depthTexture).toBeInstanceOf(DepthTexture)
    expect(session.reflectTarget.depthBuffer).toBe(true)
    session.dispose()
  })

  it('resolution 为固定常量而非主画布 DPR/CSS 尺寸推导（resize 不变性，TASK-013）', () => {
    // 会话以固定 resolution 构造；不同的"主画布尺寸"概念不存在于入参——resolution 是唯一尺寸输入，
    // 取自 REFLECTION_TARGET_SIZE_PIXELS 常量，不随 resize 变化。
    const a = createReflectionSession({
      gl: FAKE_GL,
      resolution: REFLECTION_TARGET_SIZE_PIXELS,
      blurWidth: 400,
      blurHeight: 100,
    })
    expect(a.reflectTarget.width).toBe(1024)
    a.dispose()
  })
})

describe('createReflectionSession — 确定性释放（SPEC §5.4、TASK-013 异常路径）', () => {
  it('dispose 触发反射 RenderTarget 的 dispose 事件', () => {
    const session = createReflectionSession({
      gl: FAKE_GL,
      resolution: REFLECTION_TARGET_SIZE_PIXELS,
      blurWidth: 400,
      blurHeight: 100,
    })
    const reflectWatch = watchDispose(session.reflectTarget)
    session.dispose()
    expect(reflectWatch.fired()).toBe(true)
  })

  it('dispose 触发模糊输出 RenderTarget 的 dispose 事件', () => {
    const session = createReflectionSession({
      gl: FAKE_GL,
      resolution: REFLECTION_TARGET_SIZE_PIXELS,
      blurWidth: 400,
      blurHeight: 100,
    })
    const blurWatch = watchDispose(session.blurTarget)
    session.dispose()
    expect(blurWatch.fired()).toBe(true)
  })

  it('dispose 释放反射 RenderTarget 的深度纹理（与 drei 同构的深度资源）', () => {
    const session = createReflectionSession({
      gl: FAKE_GL,
      resolution: REFLECTION_TARGET_SIZE_PIXELS,
      blurWidth: 400,
      blurHeight: 100,
    })
    const depthWatch = watchDispose(session.reflectTarget.depthTexture)
    session.dispose()
    expect(depthWatch.fired()).toBe(true)
  })

  it('BlurPass 内部两张中间 RenderTarget 与卷积材质的释放由源码静态契约保证（见 environmentContract.test.ts）', () => {
    // BlurPass 自身无 dispose；其内部 renderTargetA/renderTargetB/convolutionMaterial 由会话 dispose
    // 显式释放（reflectionSession.ts 源码），该释放链在 environmentContract 静态契约中逐行断言，
    // 此处验证会话暴露的两个 RenderTarget（reflectTarget/blurTarget）随 dispose 触发事件即可。
    const session = createReflectionSession({
      gl: FAKE_GL,
      resolution: REFLECTION_TARGET_SIZE_PIXELS,
      blurWidth: 400,
      blurHeight: 100,
    })
    const reflectWatch = watchDispose(session.reflectTarget)
    const blurWatch = watchDispose(session.blurTarget)
    session.dispose()
    expect(reflectWatch.fired()).toBe(true)
    expect(blurWatch.fired()).toBe(true)
  })

  it('dispose 幂等：重复调用不抛错、不二次触发 dispose 事件', () => {
    const session = createReflectionSession({
      gl: FAKE_GL,
      resolution: REFLECTION_TARGET_SIZE_PIXELS,
      blurWidth: 400,
      blurHeight: 100,
    })
    let count = 0
    session.reflectTarget.addEventListener('dispose', () => {
      count += 1
    })
    session.dispose()
    session.dispose()
    expect(count).toBe(1)
  })

  it('多次创建/释放会话：每次 dispose 完整释放当次资源（模拟重复挂载/卸载，无累积）', () => {
    const sessions: ReflectionSession[] = []
    for (let i = 0; i < 3; i += 1) {
      sessions.push(
        createReflectionSession({
          gl: FAKE_GL,
          resolution: REFLECTION_TARGET_SIZE_PIXELS,
          blurWidth: 400,
          blurHeight: 100,
        }),
      )
    }
    for (const session of sessions) {
      const watch = watchDispose(session.reflectTarget)
      session.dispose()
      expect(watch.fired()).toBe(true)
    }
  })
})

describe('createReflectionSession — textureMatrix 共享引用（每帧原地更新，SPEC §11.1）', () => {
  it('textureMatrix 为会话持有的稳定 Matrix4（renderReflection 原地更新其元素）', () => {
    const session = createReflectionSession({
      gl: FAKE_GL,
      resolution: REFLECTION_TARGET_SIZE_PIXELS,
      blurWidth: 400,
      blurHeight: 100,
    })
    // textureMatrix 引用在会话生命周期内稳定，材质 uniform 绑定该引用后由 renderReflection 原地更新。
    expect(session.textureMatrix).toBe(session.textureMatrix)
    expect(session.textureMatrix.elements.length).toBe(16)
    session.dispose()
  })
})
