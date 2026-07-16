import { describe, expect, it } from 'vitest'
import { Color, ShaderMaterial } from 'three'
import { ENVIRONMENT_THEME } from '../src/features/agv-map/config/visualTheme'
import { GRID_COARSE_MULTIPLIER, GRID_FINE_CELL_M } from '../src/features/agv-map/config/environmentConfig'
import { hslToCss } from '../src/features/agv-map/presentation/scene/colorConvert'
import {
  createGridMaterial,
  GRID_SHADER_SOURCE,
  GRID_UNIFORMS,
} from '../src/features/agv-map/presentation/scene/gridShader'

/**
 * 网格着色器与材质单元测试（SPEC §8.4 独立网格图层，TASK-012）。
 *
 * 不做 WebGL 编译验证（需浏览器），只断言：
 * - 材质为单一 ShaderMaterial、半透明且不写深度、不参与雾（径向衰减已处理边缘）。
 * - uniform 结构完整，径向衰减（uFadeInner/uFadeOuter）与中心（uCenter）接线存在。
 * - 着色器源码以世界 XZ 到中心的距离衰减透明度（不依赖相机，§8.4）。
 * - 颜色 uniform 为线性空间 THREE.Color，初值与主题一致。
 * - dispose 生命周期可观测（SPEC §5.4）。
 */

const THEME = ENVIRONMENT_THEME.grid
const COARSE = GRID_FINE_CELL_M * GRID_COARSE_MULTIPLIER

describe('createGridMaterial — 材质结构（§8.4、§11.1）', () => {
  it('返回 ShaderMaterial 实例', () => {
    expect(createGridMaterial(THEME, GRID_FINE_CELL_M, COARSE)).toBeInstanceOf(ShaderMaterial)
  })

  it('半透明且不写深度（地面之上的半透明叠加，不遮挡扁带）', () => {
    const mat = createGridMaterial(THEME, GRID_FINE_CELL_M, COARSE)
    expect(mat.transparent).toBe(true)
    expect(mat.depthWrite).toBe(false)
  })

  it('不参与场景雾（径向衰减已处理边缘，SPEC §8.4 仅要求路径与节点参与雾）', () => {
    expect(createGridMaterial(THEME, GRID_FINE_CELL_M, COARSE).fog).toBe(false)
  })

  it('色调映射默认启用（与 §8.5 ACES 一致）', () => {
    expect(createGridMaterial(THEME, GRID_FINE_CELL_M, COARSE).toneMapped).toBe(true)
  })
})

describe('createGridMaterial — uniform 结构（§8.4）', () => {
  const mat = createGridMaterial(THEME, GRID_FINE_CELL_M, COARSE)

  it('包含中心、单元、颜色、透明度与衰减 uniform', () => {
    for (const name of Object.values(GRID_UNIFORMS)) {
      expect(mat.uniforms[name], `uniform ${name}`).toBeDefined()
    }
  })

  it('细/粗单元尺寸初值与传入一致', () => {
    expect(mat.uniforms[GRID_UNIFORMS.cellSize].value).toBe(GRID_FINE_CELL_M)
    expect(mat.uniforms[GRID_UNIFORMS.coarseCellSize].value).toBe(COARSE)
  })

  it('基础透明度与主题一致', () => {
    expect(mat.uniforms[GRID_UNIFORMS.baseOpacity].value).toBe(THEME.baseOpacity)
  })

  it('中心与衰减半径初值为 0（由 EnvironmentLayer 在挂载时按 renderBounds 写入）', () => {
    expect(mat.uniforms[GRID_UNIFORMS.fadeInner].value).toBe(0)
    expect(mat.uniforms[GRID_UNIFORMS.fadeOuter].value).toBe(0)
  })

  it('细/粗色为 THREE.Color 实例（线性空间）', () => {
    expect(mat.uniforms[GRID_UNIFORMS.sectionColor].value).toBeInstanceOf(Color)
    expect(mat.uniforms[GRID_UNIFORMS.centerColor].value).toBeInstanceOf(Color)
  })
})

describe('createGridMaterial — 颜色线性空间转换（§8.5）', () => {
  it('细/粗色按 sRGB HSL 解析后转换到线性', () => {
    const mat = createGridMaterial(THEME, GRID_FINE_CELL_M, COARSE)
    const sectionExpected = new Color().setStyle(hslToCss(THEME.sectionColor))
    const centerExpected = new Color().setStyle(hslToCss(THEME.centerColor))
    const section = mat.uniforms[GRID_UNIFORMS.sectionColor].value as Color
    const center = mat.uniforms[GRID_UNIFORMS.centerColor].value as Color
    for (const key of ['r', 'g', 'b'] as const) {
      expect(section[key]).toBeCloseTo(sectionExpected[key], 6)
      expect(center[key]).toBeCloseTo(centerExpected[key], 6)
    }
  })
})

describe('GRID_SHADER_SOURCE — 着色器接线（§8.4）', () => {
  const { vertex, fragment } = GRID_SHADER_SOURCE

  it('顶点着色器透传世界 XZ 坐标（vWorldXZ）', () => {
    expect(vertex).toContain('varying vec2 vWorldXZ;')
    expect(vertex).toContain('modelMatrix')
  })

  it('片元着色器声明全部网格 uniform', () => {
    expect(fragment).toContain('uniform vec2 uCenter;')
    expect(fragment).toContain('uniform float uFadeInner;')
    expect(fragment).toContain('uniform float uFadeOuter;')
  })

  it('片元着色器以世界 XZ 到中心的距离做径向衰减（不依赖相机，§8.4）', () => {
    // 关键：衰减自变量为 distance(vWorldXZ, uCenter)（世界坐标），而非相机相关量。
    expect(fragment).toContain('distance(vWorldXZ, uCenter)')
    expect(fragment).toContain('smoothstep(uFadeInner, uFadeOuter, dist)')
    // 不应出现相机位置 / 视空间深度驱动的衰减。
    expect(fragment).not.toMatch(/cameraPosition|vViewPosition/)
  })

  it('片元着色器接入色调映射与输出色彩空间（§8.5）', () => {
    const tail = fragment
    const tm = tail.indexOf('tonemapping_fragment')
    const cs = tail.indexOf('colorspace_fragment')
    expect(tm).toBeGreaterThan(-1)
    expect(cs).toBeGreaterThan(tm)
  })
})

describe('createGridMaterial — 释放生命周期（SPEC §5.4，TASK-012）', () => {
  it('dispose 触发 dispose 事件，使释放路径可被自动化验证', () => {
    const mat = createGridMaterial(THEME, GRID_FINE_CELL_M, COARSE)
    let disposed = false
    mat.addEventListener('dispose', () => {
      disposed = true
    })
    mat.dispose()
    expect(disposed).toBe(true)
  })

  it('dispose 幂等：重复调用不抛错', () => {
    const mat = createGridMaterial(THEME, GRID_FINE_CELL_M, COARSE)
    expect(() => {
      mat.dispose()
      mat.dispose()
    }).not.toThrow()
  })
})
