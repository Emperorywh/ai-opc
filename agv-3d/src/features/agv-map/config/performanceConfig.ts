/**
 * 性能与像素预算集中配置（SPEC §11.1、§12）。
 *
 * 配置按职责集中、所有参数携带单位后缀（SPEC §12）。本文件承载主画布物理像素预算与
 * 有效 DPR 计算逻辑：在任意 CSS 尺寸与设备像素比下，把实际渲染像素限制在 4K 预算内，
 * 避免操作系统缩放使 4K 目标画布膨胀到 6K/8K（SPEC §11.1）。
 *
 * 阴影贴图与反射 RenderTarget 分辨率同样属于性能预算，但其使用方（阴影贴图、反射地面）
 * 由 TASK-012 接入；本期不预留空字段或占位值（§2.3 不创建未实现能力的空模块），
 * TASK-012 落地时在本文件追加 SHADOW_MAP_SIZE_PIXELS 与 REFLECTION_TARGET_SIZE_PIXELS。
 *
 * 不变量：
 * - effectiveDpr 为纯函数：相同输入产生相同输出，不读取 DOM 以外的隐式状态；
 *   DOM 尺寸与 devicePixelRatio 由调用方传入。
 * - 像素预算为硬上限：当设备像素比或 CSS 尺寸使物理像素超过预算时，DPR 被向下钳制，
 *   保证渲染分辨率不超标；CSS 尺寸本身不受影响，画面布局由 Canvas 跟随容器（§9.3）。
 */

/** 主画布最大物理宽度，单位像素（SPEC §11.1：3840）。 */
export const MAX_RENDER_WIDTH_PX = 3840

/** 主画布最大物理高度，单位像素（SPEC §11.1：2160）。 */
export const MAX_RENDER_HEIGHT_PX = 2160

/** 主画布最大物理像素总数（SPEC §11.1：3840 × 2160）。 */
export const MAX_RENDER_PIXELS = MAX_RENDER_WIDTH_PX * MAX_RENDER_HEIGHT_PX

/**
 * DPR 下限（SPEC §11.1 effectiveDpr 公式）。
 * 取 1 保证极端高分辨率容器或低 DPR 设备下仍以 CSS 像素 1:1 渲染，避免退化到 0 或负值。
 */
export const DPR_FLOOR = 1

/**
 * 计算有效设备像素比（SPEC §11.1）。
 *
 * 公式：effectiveDpr = min(devicePixelRatio, sqrt(MAX_RENDER_PIXELS / (cssWidth × cssHeight)))。
 *
 * - 当 CSS 尺寸较小（如 1080p 窗口）时，平方根项通常大于设备像素比，DPR 取设备像素比，
 *   画面保持原生清晰度。
 * - 当 CSS 尺寸接近或超过 4K（如 4K 大屏 + 操作系统缩放）时，平方根项把 DPR 向下钳制，
 *   使物理像素总数不超过 3840×2160，避免 6K/8K 膨胀（§11.1）。
 * - 输入非法（非有限或非正尺寸）时回退到 DPR_FLOOR，保证不产生 NaN 相机/渲染参数（§9.3）。
 *
 * @param devicePixelRatio 浏览器 window.devicePixelRatio（或等效物理/CSS 像素比）。
 * @param cssWidth 渲染容器 CSS 宽度，单位像素。
 * @param cssHeight 渲染容器 CSS 高度，单位像素。
 */
export function computeEffectiveDpr(
  devicePixelRatio: number,
  cssWidth: number,
  cssHeight: number,
): number {
  if (!Number.isFinite(devicePixelRatio) || devicePixelRatio <= 0) return DPR_FLOOR
  if (!Number.isFinite(cssWidth) || !Number.isFinite(cssHeight)) return DPR_FLOOR
  if (cssWidth <= 0 || cssHeight <= 0) return DPR_FLOOR
  const cssPixels = cssWidth * cssHeight
  const budgetRatio = Math.sqrt(MAX_RENDER_PIXELS / cssPixels)
  return Math.max(DPR_FLOOR, Math.min(devicePixelRatio, budgetRatio))
}
