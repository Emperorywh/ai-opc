// @vitest-environment jsdom
/*
 * 静态场景图层 React 级 StrictMode 挂载/卸载集成断言（TASK-018，SPEC 4.3 / 15.3，jsdom 环境）。
 *
 * 设计（任务验证方式第 4 项，不启动浏览器）：
 *   - 在 jsdom + react-dom/client（应用实际使用的渲染器）下，以 <StrictMode> 挂载 GroundLayer 与
 *     SceneEnvironmentLayer，触发 React StrictMode 对副作用的 setup→cleanup→setup 二次调用，
 *     再卸载；断言每个被创建的 GPU 资源 / Handle 都被释放，计数平衡、无单调增长。
 *   - 该测试直接捕获“在渲染阶段（useMemo）创建 GPU 资源”的回归：StrictMode 会丢弃首次结果，
 *     被丢弃的 geometry / material 永不 dispose；改为 effect 内创建后，每份 Handle 各自 cleanup 释放。
 *
 * 资源追踪方式：
 *   - ground：用 vi.mock 包裹真实 createGroundMesh，在创建时立刻登记 geometry / material 的 dispose
 *     事件（必须在创建时登记，因为 StrictMode 的中间 cleanup 会在挂载 act() 返回前就 dispose 首份）。
 *   - env：同样包裹 createSceneEnvironment，在创建时包装 dispose 计数（灯光无 GPU 资源，dispose 为
 *     幂等空操作，但 Handle 生命周期与 GroundLayer 必须同构）。
 *
 * 不启动浏览器：react-dom/client 在 jsdom 下渲染；图层组件构造 Three 对象无需 WebGL。
 *   <primitive> 在 react-dom 下渲染为同名占位 DOM 节点，不影响 effect 生命周期与 dispose 计数。
 */
import { describe, test, expect, beforeEach, vi } from 'vitest'
import { createElement as h } from 'react'
import type { ReactNode } from 'react'
import { createRoot } from 'react-dom/client'
import { StrictMode, act } from 'react'
import * as THREE from 'three'
import type { NumericBox3 } from '../../src/domain/sceneMap'
// React 19 act 需显式声明测试环境，避免“update not wrapped in act”告警污染断言。
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

// 经 vi.hoisted 提升的追踪器：在 vi.mock 工厂（提升到文件顶部）中可安全引用。
const tracker = vi.hoisted(() => ({
  groundCreated: 0,
  groundGeoDisposed: 0,
  groundMatDisposed: 0,
  envCreated: 0,
  envDisposed: 0,
}))

// 包裹真实 groundMesh 工厂：创建时立刻登记 geometry / material 的 dispose 事件。
vi.mock('../../src/scene/groundMesh', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/scene/groundMesh')>()
  return {
    ...actual,
    createGroundMesh: (b: NumericBox3) => {
      const handle = actual.createGroundMesh(b)
      const geo = handle.mesh.geometry as THREE.BufferGeometry
      const mat = handle.mesh.material as THREE.Material
      geo.addEventListener('dispose', () => {
        tracker.groundGeoDisposed++
      })
      mat.addEventListener('dispose', () => {
        tracker.groundMatDisposed++
      })
      tracker.groundCreated++
      return handle
    },
  }
})

// 包裹真实 sceneEnvironment 工厂：创建时包装 dispose 计数（灯光无 GPU 资源，仅校验生命周期平衡）。
vi.mock('../../src/scene/sceneEnvironment', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/scene/sceneEnvironment')>()
  return {
    ...actual,
    createSceneEnvironment: () => {
      const handle = actual.createSceneEnvironment()
      const originalDispose = handle.dispose.bind(handle)
      handle.dispose = () => {
        tracker.envDisposed++
        originalDispose()
      }
      tracker.envCreated++
      return handle
    },
  }
})

// 在 vi.mock 提升之后导入被测组件，使其拿到包裹后的工厂。
import { GroundLayer } from '../../src/scene/GroundLayer'
import { SceneEnvironmentLayer } from '../../src/scene/SceneEnvironmentLayer'

