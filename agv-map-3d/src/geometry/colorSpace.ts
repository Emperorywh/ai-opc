/*
 * 颜色空间转换原语（geometry 层，SPEC 5.2 / 7.3 / 16）。
 *
 * 信任边界定位（TASK-007 / TASK-009）：
 *   - 本模块提供 8-bit sRGB hex → 线性 sRGB [0,1] 浮点的唯一转换，供 geometry 层
 *     产出 color typed array（ribbon / 节点 / 箭头）时统一调用。
 *   - TASK-009 起增补 WCAG 相对亮度与对比度纯函数，供节点箭头在黑白候选色中按对比度
 *     择高（SPEC 8.2）；本模块仍是 color 数学唯一归宿，不向节点箭头泄漏第二套亮度公式。
 *   - 纯数值函数：不依赖 Three / React / 浏览器 API；不读取 config（分层约束禁止）。
 *
 * 线性化不变量（SPEC 5.2 / 7.3）：
 *   - 所有 color typed array 保存线性 sRGB [0,1] 浮点值；禁止把 8-bit sRGB 直接
 *     除以 255 后当作线性颜色。
 *   - 使用标准 sRGB transfer function（IEC 61966-2-1），分段公式与 Three.js
 *     SRGBColorSpace 一致；渲染端 outputColorSpace = SRGBColorSpace 时颜色闭环。
 *
 * 依赖方向（SPEC 3.3）：仅本层自身，无内部依赖。
 */

/*
 * SPEC 5.2 / 7.3：sRGB transfer function 分段阈值与系数（IEC 61966-2-1）。
 * - c ≤ 0.04045：线性段 c / 12.92。
 * - c > 0.04045：幂段 ((c + 0.055) / 1.055) ^ 2.4。
 * 单独命名避免魔法数字散落；值是标准定义，不可调整。
 */
const SRGB_LINEAR_THRESHOLD = 0.04045
const SRGB_LINEAR_SLOPE = 12.92
const SRGB_POWER_OFFSET = 0.055
const SRGB_POWER_DIVISOR = 1.055
const SRGB_POWER_GAMMA = 2.4

/*
 * 单通道 8-bit sRGB（0..255 整数）→ 线性 sRGB [0,1] 浮点（SPEC 5.2 transfer function）。
 * 先把 8-bit 值归一化到 [0,1] sRGB，再按分段公式转线性；返回值域 [0,1]。
 */
export function srgbByteToLinear(channel8bit: number): number {
  const c = channel8bit / 255
  if (c <= SRGB_LINEAR_THRESHOLD) {
    return c / SRGB_LINEAR_SLOPE
  }
  return Math.pow((c + SRGB_POWER_OFFSET) / SRGB_POWER_DIVISOR, SRGB_POWER_GAMMA)
}

/*
 * #RRGGBB hex 字符串 → 线性 sRGB 三通道 [0,1]（SPEC 7.2 颜色 → SPEC 5.2 线性化）。
 *
 * 调用方契约：
 *   - hex 必须为 7 字符 #RRGGBB 形式；非法格式由调用方避免（输入来自 SPEC 固定 hex 常量）。
 *   - 返回只读三元组 [r, g, b]，各分量已在 [0,1] 线性区间。
 */
export function hexToLinearRGB(
  hex: string,
): readonly [number, number, number] {
  const r = Number.parseInt(hex.slice(1, 3), 16)
  const g = Number.parseInt(hex.slice(3, 5), 16)
  const b = Number.parseInt(hex.slice(5, 7), 16)
  return [srgbByteToLinear(r), srgbByteToLinear(g), srgbByteToLinear(b)]
}

/*
 * WCAG 相对亮度与对比度原语（SPEC 8.2 节点箭头黑白择色）。
 *
 * 规格来源：WCAG 2.1 相对亮度与对比度定义。
 *   - 相对亮度 L = 0.2126·R + 0.7152·G + 0.0722·B，R/G/B 为 sRGB 通道经 transfer function
 *     线性化后的值（WCAG 2.1 §1.4.3 "relative luminance"）。
 *   - 对比度 = (L_lighter + 0.05) / (L_darker + 0.05)，取值范围 [1, 21]
 *     （WCAG 2.1 §1.4.3 "contrast ratio"）。
 *
 * 阈值一致性不变量：
 *   - WCAG 原始定义使用 0.03928 作为线性/幂分段阈值；本实现复用 hexToLinearRGB 的
 *     IEC 61966-2-1 transfer function（阈值 0.04045）。对于 8-bit sRGB 输入，两个阈值对
 *     所有 0..255 整数通道值给出相同的分支判定（0.03928·255 ≈ 10.02、0.04045·255 ≈ 10.31，
 *     均落在 10 与 11 之间切换分支），因此 8-bit hex 输入下两种定义产生完全相同的线性值
 *     与相对亮度——不存在第二套亮度语义，只是复用同一线性化通路。
 *   - 本项目所有 WCAG 输入均为 SPEC 固定 8-bit hex（节点基色 / #111111 / #FFFFFF），
 *     故上述等价性始终成立，无需在调用方额外处理阈值差异。
 */

/*
 * WCAG 相对亮度的 sRGB 通道权重（BT.709 主体系数，WCAG 2.1 固定定义）。
 * 单独命名避免魔法数字散落；值是标准定义，不可调整。
 */
const WCAG_LUMINANCE_R_WEIGHT = 0.2126
const WCAG_LUMINANCE_G_WEIGHT = 0.7152
const WCAG_LUMINANCE_B_WEIGHT = 0.0722

/*
 * WCAG 对比度公式的常量偏移（WCAG 2.1 固定 0.05），代表标称白/黑的相对亮度裕度。
 */
const WCAG_CONTRAST_OFFSET = 0.05

/*
 * 线性 sRGB 三通道 → WCAG 相对亮度 L ∈ [0,1]（SPEC 8.2）。
 * 直接消费已线性化的通道值，复用同一 transfer function，不在调用方重复线性化。
 */
export function relativeLuminanceFromLinear(
  r: number,
  g: number,
  b: number,
): number {
  return (
    WCAG_LUMINANCE_R_WEIGHT * r +
    WCAG_LUMINANCE_G_WEIGHT * g +
    WCAG_LUMINANCE_B_WEIGHT * b
  )
}

/*
 * #RRGGBB hex → WCAG 相对亮度 L ∈ [0,1]（SPEC 8.2）。
 * 先经 hexToLinearRGB 线性化，再加权求相对亮度；返回值域 [0,1]。
 */
export function relativeLuminance(hex: string): number {
  const [r, g, b] = hexToLinearRGB(hex)
  return relativeLuminanceFromLinear(r, g, b)
}

/*
 * 两个 #RRGGBB hex 之间的 WCAG 对比度 ∈ [1, 21]（SPEC 8.2）。
 * (max(L1, L2) + 0.05) / (min(L1, L2) + 0.05)；同色对比度为 1，黑白对比度约 21。
 */
export function contrastRatio(hexA: string, hexB: string): number {
  const la = relativeLuminance(hexA)
  const lb = relativeLuminance(hexB)
  const lighter = Math.max(la, lb)
  const darker = Math.min(la, lb)
  return (lighter + WCAG_CONTRAST_OFFSET) / (darker + WCAG_CONTRAST_OFFSET)
}
