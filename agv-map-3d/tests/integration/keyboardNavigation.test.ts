// @vitest-environment jsdom
/*
 * 统一键盘导航焦点边界与消费范围集成断言（TASK-020，SPEC §12.5 / §13 / 任务约束，jsdom 环境）。
 *
 * 设计（任务验证方式第 3、4 项，不启动浏览器）：
 *   - createMapKeyboardHandler 是纯 DOM 接线（不依赖 Three / R3F），可在 jsdom 下直接验证。
 *   - 焦点边界：容器拥有焦点时消费已知键并 preventDefault；未聚焦 / 可编辑控件来源 / 未知键不消费、
 *     不 preventDefault、不派发意图（不劫持页面全局键盘）。
 *   - 重复按键：每次 keydown（含 repeat）均派发一次意图，支持长按连续平移 / 缩放 / 旋转。
 *   - 意图派发：方向键 / +/- / Q/E / Home 分别落到 onPan / onZoom / onRotate / onHome。
 *
 * 不启动浏览器：jsdom 提供 document.activeElement / element.focus() / window event 派发；
 *   不挂载 Canvas / WebGL，不接触 Three。
 */
import { describe, test, expect, beforeEach, afterEach } from 'vitest'
import {
  createMapKeyboardHandler,
} from '../../src/keyboardNavigation'
import type { KeyboardNavigationCallbacks } from '../../src/keyboardNavigation'

/*
 * 构造一个记录各意图调用次数的 mock 回调集合，便于断言派发目标。
 */
function makeTrackingCallbacks() {
  const calls = {
    pan: 0,
    zoom: 0,
    rotate: 0,
    home: 0,
    lastPan: null as null | { along: string; sign: number },
    lastZoom: null as null | { factor: number },
    lastRotate: null as null | { deltaRadians: number },
  }
  const callbacks: KeyboardNavigationCallbacks = {
    onPan: (i) => {
      calls.pan++
      calls.lastPan = { along: i.along, sign: i.sign }
    },
    onZoom: (i) => {
      calls.zoom++
      calls.lastZoom = { factor: i.factor }
    },
    onRotate: (i) => {
      calls.rotate++
      calls.lastRotate = { deltaRadians: i.deltaRadians }
    },
    onHome: () => {
      calls.home++
    },
  }
  return { callbacks, calls }
}

/*
 * 构造一个 cancelable KeyboardEvent；返回后可检查 defaultPrevented 验证 preventDefault 范围。
 */
function keydown(key: string, opts: { repeat?: boolean } = {}): KeyboardEvent {
  return new KeyboardEvent('keydown', {
    key,
    bubbles: true,
    cancelable: true,
    repeat: opts.repeat === true,
  })
}

describe('createMapKeyboardHandler · 焦点边界（SPEC §12.5 / 任务约束）', () => {
  let container: HTMLDivElement
  let handler: (event: KeyboardEvent) => void
  let tracked: ReturnType<typeof makeTrackingCallbacks>

  beforeEach(() => {
    container = document.createElement('div')
    container.tabIndex = 0
    document.body.appendChild(container)
    tracked = makeTrackingCallbacks()
    handler = createMapKeyboardHandler(container, tracked.callbacks)
    window.addEventListener('keydown', handler)
  })

  afterEach(() => {
    window.removeEventListener('keydown', handler)
    container.remove()
  })

  test('容器拥有焦点 + 方向键 → 派发 onPan + preventDefault', () => {
    container.focus()
    expect(document.activeElement).toBe(container)
    const ev = keydown('ArrowRight')
    window.dispatchEvent(ev)
    expect(tracked.calls.pan).toBe(1)
    expect(tracked.calls.lastPan).toEqual({ along: 'right', sign: 1 })
    expect(ev.defaultPrevented).toBe(true)
  })

  test('容器未聚焦 + 方向键 → 不派发、不 preventDefault（不劫持全局键盘）', () => {
    // 焦点在 body（容器外）。
    document.body.focus()
    expect(document.activeElement).not.toBe(container)
    const ev = keydown('ArrowRight')
    window.dispatchEvent(ev)
    expect(tracked.calls.pan).toBe(0)
    expect(ev.defaultPrevented).toBe(false)
  })
})

