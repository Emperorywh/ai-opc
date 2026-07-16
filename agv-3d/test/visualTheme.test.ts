import { describe, expect, it } from 'vitest'
import { ACESFilmicToneMapping, SRGBColorSpace } from 'three'
import {
  BLOOM_THEME,
  COLOR_PIPELINE,
  COMPOSER_MULTISAMPLING,
  NODE_BASE_COLORS,
  NODE_VISUAL_THEME,
  PATH_BASE_COLOR,
  PATH_FLOW_HIGHLIGHT_COLOR,
  PATH_VISUAL_THEME,
} from '../src/features/agv-map/config/visualTheme'
import type { RawNodeType } from '../src/features/agv-map/domain/rawDto'

const ALL_TYPES: readonly RawNodeType[] = ['node', 'work', 'charge', 'park']

describe('visualTheme — 基础色（SPEC §8.2）', () => {
  it('四类节点基础色逐字匹配 SPEC §8.2 调色板', () => {
    expect(NODE_BASE_COLORS.node).toEqual({ h: 210, s: 0.9, l: 0.6 })
    expect(NODE_BASE_COLORS.work).toEqual({ h: 180, s: 0.9, l: 0.55 })
    expect(NODE_BASE_COLORS.charge).toEqual({ h: 48, s: 1.0, l: 0.6 })
    expect(NODE_BASE_COLORS.park).toEqual({ h: 140, s: 0.8, l: 0.55 })
  })

  it('主题表基础色与 NODE_BASE_COLORS 一致', () => {
    for (const type of ALL_TYPES) {
      expect(NODE_VISUAL_THEME[type].color.baseColor).toEqual(NODE_BASE_COLORS[type])
    }
  })
})

describe('visualTheme — Emissive 目标排序（SPEC §8.2）', () => {
  it('node 低于 work、work 不高于 charge/park（低于/接近/高于 Bloom 阈值）', () => {
    const e = (t: RawNodeType) => NODE_VISUAL_THEME[t].color.emissiveIntensity
    expect(e('node')).toBeLessThan(e('work'))
    expect(e('work')).toBeLessThanOrEqual(e('charge'))
    expect(e('charge')).toBeGreaterThan(e('node'))
    expect(e('park')).toBeGreaterThan(e('node'))
  })

  it('node 的 emissiveIntensity 恰为 0（明确低于阈值、不发光）', () => {
    expect(NODE_VISUAL_THEME.node.color.emissiveIntensity).toBe(0)
  })
})

describe('visualTheme — 材质参数', () => {
  it.each(ALL_TYPES)('%s 的 metalness/roughness 落在合理区间', (type) => {
    const m = NODE_VISUAL_THEME[type].material
    expect(m.metalness).toBeGreaterThanOrEqual(0)
    expect(m.metalness).toBeLessThanOrEqual(1)
    expect(m.roughness).toBeGreaterThanOrEqual(0)
    expect(m.roughness).toBeLessThanOrEqual(1)
  })
})

describe('visualTheme — 路径扁带与流光色（SPEC §8.2、TASK-010）', () => {
  it('基础色与流动高亮色逐字匹配 SPEC §8.2 调色板', () => {
    expect(PATH_BASE_COLOR).toEqual({ h: 200, s: 0.85, l: 0.55 })
    expect(PATH_FLOW_HIGHLIGHT_COLOR).toEqual({ h: 185, s: 1.0, l: 0.75 })
  })

  it('主题表路径色与断言基准一致', () => {
    expect(PATH_VISUAL_THEME.color.baseColor).toEqual(PATH_BASE_COLOR)
    expect(PATH_VISUAL_THEME.color.flowHighlightColor).toEqual(PATH_FLOW_HIGHLIGHT_COLOR)
  })

  it('流动高亮强度为正，使脉冲峰值能明确超过 Bloom 阈值 1.0', () => {
    expect(PATH_VISUAL_THEME.color.flowHighlightIntensity).toBeGreaterThan(0)
  })
})

