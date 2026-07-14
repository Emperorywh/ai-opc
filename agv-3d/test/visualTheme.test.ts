import { describe, expect, it } from 'vitest'
import {
  NODE_BASE_COLORS,
  NODE_VISUAL_THEME,
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