describe('createMapKeyboardHandler · container = null（尚未挂载）不消费（SPEC §12.5）', () => {
  let container: HTMLDivElement
  let tracked: ReturnType<typeof makeTrackingCallbacks>
  // null-container 专用 handler：在 beforeEach 创建、afterEach 解除，避免与非 null handler 互相干扰。
  let nullHandler: ((event: KeyboardEvent) => void) | null

  beforeEach(() => {
    container = document.createElement('div')
    container.tabIndex = 0
    document.body.appendChild(container)
    tracked = makeTrackingCallbacks()
    nullHandler = createMapKeyboardHandler(null, tracked.callbacks)
    window.addEventListener('keydown', nullHandler)
  })

  afterEach(() => {
    if (nullHandler !== null) {
      window.removeEventListener('keydown', nullHandler)
    }
    container.remove()
  })

  test('container = null + 容器聚焦 + 任意键 → 不派发、不 preventDefault', () => {
    container.focus()
    const ev = keydown('Home')
    window.dispatchEvent(ev)
    expect(tracked.calls.home).toBe(0)
    expect(ev.defaultPrevented).toBe(false)
  })
})

describe('createMapKeyboardHandler · 可编辑控件来源不劫持（任务异常路径）', () => {
  let container: HTMLDivElement
  let input: HTMLInputElement
  let handler: (event: KeyboardEvent) => void
  let tracked: ReturnType<typeof makeTrackingCallbacks>

  beforeEach(() => {
    container = document.createElement('div')
    container.tabIndex = 0
    input = document.createElement('input')
    container.appendChild(input)
    document.body.appendChild(container)
    tracked = makeTrackingCallbacks()
    handler = createMapKeyboardHandler(container, tracked.callbacks)
    window.addEventListener('keydown', handler)
  })

  afterEach(() => {
    window.removeEventListener('keydown', handler)
    container.remove()
  })

  test('容器内 input 拥有焦点 + 方向键 → 不派发（避免劫持文本输入）', () => {
    input.focus()
    expect(document.activeElement).toBe(input)
    // input 在 container 内，但属可编辑控件：不消费。
    const ev = keydown('ArrowLeft')
    window.dispatchEvent(ev)
    expect(tracked.calls.pan).toBe(0)
    expect(ev.defaultPrevented).toBe(false)
  })

  test('容器内 textarea 拥有焦点 + Home → 不派发', () => {
    const textarea = document.createElement('textarea')
    container.appendChild(textarea)
    textarea.focus()
    const ev = keydown('Home')
    window.dispatchEvent(ev)
    expect(tracked.calls.home).toBe(0)
    expect(ev.defaultPrevented).toBe(false)
  })
})

describe('createMapKeyboardHandler · 未知键不消费（SPEC §12.5 / 任务约束）', () => {
  let container: HTMLDivElement
  let handler: (event: KeyboardEvent) => void
  let tracked: ReturnType<typeof makeTrackingCallbacks>

  beforeEach(() => {
    container = document.createElement('div')
    container.tabIndex = 0
    document.body.appendChild(container)
    tracked = makeTrackingCallbacks()
    handler = createMapKeyboardHandler(container, tracked.callbacks)
    window.addEventListener('keydown', handler)
  })

  afterEach(() => {
    window.removeEventListener('keydown', handler)
    container.remove()
  })

  test.each(['Enter', 'Tab', ' ', 'Escape', 'a', 'PageDown', 'F5'])(
    '容器聚焦 + 未知键 %s → 不派发、不 preventDefault',
    (key) => {
      container.focus()
      const ev = keydown(key)
      window.dispatchEvent(ev)
      expect(tracked.calls.pan + tracked.calls.zoom + tracked.calls.rotate + tracked.calls.home).toBe(0)
      expect(ev.defaultPrevented).toBe(false)
    },
  )
})

