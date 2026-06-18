/**
 * Task 23 · 指针拾取 hook 单测（usePointerPick 纯函数 + createPointerPick 工厂）。
 *
 * 覆盖（SPEC §6.3 D9 步骤 3-4 / 风险验证 2 不拖帧 / §9 左键拖拽 vs 点击）：
 *   · clientToNdc：客户端像素 → NDC（边界 + y 翻转，与 pickAt NDC→像素互逆）
 *   · isClickGesture：位移阈值判定（点击 vs 拖拽 pan）
 *   · shouldPick：pointermove 节流
 *   · createPointerPick（fake-element 集成）：
 *       pointermove→pick→onHover（命中变化才触发）/ 节流 / null 处理
 *       pointerdown+up 小位移→onSelect / 大位移不触发（拖拽）/ 非主键
 *       pointerleave→onHover(null) / detach 移除监听
 *
 * vitest node 无 DOM，用 fake element（addEventListener/removeEventListener/dispatch stub）
 * + 注入式 deps.pick/getRect/handlers/now —— 仅测事件→拾取→回调逻辑，不依赖浏览器 PointerEvent。
 * 同 inputAdapter.test 模式；hook 本身（useThree + useEffect 薄封装）不单测。
 */
import { describe, it, expect, vi } from 'vitest'
import {
  clientToNdc,
  isClickGesture,
  shouldPick,
  createPointerPick,
  CLICK_THRESHOLD_PX,
  PICK_THROTTLE_MS,
  type PointerPickElement,
  type PointerEv,
  type PointerPickRect,
} from '../src/hooks/usePointerPick'

// ---- fake element（node 无 DOM，复刻 addEventListener/removeEventListener/dispatch）----
function fakeElement() {
  const listeners = new Map<string, Set<(e: PointerEv) => void>>()
  return {
    addEventListener(type: string, fn: (e: PointerEv) => void) {
      let set = listeners.get(type)
      if (!set) {
        set = new Set()
        listeners.set(type, set)
      }
      set.add(fn)
    },
    removeEventListener(type: string, fn: (e: PointerEv) => void) {
      listeners.get(type)?.delete(fn)
    },
    dispatch(type: string, ev: PointerEv) {
      listeners.get(type)?.forEach((fn) => fn(ev))
    },
    listenerCount(type: string) {
      return listeners.get(type)?.size ?? 0
    },
  }
}

const RECT: PointerPickRect = { left: 0, top: 0, width: 100, height: 100 }

function makeDeps(returns: number | null) {
  return {
    pick: vi.fn(() => returns),
    getRect: () => RECT,
  }
}

// ---------------------------------------------------------------------------
// clientToNdc
// ---------------------------------------------------------------------------

describe('clientToNdc（客户端像素 → NDC）', () => {
  it('左上角 → (-1, +1)（NDC 原点左下，y 翻转）', () => {
    expect(clientToNdc(0, 0, RECT)).toEqual([-1, 1])
  })
  it('右下角 → (+1, -1)', () => {
    expect(clientToNdc(100, 100, RECT)).toEqual([1, -1])
  })
  it('中心 → (0, 0)', () => {
    expect(clientToNdc(50, 50, RECT)).toEqual([0, 0])
  })
  it('y 翻转：clientY 增大 → ndcY 减小（DOM 向下，NDC 向上）', () => {
    const [, y1] = clientToNdc(50, 25, RECT)
    const [, y2] = clientToNdc(50, 75, RECT)
    expect(y1).toBeGreaterThan(y2)
  })
  it('rect offset：left/top 偏移基准', () => {
    const r: PointerPickRect = { left: 200, top: 100, width: 100, height: 100 }
    expect(clientToNdc(200, 100, r)).toEqual([-1, 1])
    expect(clientToNdc(250, 150, r)).toEqual([0, 0])
  })
  it('与 pickAt NDC→像素 互逆：ndcX=0 → pickAt px=w/2', () => {
    // clientX=50→ndcX=0；pickAt 内 px=round((0+1)/2*w)=w/2=50（w=100）。闭环对齐。
    const [ndcX] = clientToNdc(50, 50, RECT)
    expect(Math.round(((ndcX + 1) / 2) * 100)).toBe(50)
  })
})

// ---------------------------------------------------------------------------
// isClickGesture
// ---------------------------------------------------------------------------

