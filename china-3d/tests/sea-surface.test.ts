/**
 * 动态半透明海面测试（TASK-007 验收 1–4，SPEC §3.5）。
 *
 * 依赖方向：测试基线（vitest，Node 环境），import src/config/sea-surface（纯 TS）、
 * src/three/sea-surface-shaders（纯 GLSL 字符串）、src/three/terrain-layout（纯 TS）、
 * src/config/elevation-color-ramp（纯 TS，水下梯度断言）。不启动 WebGL / 浏览器——渲染正确性由
 * 「配置不变量 + shader 源码结构不变量 + 组件装配源码扫描 + 波动数值仿真 + 无头 Chrome 截图（人工 /
 * 脚本）」共同保证。
 *
 * 覆盖：
 * - 验收 1：海平面 y=0（与地形同米制）；透明度基线 0.6 落在 SPEC 区间 [0.55, 0.7]；片元着色器
 *   声明唯一时间 uniform uTime，两层流动 sin 均消费 uTime（时间驱动的法线扰动微波）。
 * - 验收 2：组件 transparent + depthWrite=false（水下地形透过海面可见、海面不遮陆地）；海面着色
 *   不读 heightmap / 不查色阶（无 sampler2D、无高程字段）；水下地形色阶自带近岸浅→远海深明→暗
 *   梯度（elevation-color-ramp 分段线性：-1500 近黑 → 0⁻ 偏亮）。
 * - 验收 3：组件动画时钟走 R3F useFrame 的共享 clock（state.clock.getElapsedTime()），全 src 无
 *   new THREE.Clock / new Clock 独立时钟；着色器 uTime 声明恰一次（无第二时间源）。
 * - 验收 4：App 在 Canvas 内挂载 <SeaSurface />；波动数值仿真证明亮度调制随时间流动且细微（< 0.1）。
 */

import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  SEA_LEVEL_Y_METERS,
  SEA_SURFACE_CONFIG,
  SEA_SURFACE_HEX,
  SEA_SURFACE_OPACITY,
  SEA_SURFACE_OPACITY_MAX,
  SEA_SURFACE_OPACITY_MIN,
  SEA_SURFACE_PLANE_LAYOUT,
  SEA_SURFACE_RGB,
  SEA_SURFACE_SEGMENTS,
  SEA_WAVE_LAYER_1,
  SEA_WAVE_LAYER_2,
  seaOpacityIsInRange,
} from '../src/config/sea-surface'
import { SEA_SURFACE_FRAGMENT_SHADER, SEA_SURFACE_VERTEX_SHADER } from '../src/three/sea-surface-shaders'
import { TERRAIN_PLANE_LAYOUT } from '../src/three/terrain-layout'
import { MAIN_MAP_WORLD_BOUNDS } from '../src/lib/projection'
import { sampleElevationColor } from '../src/config/elevation-color-ramp'

const projectRoot = resolve(fileURLToPath(import.meta.url), '..', '..')
const srcRoot = resolve(projectRoot, 'src')

/** 读取 src 下某源码文件的文本（源码结构不变量扫描用）。 */
function readSource(relativePath: string): string {
  return readFileSync(resolve(srcRoot, relativePath), 'utf-8')
}

/**
 * 剥离块注释与行注释后的代码文本。
 *
 * 「无独立时钟」类不变量约束的是**代码行为**，文档注释里允许出现「不 new THREE.Clock()」这类
 * 反面示例文字；剥离注释后再扫描，避免把说明文字误判为违规代码。
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

/** Rec.601 相对亮度（字节 RGB → 标量），供「近岸浅、远海深」明度排序断言。 */
function luminance(color: { readonly r: number; readonly g: number; readonly b: number }): number {
  return 0.299 * color.r + 0.587 * color.g + 0.114 * color.b
}

