/**
 * 色彩规范（SPEC §2.1，低饱和、水彩感）。
 *
 * Task 08（M2）：新增 `desaturateHex` 统一低饱和化工具（SPEC §2.1「所有色值需经
 * 低饱和化统一处理（S 降 15–25%）」）+ 雪线色 `snow`（§2.2.1 雪线带）。terrainMaterial
 * 经 `desaturateHex` 接入全部色值 → 完整 palette 接入 + 低饱和。`palette` 仍为原始
 * SPEC 参考值（ocean Task 07 已据此验证，本 Task 不改其语义，仅新增派生工具）。
 */

/** 单个地物的颜色（单色或一组渐变色）。 */
export type PaletteColor = string | readonly [string, string]

export const palette = {
  grassland: ['#8FA98A', '#A9C0A0'] as const, // 草地/平原 鼠尾草绿
  mountain: ['#7E8B76', '#9AA892'] as const, // 山脉 暖灰绿
  plateau: '#A39A78', // 高原 沙橄榄
  desert: ['#D9C39B', '#C9B083'] as const, // 沙漠 浅赭石
  oceanShallow: '#7FC4C0', // 海洋（浅）青绿
  oceanDeep: '#2E6E73', // 海洋（深）深青绿
  river: '#6FD0E8', // 河流 青蓝发光
  border: '#F3E9D2', // 边界描边 柔光暖白（半透明）
  disputed: '#C9BFA8', // 争议边界 虚线暖灰
  snow: '#E8EAEC', // 雪线 近白（§2.2.1 雪线带，SPEC §2.1 未单列）
} as const

export type Palette = typeof palette

/** SPEC §2.1「低饱和化统一处理（S 降 15–25%）」取中值 20%。 */
export const SATURATION_REDUCTION = 0.2

// ---------------------------------------------------------------------------
// 颜色空间转换（纯 TS，无 three 依赖，可在 Node 单测验证）
// ---------------------------------------------------------------------------

/** 规范化 hex（支持 #RGB 缩写 → #RRGGBB，去 #）。 */
function normHex(hex: string): string {
  const h = hex.replace('#', '').trim()
  return h.length === 3
    ? h
        .split('')
        .map((c) => c + c)
        .join('')
    : h
}

function hexToRgb(hex: string): [number, number, number] {
  const h = normHex(hex)
  const n = parseInt(h, 16)
  if (h.length !== 6 || Number.isNaN(n)) {
    throw new Error(`非法 hex 颜色：${hex}`)
  }
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255]
}

/** sRGB [0..255] → HSL（h/s/l ∈ [0,1]）。标准算法（W3C）。 */
function rgbToHsl(r: number, g: number, b: number): [number, number, number] {
  const rr = r / 255
  const gg = g / 255
  const bb = b / 255
  const max = Math.max(rr, gg, bb)
  const min = Math.min(rr, gg, bb)
  const l = (max + min) / 2
  const d = max - min
  let h = 0
  let s = 0
  if (d !== 0) {
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min)
    switch (max) {
      case rr:
        h = (gg - bb) / d + (gg < bb ? 6 : 0)
        break
      case gg:
        h = (bb - rr) / d + 2
        break
      default:
        h = (rr - gg) / d + 4
    }
    h /= 6
  }
  return [h, s, l]
}

/** HSL → sRGB [0..255]。 */
function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  if (s === 0) {
    const v = Math.round(l * 255)
    return [v, v, v]
  }
  const hue2rgb = (p: number, q: number, t: number) => {
    if (t < 0) t += 1
    if (t > 1) t -= 1
    if (t < 1 / 6) return p + (q - p) * 6 * t
    if (t < 1 / 2) return q
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6
    return p
  }
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s
  const p = 2 * l - q
  return [
    Math.round(hue2rgb(p, q, h + 1 / 3) * 255),
    Math.round(hue2rgb(p, q, h) * 255),
    Math.round(hue2rgb(p, q, h - 1 / 3) * 255),
  ]
}

function rgbToHex(r: number, g: number, b: number): string {
  const to2 = (v: number) =>
    Math.max(0, Math.min(255, Math.round(v)))
      .toString(16)
      .padStart(2, '0')
  return `#${to2(r)}${to2(g)}${to2(b)}`
}

/**
 * 降低颜色饱和度（SPEC §2.1：S 降 15–25%）。
 *
 * 在 sRGB→HSL 空间降低 S（色相 H / 明度 L 不变），再转回 hex。
 * `amount=0` → 原色不变（精确往返）；`amount=1` → 完全去饱和（灰）。
 * 取中值 `SATURATION_REDUCTION=0.2` 为默认降幅。
 */
export function desaturateHex(hex: string, amount: number = SATURATION_REDUCTION): string {
  if (amount <= 0) return hex
  const a = Math.min(1, amount)
  const [r, g, b] = hexToRgb(hex)
  const [h, s, l] = rgbToHsl(r, g, b)
  return rgbToHex(...hslToRgb(h, Math.max(0, s * (1 - a)), l))
}
