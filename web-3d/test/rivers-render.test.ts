/**
 * Task 29 · 河流渲染层单测（riverMaterial.ts 纯函数 + 材质契约 + level 属性）。
 *
 * 验证（SPEC §6.4 流动发光河流 shader）：
 *   · riverFlowPulse：沿 u 弧长的流动光带脉冲（峰值 phase=0.5→1 / 谷 0·1→0 / 周期性 / 时不变流动）
 *   · riverEdgeMask：边缘软过渡（中心满 / 边缘零 / edgeSoft 范围 / clamp）
 *   · riverLevelBoost：level 亮度增益（大河更亮 / 比例 / clamp）
 *   · buildRiverLevelAttribute：每顶点 level（对齐顶点数 / 同河一致 / 异河不同）
 *   · createRiverMaterial：uniforms 齐全 + 初值 + pulseStrength 开关 + 透明/polygonOffset 契约 + shader 源码
 *
 * 不渲染真实 WebGL（vitest node 环境）；材质仅断言对象契约（同 highlight.test createHighlightMaterial
 * 模式），真实 GLSL 编译 + 流动观感留 dev Review。RiverData fixture 由 pipeline packRivers → 前端
 * decodeRivers 构造（与 rivers.test 同源，确保 fixture 真实可信）。
 */
import { describe, it, expect } from 'vitest'
import * as THREE from 'three'
import { packRivers } from '../scripts/data-pipeline/lib/rivers-pack.mjs'
import { RIVER_LEVELS } from '../scripts/data-pipeline/lib/rivers-data.mjs'
import { projectRobinson } from '../scripts/data-pipeline/lib/robinson.mjs'
import { decodeRivers as decodeRiversFE } from '../src/data/rivers'
import {
  riverFlowPulse,
  riverEdgeMask,
  riverLevelBoost,
  buildRiverLevelAttribute,
  createRiverMaterial,
  RIVER_MATERIAL_OPTS,
  RIVER_RENDER_ORDER,
  RIVER_FLOW_FREQ,
  RIVER_FLOW_SPEED,
  RIVER_PULSE_STRENGTH,
  RIVER_EDGE_SOFT,
  RIVER_OPACITY,
  RIVER_LEVEL_BOOST,
  RIVER_MAX_LEVEL,
  RIVER_COLOR,
  RIVER_GLOW_COLOR,
  RIVER_POLYGON_OFFSET_FACTOR,
  RIVER_POLYGON_OFFSET_UNITS,
} from '../src/three/rivers/riverMaterial'
import type { ElevationMeta } from '../src/config/projection'

// ---- 合成 RiverData（与 rivers.test 同源：packRivers → 前端 decode）----
const META: ElevationMeta = {
  elevationMin: -5000,
  elevationMax: 6500,
  seaLevelMeters: 0,
  heightExaggeration: 2.5,
}
const TEST_RIVERS = [
  {
    name: '长江',
    level: RIVER_LEVELS.LARGE as const,
    vertices: [
      [91, 33],
      [106, 30],
      [122, 31],
    ] as Array<[number, number]>,
  },
  {
    name: '多瑙河',
    level: RIVER_LEVELS.MEDIUM as const,
    vertices: [
      [8, 48],
      [16, 48],
      [29, 45],
    ] as Array<[number, number]>,
  },
]
const RIVER_DATA = decodeRiversFE(
  packRivers(TEST_RIVERS, projectRobinson, () => 0.7, META, { simplify: 0 }).bytes,
)

// ---------------------------------------------------------------------------
// riverFlowPulse（流动光带脉冲）
// ---------------------------------------------------------------------------

