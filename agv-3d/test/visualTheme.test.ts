import { describe, expect, it } from 'vitest'
import {
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
