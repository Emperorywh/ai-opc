/**
 * 场景氛围配置与装配的不变量测试（TASK-008 验收 3 的支撑，SPEC §3.4）。
 *
 * 依赖方向：测试基线（vitest，Node 环境），import src/config/scene-atmosphere（纯 TS，不依赖
 * three / React / DOM）与 src/lib/projection。场景氛围配置是冻结常量 + 纯函数，可在 Node 内完整
 * 断言「主光来自西北偏高」「单主光」「环境光存在」「地形阴影关闭」「深蓝黑背景」「雾色 = 背景色」
 * 「远缘雾因子轻微」「无外部纹理请求」，无需启动浏览器 / WebGL；SceneAtmosphere 装配由源码结构
 * 扫描断言（灯光 / 背景 / 雾 JSX 全部取自配置）。
 *
 * 本测试同时吸收 TASK-006 terrain-shading.test 的全部照明断言——terrain-shading 模块已被
 * scene-atmosphere 吸收为唯一事实源（TASK-008），照明数值逐项保持一致，此处继续锁定。
 *
 * 覆盖：
 * - 主光方向：西北偏高（x<0 西、y>0 上、z<0 北），单位向量；方位角 225°、仰角 50°。
 * - 单主光结构性不变量（MAIN_LIGHT_COUNT = 1，配置以单一 mainLight 对象表达）。
 * - 主光颜色冷白、强度为正不超过 1。
 * - 半球环境光：天 / 地双色存在且不同、强度 < 1（低强度，背光面不死黑又不冲淡色阶）。
 * - 地形阴影关闭：castShadow=false、shadowsEnabled=false（结构性决定，非默认凑巧）。
 * - 背景与雾：深蓝黑（三通道低、蓝占优）；雾色 === 背景色；远缘雾因子 < 0.2 不吞没要素。
 * - 无外部纹理请求 / 无天空盒：颜色字段全部 #rrggbb 纯色，无纹理 / skybox / environment 字段。
 * - 配置冻结；hexToShaderFloat3 字节 / 255 归一化与非法拒绝。
 * - SceneAtmosphere 组件装配源码扫描：背景 / 雾 / 半球光 / 主光全部取自配置，无硬编码氛围常量。
 * - 全 src 无 terrain-shading 残留引用（唯一事实源不变量）。
 */

import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  FOG_DENSITY_FACTOR,
  FOG_ENABLED,
  FOG_FAR_EDGE_REFERENCE_METERS,
  HEMISPHERE_GROUND_HEX,
  HEMISPHERE_INTENSITY,
  HEMISPHERE_SKY_HEX,
  MAIN_LIGHT_AZIMUTH_DEGREES,
  MAIN_LIGHT_COUNT,
  MAIN_LIGHT_DIRECTION,
  MAIN_LIGHT_ELEVATION_DEGREES,
  MAIN_LIGHT_HEX,
  MAIN_LIGHT_INTENSITY,
  SCENE_ATMOSPHERE_CONFIG,
  computeFogFactor,
  hexToShaderFloat3,
} from '../src/config/scene-atmosphere'

const projectRoot = resolve(fileURLToPath(import.meta.url), '..', '..')
const srcRoot = resolve(projectRoot, 'src')

/** 读取 src 下某源码文件的文本（源码结构不变量扫描用）。 */
function readSource(relativePath: string): string {
  return readFileSync(resolve(srcRoot, relativePath), 'utf-8')
}

/**
 * 剥离块注释与行注释后的代码文本。
 *
 * 「无 terrain-shading 残留」约束的是**代码引用**（import / 标识符），文档注释里允许出现
 * 「吸收 TASK-006 terrain-shading」这类历史说明文字；剥离注释后再扫描，避免把说明文字误判为残留。
 */
function stripComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '')
}

/** 递归收集 src 下全部 .ts / .tsx 源文件（相对 src 的路径）。 */
function listSrcFiles(dir: string = srcRoot, prefix: string = ''): string[] {
  const entries = readdirSync(dir)
  const files: string[] = []
  for (const entry of entries) {
    const absolute = resolve(dir, entry)
    const relative = prefix === '' ? entry : `${prefix}/${entry}`
    if (statSync(absolute).isDirectory()) {
      files.push(...listSrcFiles(absolute, relative))
    } else if (entry.endsWith('.ts') || entry.endsWith('.tsx')) {
      files.push(relative)
    }
  }
  return files
}

