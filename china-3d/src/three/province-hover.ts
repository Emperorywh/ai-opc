/**
 * 省级悬停焦点的轻量共享状态（React context，TASK-009，SPEC §4.2）。
 *
 * 角色与依赖方向：
 * - 本模块是「hoveredProvince（悬停省份稳定标识 adminId | null）」跨组件共享的唯一载体。生产端
 *   （src/three/ProvinceHoverPicker——唯一拾取点）经 dispatch 写入；消费端（src/three/ProvinceBorders
 *   的边界样式；TASK-010 标签模块的标签样式）经 hook 只读消费。视图组件不得各自再做一次拾取，
 *   也不得用 Three.js 对象引用 / 中文名匹配 / 多组件布尔组合来表达焦点——焦点以稳定行政区标识
 *   （CN- 前缀 adminId）表达，单一字符串原子替换，快速跨省至多一个焦点、不残留多高亮。
 * - 本模块只依赖 React（createContext / useContext），不含组件（Provider 组件在
 *   ProvinceHoverProvider.tsx），故本文件不触发组件-非组件混合导出的 fast-refresh 约束。
 * - Provider 必须挂在 R3F <Canvas> 内部：Canvas 是独立 React 渲染根，外部 context 不会自动透传；
 *   而生产端与全部消费端（边界、TASK-010 标签）都在 Canvas 内，故 Provider 置于 Canvas 子树。
 *
 * 状态 / dispatch 双 context 拆分（避免无谓重渲染）：
 * - 状态 context（HoveredProvinceContext）：hover 变化时只有「读状态的消费者」（省界 Lines、标签）
 *   重渲染；dispatch context（ProvinceHoverDispatchContext）的值是 React 保证引用稳定的 setState，
 *   永不变化，故只写不读的 ProvinceHoverPicker 不因 hover 变化重渲染。
 * - 缺 Provider 时 hook 确定性抛错（显式失败，不静默无焦点）——消费方忘了被 Provider 包裹是装配
 *   错误，必须在挂载期暴露。状态以 `| undefined` 区分「Provider 缺失」（undefined）与「无焦点」
 *   （null，合法状态值）。
 */

import { createContext, useContext } from 'react'

/**
 * 悬停省份焦点：命中行政区的稳定标识（CN- 前缀 adminId），或 null（无焦点：指针在海域 / 地图外 /
 * 移出画布 / 几何未就绪）。
 */
export type HoveredProvinceId = string | null

/** dispatch 签名：把最新裁决结果（adminId 或 null）原子写入唯一焦点状态。 */
export type ProvinceHoverDispatch = (adminId: HoveredProvinceId) => void

/**
 * 悬停焦点状态 context（只读消费侧）。默认 undefined = 「Provider 缺失」哨兵；
 * Provider 内供给 HoveredProvinceId（string | null），故消费者可用 undefined 区分装配错误与无焦点。
 */
export const HoveredProvinceContext = createContext<HoveredProvinceId | undefined>(undefined)

/**
 * 悬停焦点 dispatch context（写入侧）。默认 null = 「Provider 缺失」哨兵（dispatch 本身是函数，
 * 用 null 作哨兵不会与合法值混淆）。
 */
export const ProvinceHoverDispatchContext = createContext<ProvinceHoverDispatch | null>(null)

/**
 * 读取当前悬停省份焦点（string | null）。仅供视图组件消费样式派生（省界加亮加粗 / 压暗、标签放大）。
 * 必须在 <ProvinceHoverProvider> 内使用，否则确定性抛错（装配错误显式暴露）。
 */
export function useHoveredProvince(): HoveredProvinceId {
  const value = useContext(HoveredProvinceContext)
  if (value === undefined) {
    throw new Error('useHoveredProvince 必须在 <ProvinceHoverProvider> 内使用（Canvas 子树）。')
  }
  return value
}

/**
 * 取得悬停焦点写入函数。仅供唯一拾取点（ProvinceHoverPicker）使用；视图组件不得经此写焦点
 * （单向数据流：拾取 → 状态 → 样式）。
 * 必须在 <ProvinceHoverProvider> 内使用，否则确定性抛错。
 */
export function useProvinceHoverDispatch(): ProvinceHoverDispatch {
  const dispatch = useContext(ProvinceHoverDispatchContext)
  if (dispatch === null) {
    throw new Error('useProvinceHoverDispatch 必须在 <ProvinceHoverProvider> 内使用（Canvas 子树）。')
  }
  return dispatch
}
