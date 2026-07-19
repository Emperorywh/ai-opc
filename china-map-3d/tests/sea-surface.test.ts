/**
 * 动态海面配置与着色器不变量测试（TASK-013 验证方式 1、2）。
 *
 * 依赖方向：测试基线（vitest，Node 环境），import src/config/sea-surface（纯 TS，不依赖 three / React /
 * DOM）、src/three/sea-surface-shaders（纯 GLSL 字符串）、src/three/terrain-layout（纯 TS，用于断言海面
 * 与地形 plane 共面同范围）、src/lib/projection（MAIN_MAP_WORLD_BOUNDS）。海面配置是冻结常量 + 纯函数，
 * 着色器是字符串，可在 Node 内完整断言「海平面 = 0（与地形同米制）」「透明度落在 [0.55, 0.7]」
 * 「覆盖范围 = 主图世界包围盒且 = 地形 plane」「动画单一时间输入 uTime」「无运行时纹理下载」「不携带
 * 高程 / 色阶字段」，无需启动浏览器 / WebGL（人工视觉验收留给 TASK-013 验证方式 4、5）。
 *
 * 覆盖（TASK-013 验证方式 1、2）：
 * - 海平面：SEA_LEVEL_Y_METERS = 0（与地形真实海拔 h 经 k 位移后 h=0 → 世界 y=0 同米制）。
 * - 透明度：opacity 落在 [0.55, 0.7]（SPEC §3.5），上下限边界严格。
 * - 覆盖范围：海面 plane 米制布局 = 主图世界包围盒跨度 = 地形 plane 布局（共面同范围，逐米对齐）。
 * - 动画输入契约：着色器只声明一个 uniform float uTime（统一时钟），两层 sin 均含 uTime·speed 项，
 *   波动参数有限、幅度 < 0.1（细微不喧宾夺主）。
 * - 无运行时纹理下载：着色器不含 sampler2D（不采样法线 / 高程 / 噪声纹理），配置不含 URL / 纹理路径。
 * - 不参与陆地色阶：配置不含高程 / 色阶字段（domain / ramp / breakpoints / minH / maxH），不改写高程。
 * - 颜色：深蓝青（蓝通道占优、明度低于陆地层设色近岸色、高于深海近黑）。
 * - 配置冻结：海面对象运行时不可被偷偷改（如把透明度调到 1.0 会遮住大陆架）。
 */

import { describe, it, expect } from 'vitest'
import {
  SEA_LEVEL_Y_METERS,
  SEA_SURFACE_CONFIG,
  SEA_SURFACE_OPACITY,
  SEA_SURFACE_OPACITY_MAX,
  SEA_SURFACE_OPACITY_MIN,
  SEA_SURFACE_PLANE_LAYOUT,
  seaOpacityIsInRange,
} from '../src/config/sea-surface'
import { SEA_SURFACE_FRAGMENT_SHADER, SEA_SURFACE_VERTEX_SHADER } from '../src/three/sea-surface-shaders'
import { TERRAIN_PLANE_LAYOUT } from '../src/three/terrain-layout'
import { displaceElevationToWorldY } from '../src/config/terrain-config'
import { MAIN_MAP_WORLD_BOUNDS } from '../src/lib/projection'

const TOLERANCE = 1e-6

/** 断言两个数值在给定绝对容差内相等。 */
function expectAlmostEqual(actual: number, expected: number, tolerance: number, note = ''): void {
  expect(Math.abs(actual - expected), `期望 ${actual} ≈ ${expected}（容差 ${tolerance}）${note}`).toBeLessThanOrEqual(
    tolerance,
  )
}

