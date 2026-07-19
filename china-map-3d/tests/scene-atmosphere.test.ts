/**
 * 深色地势照明与背景层次配置的不变量测试（TASK-012 验证方式 1）。
 *
 * 依赖方向：测试基线（vitest，Node 环境），import src/config/scene-atmosphere（纯 TS，不依赖
 * three / React / DOM）与 src/lib/projection（MAIN_MAP_WORLD_BOUNDS）。场景氛围配置是冻结常量 +
 * 纯函数，可在 Node 内完整断言「主光来自西北偏高」「单主光」「环境光存在」「地形阴影关闭」
 * 「无外部纹理请求」「远缘雾因子轻微不吞没要素」，无需启动浏览器 / WebGL（人工视觉验收留给
 * TASK-012 验证方式 3、4）。
 *
 * 覆盖（TASK-012 验证方式 1：场景视觉配置满足主光方向、单主光、环境光存在和地形阴影关闭等不变量）：
 * - 主光方向：西北偏高（x<0 西、y>0 上、z<0 北），单位向量，与方位角 / 仰角派生一致。
 * - 单主光：MAIN_LIGHT_COUNT = 1，配置以单一 mainLight 对象表达（无第二盏主光的结构保证）。
 * - 环境光存在：半球环境光字段齐全、强度 > 0 且为低强度（< 1）。
 * - 地形阴影关闭：主光 castShadow=false、渲染器 shadowsEnabled=false（结构性决定，非默认凑巧）。
 * - 背景与雾：深蓝黑背景三通道低且蓝占优；雾色 = 背景色（远缘无接缝）；雾密度轻微（远角雾因子 < 0.2）。
 * - 无外部纹理请求：配置字段不含 URL / 路径串，背景为纯色（非纹理路径），不引入天空盒 / 卫星影像。
 * - 配置冻结：氛围对象运行时不可被偷偷放宽（如开阴影、改光向）。
 */

import { describe, it, expect } from 'vitest'
import {
  FOG_DENSITY_FACTOR,
  FOG_ENABLED,
  FOG_FAR_EDGE_REFERENCE_METERS,
  MAIN_LIGHT_COUNT,
  SCENE_ATMOSPHERE_CONFIG,
  computeFogFactor,
  hexToShaderFloat3,
} from '../src/config/scene-atmosphere'

const TOLERANCE = 1e-6

/** 断言两个数值在给定绝对容差内相等。 */
function expectAlmostEqual(actual: number, expected: number, tolerance: number, note = ''): void {
  expect(Math.abs(actual - expected), `期望 ${actual} ≈ ${expected}（容差 ${tolerance}）${note}`).toBeLessThanOrEqual(
    tolerance,
  )
}

describe('主光方向：西北偏高方位（TASK-012 验证方式 1）', () => {
  const { direction } = SCENE_ATMOSPHERE_CONFIG.mainLight

  it('光向 x<0（西）、y>0（上）、z<0（北）= 西北偏高', () => {
    expect(direction.x).toBeLessThan(0, '光向 x<0 表示光源在西（西北偏高）')
    expect(direction.y).toBeGreaterThan(0, '光向 y>0 表示光源在地平以上（偏高）')
    expect(direction.z).toBeLessThan(0, '光向 z<0 表示光源在北（西北偏高）')
  })

  it('光向为单位向量（Lambert dot 量纲精确）', () => {
    const len = Math.hypot(direction.x, direction.y, direction.z)
    expectAlmostEqual(len, 1, TOLERANCE, '光向应归一化为单位向量')
  })

  it('水平分量在西-北象限均衡（西北角平分线，dx ≈ dz < 0）', () => {
    // 西北 225°：sin/cos(225°) 均为 -√2/2，故水平 x ≈ z（同负），强调青藏（西）—东海梯度。
    expectAlmostEqual(direction.x, direction.z, Math.abs(direction.x) * 1e-6, 'dx ≈ dz（西北 45° 角平分）')
  })

  it('仰角为「偏高」（y 分量明显大于水平分量的一半，保留侧向明暗又不压平地势）', () => {
    const horiz = Math.hypot(direction.x, direction.z)
    // 仰角 50°：y/horiz = tan(50°) ≈ 1.19；「偏高」要求 y 不至于过小（过小=贴地平）。
    expect(direction.y / horiz).toBeGreaterThan(1.0, 'y/水平 > 1，仰角 > 45°（偏高方位）')
  })
})

describe('单主光（TASK-012 验证方式 1）', () => {
  it('MAIN_LIGHT_COUNT = 1（结构上只有一盏主光）', () => {
    expect(MAIN_LIGHT_COUNT).toBe(1)
  })

  it('配置以单一 mainLight 对象表达（非数组 / 非集合，无第二盏主光的结构入口）', () => {
    expect(typeof SCENE_ATMOSPHERE_CONFIG.mainLight).toBe('object')
    // mainLight 是单一对象，不是数组——任何「第二盏主光」都必须改结构，从而被本测试与代码审查捕获。
    expect(Array.isArray(SCENE_ATMOSPHERE_CONFIG.mainLight)).toBe(false)
  })

  it('主光强度 > 0（主光是地势明暗的实际来源，非零）', () => {
    expect(SCENE_ATMOSPHERE_CONFIG.mainLight.intensity).toBeGreaterThan(0)
  })
})

