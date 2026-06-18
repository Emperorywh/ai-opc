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
  touchPinchDistance,
  pinchZoomFactor,
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
    // createTouchAdapter 读写 el.style.touchAction（attach 设 none / detach 还原）。
    style: { touchAction: '' },
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

// 触屏事件结构子集（touches 为数组，兼容 TouchList 的 length + 索引访问；adapter 仅读 clientX/Y）。
type FakeTouchPoint = { clientX: number; clientY: number }
type FakeTouchEv = {
  touches: FakeTouchPoint[]
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

describe('touchPinchDistance（两指欧氏距离）', () => {
  it('已知两点距离（3-4-5）', () => {
    expect(touchPinchDistance({ clientX: 0, clientY: 0 }, { clientX: 3, clientY: 4 })).toBe(5)
  })
  it('同点距离 0', () => {
    expect(touchPinchDistance({ clientX: 5, clientY: 5 }, { clientX: 5, clientY: 5 })).toBe(0)
  })
  it('指序无关（a/b 对称）', () => {
    const p1 = { clientX: 10, clientY: 20 }
    const p2 = { clientX: 30, clientY: 40 }
    expect(touchPinchDistance(p1, p2)).toBeCloseTo(touchPinchDistance(p2, p1))
  })
})

describe('pinchZoomFactor（距离比 → zoom 乘子，与 onZoom 语义同源）', () => {
  it('张开（curr>last）→ factor<1 推近（放大）', () => {
    expect(pinchZoomFactor(200, 100)).toBeCloseTo(0.5)
  })
  it('捏合（curr<last）→ factor>1 拉远（缩小）', () => {
    expect(pinchZoomFactor(100, 200)).toBeCloseTo(2)
  })
  it('不变（curr=last）→ factor=1', () => {
    expect(pinchZoomFactor(150, 150)).toBe(1)
  })
  it('防除零（curr=0）→ factor=1', () => {
    expect(pinchZoomFactor(0, 100)).toBe(1)
  })
  it('防除零（curr<0）→ factor=1', () => {
    expect(pinchZoomFactor(-5, 100)).toBe(1)
  })
})

describe('createTouchAdapter（双指 pinch zoom，Task 30 / SPEC §9）', () => {
  it('kind = touch', () => {
    expect(createTouchAdapter().kind).toBe('touch')
  })
  it('attach 返回 detach 函数', () => {
    const el = fakeElement()
    const detach = createTouchAdapter().attach(el as unknown as HTMLElement, {
      onPan: () => {},
      onZoom: () => {},
    })
    expect(typeof detach).toBe('function')
    expect(() => detach()).not.toThrow()
  })
  it('单指 touchmove 不触发 onZoom/onPan（让位 mouse-trackpad 的 pointer pan）', () => {
    const el = fakeElement()
    const onPan = vi.fn()
    const onZoom = vi.fn()
    createTouchAdapter().attach(el as unknown as HTMLElement, { onPan, onZoom })
    el.dispatch('touchstart', { touches: [{ clientX: 0, clientY: 0 }], preventDefault: () => {} } as FakeTouchEv)
    el.dispatch('touchmove', { touches: [{ clientX: 50, clientY: 50 }], preventDefault: () => {} } as FakeTouchEv)
    expect(onZoom).not.toHaveBeenCalled()
    expect(onPan).not.toHaveBeenCalled()
  })
  it('双指张开（距离增大）→ onZoom factor<1（推近放大）', () => {
    const el = fakeElement()
    const onZoom = vi.fn()
    createTouchAdapter().attach(el as unknown as HTMLElement, { onPan: () => {}, onZoom })
    // 初始两指距离 100
    el.dispatch('touchstart', {
      touches: [{ clientX: 0, clientY: 0 }, { clientX: 100, clientY: 0 }],
      preventDefault: () => {},
    } as FakeTouchEv)
    // 张开到距离 200 → factor = lastDist/currDist = 100/200 = 0.5
    el.dispatch('touchmove', {
      touches: [{ clientX: 0, clientY: 0 }, { clientX: 200, clientY: 0 }],
      preventDefault: () => {},
    } as FakeTouchEv)
    expect(onZoom).toHaveBeenCalledTimes(1)
    expect(onZoom).toHaveBeenCalledWith(0.5)
  })
  it('双指捏合（距离减小）→ onZoom factor>1（拉远缩小）', () => {
    const el = fakeElement()
    const onZoom = vi.fn()
    createTouchAdapter().attach(el as unknown as HTMLElement, { onPan: () => {}, onZoom })
    el.dispatch('touchstart', {
      touches: [{ clientX: 0, clientY: 0 }, { clientX: 200, clientY: 0 }],
      preventDefault: () => {},
    } as FakeTouchEv)
    // 捏合到距离 100 → factor = 200/100 = 2
    el.dispatch('touchmove', {
      touches: [{ clientX: 0, clientY: 0 }, { clientX: 100, clientY: 0 }],
      preventDefault: () => {},
    } as FakeTouchEv)
    expect(onZoom).toHaveBeenCalledWith(2)
  })
  it('双指 touchmove 调 preventDefault（阻止浏览器页面 pinch-zoom）', () => {
    const el = fakeElement()
    const preventDefault = vi.fn()
    createTouchAdapter().attach(el as unknown as HTMLElement, { onPan: () => {}, onZoom: () => {} })
    el.dispatch('touchstart', {
      touches: [{ clientX: 0, clientY: 0 }, { clientX: 100, clientY: 0 }],
      preventDefault,
    } as FakeTouchEv)
    el.dispatch('touchmove', {
      touches: [{ clientX: 0, clientY: 0 }, { clientX: 150, clientY: 0 }],
      preventDefault,
    } as FakeTouchEv)
    expect(preventDefault).toHaveBeenCalled()
  })
  it('累积 pinch：多次 touchmove 各自上报相对上一帧的距离比', () => {
    const el = fakeElement()
    const onZoom = vi.fn()
    createTouchAdapter().attach(el as unknown as HTMLElement, { onPan: () => {}, onZoom })
    el.dispatch('touchstart', {
      touches: [{ clientX: 0, clientY: 0 }, { clientX: 100, clientY: 0 }],
      preventDefault: () => {},
    } as FakeTouchEv)
    // 100 → 150 → 300（每帧相对上一帧 currDist）
    el.dispatch('touchmove', {
      touches: [{ clientX: 0, clientY: 0 }, { clientX: 150, clientY: 0 }],
      preventDefault: () => {},
    } as FakeTouchEv) // factor = 100/150
    el.dispatch('touchmove', {
      touches: [{ clientX: 0, clientY: 0 }, { clientX: 300, clientY: 0 }],
      preventDefault: () => {},
    } as FakeTouchEv) // factor = 150/300
    expect(onZoom).toHaveBeenCalledTimes(2)
    expect(onZoom).toHaveBeenNthCalledWith(1, 100 / 150)
    expect(onZoom).toHaveBeenNthCalledWith(2, 150 / 300)
  })
  it('touchend 剩余 <2 指 → 重置，后续 touchmove 不误触发', () => {
    const el = fakeElement()
    const onZoom = vi.fn()
    createTouchAdapter().attach(el as unknown as HTMLElement, { onPan: () => {}, onZoom })
    el.dispatch('touchstart', {
      touches: [{ clientX: 0, clientY: 0 }, { clientX: 100, clientY: 0 }],
      preventDefault: () => {},
    } as FakeTouchEv)
    // 抬起一指（剩 1 指）→ pinchDist 重置为 null
    el.dispatch('touchend', {
      touches: [{ clientX: 50, clientY: 0 }],
      preventDefault: () => {},
    } as FakeTouchEv)
    // 即便 touches 仍是 2 个，pinchDist 已 null，onTouchMove 早返
    el.dispatch('touchmove', {
      touches: [{ clientX: 0, clientY: 0 }, { clientX: 200, clientY: 0 }],
      preventDefault: () => {},
    } as FakeTouchEv)
    expect(onZoom).not.toHaveBeenCalled()
  })
  it('attach 设 touch-action:none，detach 还原原值', () => {
    const el = fakeElement()
    el.style.touchAction = 'pan-x' // 模拟元素既有值
    const detach = createTouchAdapter().attach(el as unknown as HTMLElement, {
      onPan: () => {},
      onZoom: () => {},
    })
    expect(el.style.touchAction).toBe('none')
    detach()
    expect(el.style.touchAction).toBe('pan-x')
  })
  it('detach 后 touch 事件不再触发 onZoom', () => {
    const el = fakeElement()
    const onZoom = vi.fn()
    const detach = createTouchAdapter().attach(el as unknown as HTMLElement, { onPan: () => {}, onZoom })
    detach()
    el.dispatch('touchstart', {
      touches: [{ clientX: 0, clientY: 0 }, { clientX: 100, clientY: 0 }],
      preventDefault: () => {},
    } as FakeTouchEv)
    el.dispatch('touchmove', {
      touches: [{ clientX: 0, clientY: 0 }, { clientX: 200, clientY: 0 }],
      preventDefault: () => {},
    } as FakeTouchEv)
    expect(onZoom).not.toHaveBeenCalled()
  })
  it('detach 移除所有 touch 监听（计数归零）', () => {
    const el = fakeElement()
    const detach = createTouchAdapter().attach(el as unknown as HTMLElement, {
      onPan: () => {},
      onZoom: () => {},
    })
    expect(el.listenerCount('touchstart')).toBe(1)
    expect(el.listenerCount('touchmove')).toBe(1)
    expect(el.listenerCount('touchend')).toBe(1)
    expect(el.listenerCount('touchcancel')).toBe(1)
    detach()
    expect(el.listenerCount('touchstart')).toBe(0)
    expect(el.listenerCount('touchmove')).toBe(0)
  })
})