describe('海平面 = 地形海平面（同一米制 y=0，TASK-013 验证方式 1 / 实现约束）', () => {
  it('SEA_LEVEL_Y_METERS === 0（与地形真实海拔 h=0 经 k 位移后世界 y=0 同米制）', () => {
    expect(SEA_LEVEL_Y_METERS).toBe(0)
    // 配置聚合体也携带同一海平面值（组件据此放置 mesh position.y）。
    expect(SEA_SURFACE_CONFIG.levelYMeters).toBe(0)
  })

  it('海平面不依赖垂直夸张系数 k（k 只放大地形 world-y，不改海面 y=0）', () => {
    // 形式证明：用地形配置层的真实位移公式镜像 displaceElevationToWorldY（世界 y = h·k）。
    // 海平面 h=0：无论 k=1.5/2.0/3.0，地形海平面世界 y = 0·k = 0，海面 y=0 恒与之重合。
    for (const k of [1.5, 2.0, 3.0]) {
      const terrainSeaLevelY = displaceElevationToWorldY(0, k)
      expect(terrainSeaLevelY).toBe(SEA_LEVEL_Y_METERS)
    }
  })
})

describe('半透明基线：opacity 落在 [0.55, 0.7]（SPEC §3.5、TASK-013 输出约束）', () => {
  it('透明度上下限 = 0.55 / 0.70（SPEC §3.5 边界）', () => {
    expect(SEA_SURFACE_OPACITY_MIN).toBe(0.55)
    expect(SEA_SURFACE_OPACITY_MAX).toBe(0.7)
  })

  it('基线透明度落在 [0.55, 0.7] 内', () => {
    expect(SEA_SURFACE_OPACITY).toBeGreaterThanOrEqual(SEA_SURFACE_OPACITY_MIN)
    expect(SEA_SURFACE_OPACITY).toBeLessThanOrEqual(SEA_SURFACE_OPACITY_MAX)
    expect(SEA_SURFACE_CONFIG.opacity).toBe(SEA_SURFACE_OPACITY)
  })

  it('seaOpacityIsInRange：区间内为 true、端点含、区间外为 false、非有限为 false', () => {
    expect(seaOpacityIsInRange(0.55)).toBe(true)
    expect(seaOpacityIsInRange(0.7)).toBe(true)
    expect(seaOpacityIsInRange(0.6)).toBe(true)
    // 区间外：过浓（看不见大陆架）/ 过淡（读不出「水」）。
    expect(seaOpacityIsInRange(0.4)).toBe(false)
    expect(seaOpacityIsInRange(0.8)).toBe(false)
    expect(seaOpacityIsInRange(1.0)).toBe(false)
    expect(seaOpacityIsInRange(0.0)).toBe(false)
    // 非有限：防御脏值进入透明度。
    expect(seaOpacityIsInRange(Number.NaN)).toBe(false)
    expect(seaOpacityIsInRange(Number.POSITIVE_INFINITY)).toBe(false)
  })

  it('透明度严格小于 1（半透明而非不透明——不透明平面会遮住大陆架，违反 TASK-013 实现约束）', () => {
    expect(SEA_SURFACE_OPACITY).toBeLessThan(1)
    expect(SEA_SURFACE_OPACITY).toBeGreaterThan(0)
  })
})