describe('环境光存在且低强度（TASK-012 验证方式 1）', () => {
  it('半球环境光字段齐全（天色 / 地色 / 强度均在）', () => {
    const { hemisphereAmbient } = SCENE_ATMOSPHERE_CONFIG
    expect(hemisphereAmbient.skyHex).toBeTruthy()
    expect(hemisphereAmbient.groundHex).toBeTruthy()
    expect(Number.isFinite(hemisphereAmbient.intensity)).toBe(true)
  })

  it('环境光强度 > 0（存在，保证背光面不死黑）', () => {
    expect(SCENE_ATMOSPHERE_CONFIG.hemisphereAmbient.intensity).toBeGreaterThan(0)
  })

  it('环境光强度为低强度（< 1，不以过强环境光冲淡高程色阶）', () => {
    expect(SCENE_ATMOSPHERE_CONFIG.hemisphereAmbient.intensity).toBeLessThan(1)
  })
})

describe('地形阴影关闭（TASK-012 验证方式 1、5）', () => {
  it('主光 castShadow = false（不投递地形阴影贴图）', () => {
    expect(SCENE_ATMOSPHERE_CONFIG.mainLight.castShadow).toBe(false)
  })

  it('渲染器 shadowsEnabled = false（Canvas 不启用阴影图）', () => {
    expect(SCENE_ATMOSPHERE_CONFIG.shadowsEnabled).toBe(false)
  })

  it('阴影关闭是显式配置字段（结构性决定，非默认值凑巧为 false）', () => {
    // 字段必须存在于冻结配置中——确保「阴影关闭」是被声明的不变量，而非遗漏。
    expect(SCENE_ATMOSPHERE_CONFIG).toHaveProperty('mainLight.castShadow', false)
    expect(SCENE_ATMOSPHERE_CONFIG).toHaveProperty('shadowsEnabled', false)
  })
})

describe('背景与雾：深蓝黑背景、雾色 = 背景色、远缘雾因子轻微', () => {
  it('背景为深蓝黑（三通道均低、蓝通道相对占优，与深色科技风一致）', () => {
    const { backgroundRgb } = SCENE_ATMOSPHERE_CONFIG
    expect(backgroundRgb.r).toBeLessThan(40, '红通道低（深色）')
    expect(backgroundRgb.g).toBeLessThan(40, '绿通道低（深色）')
    expect(backgroundRgb.b).toBeLessThan(50, '蓝通道低（深色）')
    // 深蓝黑：蓝通道 >= 红、绿通道（蓝黑色相）。
    expect(backgroundRgb.b).toBeGreaterThanOrEqual(backgroundRgb.r)
    expect(backgroundRgb.b).toBeGreaterThanOrEqual(backgroundRgb.g)
  })

  it('雾色 === 背景色（远缘淡入背景，无接缝）', () => {
    expect(SCENE_ATMOSPHERE_CONFIG.fog.hex).toBe(SCENE_ATMOSPHERE_CONFIG.backgroundHex)
  })

  it('雾密度 > 0（启用时实际生效）或 FOG_ENABLED=false（二者居其一，语义自洽）', () => {
    if (FOG_ENABLED) {
      expect(SCENE_ATMOSPHERE_CONFIG.fog.density).toBeGreaterThan(0)
    } else {
      // 关闭雾是允许的视觉决策；此时远缘衔接由背景色 + 构图承担（已在背景色上对齐）。
      expect(FOG_ENABLED).toBe(false)
    }
  })

  it('远缘雾因子轻微（< 0.2），不吞没南海 / 边界 / 标签', () => {
    if (!FOG_ENABLED) return // 雾关闭时本断言无对象。
    const farEdgeFactor = computeFogFactor(
      FOG_FAR_EDGE_REFERENCE_METERS,
      SCENE_ATMOSPHERE_CONFIG.fog.density,
    )
    // 远角雾因子 < 0.2：远缘被柔化但完全可读（南海诸岛 / 边界 / 标签不被吞没）。
    expect(farEdgeFactor).toBeLessThan(0.2)
    // 同时雾因子 > 0（密度系数非零，雾实际存在而非被关到不可见）。
    expect(farEdgeFactor).toBeGreaterThan(0)
  })

  it('雾密度系数无量纲且落在轻微区间（0.05–0.4，随地图对角线伸缩）', () => {
    expect(FOG_DENSITY_FACTOR).toBeGreaterThanOrEqual(0.05)
    expect(FOG_DENSITY_FACTOR).toBeLessThanOrEqual(0.4)
  })

  it('computeFogFactor 与 three.js FogExp2 公式同源（depth=0 时为 0，密度越大因子越大）', () => {
    expect(computeFogFactor(0, SCENE_ATMOSPHERE_CONFIG.fog.density)).toBe(0)
    const d = SCENE_ATMOSPHERE_CONFIG.fog.density
    expect(computeFogFactor(1e7, d)).toBeGreaterThan(computeFogFactor(1e6, d))
  })
})

