/**
 * Task 10 · InputAdapter 单测（SPEC §9 / D20 验收：滚轮缩放 / 拖拽 pan 经抽象层正确翻译）。
 *
 * 覆盖：
 *  - wheelToZoomFactor 纯函数（量级归一 deltaMode + 触控板 pinch ctrlKey + Task 09 PIXEL 回归不变量）
 *  - createMouseTrackpadAdapter：pointer 拖拽→pan、wheel→zoom、attach 返回 detach（fake-element 集成）
 *  - createTouchAdapter：kind='touch' 预留 stub（Phase 2 / Task 30）
 *
 * vitest 为 node 环境（无 DOM），用 fake element（addEventListener/removeEventListener stub）
 * + plain event 对象驱动 —— 仅测 adapter 的绑定/翻译逻辑，不依赖浏览器 PointerEvent/WheelEvent。
 */
import { describe, it, expect, vi } from 'vitest'
import { cameraConfig } from '../src/config/camera'
import {
  wheelToZoomFactor,
  createMouseTrackpadAdapter,
  createTouchAdapter,
} from '../src/three/camera/inputAdapter'

// ---- fake element（node 环境无 DOM，仅复刻 adapter 用到的方法）----
function fakeElement() {
  const listeners = new Map<string, Set<(e: unknown) => void>>()
  return {
    addEventListener(type: string, fn: (e: unknown) => void) {
      let set = listeners.get(type)
      if (!set) {
        set = new Set()
        listeners.set(type, set)
      }
      set.add(fn)
    },
    removeEventListener(type: string, fn: (e: unknown) => void) {
      listeners.get(type)?.delete(fn)
    },
    dispatch(type: string, ev: unknown) {
      listeners.get(type)?.forEach((fn) => fn(ev))
    },
    setPointerCapture: vi.fn(),
    releasePointerCapture: vi.fn(),
    listenerCount(type: string) {
      return listeners.get(type)?.size ?? 0
    },
  }
}

// plain event（adapter 仅读用到的字段 + 调方法，不依赖 instanceof）
type FakePointer = { button: number; clientX: number; clientY: number; pointerId: number }
type FakeWheel = {
  deltaY: number
  deltaMode: number
  ctrlKey: boolean
  preventDefault: () => void
}

describe('wheelToZoomFactor（量级归一 + pinch + Task 09 回归）', () => {
  it('PIXEL mode + 无 ctrlKey = Task 09 exp(deltaY · wheelZoomFactor)', () => {
    const d = 100
    expect(wheelToZoomFactor(d, 0, false)).toBeCloseTo(
      Math.exp(d * cameraConfig.wheelZoomFactor),
    )
  })
  it('deltaY>0 拉远（factor>1）、deltaY<0 推近（factor<1）', () => {
    expect(wheelToZoomFactor(100, 0, false)).toBeGreaterThan(1)
    expect(wheelToZoomFactor(-100, 0, false)).toBeLessThan(1)
  })
  it('deltaY=0 不变（factor=1）', () => {
    expect(wheelToZoomFactor(0, 0, false)).toBe(1)
  })
  it('LINE mode 归一 ×16（deltaY=1 LINE ≡ deltaY=16 PIXEL）', () => {
    expect(wheelToZoomFactor(1, 1, false)).toBeCloseTo(wheelToZoomFactor(16, 0, false))
  })
  it('PAGE mode 归一 ×400（deltaY=1 PAGE ≡ deltaY=400 PIXEL）', () => {
    expect(wheelToZoomFactor(1, 2, false)).toBeCloseTo(wheelToZoomFactor(400, 0, false))
  })
  it('LINE 与 PIXEL 鼠标手感一致（同一格滚动两路径结果相同）', () => {
    const fromPixel = wheelToZoomFactor(100, 0, false)
    const fromLine = wheelToZoomFactor(100 / 16, 1, false)
    expect(fromLine).toBeCloseTo(fromPixel, 6)
  })
  it('ctrlKey=true（触控板 pinch）用 pinchZoomFactor', () => {
    const d = 10
    expect(wheelToZoomFactor(d, 0, true)).toBeCloseTo(
      Math.exp(d * cameraConfig.pinchZoomFactor),
    )
  })
  it('pinch 系数 ≠ 滚轮系数（独立调参位）', () => {
    expect(cameraConfig.pinchZoomFactor).not.toBe(cameraConfig.wheelZoomFactor)
  })
  it('pinch 同向：>0 拉远、<0 推近', () => {
    expect(wheelToZoomFactor(10, 0, true)).toBeGreaterThan(1)
    expect(wheelToZoomFactor(-10, 0, true)).toBeLessThan(1)
  })
  it('ctrlKey 不影响 PIXEL 鼠标量级归一（仅换系数）', () => {
    // LINE×16 归一 与 ctrlKey 无关（pinch 不产生 LINE）
    expect(wheelToZoomFactor(1, 1, true)).toBeCloseTo(wheelToZoomFactor(16, 0, true))
  })
})

