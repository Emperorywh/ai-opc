import { describe, expect, it } from 'vitest'
import { MeshReflectorMaterial as DreiReflectorClass } from '@react-three/drei/materials/MeshReflectorMaterial'
import { Color } from 'three'
import { ENVIRONMENT_THEME } from '../src/features/agv-map/config/visualTheme'
import { hslToCss } from '../src/features/agv-map/presentation/scene/colorConvert'
import { createReflectionMaterial } from '../src/features/agv-map/presentation/scene/reflectionMaterial'

/**
 * 平面反射材质工厂单元测试（SPEC §8.3、§8.4，TASK-013）。
 *
 * 不做 WebGL 渲染验证（需浏览器），只断言：
 * - 材质类型为 drei MeshReflectorMaterial（SPEC §8.4 唯一真实平面反射方案，非普通材质伪反射）。
 * - 地面基础色/粗糙度/金属度来自地面主题；反射参数来自反射主题（§8.2、§12 禁止散落）。
 * - 基础色按 sRGB HSL 线性化（§8.5）。
 * - 固定启用 USE_BLUR define 与 hasBlur（SPEC §8.4 一次粗糙模糊）。
 * - dispose 生命周期可观测（SPEC §5.4 显式释放路径）。
 */

describe('createReflectionMaterial — 材质类型（SPEC §8.4 真实平面反射）', () => {
  it('返回 drei MeshReflectorMaterial 实例（非普通 MeshStandardMaterial 伪反射）', () => {
    const mat = createReflectionMaterial(ENVIRONMENT_THEME.ground, ENVIRONMENT_THEME.reflection)
    expect(mat).toBeInstanceOf(DreiReflectorClass)
    // MeshReflectorMaterial 继承 MeshStandardMaterial，仍接收光照与阴影。
    expect(mat.isMeshStandardMaterial).toBe(true)
    mat.dispose()
  })
})

describe('createReflectionMaterial — 参数来自主题（SPEC §8.2、§12）', () => {
  it('粗糙度与金属度与地面主题一致', () => {
    const mat = createReflectionMaterial(ENVIRONMENT_THEME.ground, ENVIRONMENT_THEME.reflection)
    expect(mat.roughness).toBe(ENVIRONMENT_THEME.ground.roughness)
    expect(mat.metalness).toBe(ENVIRONMENT_THEME.ground.metalness)
    mat.dispose()
  })

  it('反射参数 mirror/mixStrength/mixBlur 与反射主题一致', () => {
    const mat = createReflectionMaterial(ENVIRONMENT_THEME.ground, ENVIRONMENT_THEME.reflection)
    expect(mat.mirror).toBe(ENVIRONMENT_THEME.reflection.mirror)
    expect(mat.mixStrength).toBe(ENVIRONMENT_THEME.reflection.mixStrength)
    expect(mat.mixBlur).toBe(ENVIRONMENT_THEME.reflection.mixBlur)
    mat.dispose()
  })
})

describe('createReflectionMaterial — 颜色线性化（SPEC §8.5）', () => {
  it('基础色等于地面主题色按 sRGB HSL 线性化结果', () => {
    const expected = new Color().setStyle(hslToCss(ENVIRONMENT_THEME.ground.color))
    const mat = createReflectionMaterial(ENVIRONMENT_THEME.ground, ENVIRONMENT_THEME.reflection)
    for (const key of ['r', 'g', 'b'] as const) {
      expect(mat.color[key]).toBeCloseTo(expected[key], 6)
    }
    mat.dispose()
  })

  it('基础色线性亮度低于 Bloom 阈值 1.0（深色底不进入 Bloom）', () => {
    const mat = createReflectionMaterial(ENVIRONMENT_THEME.ground, ENVIRONMENT_THEME.reflection)
    expect(Math.max(mat.color.r, mat.color.g, mat.color.b)).toBeLessThan(1.0)
    mat.dispose()
  })
})

describe('createReflectionMaterial — 固定启用一次粗糙模糊（SPEC §8.4、TASK-013）', () => {
  it('hasBlur = true（材质始终走模糊反射混合路径）', () => {
    const mat = createReflectionMaterial(ENVIRONMENT_THEME.ground, ENVIRONMENT_THEME.reflection)
    expect(mat.hasBlur).toBe(true)
    mat.dispose()
  })

  it('注入 USE_BLUR define（首帧编译即启用模糊着色路径）', () => {
    const mat = createReflectionMaterial(ENVIRONMENT_THEME.ground, ENVIRONMENT_THEME.reflection)
    expect(mat.defines?.USE_BLUR).toBeDefined()
    mat.dispose()
  })
})

describe('createReflectionMaterial — 纯函数确定性', () => {
  it('相同主题两次构建得到相等的颜色与材质参数', () => {
    const a = createReflectionMaterial(ENVIRONMENT_THEME.ground, ENVIRONMENT_THEME.reflection)
    const b = createReflectionMaterial(ENVIRONMENT_THEME.ground, ENVIRONMENT_THEME.reflection)
    expect(a.mirror).toBe(b.mirror)
    expect(a.mixStrength).toBe(b.mixStrength)
    expect(a.mixBlur).toBe(b.mixBlur)
    for (const key of ['r', 'g', 'b'] as const) {
      expect(a.color[key]).toBe(b.color[key])
    }
    a.dispose()
    b.dispose()
  })
})

describe('createReflectionMaterial — 释放生命周期（SPEC §5.4，TASK-013）', () => {
  it('dispose 触发 dispose 事件，使释放路径可被自动化验证', () => {
    const mat = createReflectionMaterial(ENVIRONMENT_THEME.ground, ENVIRONMENT_THEME.reflection)
    let disposed = false
    mat.addEventListener('dispose', () => {
      disposed = true
    })
    mat.dispose()
    expect(disposed).toBe(true)
  })

  it('dispose 幂等：重复调用不抛错', () => {
    const mat = createReflectionMaterial(ENVIRONMENT_THEME.ground, ENVIRONMENT_THEME.reflection)
    expect(() => {
      mat.dispose()
      mat.dispose()
    }).not.toThrow()
  })
})
