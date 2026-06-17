/**
 * 全局状态 —— Zustand 单一可信源（SPEC §4.2）。
 *
 * Task 01 仅落地切片骨架（类型 + setter）。各切片在对应 Task 实际接入：
 * - hoveredId / selectedId：M7（GPU 颜色拾取 + 交互高亮）
 * - cameraZoom：M3（SandboxControls）
 * - qualityTier：M3（AdaptiveQuality）—— 生效档位（渲染层订阅）
 * - qualityTierOverride：M3（AdaptiveQuality）—— 手动覆盖；null=自适应，非 null=锁定该档
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
  /** 当前生效质量分档（M3，渲染层 ocean/terrain 订阅切换 uniform value）。 */
  qualityTier: QualityTier
  /** 手动覆盖档位（M3）；null=自适应探测，非 null=锁定（暂停自适应切换）。 */
  qualityTierOverride: QualityTier | null
  // setters
  setHovered: (id: number | null) => void
  setSelected: (id: number | null) => void
  setCameraZoom: (zoom: number) => void
  setQualityTier: (tier: QualityTier) => void
  setQualityTierOverride: (tier: QualityTier | null) => void
}

export const useStore = create<StoreState>()((set) => ({
  hoveredId: null,
  selectedId: null,
  cameraZoom: 1,
  qualityTier: 'high',
  qualityTierOverride: null,
  setHovered: (id) => set({ hoveredId: id }),
  setSelected: (id) => set({ selectedId: id }),
  setCameraZoom: (zoom) => set({ cameraZoom: zoom }),
  setQualityTier: (tier) => set({ qualityTier: tier }),
  setQualityTierOverride: (tier) => set({ qualityTierOverride: tier }),
}))
