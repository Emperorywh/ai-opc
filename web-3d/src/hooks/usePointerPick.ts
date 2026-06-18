/**
 * 指针拾取 hook（SPEC §6.3 D9 步骤 3-4，Task 23）—— 把颜色拾取能力（picking.ts）
 * 绑定到 R3F canvas DOM 指针事件 → store hovered/selected 流转。
 *
 * 流转闭环（SPEC §4.4 数据流）：
 *   pointermove(节流) → pickAt 读 1×1 → countryId → store.setHovered
 *   pointerdown/up（移动 < 阈值 = 点击，非拖拽 pan）→ pickAt → store.setSelected
 *   pointerleave → store.setHovered(null)
 *
 * ─── 与 SandboxControls 共存（SPEC §9「左键拖拽 pan + 左键点击选中」）──────────────
 * 左键同时用于 pan（SandboxControls）与 select（本 hook）。区分：pointerdown→pointerup 期间
 * 位移 ≤ CLICK_THRESHOLD_PX 视为「点击」→ 选中；超过阈值视为「拖拽」→ 不选中（pan 由
 * SandboxControls 处理）。两者各自绑 DOM 事件互不干扰（pan 在 capture 下持续，select 仅判位移）。
 *
 * ─── 性能（SPEC §6.3 点 5「仅在命中变化时」+ §6.3 D9 风险验证 2「不拖帧」）────────────
 *   - pickAt 按需渲染（指针事件时 1 次 RT draw call + 1px 回读，非每帧，Task 22）；
 *   - pointermove 经 PICK_THROTTLE_MS 节流（约 25 次/秒），高频移动不洪泛 pickAt；
 *   - hover 仅在命中 countryId **变化**时 setHovered（同国内部移动不触发 store 更新 →
 *     CountryMeshes 不 re-render → 高亮 uniform 不重复同步）。
 *
 * ─── 可测性（vitest node 无 DOM，仿 inputAdapter.test 模式）─────────────────────────
 * 核心「DOM 事件 → pick → 回调」逻辑抽成不依赖 React 的 createPointerPick 工厂（attach/detach），
 * + 纯函数（clientToNdc / isClickGesture / shouldPick）。hook 仅作薄绑定层（useThree + useEffect），
 * 与 useCameraInput（薄封装 inputAdapter）同惯例 —— hook 本身不单测，测工厂 + 纯函数。
 */
import { useEffect } from 'react'
import { useThree } from '@react-three/fiber'
import { useStore } from '../state/store'
import { getPickingApi } from '../three/borders/picking'

/** 点击位移阈值（px）：pointerdown→up 位移 ≤ 此值视为「点击」（非拖拽 pan）。 */
export const CLICK_THRESHOLD_PX = 5
/** pointermove 拾取节流间隔（ms）：约 25 次/秒，流畅且不洪泛 pickAt。 */
export const PICK_THROTTLE_MS = 40

/** 指针事件用到的字段（PointerEvent 的结构子集，测试用 plain 对象）。 */
type PointerEv = { clientX: number; clientY: number; button: number }

/** DOM 元素鸭子类型（addEventListener / removeEventListener），便于 fake element 注入测试。 */
export type PointerPickElement = {
  addEventListener: (type: string, fn: (e: PointerEv) => void) => void
  removeEventListener: (type: string, fn: (e: PointerEv) => void) => void
}

/** canvas 显示矩形（getBoundingClientRect 的结构子集）。 */
export type PointerPickRect = { left: number; top: number; width: number; height: number }

/** 拾取依赖（注入 pick 能力 + rect 获取，解耦真实 DOM）。 */
export type PointerPickDeps = {
  /** 给定指针 NDC [-1,1]，返回命中 countryId | null（未就绪 / 无命中）。 */
  pick: (ndcX: number, ndcY: number) => number | null
  /** 当前 canvas 显示矩形（NDC 换算基准）。 */
  getRect: () => PointerPickRect
}

/** 拾取回调（写 store hovered/selected）。 */
export type PointerPickHandlers = {
  onHover: (id: number | null) => void
  onSelect: (id: number | null) => void
}

export type PointerPickOptions = {
  /** 点击位移阈值（默认 CLICK_THRESHOLD_PX）。 */
  clickThresholdPx?: number
  /** pointermove 节流间隔（默认 PICK_THROTTLE_MS）。 */
  throttleMs?: number
  /** 时间源（默认 performance.now，测试注入固定时钟）。 */
  now?: () => number
}

// ---------------------------------------------------------------------------
// 纯函数（与 GLSL 无关，DOM 坐标换算 + 手势判定 + 节流，供单测）
// ---------------------------------------------------------------------------

/**
 * 客户端像素坐标 → NDC [-1,1]（SPEC §6.3 pickAt 的 NDC 输入）。
 *   ndcX = (clientX - rect.left) / rect.width × 2 - 1
 *   ndcY = -((clientY - rect.top) / rect.height × 2 - 1)   // DOM y 向下，NDC y 向上，取负翻转
 * 与 pickAt 内 NDC→像素映射互逆：clientX 在 rect 左缘→ndcX=-1→pickAt px=0。
 */