// 合法有限地面范围（仅用于驱动 createGroundMesh，不加载真实样本）。
const groundBounds: NumericBox3 = {
  minX: -10,
  maxX: 10,
  minY: 0,
  maxY: 0,
  minZ: -5,
  maxZ: 5,
}

beforeEach(() => {
  tracker.groundCreated = 0
  tracker.groundGeoDisposed = 0
  tracker.groundMatDisposed = 0
  tracker.envCreated = 0
  tracker.envDisposed = 0
})

// ─── StrictMode 挂载/卸载：资源计数平衡（SPEC 4.3 / 15.3）──────────────────────

describe('GroundLayer · StrictMode 挂载/卸载无 GPU 资源泄漏（SPEC 4.3 / 15.3）', () => {
  test('StrictMode 二次创建的每份 geometry / material 均被 dispose', async () => {
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)

    // StrictMode 下挂载：effect 经历 setup→cleanup→setup，createGroundMesh 被调用 2 次。
    await act(async () => {
      root.render(
        h(StrictMode, null, h(GroundLayer, { groundBounds })),
      )
    })
    // StrictMode 必须触发二次创建；若未触发则该测试不再能暴露 useMemo 回归，断言会失败提示。
    expect(tracker.groundCreated).toBeGreaterThanOrEqual(2)
    // 挂载阶段尚未最终卸载：此时只期望“中间 cleanup 已释放首份”，即至少 1 份已 dispose。
    expect(tracker.groundGeoDisposed).toBeGreaterThanOrEqual(1)

    // 卸载：触发留存 Handle 的 cleanup dispose。
    await act(async () => {
      root.unmount()
    })
    // 卸载后全部创建的 geometry / material 均已 dispose：计数平衡，无悬挂资源。
    expect(tracker.groundGeoDisposed).toBe(tracker.groundCreated)
    expect(tracker.groundMatDisposed).toBe(tracker.groundCreated)

    container.remove()
  })

  test('重复挂载/卸载 20 次：累计创建数 === 累计释放数（计数不单调增长）', async () => {
    for (let i = 0; i < 20; i++) {
      const container = document.createElement('div')
      document.body.appendChild(container)
      const root = createRoot(container)
      await act(async () => {
        root.render(h(GroundLayer, { groundBounds }))
      })
      await act(async () => {
        root.unmount()
      })
      container.remove()
    }
    // 不带 StrictMode 的普通挂载/卸载：每轮创建 1 份、释放 1 份；累计严格平衡。
    expect(tracker.groundCreated).toBe(20)
    expect(tracker.groundGeoDisposed).toBe(20)
    expect(tracker.groundMatDisposed).toBe(20)
  })
})

describe('SceneEnvironmentLayer · StrictMode 挂载/卸载 Handle 生命周期平衡（SPEC 4.3）', () => {
  test('StrictMode 二次创建的每个灯光 Handle 均被 dispose', async () => {
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)

    await act(async () => {
      root.render(
        h(StrictMode, null, h(SceneEnvironmentLayer)),
      )
    })
    expect(tracker.envCreated).toBeGreaterThanOrEqual(2)

    await act(async () => {
      root.unmount()
    })
    // 灯光无 GPU 资源，但 Handle 生命周期必须与 GroundLayer 同构：创建数 === dispose 数。
    expect(tracker.envDisposed).toBe(tracker.envCreated)

    container.remove()
  })
})

describe('StaticSceneContent 静态装配 · Ground + 环境灯光同挂同卸无泄漏', () => {
  test('同时挂载两层并卸载：ground 与 env 各自创建数 === 释放数', async () => {
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)

    await act(async () => {
      const tree: ReactNode = h(StrictMode, null, h(GroundLayer, { groundBounds }), h(SceneEnvironmentLayer))
      root.render(tree)
    })
    expect(tracker.groundCreated).toBeGreaterThanOrEqual(2)
    expect(tracker.envCreated).toBeGreaterThanOrEqual(2)

    await act(async () => {
      root.unmount()
    })
    expect(tracker.groundGeoDisposed).toBe(tracker.groundCreated)
    expect(tracker.groundMatDisposed).toBe(tracker.groundCreated)
    expect(tracker.envDisposed).toBe(tracker.envCreated)

    container.remove()
  })
})
