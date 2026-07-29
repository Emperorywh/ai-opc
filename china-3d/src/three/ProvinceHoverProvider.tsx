/**
 * 省级悬停焦点状态的 Provider 组件（TASK-009，SPEC §4.2）。
 *
 * 职责单一：持有 hoveredProvince（adminId | null）这一个 useState，并经 province-hover.ts 的双
 * context 向 Canvas 子树供给「状态（只读）+ dispatch（写入）」。本组件不拾取、不渲染任何 3D 对象，
 * 只是状态的挂载点——拾取由 ProvinceHoverPicker 单点承担，样式由 ProvinceBorders / TASK-010 标签
 * 模块消费。
 *
 * 挂载位置：必须放在 R3F <Canvas> 内部（Canvas 是独立 React 渲染根，外部 context 不透传），包裹
 * 省界线与拾取面（以及 TASK-010 的标签层）。状态变化时只有经 useHoveredProvince 读状态的消费者
 * 重渲染；children 元素引用来自父级、跨 Provider 重渲染保持稳定，故其余子树不发生无谓重渲染。
 */

import { useState } from 'react'
import type { ReactNode } from 'react'
import {
  HoveredProvinceContext,
  ProvinceHoverDispatchContext,
  type HoveredProvinceId,
} from './province-hover'

/** ProvinceHoverProvider 的 props：只接收 children，不接收任何配置 / 回调（状态自包含）。 */
export interface ProvinceHoverProviderProps {
  readonly children: ReactNode
}

/**
 * 悬停焦点状态的挂载点。hoveredAdminId 初值 null（无焦点）；ProvinceHoverPicker 经 dispatch 原子
 * 更新，卸载 / 移出 / 海域时复位 null（恢复不变量由拾取组件的清理与 out 回调共同保证）。
 */
export function ProvinceHoverProvider({ children }: ProvinceHoverProviderProps): ReactNode {
  const [hoveredAdminId, setHoveredAdminId] = useState<HoveredProvinceId>(null)
  // setHoveredAdminId 是 React 保证引用稳定的 setState：dispatch context 值永不变化，
  // 只写不读的拾取组件不因 hover 变化重渲染。
  return (
    <ProvinceHoverDispatchContext.Provider value={setHoveredAdminId}>
      <HoveredProvinceContext.Provider value={hoveredAdminId}>
        {children}
      </HoveredProvinceContext.Provider>
    </ProvinceHoverDispatchContext.Provider>
  )
}