describe('createMouseTrackpadAdapter', () => {
  it('kind = mouse-trackpad', () => {
    expect(createMouseTrackpadAdapter().kind).toBe('mouse-trackpad')
  })
  it('attach 返回 detach 函数', () => {
    const el = fakeElement()
    const detach = createMouseTrackpadAdapter().attach(el as unknown as HTMLElement, {
      onPan: () => {},
      onZoom: () => {},
    })
    expect(typeof detach).toBe('function')
    detach()
  })
  it('pointer 拖拽 → onPan（屏幕像素增量）', () => {
    const el = fakeElement()
    const onPan = vi.fn()
    const onZoom = vi.fn()
    createMouseTrackpadAdapter().attach(el as unknown as HTMLElement, { onPan, onZoom })
    el.dispatch('pointerdown', { button: 0, clientX: 100, clientY: 100, pointerId: 1 } as FakePointer)
    el.dispatch('pointermove', { button: 0, clientX: 150, clientY: 90, pointerId: 1 } as FakePointer)
    expect(onPan).toHaveBeenCalledWith(50, -10)
    expect(onZoom).not.toHaveBeenCalled()
  })
  it('未按下不触发 pan（pointermove 无前置 down）', () => {
    const el = fakeElement()
    const onPan = vi.fn()
    createMouseTrackpadAdapter().attach(el as unknown as HTMLElement, {
      onPan,
      onZoom: () => {},
    })
    el.dispatch('pointermove', { button: 0, clientX: 200, clientY: 200, pointerId: 1 } as FakePointer)
    expect(onPan).not.toHaveBeenCalled()
  })
  it('非主键（button≠0）不触发 pan', () => {
    const el = fakeElement()
    const onPan = vi.fn()
    createMouseTrackpadAdapter().attach(el as unknown as HTMLElement, {
      onPan,
      onZoom: () => {},
    })
    el.dispatch('pointerdown', { button: 2, clientX: 0, clientY: 0, pointerId: 1 } as FakePointer)
    el.dispatch('pointermove', { button: 2, clientX: 50, clientY: 50, pointerId: 1 } as FakePointer)
    expect(onPan).not.toHaveBeenCalled()
  })
  it('pointerup 结束拖拽（后续 move 不再 pan）', () => {
    const el = fakeElement()
    const onPan = vi.fn()
    createMouseTrackpadAdapter().attach(el as unknown as HTMLElement, {
      onPan,
      onZoom: () => {},
    })
    el.dispatch('pointerdown', { button: 0, clientX: 0, clientY: 0, pointerId: 1 } as FakePointer)
    el.dispatch('pointerup', { button: 0, clientX: 0, clientY: 0, pointerId: 1 } as FakePointer)
    el.dispatch('pointermove', { button: 0, clientX: 100, clientY: 100, pointerId: 1 } as FakePointer)
    expect(onPan).not.toHaveBeenCalled()
  })
  it('pointercancel 同样结束拖拽', () => {
    const el = fakeElement()
    const onPan = vi.fn()
    createMouseTrackpadAdapter().attach(el as unknown as HTMLElement, {
      onPan,
      onZoom: () => {},
    })
    el.dispatch('pointerdown', { button: 0, clientX: 0, clientY: 0, pointerId: 1 } as FakePointer)
    el.dispatch('pointercancel', { button: 0, clientX: 0, clientY: 0, pointerId: 1 } as FakePointer)
    el.dispatch('pointermove', { button: 0, clientX: 100, clientY: 100, pointerId: 1 } as FakePointer)
    expect(onPan).not.toHaveBeenCalled()
  })
  it('累积拖拽：多次 move 各自上报增量（非绝对位置）', () => {
    const el = fakeElement()
    const onPan = vi.fn()
    createMouseTrackpadAdapter().attach(el as unknown as HTMLElement, {
      onPan,
      onZoom: () => {},
    })
    el.dispatch('pointerdown', { button: 0, clientX: 0, clientY: 0, pointerId: 1 } as FakePointer)
    el.dispatch('pointermove', { button: 0, clientX: 10, clientY: 0, pointerId: 1 } as FakePointer)
    el.dispatch('pointermove', { button: 0, clientX: 20, clientY: 0, pointerId: 1 } as FakePointer)
    el.dispatch('pointermove', { button: 0, clientX: 25, clientY: 5, pointerId: 1 } as FakePointer)
    expect(onPan).toHaveBeenCalledTimes(3)
    expect(onPan).toHaveBeenNthCalledWith(1, 10, 0)
    expect(onPan).toHaveBeenNthCalledWith(2, 10, 0)
    expect(onPan).toHaveBeenNthCalledWith(3, 5, 5)
  })
  it('wheel → onZoom（PIXEL 量级 = wheelToZoomFactor）', () => {
    const el = fakeElement()
    const onZoom = vi.fn()
    createMouseTrackpadAdapter().attach(el as unknown as HTMLElement, {
      onPan: () => {},
      onZoom,
    })
    const preventDefault = vi.fn()
    el.dispatch('wheel', { deltaY: 100, deltaMode: 0, ctrlKey: false, preventDefault } as FakeWheel)
    expect(onZoom).toHaveBeenCalledTimes(1)
    expect(onZoom).toHaveBeenCalledWith(Math.exp(100 * cameraConfig.wheelZoomFactor))
    expect(preventDefault).toHaveBeenCalled() // 阻止页面跟随滚动
  })
  it('wheel ctrlKey（触控板 pinch）→ onZoom 用 pinchZoomFactor', () => {
    const el = fakeElement()
    const onZoom = vi.fn()
    createMouseTrackpadAdapter().attach(el as unknown as HTMLElement, {
      onPan: () => {},
      onZoom,
    })
    el.dispatch('wheel', {
      deltaY: 10,
      deltaMode: 0,
      ctrlKey: true,
      preventDefault: () => {},
    } as FakeWheel)
    expect(onZoom).toHaveBeenCalledWith(Math.exp(10 * cameraConfig.pinchZoomFactor))
  })
  it('wheel LINE mode 归一到 PIXEL 量级', () => {
    const el = fakeElement()
    const onZoom = vi.fn()
    createMouseTrackpadAdapter().attach(el as unknown as HTMLElement, {
      onPan: () => {},
      onZoom,
    })
    el.dispatch('wheel', {
      deltaY: 6,
      deltaMode: 1,
      ctrlKey: false,
      preventDefault: () => {},
    } as FakeWheel)
    expect(onZoom).toHaveBeenCalledWith(wheelToZoomFactor(6, 1, false))
  })
  it('detach 后 handlers 不再被触发', () => {
    const el = fakeElement()
    const onPan = vi.fn()
    const onZoom = vi.fn()
    const detach = createMouseTrackpadAdapter().attach(el as unknown as HTMLElement, {
      onPan,
      onZoom,
    })
    detach()
    el.dispatch('pointerdown', { button: 0, clientX: 0, clientY: 0, pointerId: 1 } as FakePointer)
    el.dispatch('pointermove', { button: 0, clientX: 50, clientY: 50, pointerId: 1 } as FakePointer)
    el.dispatch('wheel', { deltaY: 100, deltaMode: 0, ctrlKey: false, preventDefault: () => {} } as FakeWheel)
    expect(onPan).not.toHaveBeenCalled()
    expect(onZoom).not.toHaveBeenCalled()
  })
  it('detach 移除所有监听（监听计数归零）', () => {
    const el = fakeElement()
    const detach = createMouseTrackpadAdapter().attach(el as unknown as HTMLElement, {
      onPan: () => {},
      onZoom: () => {},
    })
    expect(el.listenerCount('pointerdown')).toBe(1)
    expect(el.listenerCount('pointermove')).toBe(1)
    expect(el.listenerCount('pointerup')).toBe(1)
    expect(el.listenerCount('pointercancel')).toBe(1)
    expect(el.listenerCount('wheel')).toBe(1)
    detach()
    expect(el.listenerCount('pointerdown')).toBe(0)
    expect(el.listenerCount('wheel')).toBe(0)
  })
  it('setPointerCapture 在 down 时调用、releasePointerCapture 在 up 时调用', () => {
    const el = fakeElement()
    createMouseTrackpadAdapter().attach(el as unknown as HTMLElement, {
      onPan: () => {},
      onZoom: () => {},
    })
    el.dispatch('pointerdown', { button: 0, clientX: 0, clientY: 0, pointerId: 7 } as FakePointer)
    expect(el.setPointerCapture).toHaveBeenCalledWith(7)
    el.dispatch('pointerup', { button: 0, clientX: 0, clientY: 0, pointerId: 7 } as FakePointer)
    expect(el.releasePointerCapture).toHaveBeenCalledWith(7)
  })
})

describe('createTouchAdapter（SPEC §9 预留，Phase 2 / Task 30 接入）', () => {
  it('kind = touch', () => {
    expect(createTouchAdapter().kind).toBe('touch')
  })
  it('attach 返回 detach 函数（no-op 占位）', () => {
    const detach = createTouchAdapter().attach({} as HTMLElement, {
      onPan: () => {},
      onZoom: () => {},
    })
    expect(typeof detach).toBe('function')
    expect(() => detach()).not.toThrow()
  })
  it('预留 stub 不消费 handlers（未实现触控逻辑，handlers 不被调用）', () => {
    const onPan = vi.fn()
    const onZoom = vi.fn()
    const detach = createTouchAdapter().attach({} as HTMLElement, { onPan, onZoom })
    expect(onPan).not.toHaveBeenCalled()
    expect(onZoom).not.toHaveBeenCalled()
    detach()
  })
})
