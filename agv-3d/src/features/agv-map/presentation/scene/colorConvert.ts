import { Color } from 'three'
import type { HslColor } from '../../config/visualTheme'

/**
 * 展示层颜色转换共享工具（SPEC §8.2、§8.5）。
 *
 * 节点材质与路径材质都需要把 visualTheme 中的 sRGB HSL 元组转换为线性空间 THREE.Color。
 * 该转换逻辑在此集中，避免 nodeMaterial / pathShader 各持一份私有副本（SPEC §12 禁止散落
 * 与重复；TASK-009 完成标准禁止重复逻辑）。
 *
 * 色彩管线约定（SPEC §8.5）：
 * - Color.setStyle 默认按 sRGB 解析；在 ColorManagement 启用（R3F 默认）时自动转换到工作
 *   线性空间，使着色器 / MeshStandardMaterial 直接消费即可进入色调映射与输出色彩空间块。
 * - 输入 HSL 为 sRGB 空间（H: 0~360 度，S/L: 0~1），与 SPEC §8.2 调色板一致。
 */

/**
 * 把 HSL 元组格式化为 Three.js 可解析的 CSS hsl() 字符串。
 *
 * 保留三位小数，保证与既有路径材质测试的字面期望（如 'hsl(200, 85.000%, 55.000%)'）一致。
 */
export function hslToCss(hsl: HslColor): string {
  return `hsl(${hsl.h}, ${(hsl.s * 100).toFixed(3)}%, ${(hsl.l * 100).toFixed(3)}%)`
}

/**
 * 把 HSL 元组转换为线性工作空间的 THREE.Color（经 CSS hsl() 字符串解析）。
 *
 * 返回的 Color 可直接作为 MeshStandardMaterial.color / emissive 或着色器 uniform 值；
 * 在 R3F 默认 ColorManagement 下，setStyle 会从 sRGB 线性化，保证 ACES 色调映射与 sRGB
 * 输出的色彩一致性（SPEC §8.5）。
 */
export function hslToLinearColor(hsl: HslColor): Color {
  return new Color().setStyle(hslToCss(hsl))
}