describe('海面配置不变量（验收 1：y=0 水平面 + opacity 0.55–0.7）', () => {
  it('海平面世界 y = 0（与地形同米制海平面：世界 y = h·k，h=0 → y=0，无视觉偏移）', () => {
    expect(SEA_LEVEL_Y_METERS).toBe(0)
    expect(SEA_SURFACE_CONFIG.levelYMeters).toBe(0)
  })

  it('透明度基线 = 0.6，落在 SPEC §3.5 区间 [0.55, 0.7]（端点锚定 SPEC）', () => {
    expect(SEA_SURFACE_OPACITY_MIN).toBe(0.55)
    expect(SEA_SURFACE_OPACITY_MAX).toBe(0.7)
    expect(SEA_SURFACE_OPACITY).toBe(0.6)
    expect(seaOpacityIsInRange(SEA_SURFACE_OPACITY)).toBe(true)
    expect(SEA_SURFACE_CONFIG.opacity).toBe(SEA_SURFACE_OPACITY)
  })

  it('seaOpacityIsInRange 边界语义：端点含、界外与 NaN 拒', () => {
    expect(seaOpacityIsInRange(0.55)).toBe(true)
    expect(seaOpacityIsInRange(0.7)).toBe(true)
    expect(seaOpacityIsInRange(0.549)).toBe(false)
    expect(seaOpacityIsInRange(0.701)).toBe(false)
    expect(seaOpacityIsInRange(Number.NaN)).toBe(false)
    expect(seaOpacityIsInRange(Number.POSITIVE_INFINITY)).toBe(false)
  })

  it('基线色为深蓝青（蓝 > 绿 > 红），字节 RGB 与十六进制一致', () => {
    expect(SEA_SURFACE_HEX).toBe('#0a3340')
    expect(SEA_SURFACE_RGB).toEqual({ r: 10, g: 51, b: 64 })
    expect(SEA_SURFACE_RGB.b).toBeGreaterThan(SEA_SURFACE_RGB.g)
    expect(SEA_SURFACE_RGB.g).toBeGreaterThan(SEA_SURFACE_RGB.r)
    // 明度高于深海近黑 #06121c（半透明下仍可辨），低于近岸平原 #1f4d3a（读作「水」）。
    expect(luminance(SEA_SURFACE_RGB)).toBeGreaterThan(luminance({ r: 6, g: 18, b: 28 }))
    expect(luminance(SEA_SURFACE_RGB)).toBeLessThan(luminance({ r: 31, g: 77, b: 58 }))
  })

  it('海面 plane 覆盖范围与地形 plane 逐字段相等（同一份主图世界包围盒派生，无第二套范围常量）', () => {
    expect(SEA_SURFACE_PLANE_LAYOUT.worldWidthX).toBe(TERRAIN_PLANE_LAYOUT.worldWidthX)
    expect(SEA_SURFACE_PLANE_LAYOUT.worldHeightZ).toBe(TERRAIN_PLANE_LAYOUT.worldHeightZ)
    expect(SEA_SURFACE_PLANE_LAYOUT.centerZ).toBe(TERRAIN_PLANE_LAYOUT.centerZ)
    expect(SEA_SURFACE_PLANE_LAYOUT.worldWidthX).toBe(
      MAIN_MAP_WORLD_BOUNDS.maxX - MAIN_MAP_WORLD_BOUNDS.minX,
    )
    expect(SEA_SURFACE_PLANE_LAYOUT.worldHeightZ).toBe(
      MAIN_MAP_WORLD_BOUNDS.maxZ - MAIN_MAP_WORLD_BOUNDS.minZ,
    )
  })

  it('plane 分段 = 1（波动在片元，无需顶点位移，顶点预算极低）', () => {
    expect(SEA_SURFACE_SEGMENTS).toBe(1)
    expect(SEA_SURFACE_CONFIG.segments).toBe(1)
  })

  it('双层波动参数有限、流速为正、幅度细微（合计 < 0.1），两层频率 / 相位不同', () => {
    for (const layer of [SEA_WAVE_LAYER_1, SEA_WAVE_LAYER_2]) {
      expect(Number.isFinite(layer.frequencyU)).toBe(true)
      expect(Number.isFinite(layer.frequencyV)).toBe(true)
      expect(Number.isFinite(layer.speed)).toBe(true)
      expect(Number.isFinite(layer.amplitude)).toBe(true)
      expect(Number.isFinite(layer.phase)).toBe(true)
      expect(layer.speed).toBeGreaterThan(0)
      expect(layer.amplitude).toBeGreaterThan(0)
      expect(layer.amplitude).toBeLessThan(0.1)
    }
    expect(SEA_WAVE_LAYER_1.amplitude + SEA_WAVE_LAYER_2.amplitude).toBeLessThan(0.1)
    // 两层频率 / 相位不同：叠加呈非周期涟漪而非驻波。
    expect(SEA_WAVE_LAYER_1.frequencyU).not.toBe(SEA_WAVE_LAYER_2.frequencyU)
    expect(SEA_WAVE_LAYER_1.phase).not.toBe(SEA_WAVE_LAYER_2.phase)
  })

  it('配置整体冻结（防运行时被偷偷改透明度 / 海平面）', () => {
    expect(Object.isFrozen(SEA_SURFACE_CONFIG)).toBe(true)
    expect(Object.isFrozen(SEA_SURFACE_CONFIG.planeLayout)).toBe(true)
    expect(Object.isFrozen(SEA_SURFACE_CONFIG.colorRgb)).toBe(true)
    expect(Object.isFrozen(SEA_SURFACE_CONFIG.waves)).toBe(true)
    expect(Object.isFrozen(SEA_SURFACE_CONFIG.waves.layer1)).toBe(true)
    expect(Object.isFrozen(SEA_SURFACE_CONFIG.waves.layer2)).toBe(true)
  })

  it('海面配置不携带高程 / 色阶字段（海面不参与分层设色、不改写高程或色阶配置）', () => {
    const FORBIDDEN_KEYS = [
      'domain',
      'ramp',
      'rampTexture',
      'breakpoints',
      'minH',
      'maxH',
      'minValueMeters',
      'maxValueMeters',
      'elevation',
      'elevationEncoding',
      'heightmap',
    ]
    for (const key of FORBIDDEN_KEYS) {
      expect(key in SEA_SURFACE_CONFIG, `海面配置不应携带 ${key}`).toBe(false)
    }
  })
})

