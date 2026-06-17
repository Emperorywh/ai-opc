/**
 * 全局状态 —— Zustand 单一可信源（SPEC §4.2）。
 *
 * Task 01 仅落地切片骨架（类型 + setter）。各切片在对应 Task 实际接入：
 * - hoveredId / selectedId：M7（GPU 颜色拾取 + 交互高亮）
 * - cameraZoom：M3（SandboxControls）
 * - qualityTier：M3（AdaptiveQuality）—— 生效档位（渲染层订阅）
 * - qualityTierOverride：M3（AdaptiveQuality）—— 手动覆盖；null=自适应，非 null=锁定该档
 * - loadingStage / loadingProgress / loadingError：M5 Task 17（加载进度）
 *   加载状态横跨 UI 层（Loader）与 3D 层（Scene），R3F <Canvas> 不继承外部 React
 *   Context，故经 store 桥梁解耦（SPEC §4.2）。Scene 编排加载上报，Loader 订阅渲染。
 */
import { create } from 'zustand'
import type { QualityTier } from '../config/quality'

/** 地形资产加载阶段（Task 17，分项进度语义标记）。单调递进 init→meta→terrain→decode→ready。 */
export type LoadingStage = 'init' | 'meta' | 'terrain' | 'decode' | 'ready'

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
  /** 地形资产加载阶段（Task 17）。 */
  loadingStage: LoadingStage
  /** 整体加载进度 0–1（Task 17）；store 钳到 [0,1]。 */
  loadingProgress: number
  /** 地形资产加载错误信息（Task 17）；null=无错误。 */
  loadingError: string | null
  // setters
  setHovered: (id: number | null) => void
  setSelected: (id: number | null) => void
  setCameraZoom: (zoom: number) => void
  setQualityTier: (tier: QualityTier) => void
  setQualityTierOverride: (tier: QualityTier | null) => void
  /** 上报加载阶段与整体进度（Task 17，Scene 编排加载时调用；progress 自动钳到 [0,1]）。 */
  setLoading: (stage: LoadingStage, progress: number) => void
  /** 上报/清除加载错误（Task 17）。 */
  setLoadingError: (msg: string | null) => void
}

/** 钳到 [0,1]；非有限数回 0（loading.ts 有同名纯函数供单测，此处内联避免 store→ui 依赖）。 */
function clampProgress(p: number): number {
  if (!Number.isFinite(p)) return 0
  return Math.min(1, Math.max(0, p))
}

export const useStore = create<StoreState>()((set) => ({
  hoveredId: null,
  selectedId: null,
  cameraZoom: 1,
  qualityTier: 'high',
  qualityTierOverride: null,
  loadingStage: 'init',
  loadingProgress: 0,
  loadingError: null,
  setHovered: (id) => set({ hoveredId: id }),
  setSelected: (id) => set({ selectedId: id }),
  setCameraZoom: (zoom) => set({ cameraZoom: zoom }),
  setQualityTier: (tier) => set({ qualityTier: tier }),
  setQualityTierOverride: (tier) => set({ qualityTierOverride: tier }),
  setLoading: (stage, progress) =>
    set({ loadingStage: stage, loadingProgress: clampProgress(progress) }),
  setLoadingError: (msg) => set({ loadingError: msg }),
}))