const TOLERANCE = 1e-6

/** 断言两个数值在给定绝对容差内相等。 */
function expectAlmostEqual(actual: number, expected: number, tolerance: number, note = ''): void {
  expect(Math.abs(actual - expected), `期望 ${actual} ≈ ${expected}（容差 ${tolerance}）${note}`).toBeLessThanOrEqual(
    tolerance,
  )
}

describe('主光方向：西北偏高（SPEC §3.4）', () => {
  it('方向向量 x<0（西）、y>0（上）、z<0（北）', () => {
    expect(MAIN_LIGHT_DIRECTION.x).toBeLessThan(0)
    expect(MAIN_LIGHT_DIRECTION.y).toBeGreaterThan(0)
    expect(MAIN_LIGHT_DIRECTION.z).toBeLessThan(0)
  })

  it('方向向量是单位向量（Lambert dot 量纲精确）', () => {
    const { x, y, z } = MAIN_LIGHT_DIRECTION
    expect(Math.hypot(x, y, z)).toBeCloseTo(1, 9)
  })

  it('方位角 225°（西北角平分线）、仰角 50°（偏高）', () => {
    expect(MAIN_LIGHT_AZIMUTH_DEGREES).toBe(225)
    expect(MAIN_LIGHT_ELEVATION_DEGREES).toBe(50)
    // 仰角 50° → +Y 分量 = sin(50°) ≈ 0.766。
    expect(MAIN_LIGHT_DIRECTION.y).toBeCloseTo(Math.sin((50 * Math.PI) / 180), 6)
    // 方位角 225° → 水平分量 x = z（西 / 北等量）。
    expect(MAIN_LIGHT_DIRECTION.x).toBeCloseTo(MAIN_LIGHT_DIRECTION.z, 9)
  })

  it('仰角为「偏高」（y 分量大于水平分量，仰角 > 45°，保留侧向明暗又不压平地势）', () => {
    const horiz = Math.hypot(MAIN_LIGHT_DIRECTION.x, MAIN_LIGHT_DIRECTION.z)
    expect(MAIN_LIGHT_DIRECTION.y / horiz).toBeGreaterThan(1.0)
  })

  it('主光为冷白偏亮色（暖白偏冷，各通道高且蓝略占优）', () => {
    const [r, g, b] = hexToShaderFloat3(MAIN_LIGHT_HEX)
    expect(r).toBeGreaterThan(0.8)
    expect(g).toBeGreaterThan(0.8)
    expect(b).toBeGreaterThan(0.8)
    expect(b).toBeGreaterThanOrEqual(r)
  })

  it('主光强度为正且不超过 1（主明暗来源，不过曝）', () => {
    expect(MAIN_LIGHT_INTENSITY).toBeGreaterThan(0)
    expect(MAIN_LIGHT_INTENSITY).toBeLessThanOrEqual(1)
  })
})

describe('单主光结构性不变量（SPEC §3.4「单盏主光」）', () => {
  it('MAIN_LIGHT_COUNT = 1（结构上只有一盏主光）', () => {
    expect(MAIN_LIGHT_COUNT).toBe(1)
  })

  it('配置以单一 mainLight 对象表达（不存在主光数组 / 第二盏主光的结构入口）', () => {
    expect(Array.isArray(SCENE_ATMOSPHERE_CONFIG.mainLight)).toBe(false)
    expect(typeof SCENE_ATMOSPHERE_CONFIG.mainLight).toBe('object')
    expect(SCENE_ATMOSPHERE_CONFIG.mainLight.direction).toBe(MAIN_LIGHT_DIRECTION)
  })
})

describe('半球环境光：低强度、天地双色（SPEC §3.4「保证背光面不死黑」）', () => {
  it('强度 < 1（低强度不变量，不冲淡分层设色）且 > 0（背光面有补光）', () => {
    expect(HEMISPHERE_INTENSITY).toBeGreaterThan(0)
    expect(HEMISPHERE_INTENSITY).toBeLessThan(1)
  })

  it('天色与地色不同（天 / 地双色插值才有意义）', () => {
    expect(HEMISPHERE_SKY_HEX).not.toBe(HEMISPHERE_GROUND_HEX)
  })

  it('天色为冷调暗蓝（蓝通道占优），适配深色科技风', () => {
    const [r, g, b] = hexToShaderFloat3(HEMISPHERE_SKY_HEX)
    expect(b).toBeGreaterThan(r)
    expect(b).toBeGreaterThan(g)
  })
})

