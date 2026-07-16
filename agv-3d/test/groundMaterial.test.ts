import { describe, expect, it } from 'vitest'
import { Color, MeshStandardMaterial } from 'three'
import { ENVIRONMENT_THEME } from '../src/features/agv-map/config/visualTheme'
import { hslToCss } from '../src/features/agv-map/presentation/scene/colorConvert'
import { createGroundMaterial } from '../src/features/agv-map/presentation/scene/groundMaterial'

/**
 * 地面深色不透明材质工厂单元测试（SPEC §8.3、§8.4，TASK-012）。
 *
 * 不做 WebGL 渲染验证（需浏览器），只断言：
 * - 材质类型固定为 MeshStandardMaterial（SPEC §8.3 物理材质，本期深色不透明基线）。
 * - 颜色、粗糙度、金属度全部来自环境主题（§8.2、§12 禁止组件内散落色值）。
 * - 颜色按 sRGB HSL 线性化（§8.5）。
 * - dispose 生命周期可观测（SPEC §5.4 显式释放路径）。
 */

describe('createGroundMaterial — 材质类型（SPEC §8.3）', () => {
  it('返回 MeshStandardMaterial 实例', () => {
    expect(createGroundMaterial(ENVIRONMENT_THEME.ground)).toBeInstanceOf(MeshStandardMaterial)
  })
})

describe('createGroundMaterial — 参数来自环境主题（SPEC §8.2、§12）', () => {
  it('粗糙度与金属度与主题一致', () => {
    const mat = createGroundMaterial(ENVIRONMENT_THEME.ground)
    expect(mat.roughness).toBe(ENVIRONMENT_THEME.ground.roughness)
    expect(mat.metalness).toBe(ENVIRONMENT_THEME.ground.metalness)
  })
})

describe('createGroundMaterial — 颜色线性化（SPEC §8.5）', () => {
  it('基础色等于主题色按 sRGB HSL 线性化结果', () => {
    const expected = new Color().setStyle(hslToCss(ENVIRONMENT_THEME.ground.color))
    const mat = createGroundMaterial(ENVIRONMENT_THEME.ground)
    for (const key of ['r', 'g', 'b'] as const) {
      expect(mat.color[key]).toBeCloseTo(expected[key], 6)
    }
  })

  it('基础色线性亮度低于 Bloom 阈值 1.0（深色底不进入 Bloom）', () => {
    const mat = createGroundMaterial(ENVIRONMENT_THEME.ground)
    expect(Math.max(mat.color.r, mat.color.g, mat.color.b)).toBeLessThan(1.0)
  })
})

describe('createGroundMaterial — 纯函数确定性', () => {
  it('相同主题两次构建得到相等的颜色与材质参数', () => {
    const a = createGroundMaterial(ENVIRONMENT_THEME.ground)
    const b = createGroundMaterial(ENVIRONMENT_THEME.ground)
    expect(a.roughness).toBe(b.roughness)
    expect(a.metalness).toBe(b.metalness)
    for (const key of ['r', 'g', 'b'] as const) {
      expect(a.color[key]).toBe(b.color[key])
    }
  })
})

describe('createGroundMaterial — 释放生命周期（SPEC §5.4，TASK-012）', () => {
  it('dispose 触发 dispose 事件，使释放路径可被自动化验证', () => {
    const mat = createGroundMaterial(ENVIRONMENT_THEME.ground)
    let disposed = false
    mat.addEventListener('dispose', () => {
      disposed = true
    })
    mat.dispose()
    expect(disposed).toBe(true)
  })

  it('dispose 幂等：重复调用不抛错', () => {
    const mat = createGroundMaterial(ENVIRONMENT_THEME.ground)
    expect(() => {
      mat.dispose()
      mat.dispose()
    }).not.toThrow()
  })
})
