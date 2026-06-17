/**
 * 争议边界变体接口（SPEC §6.3「争议边界合规 D10」+ §12，Task 21）。
 *
 * D10 合规：默认 Natural Earth 主流立场 + 争议区虚线，教育中立。本模块是**可替换数据源接口**
 * 预留——未来可切换「中文版 / 国际版」争议边界数据（不同立场表达）。MVP 仅 `ne` 变体生效
 * （消费 `public/data/disputed.bin`），`china` / `international` 为占位预留；渲染层 DisputedLines
 * 不依赖具体变体（争议虚线表达统一），仅数据源可替换。
 *
 * 纯配置（常量 + 类型 + getter），无副作用，可在 Node 单测验证「接口存在 / 可扩展 / 默认 ne」。
 * 未来切换路径：pipeline 按 variant 选不同 NE 子集 / 第三方数据 → 重生成 disputed.bin（前端不变），
 * 或前端按 variant fetch 不同 URL——本 Task 仅预留接口骨架，不绑定 fetch 契约。
 */

/** 争议边界数据源变体 id（D10 可替换接口；新增变体扩展此联合类型）。 */
export type BoundaryVariantId = 'ne' | 'china' | 'international'

/** 单个变体描述（接口可替换的数据维度）。 */
export interface BoundaryVariant {
  id: BoundaryVariantId
  /** 展示名（未来 Legend / 设置面板用）。 */
  label: string
  /**
   * 该变体的争议数据源说明（MVP 仅 `ne` 指向真实 NE disputed_areas 数据集）。
   * `reserved` = 预留占位（数据源未接入）。
   */
  disputedSource: string
  /** 是否已接入可用数据（MVP 仅 ne=true；预留变体 false）。 */
  available: boolean
}

/**
 * 变体表（SPEC §6.3：ne 默认 + 中文版/国际版预留）。
 * 新增变体只需在此追加一行 + 扩展 `BoundaryVariantId`——接口扩展点。
 */
export const BOUNDARY_VARIANTS: Record<BoundaryVariantId, BoundaryVariant> = {
  ne: {
    id: 'ne',
    label: 'Natural Earth（默认 · 教育中立）',
    disputedSource: 'ne_10m_admin_0_boundary_lines_disputed_areas',
    available: true,
  },
  china: {
    id: 'china',
    label: '中文版（预留）',
    disputedSource: 'reserved',
    available: false,
  },
  international: {
    id: 'international',
    label: '国际版（预留）',
    disputedSource: 'reserved',
    available: false,
  },
}

/** MVP 默认变体（D10：Natural Earth 主流立场，教育中立）。 */
export const DEFAULT_BOUNDARY_VARIANT: BoundaryVariantId = 'ne'

/** 当前生效变体（MVP 固定 ne；未来经 store / 设置面板切换时改为动态读取）。 */
export const CURRENT_BOUNDARY_VARIANT: BoundaryVariantId = DEFAULT_BOUNDARY_VARIANT

/**
 * 取变体描述（未知 id 回退默认 `ne`，不抛错——配置容错）。
 * @param id 变体 id（默认 `CURRENT_BOUNDARY_VARIANT`）
 */
export function getBoundaryVariant(
  id: BoundaryVariantId = CURRENT_BOUNDARY_VARIANT,
): BoundaryVariant {
  return BOUNDARY_VARIANTS[id] ?? BOUNDARY_VARIANTS[DEFAULT_BOUNDARY_VARIANT]
}

/** 全部可用变体（available=true），供未来切换 UI 枚举（MVP 仅 ne）。 */
export function availableVariants(): BoundaryVariant[] {
  return (Object.values(BOUNDARY_VARIANTS) as BoundaryVariant[]).filter((v) => v.available)
}
