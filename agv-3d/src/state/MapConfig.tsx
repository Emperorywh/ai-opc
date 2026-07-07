// ============================================================================
// 全局运行时状态：相机模式 + 标签开关 + Y 翻转开关（SPEC §3、§5.4、§10）
// ----------------------------------------------------------------------------
// 设计要点：
// 1. 用 React Context + useState 承载，不引入 zustand（SPEC §5.4 明确）。
// 2. Controls（TASK_011）写入这些开关，各渲染层与 MapView 通过 useMapConfig 读取。
// 3. 默认值取自 src/config/constants.ts，保证「集中配置」单一来源。
// ============================================================================
import { createContext, useContext, useState } from 'react'
import type { ReactNode } from 'react'

import { constants } from '../config/constants.ts'

// ----------------------------------------------------------------------------
// 相机投影模式（SPEC §3）
// - orthographic：正交，纯俯视（默认）
// - perspective：透视，斜视
// 用字面量联合而非 enum，兼容 erasableSyntaxOnly。
// ----------------------------------------------------------------------------
export type CameraMode = 'orthographic' | 'perspective'

// ----------------------------------------------------------------------------
// Context 值：四个开关 + 各自的 setter
// 与 useState 一一对应，调用方既能读值也能改值。
// ----------------------------------------------------------------------------
export interface MapConfigValue {
  // Y 翻转开关：true 时场景对 z 取反（校正上下镜像）
  isFlipY: boolean
  // 相机模式：正交 / 透视
  cameraMode: CameraMode
  // 节点标签显隐开关（默认关，SPEC §5.4）
  showNodeLabels: boolean
  // 路径标签显隐开关（默认关，SPEC §5.4）
  showEdgeLabels: boolean
  // 各开关的写入函数
  setIsFlipY: (value: boolean) => void
  setCameraMode: (value: CameraMode) => void
  setShowNodeLabels: (value: boolean) => void
  setShowEdgeLabels: (value: boolean) => void
}

// ----------------------------------------------------------------------------
// 默认值：取自 constants（SPEC §3、§7）
// - isFlipY 默认 false（源数据 Y 朝向未定，渲染后据实翻转）
// - cameraMode 默认正交（纯俯视）
// - 两个标签开关默认关（1k–10k 标签默认不渲染，避免性能崩溃）
// ----------------------------------------------------------------------------
const DEFAULT_IS_FLIP_Y = constants.isFlipY
const DEFAULT_CAMERA_MODE: CameraMode = 'orthographic'
const DEFAULT_SHOW_NODE_LABELS = false
const DEFAULT_SHOW_EDGE_LABELS = false

// ----------------------------------------------------------------------------
// Context：未挂 Provider 时存 null，由 useMapConfig 兜底抛错
// 不给无意义默认值，强制消费方必须在 Provider 树内调用，及早暴露错误挂载。
// ----------------------------------------------------------------------------
const MapConfigContext = createContext<MapConfigValue | null>(null)

// ----------------------------------------------------------------------------
// Provider：用四个 useState 持有开关状态
// value 为字面量对象，每次渲染重建——本场景状态少、更新不频繁，
// 无需 useMemo 优化（Phase 1 不引入额外复杂度）。
// ----------------------------------------------------------------------------
export function MapConfigProvider({ children }: { children: ReactNode }) {
  const [isFlipY, setIsFlipY] = useState<boolean>(DEFAULT_IS_FLIP_Y)
  const [cameraMode, setCameraMode] = useState<CameraMode>(DEFAULT_CAMERA_MODE)
  const [showNodeLabels, setShowNodeLabels] = useState<boolean>(
    DEFAULT_SHOW_NODE_LABELS,
  )
  const [showEdgeLabels, setShowEdgeLabels] = useState<boolean>(
    DEFAULT_SHOW_EDGE_LABELS,
  )

  const value: MapConfigValue = {
    isFlipY,
    cameraMode,
    showNodeLabels,
    showEdgeLabels,
    setIsFlipY,
    setCameraMode,
    setShowNodeLabels,
    setShowEdgeLabels,
  }

  return (
    <MapConfigContext.Provider value={value}>
      {children}
    </MapConfigContext.Provider>
  )
}

// ----------------------------------------------------------------------------
// 消费钩子：必须在 <MapConfigProvider> 内调用（遵守 react/rules-of-hooks）
// 未挂 Provider 时抛错，避免组件在无状态下静默渲染出错。
// ----------------------------------------------------------------------------
export function useMapConfig(): MapConfigValue {
  const value = useContext(MapConfigContext)
  if (value === null) {
    throw new Error('useMapConfig 必须在 <MapConfigProvider> 内部使用')
  }
  return value
}