describe('覆盖范围 = 主图世界包围盒且 = 地形 plane（共面同范围，TASK-013 输出约束）', () => {
  it('海面 plane 米制跨度 = 主图世界包围盒跨度', () => {
    expectAlmostEqual(
      SEA_SURFACE_PLANE_LAYOUT.widthX,
      MAIN_MAP_WORLD_BOUNDS.maxX - MAIN_MAP_WORLD_BOUNDS.minX,
      TOLERANCE,
      'widthX = maxX − minX',
    )
    expectAlmostEqual(
      SEA_SURFACE_PLANE_LAYOUT.heightZ,
      MAIN_MAP_WORLD_BOUNDS.maxZ - MAIN_MAP_WORLD_BOUNDS.minZ,
      TOLERANCE,
      'heightZ = maxZ − minZ',
    )
    expectAlmostEqual(
      SEA_SURFACE_PLANE_LAYOUT.centerZ,
      (MAIN_MAP_WORLD_BOUNDS.minZ + MAIN_MAP_WORLD_BOUNDS.maxZ) / 2,
      TOLERANCE,
      'centerZ = (minZ + maxZ) / 2',
    )
  })

  it('海面 plane 布局逐字段 = 地形 plane 布局（海陆共面同范围，无第二套范围常量）', () => {
    // 海面必须覆盖目标海域且与地形 plane 共面同范围——逐米对齐，否则海陆会错位。
    expect(SEA_SURFACE_PLANE_LAYOUT.widthX).toBe(TERRAIN_PLANE_LAYOUT.worldWidthX)
    expect(SEA_SURFACE_PLANE_LAYOUT.heightZ).toBe(TERRAIN_PLANE_LAYOUT.worldHeightZ)
    expect(SEA_SURFACE_PLANE_LAYOUT.centerZ).toBe(TERRAIN_PLANE_LAYOUT.centerZ)
  })

  it('海面 plane 覆盖完整包围盒（widthX/heightZ 为正、有限，足以覆盖海域）', () => {
    expect(Number.isFinite(SEA_SURFACE_PLANE_LAYOUT.widthX)).toBe(true)
    expect(Number.isFinite(SEA_SURFACE_PLANE_LAYOUT.heightZ)).toBe(true)
    expect(SEA_SURFACE_PLANE_LAYOUT.widthX).toBeGreaterThan(0)
    expect(SEA_SURFACE_PLANE_LAYOUT.heightZ).toBeGreaterThan(0)
  })
})

describe('动画输入契约：统一时钟 uTime（TASK-013 验证方式 1 / 实现约束「不建独立漂移时钟」）', () => {
  it('片元着色器只声明一个 uniform float uTime（唯一时间输入）', () => {
    const declarations = SEA_SURFACE_FRAGMENT_SHADER.match(/uniform\s+float\s+uTime\s*;/g) ?? []
    expect(declarations.length, '片元着色器必须恰好声明一个 uniform float uTime').toBe(1)
  })

  it('顶点着色器不声明 uTime（时间只用于片元波动，不驱动顶点位移）', () => {
    const declarations = SEA_SURFACE_VERTEX_SHADER.match(/uniform\s+float\s+uTime\s*;/g) ?? []
    expect(declarations.length).toBe(0)
  })

  it('两层 sin 波动均消费同一个 uTime（speed 只控制相对快慢，不引入第二时钟）', () => {
    // 两条 sin 调用都应包含 uTime·speed 形式（uTime 乘以某 speed uniform）。
    const sinCalls = SEA_SURFACE_FRAGMENT_SHADER.match(/sin\s*\([^)]*\)/g) ?? []
    expect(sinCalls.length, '应有双层 sin 流动').toBeGreaterThanOrEqual(2)
    for (const call of sinCalls) {
      expect(call, `每层 sin 都应消费 uTime：${call}`).toContain('uTime')
    }
    // speed 仅作为 uTime 的系数出现（uLayer1Speed / uLayer2Speed），不存在独立时间累加器。
    expect(SEA_SURFACE_FRAGMENT_SHADER).toContain('uTime * uLayer1Speed')
    expect(SEA_SURFACE_FRAGMENT_SHADER).toContain('uTime * uLayer2Speed')
  })

  it('双层波动参数全部有限（频率 / 流速 / 幅度 / 相位无 NaN/Infinity）', () => {
    const { layer1, layer2 } = SEA_SURFACE_CONFIG.waves
    for (const layer of [layer1, layer2]) {
      for (const value of [layer.frequencyU, layer.frequencyV, layer.speed, layer.amplitude, layer.phase]) {
        expect(Number.isFinite(value), `波动参数必须有限，实际为 ${value}`).toBe(true)
      }
    }
  })

  it('双层波动幅度均 < 0.1（细微、不喧宾夺主，TASK-013 实现约束）', () => {
    const { layer1, layer2 } = SEA_SURFACE_CONFIG.waves
    expect(Math.abs(layer1.amplitude)).toBeLessThan(0.1)
    expect(Math.abs(layer2.amplitude)).toBeLessThan(0.1)
    // 叠加峰值也保持细微（< 0.2）。
    expect(Math.abs(layer1.amplitude) + Math.abs(layer2.amplitude)).toBeLessThan(0.2)
  })

  it('片元输出 alpha = uOpacity（透明度由配置 uniform 决定，参与半透明混合）', () => {
    // 片元最终输出形如 vec4(color, uOpacity)——透明度直接作为 alpha。
    expect(SEA_SURFACE_FRAGMENT_SHADER).toMatch(/vec4\s*\(\s*color\s*,\s*uOpacity\s*\)/)
  })
})

