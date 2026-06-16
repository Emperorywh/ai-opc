/**
 * 色彩规范（SPEC §2.1，低饱和、水彩感）。
 *
 * ⚠️ Task 01 仅落地原始色值结构骨架；完整接入与"低饱和化统一处理（S 降 15–25%）"
 *    在 M2 Task 08（terrainMaterial 完善）完成。
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
} as const

export type Palette = typeof palette
