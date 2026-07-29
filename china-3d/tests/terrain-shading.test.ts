/**
 * 地形明暗照明配置测试（TASK-006 验收 2 的支撑：方向光法线明暗的参数事实源）。
 *
 * 依赖方向：测试基线（vitest，Node 环境），import src/config/terrain-shading（照明唯一事实源）。
 * 不依赖浏览器、React、Three.js——照明配置是冻结常量 + 纯函数，可在 Node 内完整断言
 * 「主光来自西北偏高」「单主光」「半球环境光低强度」「配置冻结」「hex 解析正确」。
 *
 * 覆盖：
 * - 主光方向：西北偏高（x<0 西、y>0 上、z<0 北），单位向量；方位角 225°、仰角 50°。
 * - 单主光结构性不变量（配置以单一 mainLight 对象表达，不存在主光数组）。
 * - 半球环境光：天 / 地双色存在且不同、强度 < 1（低强度，背光面不死黑又不冲淡色阶）。
 * - hexToShaderFloat3：字节 / 255 归一化；非法 hex 拒绝。
 * - 配置冻结（运行时不被偷偷修改）。
 */

import { describe, it, expect } from 'vitest'
import {
  TERRAIN_HEMISPHERE_GROUND_HEX,
  TERRAIN_HEMISPHERE_INTENSITY,
  TERRAIN_HEMISPHERE_SKY_HEX,
  TERRAIN_MAIN_LIGHT_AZIMUTH_DEGREES,
  TERRAIN_MAIN_LIGHT_DIRECTION,
  TERRAIN_MAIN_LIGHT_ELEVATION_DEGREES,
  TERRAIN_MAIN_LIGHT_HEX,
  TERRAIN_MAIN_LIGHT_INTENSITY,
  TERRAIN_SHADING_CONFIG,
  hexToShaderFloat3,
} from '../src/config/terrain-shading'

describe('主光方向：西北偏高（SPEC §3.4）', () => {
  it('方向向量 x<0（西）、y>0（上）、z<0（北）', () => {
    expect(TERRAIN_MAIN_LIGHT_DIRECTION.x).toBeLessThan(0)
    expect(TERRAIN_MAIN_LIGHT_DIRECTION.y).toBeGreaterThan(0)
    expect(TERRAIN_MAIN_LIGHT_DIRECTION.z).toBeLessThan(0)
  })

  it('方向向量是单位向量（dot 量纲精确）', () => {
    const { x, y, z } = TERRAIN_MAIN_LIGHT_DIRECTION
    expect(Math.hypot(x, y, z)).toBeCloseTo(1, 9)
  })

  it('方位角 225°（西北角平分线）、仰角 50°（偏高）', () => {
    expect(TERRAIN_MAIN_LIGHT_AZIMUTH_DEGREES).toBe(225)
    expect(TERRAIN_MAIN_LIGHT_ELEVATION_DEGREES).toBe(50)
    // 仰角 50° → +Y 分量 = sin(50°) ≈ 0.766。
    expect(TERRAIN_MAIN_LIGHT_DIRECTION.y).toBeCloseTo(Math.sin((50 * Math.PI) / 180), 6)
    // 方位角 225° → 水平分量 x = z（西 / 北等量）。
    expect(TERRAIN_MAIN_LIGHT_DIRECTION.x).toBeCloseTo(TERRAIN_MAIN_LIGHT_DIRECTION.z, 9)
  })

  it('主光为冷白偏亮色（暖白偏冷，各通道高且蓝略占优）', () => {
    const [r, g, b] = hexToShaderFloat3(TERRAIN_MAIN_LIGHT_HEX)
    expect(r).toBeGreaterThan(0.8)
    expect(g).toBeGreaterThan(0.8)
    expect(b).toBeGreaterThan(0.8)
    expect(b).toBeGreaterThanOrEqual(r)
  })

  it('主光强度为正且不超过 1（主明暗来源，不过曝）', () => {
    expect(TERRAIN_MAIN_LIGHT_INTENSITY).toBeGreaterThan(0)
    expect(TERRAIN_MAIN_LIGHT_INTENSITY).toBeLessThanOrEqual(1)
  })
})

describe('单主光结构性不变量（SPEC §3.4「单盏主光」）', () => {
  it('配置以单一 mainLight 对象表达（不存在主光数组 / 第二盏主光）', () => {
    expect(Array.isArray(TERRAIN_SHADING_CONFIG.mainLight)).toBe(false)
    expect(typeof TERRAIN_SHADING_CONFIG.mainLight).toBe('object')
    expect(TERRAIN_SHADING_CONFIG.mainLight.direction).toBe(TERRAIN_MAIN_LIGHT_DIRECTION)
  })
})

describe('半球环境光：低强度、天地双色（SPEC §3.4「保证背光面不死黑」）', () => {
  it('强度 < 1（低强度不变量，不冲淡分层设色）且 > 0（背光面有补光）', () => {
    expect(TERRAIN_HEMISPHERE_INTENSITY).toBeGreaterThan(0)
    expect(TERRAIN_HEMISPHERE_INTENSITY).toBeLessThan(1)
  })

  it('天色与地色不同（天 / 地双色插值才有意义）', () => {
    expect(TERRAIN_HEMISPHERE_SKY_HEX).not.toBe(TERRAIN_HEMISPHERE_GROUND_HEX)
  })

  it('天色为冷调暗蓝（蓝通道占优），适配深色科技风', () => {
    const [r, g, b] = hexToShaderFloat3(TERRAIN_HEMISPHERE_SKY_HEX)
    expect(b).toBeGreaterThan(r)
    expect(b).toBeGreaterThan(g)
  })
})

describe('hexToShaderFloat3 · 颜色空间约定（字节 / 255，与 ramp 同一约定）', () => {
  it('#rrggbb 归一化到 [0,1]³', () => {
    expect(hexToShaderFloat3('#000000')).toStrictEqual([0, 0, 0])
    expect(hexToShaderFloat3('#ffffff')).toStrictEqual([1, 1, 1])
    const [r, g, b] = hexToShaderFloat3('#9fe8d8')
    expect(r).toBeCloseTo(159 / 255, 9)
    expect(g).toBeCloseTo(232 / 255, 9)
    expect(b).toBeCloseTo(216 / 255, 9)
  })

  it('非法 hex 确定性拒绝（不带 # 前缀也可解析；位数错误抛错）', () => {
    expect(() => hexToShaderFloat3('#12345')).toThrow(Error)
    expect(() => hexToShaderFloat3('zzzzzz')).toThrow(Error)
  })
})

describe('配置冻结（照明参数不被运行时偷偷修改）', () => {
  it('TERRAIN_SHADING_CONFIG 及其子对象全部冻结', () => {
    expect(Object.isFrozen(TERRAIN_SHADING_CONFIG)).toBe(true)
    expect(Object.isFrozen(TERRAIN_SHADING_CONFIG.mainLight)).toBe(true)
    expect(Object.isFrozen(TERRAIN_SHADING_CONFIG.hemisphereAmbient)).toBe(true)
    expect(Object.isFrozen(TERRAIN_SHADING_CONFIG.mainLight.direction)).toBe(true)
  })

  it('照明配置不含阴影 / 雾字段（地形不投阴影贴图；雾归 TASK-008 场景氛围）', () => {
    expect('castShadow' in TERRAIN_SHADING_CONFIG.mainLight).toBe(false)
    expect('fog' in TERRAIN_SHADING_CONFIG).toBe(false)
  })
})