describe('riverFlowPulse（沿 u 弧长的流动光带）', () => {
  it('phase=0.5（u·freq−t·speed 小数=0.5）→ 峰值 1', () => {
    // u=0.05, freq=10, time=0 → phase=0.5 → 峰值
    expect(riverFlowPulse(0.05, 0, 10, 0.6)).toBeCloseTo(1, 10)
  })

  it('phase=0 / 1（周期边界）→ 谷 0', () => {
    expect(riverFlowPulse(0, 0, 10, 0.6)).toBe(0)
    expect(riverFlowPulse(0.1, 0, 10, 0.6)).toBe(0) // u·freq=1 → fract=0
  })

  it('值域 [0,1]（无超界）', () => {
    for (let i = 0; i < 20; i++) {
      const p = riverFlowPulse(i * 0.013, i * 0.07, 10, 0.6)
      expect(p).toBeGreaterThanOrEqual(0)
      expect(p).toBeLessThanOrEqual(1)
    }
  })

  it('周期性：u 增 1/freq → 脉冲不变（光带沿弧长周期重复）', () => {
    const base = riverFlowPulse(0.05, 0.3, RIVER_FLOW_FREQ, RIVER_FLOW_SPEED)
    const shifted = riverFlowPulse(0.05 + 1 / RIVER_FLOW_FREQ, 0.3, RIVER_FLOW_FREQ, RIVER_FLOW_SPEED)
    expect(shifted).toBeCloseTo(base, 10)
  })

  it('时不变流动：脉冲随时间沿 +u 方向移动（u + speed/(freq·Δ), t+Δ → 同相位）', () => {
    // phase = u·f − t·s；保持 phase 不变需 u 增 s/f·Δ。即光带以 speed 世界单位/秒沿河流向移动。
    const base = riverFlowPulse(0.05, 0, RIVER_FLOW_FREQ, RIVER_FLOW_SPEED)
    const moved = riverFlowPulse(
      0.05 + RIVER_FLOW_SPEED / RIVER_FLOW_FREQ,
      1,
      RIVER_FLOW_FREQ,
      RIVER_FLOW_SPEED,
    )
    expect(moved).toBeCloseTo(base, 10)
  })

  it('负相位规整（time 大时 u·freq−t·speed 为负 → fract 等价正数）', () => {
    // t=10, u=0 → phase = -6 → fract(-6) 应 = 0（与 phase=0 同谷）
    expect(riverFlowPulse(0, 10, 10, 0.6)).toBe(0)
    // t=10, u 使 u·f−t·s = -5.5 → fract = 0.5 → 峰值
    // u·10 − 6 = -5.5 → u = 0.05
    expect(riverFlowPulse(0.05, 10, 10, 0.6)).toBeCloseTo(1, 10)
  })
})

// ---------------------------------------------------------------------------
// riverEdgeMask（边缘软过渡）
// ---------------------------------------------------------------------------