describe('海面着色器结构不变量（验收 1、2、3）', () => {
  it('顶点着色器无位移（原样经 modelMatrix 变换 → 世界 y 恒为海平面），透传 UV', () => {
    expect(SEA_SURFACE_VERTEX_SHADER).toContain('varying vec2 vUv')
    expect(SEA_SURFACE_VERTEX_SHADER).toContain('vUv = uv')
    expect(SEA_SURFACE_VERTEX_SHADER).toContain('modelMatrix * vec4(position, 1.0)')
    // 无位移：顶点着色器不消费时间、不采样任何纹理（波动全部在片元，SPEC §3.5）。
    expect(SEA_SURFACE_VERTEX_SHADER).not.toContain('uTime')
    expect(SEA_SURFACE_VERTEX_SHADER).not.toContain('sampler2D')
  })

  it('片元着色器声明唯一时间 uniform uTime（恰一次），两层 sin 均消费 uTime（统一时间源）', () => {
    const declarations = SEA_SURFACE_FRAGMENT_SHADER.match(/uniform\s+float\s+uTime\b/g) ?? []
    expect(declarations).toHaveLength(1)
    expect(SEA_SURFACE_FRAGMENT_SHADER).toContain('uTime * uLayer1Speed')
    expect(SEA_SURFACE_FRAGMENT_SHADER).toContain('uTime * uLayer2Speed')
    // 无第二时间源形态（无 uTime2 / uDeltaTime 等）。
    expect(SEA_SURFACE_FRAGMENT_SHADER).not.toMatch(/uTime\d/)
    expect(SEA_SURFACE_FRAGMENT_SHADER).not.toContain('uDeltaTime')
  })

  it('双层流动正弦交叉（第一层 +V、第二层 −V），亮度调制 = uColor ×(1 + 扰动)', () => {
    expect(SEA_SURFACE_FRAGMENT_SHADER).toContain('+ vUv.y * uLayer1FrequencyV')
    expect(SEA_SURFACE_FRAGMENT_SHADER).toContain('- vUv.y * uLayer2FrequencyV')
    expect(SEA_SURFACE_FRAGMENT_SHADER).toContain(
      'wave1 * uLayer1Amplitude + wave2 * uLayer2Amplitude',
    )
    expect(SEA_SURFACE_FRAGMENT_SHADER).toContain('uColor * (1.0 + perturb)')
    const sinCount = SEA_SURFACE_FRAGMENT_SHADER.match(/sin\(/g) ?? []
    expect(sinCount.length).toBeGreaterThanOrEqual(2)
  })

  it('片元不声明任何 sampler2D（无法线贴图 / 噪声纹理 / 高程纹理，零运行时纹理下载）', () => {
    expect(SEA_SURFACE_FRAGMENT_SHADER).not.toContain('sampler2D')
  })

  it('片元不读 heightmap、不查色阶（海面不参与分层设色；深度梯度来自水下地形透见）', () => {
    expect(SEA_SURFACE_FRAGMENT_SHADER).not.toContain('uHeightmap')
    expect(SEA_SURFACE_FRAGMENT_SHADER).not.toContain('uElevationRamp')
    expect(SEA_SURFACE_FRAGMENT_SHADER).not.toContain('Elevation')
    expect(SEA_SURFACE_FRAGMENT_SHADER).not.toContain('ramp')
  })

  it('片元输出 alpha = uOpacity（透明度基线直接成为输出 alpha，半透明混合）', () => {
    expect(SEA_SURFACE_FRAGMENT_SHADER).toContain('gl_FragColor = vec4(color, uOpacity)')
  })
})

describe('SeaSurface 组件装配（验收 1、2、3：透明渲染 / 统一时钟 / 配置唯一源）', () => {
  const source = readSource('three/SeaSurface.tsx')

  it('半透明 + 不写深度：transparent + depthWrite={false}（水下地形透见、海面不遮陆地）', () => {
    expect(source).toContain('transparent')
    expect(source).toContain('depthWrite={false}')
  })

  it('mesh 落在海平面 y = SEA_SURFACE_CONFIG.levelYMeters（不硬编码海平面高度）', () => {
    expect(source).toContain('SEA_SURFACE_CONFIG.levelYMeters')
    expect(source).toContain('rotation-x={-Math.PI / 2}')
  })

  it('plane 米制宽高 / 分段取自配置 planeLayout 与 segments（与地形同范围）', () => {
    expect(source).toContain('planeLayout.worldWidthX')
    expect(source).toContain('planeLayout.worldHeightZ')
    expect(source).toContain('planeLayout.centerZ')
  })

  it('装配本层着色器与配置层 uniforms（不自写 GLSL、不复制颜色 / 透明度常量）', () => {
    expect(source).toContain('SEA_SURFACE_VERTEX_SHADER')
    expect(source).toContain('SEA_SURFACE_FRAGMENT_SHADER')
    expect(source).toContain("from '../config/sea-surface'")
    expect(source).toContain('uOpacity: { value: opacity }')
    expect(source).not.toContain('#0a3340')
    expect(source).not.toContain('0.55')
  })

  it('动画时钟走 R3F useFrame 共享 clock：每帧只把 getElapsedTime() 写进材质 uniforms（无独立时钟）', () => {
    expect(source).toContain('useFrame')
    expect(source).toContain('state.clock.getElapsedTime()')
    // R3F v9 对 <shaderMaterial uniforms={...}> 做稳定目标引用合并（拷贝传入对象），每帧 uTime
    // 必须写进材质自身 uniforms（materialRef），改组件 useMemo 初始对象不会到达 GPU（海面静止）。
    expect(source).toContain('useRef<THREE.ShaderMaterial>(null)')
    expect(source).toContain('ref={materialRef}')
    expect(source).toContain('material.uniforms.uTime.value = state.clock.getElapsedTime()')
    // useFrame 内只做 uTime 写入：不推进其他 uniform、不创建对象（无分配循环、无独立时钟）。
    // 扫描代码本体（剥离注释，文档里的反面示例文字不计）。
    const code = stripComments(source)
    expect(code).not.toContain('new THREE.Clock')
    expect(code).not.toContain('performance.now')
    expect(code).not.toContain('Date.now')
  })

  it('全 src 无独立时钟（代码本体无 new THREE.Clock / new Clock，时钟唯一走 R3F 共享 clock）', () => {
    for (const file of listSrcFiles()) {
      const code = stripComments(readSource(file))
      expect(code.includes('new THREE.Clock'), `${file} 不得创建独立 THREE.Clock`).toBe(false)
      expect(/\bnew Clock\(/.test(code), `${file} 不得创建独立 Clock`).toBe(false)
    }
  })
})

describe('水下地形深度梯度支撑（验收 2：近岸浅、远海深明→暗透过海面可见）', () => {
  it('水下色阶自带明→暗梯度：深海 -1500m 近黑、-750m 过渡、近岸 0⁻ 偏亮（明度严格递增）', () => {
    const deepSea = sampleElevationColor(-1500)
    const midShelf = sampleElevationColor(-750)
    const nearShore = sampleElevationColor(-1)
    // 深海近黑锚点（SPEC §3.1「深海近黑 #06121c」）。
    expect(deepSea).toEqual({ r: 6, g: 18, b: 28 })
    expect(luminance(midShelf)).toBeGreaterThan(luminance(deepSea))
    expect(luminance(nearShore)).toBeGreaterThan(luminance(midShelf))
  })

  it('海面透明度 ≤ 0.7 保证水下梯度可透见（过浓则梯度被海面基线色淹没）', () => {
    expect(SEA_SURFACE_CONFIG.opacity).toBeLessThanOrEqual(SEA_SURFACE_OPACITY_MAX)
    expect(SEA_SURFACE_CONFIG.opacity).toBeLessThan(1)
  })
})

describe('波动数值仿真（验收 1、4：时间驱动流动且细微，不喧宾夺主）', () => {
  /** 片元扰动公式的 CPU 镜像（与 SEA_SURFACE_FRAGMENT_SHADER 同一数学：双层 sin × 幅度）。 */
  function perturbAt(u: number, v: number, t: number): number {
    const wave1 = Math.sin(
      u * SEA_WAVE_LAYER_1.frequencyU +
        v * SEA_WAVE_LAYER_1.frequencyV +
        t * SEA_WAVE_LAYER_1.speed +
        SEA_WAVE_LAYER_1.phase,
    )
    const wave2 = Math.sin(
      u * SEA_WAVE_LAYER_2.frequencyU -
        v * SEA_WAVE_LAYER_2.frequencyV +
        t * SEA_WAVE_LAYER_2.speed +
        SEA_WAVE_LAYER_2.phase,
    )
    return wave1 * SEA_WAVE_LAYER_1.amplitude + wave2 * SEA_WAVE_LAYER_2.amplitude
  }

  it('亮度调制因子 1+扰动 恒在 (0.9, 1.1) 内且永不为负（细微、不翻转颜色）', () => {
    for (let ui = 0; ui <= 8; ui++) {
      for (let vi = 0; vi <= 8; vi++) {
        for (let ti = 0; ti <= 12; ti++) {
          const factor = 1 + perturbAt(ui / 8, vi / 8, ti * 0.5)
          expect(factor).toBeGreaterThan(0.9)
          expect(factor).toBeLessThan(1.1)
        }
      }
    }
  })

  it('扰动随时间真实流动：同一 (u,v) 在不同时刻取值不同（动画非静止）', () => {
    let maxAbsDiff = 0
    for (let ui = 0; ui <= 8; ui++) {
      for (let vi = 0; vi <= 8; vi++) {
        const u = ui / 8
        const v = vi / 8
        maxAbsDiff = Math.max(maxAbsDiff, Math.abs(perturbAt(u, v, 0) - perturbAt(u, v, 3)))
        maxAbsDiff = Math.max(maxAbsDiff, Math.abs(perturbAt(u, v, 3) - perturbAt(u, v, 7)))
      }
    }
    expect(maxAbsDiff).toBeGreaterThan(0.001)
  })
})

describe('App 总装（验收 4：海面挂载进 3D 画布）', () => {
  it('App 在 Canvas 内、地形之后挂载 <SeaSurface />（同一画布，透明通道后绘）', () => {
    const source = readFileSync(resolve(srcRoot, 'App.tsx'), 'utf-8')
    expect(source).toContain("from './three/SeaSurface'")
    const terrainIndex = source.indexOf('<ChinaTerrainMesh')
    const seaIndex = source.indexOf('<SeaSurface />')
    const canvasCloseIndex = source.indexOf('</Canvas>')
    expect(terrainIndex).toBeGreaterThan(-1)
    expect(seaIndex).toBeGreaterThan(terrainIndex)
    expect(canvasCloseIndex).toBeGreaterThan(seaIndex)
  })
})