describe('isClickGesture（点击 vs 拖拽）', () => {
  it('位移 0 → true（纯点击）', () => {
    expect(isClickGesture(50, 50, 50, 50, CLICK_THRESHOLD_PX)).toBe(true)
  })
  it('位移 < 阈值 → true（轻微抖动仍算点击）', () => {
    expect(isClickGesture(0, 0, 3, 4, CLICK_THRESHOLD_PX)).toBe(true) // hypot=5
  })
  it('位移 > 阈值 → false（拖拽 pan）', () => {
    expect(isClickGesture(0, 0, 6, 0, CLICK_THRESHOLD_PX)).toBe(false) // hypot=6
    expect(isClickGesture(0, 0, 100, 100, CLICK_THRESHOLD_PX)).toBe(false)
  })
  it('位移 = 阈值 → true（边界含等号）', () => {
    expect(isClickGesture(0, 0, CLICK_THRESHOLD_PX, 0, CLICK_THRESHOLD_PX)).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// shouldPick（节流）
// ---------------------------------------------------------------------------

describe('shouldPick（pointermove 节流）', () => {
  it('首次（last=-Infinity）→ true', () => {
    expect(shouldPick(0, -Infinity, PICK_THROTTLE_MS)).toBe(true)
  })
  it('间隔 < throttleMs → false（节流）', () => {
    expect(shouldPick(30, 0, PICK_THROTTLE_MS)).toBe(false) // 30 < 40
  })
  it('间隔 >= throttleMs → true', () => {
    expect(shouldPick(40, 0, PICK_THROTTLE_MS)).toBe(true)
    expect(shouldPick(100, 0, PICK_THROTTLE_MS)).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// createPointerPick（fake-element 集成）
// ---------------------------------------------------------------------------

describe('createPointerPick（事件→拾取→回调）', () => {
  function setup(returns: number | null, nowSeq: number[] = [0]) {
    const el = fakeElement()
    const deps = makeDeps(returns)
    const handlers = { onHover: vi.fn(), onSelect: vi.fn() }
    let i = 0
    const now = () => nowSeq[Math.min(i++, nowSeq.length - 1)]
    const detach = createPointerPick(
      el as unknown as PointerPickElement,
      deps,
      handlers,
      { now },
    )
    return { el, deps, handlers, detach }
  }

  it('返回 detach 函数', () => {
    const { detach } = setup(0)
    expect(typeof detach).toBe('function')
    detach()
  })

  it('注册 4 类监听（pointermove/down/up/leave）', () => {
    const { el, detach } = setup(0)
    expect(el.listenerCount('pointermove')).toBe(1)
    expect(el.listenerCount('pointerdown')).toBe(1)
    expect(el.listenerCount('pointerup')).toBe(1)
    expect(el.listenerCount('pointerleave')).toBe(1)
    detach()
  })

  it('pointermove → pick 收到正确 NDC（中心→(0,0)）→ onHover(id)', () => {
    const { el, deps, handlers, detach } = setup(5)
    el.dispatch('pointermove', { clientX: 50, clientY: 50, button: 0 })
    expect(deps.pick).toHaveBeenCalledWith(0, 0)
    expect(handlers.onHover).toHaveBeenCalledWith(5)
    detach()
  })

  it('节流：同帧多次 pointermove 只 pick 一次', () => {
    const { el, deps, detach } = setup(5, [10, 10, 10]) // now 恒 10
    el.dispatch('pointermove', { clientX: 50, clientY: 50, button: 0 })
    el.dispatch('pointermove', { clientX: 60, clientY: 50, button: 0 })
    el.dispatch('pointermove', { clientX: 70, clientY: 50, button: 0 })
    expect(deps.pick).toHaveBeenCalledTimes(1)
    detach()
  })

  it('节流解除：now 推进 >= throttleMs 后再次 pick', () => {
    const { el, deps, detach } = setup(5, [0, 0, 100]) // 第3次 now=100 >= 40
    el.dispatch('pointermove', { clientX: 50, clientY: 50, button: 0 })
    el.dispatch('pointermove', { clientX: 51, clientY: 50, button: 0 }) // now=0 节流
    el.dispatch('pointermove', { clientX: 52, clientY: 50, button: 0 }) // now=100 解除
    expect(deps.pick).toHaveBeenCalledTimes(2)
    detach()
  })

  it('命中变化才 onHover：同国内部移动（pick 恒返回）只触发一次', () => {
    const { el, handlers, detach } = setup(5, [0, 100, 200])
    el.dispatch('pointermove', { clientX: 50, clientY: 50, button: 0 }) // →5
    el.dispatch('pointermove', { clientX: 55, clientY: 50, button: 0 }) // →5（无变化）
    el.dispatch('pointermove', { clientX: 60, clientY: 50, button: 0 }) // →5（无变化）
    expect(handlers.onHover).toHaveBeenCalledTimes(1)
    expect(handlers.onHover).toHaveBeenCalledWith(5)
    detach()
  })

  it('命中变化：从国家 5 移到 null（边界外）→ onHover(null)', () => {
    const el = fakeElement()
    let cur = 5
    const deps = { pick: () => cur, getRect: () => RECT }
    const handlers = { onHover: vi.fn(), onSelect: vi.fn() }
    let t = 0
    const detach = createPointerPick(el as unknown as PointerPickElement, deps, handlers, {
      now: () => (t += 100),
    })
    el.dispatch('pointermove', { clientX: 50, clientY: 50, button: 0 }) // →5
    cur = null
    el.dispatch('pointermove', { clientX: 50, clientY: 50, button: 0 }) // →null（变化）
    expect(handlers.onHover).toHaveBeenNthCalledWith(1, 5)
    expect(handlers.onHover).toHaveBeenNthCalledWith(2, null)
    detach()
  })

  it('pointerdown + pointerup 小位移 → onSelect(pick 结果)', () => {
    const { el, handlers, detach } = setup(7)
    el.dispatch('pointerdown', { clientX: 50, clientY: 50, button: 0 })
    el.dispatch('pointerup', { clientX: 52, clientY: 51, button: 0 }) // hypot≈2.8 < 5
    expect(handlers.onSelect).toHaveBeenCalledWith(7)
    detach()
  })

  it('pointerup 命中 null → onSelect(null)（点击空白取消选中）', () => {
    const { el, handlers, detach } = setup(null)
    el.dispatch('pointerdown', { clientX: 50, clientY: 50, button: 0 })
    el.dispatch('pointerup', { clientX: 50, clientY: 50, button: 0 })
    expect(handlers.onSelect).toHaveBeenCalledWith(null)
    detach()
  })

  it('pointerdown + pointerup 大位移 → 不 onSelect（拖拽 pan）', () => {
    const { el, handlers, detach } = setup(7)
    el.dispatch('pointerdown', { clientX: 0, clientY: 0, button: 0 })
    el.dispatch('pointerup', { clientX: 100, clientY: 100, button: 0 }) // hypot≈141 > 5
    expect(handlers.onSelect).not.toHaveBeenCalled()
    detach()
  })

  it('未 pointerdown 直接 pointerup → 不 onSelect', () => {
    const { el, handlers, detach } = setup(7)
    el.dispatch('pointerup', { clientX: 50, clientY: 50, button: 0 })
    expect(handlers.onSelect).not.toHaveBeenCalled()
    detach()
  })

  it('非主键（button≠0）不触发 select', () => {
    const { el, handlers, detach } = setup(7)
    el.dispatch('pointerdown', { clientX: 50, clientY: 50, button: 2 })
    el.dispatch('pointerup', { clientX: 50, clientY: 50, button: 2 })
    expect(handlers.onSelect).not.toHaveBeenCalled()
    detach()
  })

  it('pointerleave → onHover(null)', () => {
    const { el, handlers, detach } = setup(5, [0, 0])
    el.dispatch('pointermove', { clientX: 50, clientY: 50, button: 0 }) // →5
    el.dispatch('pointerleave', { clientX: 0, clientY: 0, button: 0 })
    expect(handlers.onHover).toHaveBeenLastCalledWith(null)
    detach()
  })

  it('pointerleave 清按下状态（leave 后 up 不误判 click）', () => {
    const { el, handlers, detach } = setup(7)
    el.dispatch('pointerdown', { clientX: 50, clientY: 50, button: 0 })
    el.dispatch('pointerleave', { clientX: 0, clientY: 0, button: 0 })
    el.dispatch('pointerup', { clientX: 50, clientY: 50, button: 0 }) // down 已清
    expect(handlers.onSelect).not.toHaveBeenCalled()
    detach()
  })

  it('detach 移除所有监听（计数归零）', () => {
    const { el, detach } = setup(0)
    detach()
    expect(el.listenerCount('pointermove')).toBe(0)
    expect(el.listenerCount('pointerdown')).toBe(0)
    expect(el.listenerCount('pointerup')).toBe(0)
    expect(el.listenerCount('pointerleave')).toBe(0)
  })

  it('detach 后事件不再触发回调', () => {
    const { el, deps, handlers, detach } = setup(5)
    detach()
    el.dispatch('pointermove', { clientX: 50, clientY: 50, button: 0 })
    el.dispatch('pointerdown', { clientX: 50, clientY: 50, button: 0 })
    el.dispatch('pointerup', { clientX: 50, clientY: 50, button: 0 })
    expect(deps.pick).not.toHaveBeenCalled()
    expect(handlers.onHover).not.toHaveBeenCalled()
    expect(handlers.onSelect).not.toHaveBeenCalled()
  })
})