describe('createMapKeyboardHandler · 意图派发目标准确（SPEC §12.5）', () => {
  let container: HTMLDivElement
  let handler: (event: KeyboardEvent) => void
  let tracked: ReturnType<typeof makeTrackingCallbacks>

  beforeEach(() => {
    container = document.createElement('div')
    container.tabIndex = 0
    document.body.appendChild(container)
    tracked = makeTrackingCallbacks()
    handler = createMapKeyboardHandler(container, tracked.callbacks)
    window.addEventListener('keydown', handler)
  })

  afterEach(() => {
    window.removeEventListener('keydown', handler)
    container.remove()
  })

  test('四个方向键分别派发正确的 along / sign', () => {
    container.focus()
    window.dispatchEvent(keydown('ArrowLeft'))
    window.dispatchEvent(keydown('ArrowRight'))
    window.dispatchEvent(keydown('ArrowUp'))
    window.dispatchEvent(keydown('ArrowDown'))
    expect(tracked.calls.pan).toBe(4)
  })

  test('+ / - 分别派发 zoom（factor 0.9 / 1.1）', () => {
    container.focus()
    window.dispatchEvent(keydown('+'))
    expect(tracked.calls.lastZoom).toEqual({ factor: 0.9 })
    window.dispatchEvent(keydown('-'))
    expect(tracked.calls.lastZoom).toEqual({ factor: 1.1 })
    expect(tracked.calls.zoom).toBe(2)
  })

  test('q / e 分别派发 rotate（正 / 负角度）', () => {
    container.focus()
    window.dispatchEvent(keydown('q'))
    const qRot = tracked.calls.lastRotate!.deltaRadians
    expect(qRot).toBeGreaterThan(0)
    window.dispatchEvent(keydown('e'))
    const eRot = tracked.calls.lastRotate!.deltaRadians
    expect(eRot).toBeLessThan(0)
    expect(tracked.calls.rotate).toBe(2)
  })

  test('Home 派发 onHome', () => {
    container.focus()
    window.dispatchEvent(keydown('Home'))
    expect(tracked.calls.home).toBe(1)
  })
})

describe('createMapKeyboardHandler · 重复按键连续派发（任务验证方式第 4 项）', () => {
  let container: HTMLDivElement
  let handler: (event: KeyboardEvent) => void
  let tracked: ReturnType<typeof makeTrackingCallbacks>

  beforeEach(() => {
    container = document.createElement('div')
    container.tabIndex = 0
    document.body.appendChild(container)
    tracked = makeTrackingCallbacks()
    handler = createMapKeyboardHandler(container, tracked.callbacks)
    window.addEventListener('keydown', handler)
  })

  afterEach(() => {
    window.removeEventListener('keydown', handler)
    container.remove()
  })

  test('长按方向键（repeat = true）每次 keydown 均派发：5 次 repeat → 5 次 onPan', () => {
    container.focus()
    for (let i = 0; i < 5; i++) {
      window.dispatchEvent(keydown('ArrowUp', { repeat: true }))
    }
    expect(tracked.calls.pan).toBe(5)
  })

  test('长按 +/- 连续缩放：3 次 repeat → 3 次 onZoom', () => {
    container.focus()
    for (let i = 0; i < 3; i++) {
      window.dispatchEvent(keydown('-', { repeat: true }))
    }
    expect(tracked.calls.zoom).toBe(3)
  })

  test('长按 Q/E 连续旋转：4 次 repeat → 4 次 onRotate', () => {
    container.focus()
    for (let i = 0; i < 4; i++) {
      window.dispatchEvent(keydown('e', { repeat: true }))
    }
    expect(tracked.calls.rotate).toBe(4)
  })
})