export function clientToNdc(
  clientX: number,
  clientY: number,
  rect: PointerPickRect,
): [number, number] {
  const ndcX = ((clientX - rect.left) / rect.width) * 2 - 1
  // 0 - (...) 而非 -(...)：避免中心点产生 -0（与 +0 数值等价，但 toEqual/toHaveBeenCalledWith 严格区分）
  const ndcY = 0 - (((clientY - rect.top) / rect.height) * 2 - 1)
  return [ndcX, ndcY]
}

/**
 * 是否「点击」手势（位移 ≤ 阈值）。区分左键拖拽 pan（SandboxControls）与点击选中（本 hook）。
 */
export function isClickGesture(
  downX: number,
  downY: number,
  upX: number,
  upY: number,
  threshold: number,
): boolean {
  return Math.hypot(upX - downX, upY - downY) <= threshold
}

/**
 * 节流判定：距上次拾取 ≥ throttleMs 才允许下一次（pointermove 高频节流）。
 */
export function shouldPick(now: number, lastPickTime: number, throttleMs: number): boolean {
  return now - lastPickTime >= throttleMs
}

// ---------------------------------------------------------------------------
// createPointerPick：DOM 事件 → pick → 回调（不依赖 React，fake-element 可测）
// ---------------------------------------------------------------------------

/**
 * 把指针拾取绑定到 DOM 元素，返回 detach（移除监听）。
 *
 *   pointermove → 节流 → pick → 命中变化才 onHover（同国内部移动不触发）
 *   pointerdown（主键）→ 记录起点
 *   pointerup（主键）→ 位移 ≤ 阈值 = 点击 → pick → onSelect（命中 id / 未命中 null）
 *   pointerleave → onHover(null) + 清按下状态
 *
 * deps.pick 在事件时读最新（getPickingApi 经 hook 注入，CountryMeshes 注册后生效）。
 */
export function createPointerPick(
  el: PointerPickElement,
  deps: PointerPickDeps,
  handlers: PointerPickHandlers,
  opts?: PointerPickOptions,
): () => void {
  const threshold = opts?.clickThresholdPx ?? CLICK_THRESHOLD_PX
  const throttleMs = opts?.throttleMs ?? PICK_THROTTLE_MS
  const now = opts?.now ?? (() => performance.now())

  let down: { x: number; y: number } | null = null
  let lastPickTime = -Infinity
  let lastHoverId: number | null = null

  const pickAtClient = (clientX: number, clientY: number): number | null => {
    const [ndcX, ndcY] = clientToNdc(clientX, clientY, deps.getRect())
    return deps.pick(ndcX, ndcY)
  }

  const onMove = (e: PointerEv) => {
    const t = now()
    if (!shouldPick(t, lastPickTime, throttleMs)) return
    lastPickTime = t
    const id = pickAtClient(e.clientX, e.clientY)
    if (id !== lastHoverId) {
      lastHoverId = id
      handlers.onHover(id)
    }
  }

  const onDown = (e: PointerEv) => {
    if (e.button !== 0) return // 仅主键
    down = { x: e.clientX, y: e.clientY }
  }

  const onUp = (e: PointerEv) => {
    if (e.button !== 0 || !down) return
    const movedOk = isClickGesture(down.x, down.y, e.clientX, e.clientY, threshold)
    down = null
    if (!movedOk) return // 拖拽（pan），非点击
    handlers.onSelect(pickAtClient(e.clientX, e.clientY))
  }

  const onLeave = () => {
    down = null
    if (lastHoverId !== null) {
      lastHoverId = null
      handlers.onHover(null)
    }
  }

  el.addEventListener('pointermove', onMove)
  el.addEventListener('pointerdown', onDown)
  el.addEventListener('pointerup', onUp)
  el.addEventListener('pointerleave', onLeave)

  return () => {
    el.removeEventListener('pointermove', onMove)
    el.removeEventListener('pointerdown', onDown)
    el.removeEventListener('pointerup', onUp)
    el.removeEventListener('pointerleave', onLeave)
  }
}

// ---------------------------------------------------------------------------
// usePointerPick hook（薄绑定层：useThree gl → createPointerPick）
// ---------------------------------------------------------------------------

/**
 * 绑定颜色拾取到 R3F canvas。须在 <Canvas> 子树内调用（读 useThree gl）。
 *
 * deps.pick 经 getPickingApi() 读 module 寄存器（CountryMeshes 挂载时注册）：
 *   - 未就绪（boundaries 未加载）→ pick 返回 null → onHover/onSelect(null)，无副作用；
 *   - 就绪后自动生效（事件时同步读最新 api）。
 * 回调写真实 store（getState 非订阅，避免本 hook 因 hovered/selected 变化 re-render ——
 * CountryMeshes 已订阅渲染高亮，本 hook 无需感知状态）。
 */
export function usePointerPick(): void {
  const gl = useThree((s) => s.gl)

  useEffect(() => {
    const el = gl.domElement as unknown as PointerPickElement
    const deps: PointerPickDeps = {
      pick: (ndcX, ndcY) => getPickingApi()?.pick(ndcX, ndcY) ?? null,
      getRect: () => {
        const r = gl.domElement.getBoundingClientRect()
        return { left: r.left, top: r.top, width: r.width, height: r.height }
      },
    }
    const handlers: PointerPickHandlers = {
      onHover: (id) => useStore.getState().setHovered(id),
      onSelect: (id) => useStore.getState().setSelected(id),
    }
    return createPointerPick(el, deps, handlers)
  }, [gl])
}