describe('无外部纹理请求 / 无天空盒 / 无卫星影像（TASK-012 验证方式 2）', () => {
  it('配置字段不含 URL / 文件路径串（背景为纯色十六进制，非纹理资源）', () => {
    // 收集所有字符串字段，断言没有以 http / 协议头 / 资源扩展名开头的值——氛围层零外部资源依赖。
    const stringValues: readonly string[] = [
      SCENE_ATMOSPHERE_CONFIG.backgroundHex,
      SCENE_ATMOSPHERE_CONFIG.mainLight.hex,
      SCENE_ATMOSPHERE_CONFIG.hemisphereAmbient.skyHex,
      SCENE_ATMOSPHERE_CONFIG.hemisphereAmbient.groundHex,
      SCENE_ATMOSPHERE_CONFIG.fog.hex,
    ]
    for (const s of stringValues) {
      expect(s).toMatch(/^#[0-9a-fA-F]{6}$/, `氛围颜色字段必须是 #rrggbb 纯色，实际为 ${s}`)
    }
  })

  it('背景为纯色（无 texture / cubeMap / skybox 字段）', () => {
    // 氛围配置不应包含纹理 / 立方贴图 / 天空盒字段——背景由纯色 scene.background 承担。
    expect(SCENE_ATMOSPHERE_CONFIG).not.toHaveProperty('backgroundTexture')
    expect(SCENE_ATMOSPHERE_CONFIG).not.toHaveProperty('skybox')
    expect(SCENE_ATMOSPHERE_CONFIG).not.toHaveProperty('environment')
  })
})

describe('配置冻结（运行时不可被偷偷放宽）', () => {
  it('SCENE_ATMOSPHERE_CONFIG 及其子对象全部冻结', () => {
    expect(Object.isFrozen(SCENE_ATMOSPHERE_CONFIG)).toBe(true)
    expect(Object.isFrozen(SCENE_ATMOSPHERE_CONFIG.mainLight)).toBe(true)
    expect(Object.isFrozen(SCENE_ATMOSPHERE_CONFIG.mainLight.direction)).toBe(true)
    expect(Object.isFrozen(SCENE_ATMOSPHERE_CONFIG.hemisphereAmbient)).toBe(true)
    expect(Object.isFrozen(SCENE_ATMOSPHERE_CONFIG.fog)).toBe(true)
  })
})

describe('hexToShaderFloat3：十六进制 → [0,1]³ 着色器 uniform', () => {
  it('把 #rrggbb 字节正确归一化到 [0,1]³', () => {
    const [r, g, b] = hexToShaderFloat3('#070b16')
    expectAlmostEqual(r, 7 / 255, TOLERANCE)
    expectAlmostEqual(g, 11 / 255, TOLERANCE)
    expectAlmostEqual(b, 22 / 255, TOLERANCE)
  })

  it('所有分量落在 [0,1]（着色器安全区间）', () => {
    for (const hex of [
      SCENE_ATMOSPHERE_CONFIG.mainLight.hex,
      SCENE_ATMOSPHERE_CONFIG.hemisphereAmbient.skyHex,
      SCENE_ATMOSPHERE_CONFIG.hemisphereAmbient.groundHex,
    ]) {
      for (const c of hexToShaderFloat3(hex)) {
        expect(c).toBeGreaterThanOrEqual(0)
        expect(c).toBeLessThanOrEqual(1)
      }
    }
  })

  it('非法十六进制被拒绝（防御脏色值进入着色器）', () => {
    expect(() => hexToShaderFloat3('not-a-color')).toThrow()
    expect(() => hexToShaderFloat3('#abc')).toThrow()
  })
})

describe('光照 / 背景层只依赖场景视觉配置（TASK-012 实现约束）', () => {
  it('氛围配置不含行政区 / 地点 / hover 字段（与领域 / 交互解耦）', () => {
    // 氛围层只能依赖场景视觉配置，不得读取行政区、地点或 hover 状态。
    expect(SCENE_ATMOSPHERE_CONFIG).not.toHaveProperty('province')
    expect(SCENE_ATMOSPHERE_CONFIG).not.toHaveProperty('hover')
    expect(SCENE_ATMOSPHERE_CONFIG).not.toHaveProperty('place')
    expect(SCENE_ATMOSPHERE_CONFIG).not.toHaveProperty('adminId')
  })
})