describe('无运行时纹理下载 / 无独立时钟（TASK-013 实现约束）', () => {
  it('片元着色器不含 sampler2D（不采样法线 / 高程 / 噪声纹理，零运行时下载）', () => {
    expect(SEA_SURFACE_FRAGMENT_SHADER, '海面波动由纯算法双层正弦产生，不读任何纹理').not.toContain('sampler2D')
    expect(SEA_SURFACE_VERTEX_SHADER).not.toContain('sampler2D')
    // 不调用纹理采样函数（无 texture2D / texture()）。
    expect(SEA_SURFACE_FRAGMENT_SHADER).not.toMatch(/texture2D|texture\s*\(/)
  })

  it('配置不含 URL / 文件路径串（无外网纹理资源依赖）', () => {
    // 收集配置中所有字符串字段，断言没有以 http / 协议头 / 资源扩展名开头的值——海面层零外部资源。
    const stringValues: readonly string[] = [SEA_SURFACE_CONFIG.colorHex]
    for (const s of stringValues) {
      expect(s).toMatch(/^#[0-9a-fA-F]{6}$/, `海面颜色字段必须是 #rrggbb 纯色，实际为 ${s}`)
    }
    // 不存在纹理 / 法线贴图 / 外网字段。
    expect(SEA_SURFACE_CONFIG).not.toHaveProperty('normalMapUrl')
    expect(SEA_SURFACE_CONFIG).not.toHaveProperty('textureUrl')
    expect(SEA_SURFACE_CONFIG).not.toHaveProperty('noiseTexture')
  })

  it('顶点着色器不位移（plane 经模型矩阵后世界 y 恒为 0，海面落在地形海平面）', () => {
    // 顶点着色器不修改 position 的 z / y 分量（无 += 位移），原样经 modelMatrix 变换。
    expect(SEA_SURFACE_VERTEX_SHADER).not.toContain('displaced')
    expect(SEA_SURFACE_VERTEX_SHADER).not.toMatch(/\+\s*=/)
  })
})

describe('不参与陆地色阶 / 不改写高程（TASK-013 验证方式 2 / 实现约束）', () => {
  it('海面配置不含高程 / 色阶字段（不携带 domain / ramp / breakpoints / minH / maxH）', () => {
    // 海面层不承担地表分层设色——色阶事实源唯一（src/config/elevation-color-ramp），海面不复制。
    expect(SEA_SURFACE_CONFIG).not.toHaveProperty('domain')
    expect(SEA_SURFACE_CONFIG).not.toHaveProperty('ramp')
    expect(SEA_SURFACE_CONFIG).not.toHaveProperty('rampRgbData')
    expect(SEA_SURFACE_CONFIG).not.toHaveProperty('breakpoints')
    expect(SEA_SURFACE_CONFIG).not.toHaveProperty('minValueMeters')
    expect(SEA_SURFACE_CONFIG).not.toHaveProperty('maxValueMeters')
    expect(SEA_SURFACE_CONFIG).not.toHaveProperty('elevationEncoding')
  })

  it('片元着色器不读 heightmap / 不查色阶（海面颜色恒为基线色 ×扰动）', () => {
    // 海面片元不采样高程纹理、不采样色阶 ramp——大陆架透视梯度来自水下地形透过半透明海面。
    expect(SEA_SURFACE_FRAGMENT_SHADER).not.toContain('uHeightmap')
    expect(SEA_SURFACE_FRAGMENT_SHADER).not.toContain('uElevationRamp')
    expect(SEA_SURFACE_FRAGMENT_SHADER).not.toContain('elevationMeters')
  })

  it('海面半透明不钳制负高程：水下地形保留负高程（负高程由地形层 / 高程查询层保留，非海面职责）', () => {
    // 形式证明：海面层不接触高程数据，不可能钳制负高程。水下负高程的保留由地形资产（clamp-to-range
    // 保留区间内负值）与高程查询层（below-sea-level 合法负高程）保证——海面层不读这些，无从钳制。
    // 此处断言海面着色器无任何 clamp / max(0) 对高程的操作（无高程输入可钳制）。
    expect(SEA_SURFACE_FRAGMENT_SHADER).not.toMatch(/max\s*\(\s*0/)
  })
})

describe('海面深蓝青基线色（SPEC §3.5）', () => {
  it('基线色蓝通道占优（b >= g >= r，呈蓝青色相）', () => {
    const { r, g, b } = SEA_SURFACE_CONFIG.colorRgb
    expect(b).toBeGreaterThanOrEqual(g, '蓝通道 >= 绿通道（蓝青色相）')
    expect(g).toBeGreaterThanOrEqual(r, '绿通道 >= 红通道（蓝青色相，非纯蓝）')
  })

  it('基线色明度低于陆地层设色近岸色、高于深海近黑（读作「水」而非陆地或虚空）', () => {
    const { r, g, b } = SEA_SURFACE_CONFIG.colorRgb
    // 深海近黑 #06121c (6,18,28)：海面色应整体亮于深海近黑（在海面上可见为水而非黑）。
    expect(r + g + b).toBeGreaterThan(6 + 18 + 28)
    // 陆地平原近岸 #1f4d3a (31,77,58)：海面色应整体暗于平原近岸（读作水而非陆地）。
    expect(r + g + b).toBeLessThan(31 + 77 + 58)
  })

  it('基线色十六进制与字节 RGB 自洽（parseHex 一致）', () => {
    const { r, g, b } = SEA_SURFACE_CONFIG.colorRgb
    const hex = SEA_SURFACE_CONFIG.colorHex
    expect(r).toBe(Number.parseInt(hex.slice(1, 3), 16))
    expect(g).toBe(Number.parseInt(hex.slice(3, 5), 16))
    expect(b).toBe(Number.parseInt(hex.slice(5, 7), 16))
  })
})

describe('配置冻结（运行时不可被偷偷放宽）', () => {
  it('SEA_SURFACE_CONFIG 及其子对象全部冻结', () => {
    expect(Object.isFrozen(SEA_SURFACE_CONFIG)).toBe(true)
    expect(Object.isFrozen(SEA_SURFACE_CONFIG.colorRgb)).toBe(true)
    expect(Object.isFrozen(SEA_SURFACE_CONFIG.planeLayout)).toBe(true)
    expect(Object.isFrozen(SEA_SURFACE_CONFIG.waves)).toBe(true)
    expect(Object.isFrozen(SEA_SURFACE_CONFIG.waves.layer1)).toBe(true)
    expect(Object.isFrozen(SEA_SURFACE_CONFIG.waves.layer2)).toBe(true)
    expect(Object.isFrozen(SEA_SURFACE_PLANE_LAYOUT)).toBe(true)
  })

  it('透明度上下限常量稳定（SPEC 边界 0.55 / 0.70，防止被偷偷放宽遮住大陆架）', () => {
    // 透明度上下限是模块级 const，运行时不可重新赋值；显式断言其等于 SPEC 边界。
    expect(SEA_SURFACE_OPACITY_MIN).toBe(0.55)
    expect(SEA_SURFACE_OPACITY_MAX).toBe(0.7)
  })
})

describe('海面分段（波动在片元，1 段即可）', () => {
  it('海面 plane 分段为正整数（波动由片元着色器承担，顶点预算极低）', () => {
    expect(Number.isInteger(SEA_SURFACE_CONFIG.segments)).toBe(true)
    expect(SEA_SURFACE_CONFIG.segments).toBeGreaterThan(0)
  })
})
