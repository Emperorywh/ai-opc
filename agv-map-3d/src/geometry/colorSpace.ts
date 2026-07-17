/*
 * 颜色空间转换原语（geometry 层，SPEC 5.2 / 7.3 / 16）。
 *
 * 信任边界定位（TASK-007）：
 *   - 本模块提供 8-bit sRGB hex → 线性 sRGB [0,1] 浮点的唯一转换，供 geometry 层
 *     产出 color typed array（ribbon / 节点 / 箭头）时统一调用。
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
