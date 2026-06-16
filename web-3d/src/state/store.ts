/**
 * 全局状态 —— Zustand 单一可信源（SPEC §4.2）。
 *
 * Task 01 仅落地切片骨架（类型 + setter）。各切片在对应 Task 实际接入：
 * - hoveredId / selectedId：M7（GPU 颜色拾取 + 交互高亮）
 * - cameraZoom：M3（SandboxControls）
 * - qualityTier：M3（AdaptiveQuality）
 */
import { create } from 'zustand'
import type { QualityTier } from '../config/quality'

export type StoreState = {
  /** 当前悬停国家 id（M7）。 */
  hoveredId: number | null
  /** 当前选中国家 id（M7）。 */
  selectedId: number | null
  /** 相机当前缩放（M3）。 */
  cameraZoom: number
  /** 当前质量分档（M3）。 */
  qualityTier: QualityTier
  // setters
  setHovered: (id: number | null) => void
  setSelected: (id: number | null) => void
  setCameraZoom: (zoom: number) => void
  setQualityTier: (tier: QualityTier) => void
}

export const useStore = create<StoreState>()((set) => ({
  hoveredId: null,
  selectedId: null,
  cameraZoom: 1,
  qualityTier: 'high',
  setHovered: (id) => set({ hoveredId: id }),
  setSelected: (id) => set({ selectedId: id }),
  setCameraZoom: (zoom) => set({ cameraZoom: zoom }),
  setQualityTier: (tier) => set({ qualityTier: tier }),
}))
