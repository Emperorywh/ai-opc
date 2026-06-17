import { describe, it, expect } from 'vitest'
import * as THREE from 'three'
import { PLANE_WIDTH, PLANE_HEIGHT } from '../src/config/projection'
import { OCEAN_RENDER_ORDER } from '../src/three/ocean/oceanMaterial'
import {
  SHELL_RADIUS,
  SHELL_SCALE_X,
  SHELL_SCALE_Z,
  SHELL_FLATTEN,
  SHELL_SEGMENTS,
  SHELL_THETA_LENGTH,
  ATMOSPHERE_GLOW_COLOR,
  ATMOSPHERE_FRESNEL_POWER,
  ATMOSPHERE_INTENSITY_HIGH,
  ATMOSPHERE_MATERIAL_OPTS,
  ATMOSPHERE_RENDER_ORDER,
  ATMOSPHERE_BY_TIER,
  atmosphereFresnel,
  createAtmosphereMaterial,
} from '../src/three/atmosphere/atmosphereMaterial'

describe('atmosphereFresnel（纯函数，与 GLSL 同源）', () => {
  it('正对相机 |N·V|=1 → rim=0（壳顶暗）', () => {
    expect(atmosphereFresnel(1, 3)).toBeCloseTo(0, 10)
    expect(atmosphereFresnel(-1, 3)).toBeCloseTo(0, 10) // abs 兼容 BackSide 法线翻转
  })

  it('掠射边缘 N·V=0 → rim=1（亮）', () => {
    expect(atmosphereFresnel(0, 3)).toBeCloseTo(1, 10)
  })

  it('|N·V| 增大 → rim 单调递减', () => {
    const a = atmosphereFresnel(0.3, 3)
    const b = atmosphereFresnel(0.6, 3)
    expect(a).toBeGreaterThan(b)
    expect(a).toBeGreaterThan(0)
    expect(b).toBeLessThan(1)
  })

  it('对称：|N·V| 相同则 rim 相同（BackSide 法线翻转鲁棒）', () => {
    expect(atmosphereFresnel(0.5, 3)).toBeCloseTo(atmosphereFresnel(-0.5, 3), 10)
  })

  it('clamp 到 [0,1]：超界 dot 不爆（输出 0）', () => {
    expect(atmosphereFresnel(2, 3)).toBe(0)
    expect(atmosphereFresnel(-2, 3)).toBe(0)
  })

  it('power 越大边缘越窄锐（同一 |N·V|，大 power rim 更小，除掠射点）', () => {
    // |N·V|=0.5：power=2 → 0.25；power=4 → 0.0625
    expect(atmosphereFresnel(0.5, 2)).toBeGreaterThan(atmosphereFresnel(0.5, 4))
  })
})

