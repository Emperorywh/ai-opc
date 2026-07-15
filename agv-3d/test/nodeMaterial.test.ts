import { describe, expect, it } from 'vitest'
import { Color, MeshStandardMaterial } from 'three'
import { NODE_VISUAL_THEME } from '../src/features/agv-map/config/visualTheme'
import type { NodeVisualTheme } from '../src/features/agv-map/config/visualTheme'
import type { RawNodeType } from '../src/features/agv-map/domain/rawDto'
import { hslToCss } from '../src/features/agv-map/presentation/scene/colorConvert'
import { createNodeMaterial } from '../src/features/agv-map/presentation/scene/nodeMaterial'

/**
 * 节点标准材质工厂单元测试（SPEC §8.2、§8.3、§11.1，TASK-009）。
 *
 * 不做 WebGL 渲染验证（需浏览器），只断言：
 * - 材质类型固定为 MeshStandardMaterial（SPEC §8.3 节点固定标准物理材质）。
 * - 颜色、自发光、金属度、粗糙度全部来自视觉主题（§8.2、§12 禁止组件内散落色值）。
 * - 颜色按 sRGB HSL 线性化，与共享 colorConvert 一致（§8.5）。
 * - dispose 生命周期可观测（SPEC §5.4 显式释放路径可验证，不依赖后续 TASK）。
 */

const ALL_TYPES: readonly RawNodeType[] = ['node', 'work', 'charge', 'park']

describe('createNodeMaterial — 材质类型（SPEC §8.3）', () => {
  it.each(ALL_TYPES)('%s 返回 MeshStandardMaterial 实例', (type) => {
    expect(createNodeMaterial(NODE_VISUAL_THEME[type])).toBeInstanceOf(MeshStandardMaterial)
  })
})

describe('createNodeMaterial — 参数来自视觉主题（SPEC §8.2、§12）', () => {
  it.each(ALL_TYPES)('%s 的 metalness/roughness/emissiveIntensity 与主题一致', (type) => {
    const theme = NODE_VISUAL_THEME[type]
    const mat = createNodeMaterial(theme)
    expect(mat.metalness).toBe(theme.material.metalness)
    expect(mat.roughness).toBe(theme.material.roughness)
    expect(mat.emissiveIntensity).toBe(theme.color.emissiveIntensity)
  })

  it('node 的 emissiveIntensity 恰为 0（明确低于 Bloom 阈值、不发光）', () => {
    expect(createNodeMaterial(NODE_VISUAL_THEME.node).emissiveIntensity).toBe(0)
  })
})

describe('createNodeMaterial — 颜色线性化（SPEC §8.5）', () => {
  it.each(ALL_TYPES)('%s 的 color/emissive 等于基础色按 sRGB HSL 线性化结果', (type) => {
    const theme = NODE_VISUAL_THEME[type]
    const expected = new Color().setStyle(hslToCss(theme.color.baseColor))
    const mat = createNodeMaterial(theme)
    // color 与 emissive 同取基础色（emissive 按 emissiveIntensity 缩放发光层次）。
    for (const key of ['r', 'g', 'b'] as const) {
      expect(mat.color[key]).toBeCloseTo(expected[key], 6)
      expect(mat.emissive[key]).toBeCloseTo(expected[key], 6)
    }
  })
})

describe('createNodeMaterial — 纯函数确定性', () => {
  it.each(ALL_TYPES)('%s 相同主题两次构建得到相等的颜色参数', (type) => {
    const theme = NODE_VISUAL_THEME[type]
    const a = createNodeMaterial(theme)
    const b = createNodeMaterial(theme)
    expect(a.metalness).toBe(b.metalness)
    expect(a.roughness).toBe(b.roughness)
    expect(a.emissiveIntensity).toBe(b.emissiveIntensity)
    for (const key of ['r', 'g', 'b'] as const) {
      expect(a.color[key]).toBe(b.color[key])
    }
  })
})

describe('createNodeMaterial — 释放生命周期（SPEC §5.4，TASK-009）', () => {
  it('dispose 触发 dispose 事件，使释放路径可被自动化验证', () => {
    const theme: NodeVisualTheme = NODE_VISUAL_THEME.work
    const mat = createNodeMaterial(theme)
    let disposed = false
    mat.addEventListener('dispose', () => {
      disposed = true
    })
    // NodeLayer 的卸载 effect 调用 material.dispose()；此处验证该调用确实释放资源。
    mat.dispose()
    expect(disposed).toBe(true)
  })

  it.each(ALL_TYPES)('%s 的几何与材质释放路径独立可调用（不抛错）', (type) => {
    const mat = createNodeMaterial(NODE_VISUAL_THEME[type])
    expect(() => mat.dispose()).not.toThrow()
  })
})