describe('riverEdgeMask（边缘软过渡）', () => {
  it('中心 v=0 → 1（满）', () => {
    expect(riverEdgeMask(0, RIVER_EDGE_SOFT)).toBe(1)
  })

  it('边缘 |v|=1 → 0（无硬切）', () => {
    expect(riverEdgeMask(1, RIVER_EDGE_SOFT)).toBe(0)
    expect(riverEdgeMask(-1, RIVER_EDGE_SOFT)).toBe(0)
  })

  it('|v| ≤ 1−edgeSoft → 1（中心平台，无衰减）', () => {
    expect(riverEdgeMask(0.5, 0.45)).toBe(1) // 0.5 ≤ 0.55
    expect(riverEdgeMask(-0.5, 0.45)).toBe(1)
  })

  it('edgeSoft 范围内单调衰减（|v| 0.6 → 1 递减）', () => {
    const a = riverEdgeMask(0.6, 0.45)
    const b = riverEdgeMask(0.8, 0.45)
    const c = riverEdgeMask(0.95, 0.45)
    expect(a).toBeGreaterThan(b)
    expect(b).toBeGreaterThan(c)
    expect(a).toBeLessThanOrEqual(1)
    expect(c).toBeGreaterThan(0)
  })

  it('对称（v 与 -v 相等）', () => {
    expect(riverEdgeMask(0.7, 0.45)).toBeCloseTo(riverEdgeMask(-0.7, 0.45), 10)
  })

  it('clamp：超界 |v|>1 → 0', () => {
    expect(riverEdgeMask(1.5, 0.45)).toBe(0)
    expect(riverEdgeMask(-2, 0.45)).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// riverLevelBoost（level 亮度增益）
// ---------------------------------------------------------------------------

describe('riverLevelBoost（大河更亮）', () => {
  it('level=max → boost（满增益）', () => {
    expect(riverLevelBoost(3, 3, 0.5)).toBeCloseTo(0.5, 10)
  })

  it('level=1 < level=3（小河较暗）', () => {
    expect(riverLevelBoost(1, 3, 0.5)).toBeLessThan(riverLevelBoost(3, 3, 0.5))
    expect(riverLevelBoost(1, 3, 0.5)).toBeCloseTo(0.5 / 3, 10)
  })

  it('level=0 → 0', () => {
    expect(riverLevelBoost(0, 3, 0.5)).toBe(0)
  })

  it('level>max → clamp 到 boost（不超界）', () => {
    expect(riverLevelBoost(99, 3, 0.5)).toBeCloseTo(0.5, 10)
  })

  it('maxLevel<=0 → 0（防除零）', () => {
    expect(riverLevelBoost(3, 0, 0.5)).toBe(0)
    expect(riverLevelBoost(3, -1, 0.5)).toBe(0)
  })

  it('boost=0 → 0（关增益）', () => {
    expect(riverLevelBoost(3, 3, 0)).toBe(0)
  })

  it('boost 负值 → 0（clamp 下界）', () => {
    expect(riverLevelBoost(3, 3, -1)).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// buildRiverLevelAttribute（每顶点 level）
// ---------------------------------------------------------------------------

describe('buildRiverLevelAttribute（每顶点 level）', () => {
  it('长度 = 顶点数（vertices.length / 3，1 float/顶点）', () => {
    const levels = buildRiverLevelAttribute(RIVER_DATA)
    expect(levels.length).toBe(RIVER_DATA.vertices.length / 3)
  })

  it('同一河流所有顶点 level 一致 = r.level', () => {
    const levels = buildRiverLevelAttribute(RIVER_DATA)
    for (const r of RIVER_DATA.rivers) {
      for (let i = 0; i < r.vertexCount; i++) {
        expect(levels[r.vertexOffset + i]).toBe(r.level)
      }
    }
  })

  it('不同河流 level 不同（长江 LARGE=3 / 多瑙河 MEDIUM=2）', () => {
    const levels = buildRiverLevelAttribute(RIVER_DATA)
    const firstLevels = RIVER_DATA.rivers.map((r) => levels[r.vertexOffset])
    expect(firstLevels).toEqual([RIVER_LEVELS.LARGE, RIVER_LEVELS.MEDIUM])
    expect(new Set(firstLevels).size).toBe(RIVER_DATA.rivers.length)
  })

  it('每河首顶点 = r.level（与遍历起点一致）', () => {
    const levels = buildRiverLevelAttribute(RIVER_DATA)
    for (const r of RIVER_DATA.rivers) {
      expect(levels[r.vertexOffset]).toBe(r.level)
    }
  })

  it('level 全为合法值 1/2/3', () => {
    const levels = buildRiverLevelAttribute(RIVER_DATA)
    for (const l of levels) {
      expect([1, 2, 3]).toContain(l)
    }
  })
})

// ---------------------------------------------------------------------------
// createRiverMaterial（uniforms + 透明/polygonOffset 契约 + shader 源码）
// ---------------------------------------------------------------------------

describe('createRiverMaterial（材质契约）', () => {
  it('ShaderMaterial + 透明属性（transparent/depthWrite=false/DoubleSide 读 Terrain 深度）', () => {
    const mat = createRiverMaterial()
    expect(mat).toBeInstanceOf(THREE.ShaderMaterial)
    expect(mat.transparent).toBe(true)
    expect(mat.depthWrite).toBe(false)
    expect(mat.side).toBe(THREE.DoubleSide)
    expect(mat.depthTest).toBe(true) // 默认，读 Terrain 深度
    mat.dispose()
  })

  it('polygonOffset 双保险（SPEC §6.4.4 抗 z-fighting）', () => {
    const mat = createRiverMaterial()
    expect(mat.polygonOffset).toBe(true)
    expect(mat.polygonOffsetFactor).toBe(RIVER_POLYGON_OFFSET_FACTOR)
    expect(mat.polygonOffsetUnits).toBe(RIVER_POLYGON_OFFSET_UNITS)
    expect(RIVER_MATERIAL_OPTS.polygonOffset).toBe(true)
    mat.dispose()
  })

  it('RIVER_MATERIAL_OPTS 完整透明 + polygonOffset 契约', () => {
    expect(RIVER_MATERIAL_OPTS).toMatchObject({
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
      polygonOffset: true,
      polygonOffsetFactor: RIVER_POLYGON_OFFSET_FACTOR,
      polygonOffsetUnits: RIVER_POLYGON_OFFSET_UNITS,
    })
  })

  it('uniforms 齐全（时间/流动/边缘/色/opacity/level）', () => {
    const mat = createRiverMaterial()
    const keys = [
      'uTime',
      'uFlowFreq',
      'uFlowSpeed',
      'uPulseStrength',
      'uEdgeSoft',
      'uColor',
      'uGlowColor',
      'uOpacity',
      'uLevelBoost',
      'uMaxLevel',
    ]
    for (const k of keys) {
      expect(mat.uniforms[k]).toBeTruthy()
    }
    mat.dispose()
  })

  it('uniform 初值正确（uTime=0 / 流动参数 / 色为 Color）', () => {
    const mat = createRiverMaterial()
    expect(mat.uniforms.uTime.value).toBe(0)
    expect(mat.uniforms.uFlowFreq.value).toBe(RIVER_FLOW_FREQ)
    expect(mat.uniforms.uFlowSpeed.value).toBe(RIVER_FLOW_SPEED)
    expect(mat.uniforms.uPulseStrength.value).toBe(RIVER_PULSE_STRENGTH)
    expect(mat.uniforms.uEdgeSoft.value).toBe(RIVER_EDGE_SOFT)
    expect(mat.uniforms.uOpacity.value).toBe(RIVER_OPACITY)
    expect(mat.uniforms.uLevelBoost.value).toBe(RIVER_LEVEL_BOOST)
    expect(mat.uniforms.uMaxLevel.value).toBe(RIVER_MAX_LEVEL)
    expect(mat.uniforms.uColor.value).toBeInstanceOf(THREE.Color)
    expect(mat.uniforms.uGlowColor.value).toBeInstanceOf(THREE.Color)
    // 色值 = palette.river / glow 常量
    expect(mat.uniforms.uColor.value.getHexString()).toBe(new THREE.Color(RIVER_COLOR).getHexString())
    expect(mat.uniforms.uGlowColor.value.getHexString()).toBe(new THREE.Color(RIVER_GLOW_COLOR).getHexString())
    mat.dispose()
  })

  it('pulseStrength 开关：opts 传入 0 → uPulseStrength=0（低档静态带）', () => {
    const mat = createRiverMaterial({ pulseStrength: 0 })
    expect(mat.uniforms.uPulseStrength.value).toBe(0)
    mat.dispose()
  })

  it('pulseStrength 默认 = RIVER_PULSE_STRENGTH（高档满脉冲）', () => {
    const mat = createRiverMaterial()
    expect(mat.uniforms.uPulseStrength.value).toBe(RIVER_PULSE_STRENGTH)
    mat.dispose()
  })

  it('改 uniform value 不重建材质（Rivers useFrame 同步 uTime 用）', () => {
    const mat = createRiverMaterial()
    const before = mat.uniforms.uTime.value
    mat.uniforms.uTime.value = 1.23
    expect(mat.uniforms.uTime.value).toBe(1.23)
    expect(mat.uniforms.uTime.value).not.toBe(before)
    mat.dispose()
  })

  it('vertexShader 声明 attribute float level + varying vUv/vLevel（uv 由 ShaderMaterial 自动注入）', () => {
    const mat = createRiverMaterial()
    expect(mat.vertexShader).toContain('attribute float level')
    expect(mat.vertexShader).toContain('varying vec2 vUv')
    expect(mat.vertexShader).toContain('varying float vLevel')
    expect(mat.vertexShader).toContain('vUv = uv')
    mat.dispose()
  })

  it('fragmentShader 流动脉冲（fract + smoothstep 三角脉冲）+ uTime 驱动', () => {
    const mat = createRiverMaterial()
    expect(mat.fragmentShader).toContain('fract(vUv.x * uFlowFreq - uTime * uFlowSpeed)')
    expect(mat.fragmentShader).toContain('smoothstep(1.0 - uEdgeSoft, 1.0, abs(vUv.y))')
    expect(mat.fragmentShader).toContain('uPulseStrength')
    mat.dispose()
  })

  it('fragmentShader level 亮度 + emissive 近似（mix 基色/亮色 + col 提亮，无 Bloom）', () => {
    const mat = createRiverMaterial()
    expect(mat.fragmentShader).toContain('clamp(vLevel / uMaxLevel')
    expect(mat.fragmentShader).toContain('mix(uColor, uGlowColor, pulse)')
    expect(mat.fragmentShader).toContain('col += col * lvl')
    mat.dispose()
  })

  it('fragmentShader 手动 sRGB gamma（raw ShaderMaterial 不自动 encode）', () => {
    const mat = createRiverMaterial()
    expect(mat.fragmentShader).toContain('pow(col, vec3(1.0 / 2.2))')
    mat.dispose()
  })
})

// ---------------------------------------------------------------------------
// 渲染顺序（SPEC §4.3 透明物体后绘）
// ---------------------------------------------------------------------------

describe('RIVER_RENDER_ORDER（边界层之上发光带可见）', () => {
  it('= 5（Terrain=0/Ocean=1/填充=2/描边=3/争议=4 → 河流=5 → AtmosphereRim=10）', () => {
    expect(RIVER_RENDER_ORDER).toBe(5)
    expect(RIVER_RENDER_ORDER).toBeGreaterThan(4) // 边界最上层（争议=4）之上
    expect(RIVER_RENDER_ORDER).toBeLessThan(10) // AtmosphereRim 最后绘叠加之下
  })
})