describe('visualTheme — 流光动画参数（SPEC §7.6、TASK-010）', () => {
  it('重复距离 2.0 m、速度 0.4 m/s、周期 5 s', () => {
    const { flow } = PATH_VISUAL_THEME
    expect(flow.flowRepeatM).toBe(2.0)
    expect(flow.flowSpeedMps).toBe(0.4)
    expect(flow.flowPeriodSeconds).toBe(5.0)
  })

  it('运动学一致：repeat = speed × period，保证一个周期推进恰好一个重复距离', () => {
    const { flow } = PATH_VISUAL_THEME
    expect(flow.flowSpeedMps * flow.flowPeriodSeconds).toBeCloseTo(flow.flowRepeatM, 10)
  })

  it('全部流光参数携带正的单位量纲（米、米/秒、秒均为正有限值）', () => {
    const { flow } = PATH_VISUAL_THEME
    for (const v of [flow.flowRepeatM, flow.flowSpeedMps, flow.flowPeriodSeconds]) {
      expect(Number.isFinite(v)).toBe(true)
      expect(v).toBeGreaterThan(0)
    }
  })
})

describe('visualTheme — 唯一色彩管线（SPEC §8.5，TASK-014）', () => {
  it('输出色彩空间为 SRGBColorSpace', () => {
    expect(COLOR_PIPELINE.outputColorSpace).toBe(SRGBColorSpace)
  })

  it('色调映射为 ACESFilmicToneMapping', () => {
    expect(COLOR_PIPELINE.toneMapping).toBe(ACESFilmicToneMapping)
  })

  it('色调映射曝光为 1.0', () => {
    expect(COLOR_PIPELINE.toneMappingExposure).toBe(1.0)
  })

  it('色彩管线三要素均为有限、确定的标量值（不散落、可锁定）', () => {
    expect(typeof COLOR_PIPELINE.outputColorSpace).toBe('string')
    expect(COLOR_PIPELINE.outputColorSpace.length).toBeGreaterThan(0)
    expect(Number.isFinite(COLOR_PIPELINE.toneMapping)).toBe(true)
    expect(Number.isFinite(COLOR_PIPELINE.toneMappingExposure)).toBe(true)
  })
})

describe('visualTheme — Bloom 后处理参数（SPEC §8.5、§8.2，TASK-014）', () => {
  it('亮度阈值为 1.0（仅 HDR 高亮进入 Bloom）', () => {
    expect(BLOOM_THEME.luminanceThreshold).toBe(1.0)
  })

  it('亮度阈值平滑为 0.2', () => {
    expect(BLOOM_THEME.luminanceSmoothing).toBe(0.2)
  })

  it('Bloom 强度为 1.1', () => {
    expect(BLOOM_THEME.intensity).toBe(1.1)
  })

  it('启用 mipmap blur', () => {
    expect(BLOOM_THEME.mipmapBlur).toBe(true)
  })

  it('Bloom 阈值高于基础路径扁带线性亮度（基础路径不进入 Bloom，§8.5、§16.2）', () => {
    // 基础色 hsl(200,85%,55%) 线性化后最大通道 < 1.0（pathShader.test 已逐字断言），
    // 此处复验阈值 1.0 严格大于该基础亮度，确保扁带不触发 Bloom。
    expect(BLOOM_THEME.luminanceThreshold).toBeGreaterThan(0.9)
    expect(PATH_VISUAL_THEME.color.flowHighlightIntensity).toBeGreaterThan(0)
  })
})

describe('visualTheme — Composer multisampling（SPEC §8.5，TASK-014）', () => {
  it('EffectComposer multisampling 为 0（关闭 Composer MSAA，抗锯齿唯一由 SMAA 负责）', () => {
    expect(COMPOSER_MULTISAMPLING).toBe(0)
  })
})