describe('地形阴影关闭（SPEC §3.4「地形本身不投递阴影贴图」）', () => {
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

describe('背景与雾：深蓝黑背景、雾色 = 背景色、远缘雾因子轻微（SPEC §3.4）', () => {
  it('背景为深蓝黑（三通道均低、蓝通道相对占优，与深色科技风一致）', () => {
    const { backgroundRgb } = SCENE_ATMOSPHERE_CONFIG
    expect(backgroundRgb.r).toBeLessThan(40)
    expect(backgroundRgb.g).toBeLessThan(40)
    expect(backgroundRgb.b).toBeLessThan(50)
    // 深蓝黑：蓝通道 >= 红、绿通道（蓝黑色相）。
    expect(backgroundRgb.b).toBeGreaterThanOrEqual(backgroundRgb.r)
    expect(backgroundRgb.b).toBeGreaterThanOrEqual(backgroundRgb.g)
  })

  it('背景色取 SPEC §3.4 基线 #070b16（纯色，无天空盒贴图）', () => {
    expect(SCENE_ATMOSPHERE_CONFIG.backgroundHex).toBe('#070b16')
  })

  it('雾色 === 背景色（远缘淡入背景，无接缝）', () => {
    expect(SCENE_ATMOSPHERE_CONFIG.fog.hex).toBe(SCENE_ATMOSPHERE_CONFIG.backgroundHex)
  })

  it('雾密度 > 0（启用时实际生效）或 FOG_ENABLED=false（二者居其一，语义自洽）', () => {
    if (FOG_ENABLED) {
      expect(SCENE_ATMOSPHERE_CONFIG.fog.density).toBeGreaterThan(0)
    } else {
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

describe('无外部纹理请求 / 无天空盒 / 无卫星影像（SPEC §3.4「不引入天空盒贴图」）', () => {
  it('配置字段不含 URL / 文件路径串（背景为纯色十六进制，非纹理资源）', () => {
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
    expect(SCENE_ATMOSPHERE_CONFIG).not.toHaveProperty('backgroundTexture')
    expect(SCENE_ATMOSPHERE_CONFIG).not.toHaveProperty('skybox')
    expect(SCENE_ATMOSPHERE_CONFIG).not.toHaveProperty('environment')
  })
})

describe('hexToShaderFloat3 · 颜色空间约定（字节 / 255，与 ramp 同一约定）', () => {
  it('#rrggbb 归一化到 [0,1]³', () => {
    expect(hexToShaderFloat3('#000000')).toStrictEqual([0, 0, 0])
    expect(hexToShaderFloat3('#ffffff')).toStrictEqual([1, 1, 1])
    const [r, g, b] = hexToShaderFloat3('#070b16')
    expectAlmostEqual(r, 7 / 255, TOLERANCE)
    expectAlmostEqual(g, 11 / 255, TOLERANCE)
    expectAlmostEqual(b, 22 / 255, TOLERANCE)
  })

  it('所有氛围颜色分量落在 [0,1]（着色器安全区间）', () => {
    for (const hex of [
      SCENE_ATMOSPHERE_CONFIG.mainLight.hex,
      SCENE_ATMOSPHERE_CONFIG.hemisphereAmbient.skyHex,
      SCENE_ATMOSPHERE_CONFIG.hemisphereAmbient.groundHex,
      SCENE_ATMOSPHERE_CONFIG.fog.hex,
    ]) {
      for (const c of hexToShaderFloat3(hex)) {
        expect(c).toBeGreaterThanOrEqual(0)
        expect(c).toBeLessThanOrEqual(1)
      }
    }
  })

  it('非法 hex 确定性拒绝（不带 # 前缀也可解析；位数错误抛错）', () => {
    expect(() => hexToShaderFloat3('#12345')).toThrow(Error)
    expect(() => hexToShaderFloat3('zzzzzz')).toThrow(Error)
  })
})

describe('配置冻结（氛围参数不被运行时偷偷修改）', () => {
  it('SCENE_ATMOSPHERE_CONFIG 及其子对象全部冻结', () => {
    expect(Object.isFrozen(SCENE_ATMOSPHERE_CONFIG)).toBe(true)
    expect(Object.isFrozen(SCENE_ATMOSPHERE_CONFIG.mainLight)).toBe(true)
    expect(Object.isFrozen(SCENE_ATMOSPHERE_CONFIG.mainLight.direction)).toBe(true)
    expect(Object.isFrozen(SCENE_ATMOSPHERE_CONFIG.hemisphereAmbient)).toBe(true)
    expect(Object.isFrozen(SCENE_ATMOSPHERE_CONFIG.fog)).toBe(true)
  })

  it('氛围配置不含行政区 / 地点 / hover 字段（光照 / 背景层只依赖场景视觉配置）', () => {
    expect(SCENE_ATMOSPHERE_CONFIG).not.toHaveProperty('province')
    expect(SCENE_ATMOSPHERE_CONFIG).not.toHaveProperty('hover')
    expect(SCENE_ATMOSPHERE_CONFIG).not.toHaveProperty('place')
    expect(SCENE_ATMOSPHERE_CONFIG).not.toHaveProperty('adminId')
  })
})

describe('SceneAtmosphere 组件装配（源码结构扫描：氛围 JSX 全部取自配置）', () => {
  const source = readSource('three/SceneAtmosphere.tsx')

  it('深蓝黑纯色背景：<color attach="background">，色值取自配置（无天空盒贴图）', () => {
    expect(source).toContain('<color attach="background" args={[backgroundHex]} />')
    expect(source).not.toContain('skybox')
    expect(source).not.toContain('CubeTexture')
  })

  it('可选轻雾：<fogExp2 attach="fog"> 按配置 enabled 条件渲染，雾色 / 密度取自配置', () => {
    expect(source).toContain('fog.enabled && <fogExp2 attach="fog" args={[fog.hex, fog.density]} />')
  })

  it('低强度半球环境光：天 / 地色 + 强度全部取自配置', () => {
    expect(source).toContain('<hemisphereLight')
    expect(source).toContain('color={hemisphereAmbient.skyHex}')
    expect(source).toContain('groundColor={hemisphereAmbient.groundHex}')
    expect(source).toContain('intensity={hemisphereAmbient.intensity}')
  })

  it('单盏方向主光：position = 配置光向（西北偏高），castShadow 取自配置（结构性 false）', () => {
    expect(source).toContain('<directionalLight')
    expect(source).toContain('mainLight.direction')
    expect(source).toContain('color={mainLight.hex}')
    expect(source).toContain('intensity={mainLight.intensity}')
    expect(source).toContain('castShadow={mainLight.castShadow}')
  })

  it('组件只读 SCENE_ATMOSPHERE_CONFIG，不硬编码任何氛围色值 / 光向常量', () => {
    expect(source).toContain("from '../config/scene-atmosphere'")
    // 不硬编码十六进制色值（全部经配置字段引用）。
    expect(source).not.toMatch(/#[0-9a-fA-F]{6}/)
    // 不复制方位角 / 仰角 / 强度字面量（光向经 mainLight.direction 引用）。
    expect(source).not.toContain('225')
    expect(source).not.toContain('0.9')
  })
})

describe('唯一事实源不变量：全 src 无 terrain-shading 残留（TASK-008 吸收）', () => {
  it('没有任何源文件再在代码中引用 config/terrain-shading 或 TERRAIN_SHADING_CONFIG', () => {
    for (const file of listSrcFiles()) {
      // 扫描代码本体（剥离注释，文档里的历史说明文字不计）。
      const code = stripComments(readSource(file))
      expect(code.includes('terrain-shading'), `${file} 不得再引用 terrain-shading（已被 scene-atmosphere 吸收）`).toBe(false)
      expect(code.includes('TERRAIN_SHADING_CONFIG'), `${file} 不得再引用 TERRAIN_SHADING_CONFIG`).toBe(false)
    }
  })

  it('地形与海面着色器的照明 / 雾 uniform 注释指向 scene-atmosphere（单一来源语义一致）', () => {
    expect(readSource('three/terrain-shaders.ts')).toContain('SCENE_ATMOSPHERE_CONFIG')
    expect(readSource('three/sea-surface-shaders.ts')).toContain('SCENE_ATMOSPHERE_CONFIG')
  })
})