describe('atmosphere 几何常量（贴合 2:1 平面边缘）', () => {
  it('辉光色为合法 hex（desaturateHex 产出）', () => {
    expect(ATMOSPHERE_GLOW_COLOR).toMatch(/^#?[0-9a-fA-F]{6}$/)
  })

  it('fresnelPower 与强度为正（克制）', () => {
    expect(ATMOSPHERE_FRESNEL_POWER).toBeGreaterThan(0)
    expect(ATMOSPHERE_INTENSITY_HIGH).toBeGreaterThan(0)
    expect(ATMOSPHERE_INTENSITY_HIGH).toBeLessThanOrEqual(1)
  })

  it('椭圆壳 scale 保持 2:1 贴合平面边缘（scaleZ/scaleX = PLANE_H/PLANE_W）', () => {
    expect(SHELL_SCALE_Z / SHELL_SCALE_X).toBeCloseTo(PLANE_HEIGHT / PLANE_WIDTH, 6)
  })

  it('椭圆壳覆盖平面半宽（SHELL_SCALE_X > PLANE_WIDTH/2，留边缘辉光余量）', () => {
    expect(SHELL_SCALE_X).toBeGreaterThan(PLANE_WIDTH / 2)
    expect(SHELL_SCALE_Z).toBeGreaterThan(PLANE_HEIGHT / 2)
  })

  it('壳半径 / 压扁 / 细分 / theta 均为正合法', () => {
    expect(SHELL_RADIUS).toBeGreaterThan(0)
    expect(SHELL_FLATTEN).toBeGreaterThan(0)
    expect(SHELL_FLATTEN).toBeLessThan(1)
    expect(SHELL_SEGMENTS.width).toBeGreaterThanOrEqual(8)
    expect(SHELL_SEGMENTS.height).toBeGreaterThanOrEqual(8)
    expect(SHELL_THETA_LENGTH).toBeCloseTo(Math.PI / 2, 10) // 上半球
  })
})

describe('atmosphere 材质属性（SPEC §6.7：additive + BackSide + 不写深度）', () => {
  it('ATMOSPHERE_MATERIAL_OPTS 契约', () => {
    expect(ATMOSPHERE_MATERIAL_OPTS.transparent).toBe(true)
    expect(ATMOSPHERE_MATERIAL_OPTS.depthWrite).toBe(false)
    expect(ATMOSPHERE_MATERIAL_OPTS.depthTest).toBe(false)
    expect(ATMOSPHERE_MATERIAL_OPTS.side).toBe(THREE.BackSide)
    expect(ATMOSPHERE_MATERIAL_OPTS.blending).toBe(THREE.AdditiveBlending)
  })

  it('createAtmosphereMaterial 输出 ShaderMaterial 满足契约 + uniform + GLSL', () => {
    const m = createAtmosphereMaterial(0.5)
    expect(m).toBeInstanceOf(THREE.ShaderMaterial)
    expect(m.transparent).toBe(true)
    expect(m.depthWrite).toBe(false)
    expect(m.depthTest).toBe(false)
    expect(m.side).toBe(THREE.BackSide)
    expect(m.blending).toBe(THREE.AdditiveBlending)
    expect(m.uniforms.uIntensity.value).toBe(0.5)
    expect(m.uniforms.uFresnelPower.value).toBe(ATMOSPHERE_FRESNEL_POWER)
    expect(m.uniforms.uGlowColor.value).toBeInstanceOf(THREE.Color)
    // GLSL 防回归：fresnel 边缘 rim + abs + view-space normalMatrix
    expect(m.vertexShader).toContain('normalMatrix')
    expect(m.fragmentShader).toContain('abs(dot')
    expect(m.fragmentShader).toContain('uFresnelPower')
  })

  it('默认强度 = 高档常量', () => {
    expect(createAtmosphereMaterial().uniforms.uIntensity.value).toBe(ATMOSPHERE_INTENSITY_HIGH)
  })

  it('渲染顺序高于 Ocean（§4.3 管线末项最后绘）', () => {
    expect(ATMOSPHERE_RENDER_ORDER).toBeGreaterThan(OCEAN_RENDER_ORDER)
  })
})

describe('atmosphere 质量分档（SPEC §8：低档关辉光）', () => {
  it('低档关闭辉光', () => {
    expect(ATMOSPHERE_BY_TIER.low.enabled).toBe(false)
    expect(ATMOSPHERE_BY_TIER.low.intensity).toBe(0)
  })

  it('高档启用且强度最大', () => {
    expect(ATMOSPHERE_BY_TIER.high.enabled).toBe(true)
    expect(ATMOSPHERE_BY_TIER.high.intensity).toBe(ATMOSPHERE_INTENSITY_HIGH)
  })

  it('中档启用但弱于高档（克制，不抢戏）', () => {
    expect(ATMOSPHERE_BY_TIER.medium.enabled).toBe(true)
    expect(ATMOSPHERE_BY_TIER.medium.intensity).toBeGreaterThan(0)
    expect(ATMOSPHERE_BY_TIER.medium.intensity).toBeLessThan(ATMOSPHERE_BY_TIER.high.intensity)
  })

  it('三档齐全（high/medium/low）', () => {
    expect(Object.keys(ATMOSPHERE_BY_TIER).sort()).toEqual(['high', 'low', 'medium'])
  })
})
