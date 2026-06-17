/**
 * 性能分档参数（SPEC §8 / D18：自动检测分档）。
 *
 * Task 01：分档常量骨架。
 * Task 11：完整分档参数 + 自适应阈值（FPS 滑动窗口 / 滞回 / 冷却）落地。
 *   - 高：dpr≤2、全波数、全标签、全地形水彩效果、接触阴影占位开
 *   - 中：dpr≤1.5、海洋减波、标签密度↓、地形效果部分降、接触阴影关
 *   - 低：dpr≤1、正弦波海洋、仅大洲标签、地形效果最简、关辉光
 */

export type QualityTier = 'high' | 'medium' | 'low'

/** 档位由低到高排列（滞回升降档沿此序相邻移动）。 */
export const QUALITY_TIER_ORDER: readonly QualityTier[] = ['low', 'medium', 'high']

/** 标签密度（LOD 联动，M4 LabelLayer 消费）。 */
export type LabelDensity = 'all' | 'major' | 'continent'

/**
 * 地形水彩效果分档（对应 terrainMaterial 的 5 个 uniform 开关，§2.2 / §8）。
 * M3 Task 11 经 store 改 uniform value（M2 预留钩子，不动 shader）。
 */
export type TerrainEffectConfig = {
  /** 坡度强调强度（陡坡偏暖灰绿）。 */
  slopeEmphasis: number
  /** 水彩噪声强度（明度调制幅度）。 */
  watercolorNoise: number
  /** 海岸线等高线强度（单 smoothstep，开销低，低档保留以维持可读性）。 */
  coastline: number
  /** 软描边轮廓强度（暖白 rim）。 */
  rimOutline: number
  /** normal.png 细节法线 blend 权重（0=纯几何法线）。 */
  detailNormal: number
}

export type QualityConfig = {
  /** 像素比上限（dpr），4K 下避免 4× 渲染量爆显存。 */
  dprMax: number
  /** 海洋 Gerstner 波数（低档降为正弦波，0 表示正弦）。 */
  oceanWaves: number
  /** 标签密度（LOD 联动）。 */
  labelDensity: LabelDensity
  /** 接触阴影 shader 近似占位（默认不启用实时 shadow map；MVP 无接触阴影 shader，占位）。 */
  contactShadow: boolean
  /** 地形水彩效果分档（shader 复杂度开关）。 */
  terrainEffects: TerrainEffectConfig
}

export const qualityConfigs: Record<QualityTier, QualityConfig> = {
  high: {
    dprMax: 2,
    oceanWaves: 5,
    labelDensity: 'all',
    contactShadow: true,
    terrainEffects: { slopeEmphasis: 1.0, watercolorNoise: 1.0, coastline: 1.0, rimOutline: 1.0, detailNormal: 0.3 },
  },
  medium: {
    dprMax: 1.5,
    oceanWaves: 3,
    labelDensity: 'major',
    contactShadow: false,
    // 中档：降噪声颗粒 + 减 rim + 略降细节法线（坡度/海岸线维持以保证地形可读）。
    terrainEffects: { slopeEmphasis: 1.0, watercolorNoise: 0.5, coastline: 1.0, rimOutline: 0.5, detailNormal: 0.2 },
  },
  low: {
    dprMax: 1,
    oceanWaves: 0,
    labelDensity: 'continent',
    contactShadow: false,
    // 低档：关噪声/rim/细节法线（省片元开销）；海岸线保留描边维持辨识。
    terrainEffects: { slopeEmphasis: 0.5, watercolorNoise: 0.0, coastline: 1.0, rimOutline: 0.0, detailNormal: 0.0 },
  },
}

export const defaultQualityTier: QualityTier = 'high'

/**
 * 自适应分档运行参数（SPEC §8：~1s 滑动窗口评估 + 跨阈值平滑切换不抖动）。
 *
 * 滞回（hysteresis）+ 持续命中（sustained）+ 冷却（cooldown）三重防抖动：
 *  - 仅当 FPS 连续 `sustainedWindows` 个评估窗口都指向同一非当前档位，且距上次切换超过
 *    `cooldownSec`，才提交切换 —— FPS 在阈值附近抖动时不会频繁换档。
 *  - 升降档阈值分离（upgradeFps > downgradeFps）形成滞回带，避免临界震荡。
 */
export const qualityAdaptive = {
  /** FPS 评估窗口时长（秒）；窗口满后算一次平均 FPS 并推进档位状态机。 */
  fpsWindowSec: 1.0,
  /** 降档阈值：平均 FPS 持续低于此值 → 下调一档。 */
  downgradeFps: 45,
  /** 升档阈值：平均 FPS 持续高于此值 → 上调一档（>downgradeFps 形成滞回带）。 */
  upgradeFps: 57,
  /** 切换冷却（秒）：距上次切换不足此值不提交，防抖动。 */
  cooldownSec: 2.0,
  /** 升降档需连续命中相同候选档位的评估窗口数（防瞬时掉帧误判）。 */
  sustainedWindows: 2,
} as const

export type QualityAdaptiveConfig = typeof qualityAdaptive
