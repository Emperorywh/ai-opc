/**
 * 性能分档参数（SPEC §8 / D18：自动检测分档）。
 *
 * ⚠️ Task 01 仅落地分档常量骨架；AdaptiveQuality 探测与切换在 Task 11。
 */

export type QualityTier = 'high' | 'medium' | 'low'

export type QualityConfig = {
  /** 像素比上限（dpr），4K 下避免 4× 渲染量爆显存。 */
  dprMax: number
  /** 海洋 Gerstner 波数（低档降为正弦波，0 表示正弦）。 */
  oceanWaves: number
  /** 标签密度（LOD 联动）。 */
  labelDensity: 'all' | 'major' | 'continent'
  /** 接触阴影 shader 近似（默认不启用实时 shadow map）。 */
  contactShadow: boolean
}

export const qualityConfigs: Record<QualityTier, QualityConfig> = {
  high: { dprMax: 2, oceanWaves: 5, labelDensity: 'all', contactShadow: true },
  medium: { dprMax: 1.5, oceanWaves: 3, labelDensity: 'major', contactShadow: false },
  low: { dprMax: 1, oceanWaves: 0, labelDensity: 'continent', contactShadow: false },
}

export const defaultQualityTier: QualityTier = 'high'
