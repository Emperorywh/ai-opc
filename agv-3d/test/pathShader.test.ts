import { describe, expect, it } from 'vitest'
import { Color, ShaderMaterial } from 'three'
import { PATH_VISUAL_THEME } from '../src/features/agv-map/config/visualTheme'
import {
  createPathMaterial,
  FLOW_OFFSET_UNIFORM,
  PATH_SHADER_SOURCE,
} from '../src/features/agv-map/presentation/scene/pathShader'

/**
 * 路径扁带着色器与材质单元测试（SPEC §7.6、§8.3、§11.1，TASK-010）。
 *
 * 不做 WebGL 编译验证（需浏览器），只断言：
 * - 材质为单一 ShaderMaterial、声明 fog 支持、uniform 结构完整。
 * - 着色器源码引用了正确的自定义 attribute / uniform，并接入色调映射、输出色彩空间与雾块。
 * - 颜色 uniform 为线性空间 THREE.Color，初值与主题一致。
 */
const COLOR = PATH_VISUAL_THEME.color
const FLOW = PATH_VISUAL_THEME.flow

describe('createPathMaterial — 材质结构与单一性（§8.3、§11.1）', () => {
  it('返回 ShaderMaterial 实例', () => {
    expect(createPathMaterial(COLOR, FLOW)).toBeInstanceOf(ShaderMaterial)
  })

  it('声明 fog:true，使 TASK-012 接入场景雾时无需修改本图层', () => {
    expect(createPathMaterial(COLOR, FLOW).fog).toBe(true)
  })

  it('非透明（扁带为不透明上表面）', () => {
    expect(createPathMaterial(COLOR, FLOW).transparent).toBe(false)
  })

  it('色调映射默认启用（与 §8.5 ACES 一致）', () => {
    expect(createPathMaterial(COLOR, FLOW).toneMapped).toBe(true)
  })
})

describe('createPathMaterial — uniform 结构（§7.6 每帧单 uniform）', () => {
  const material = createPathMaterial(COLOR, FLOW)

  it('包含流光与颜色 uniform', () => {
    for (const name of ['uBaseColor', 'uFlowColor', 'uFlowOffsetM', 'uFlowRepeatM', 'uFlowIntensity']) {
      expect(material.uniforms[name], `uniform ${name}`).toBeDefined()
    }
  })

  it('合并了 UniformsLib.fog 的四个雾 uniform（供 refreshFogUniforms 写入）', () => {
    for (const name of ['fogColor', 'fogNear', 'fogFar', 'fogDensity']) {
      expect(material.uniforms[name], `fog uniform ${name}`).toBeDefined()
    }
  })

  it('uFlowOffsetM 初值为 0（未推进时脉冲静止）', () => {
    expect(material.uniforms[FLOW_OFFSET_UNIFORM].value).toBe(0)
  })

  it('uFlowRepeatM 与主题重复距离一致', () => {
    expect(material.uniforms.uFlowRepeatM.value).toBe(FLOW.flowRepeatM)
  })

  it('uFlowIntensity 与主题高亮强度一致', () => {
    expect(material.uniforms.uFlowIntensity.value).toBe(COLOR.flowHighlightIntensity)
  })

  it('uBaseColor / uFlowColor 为 THREE.Color 实例（线性空间）', () => {
    expect(material.uniforms.uBaseColor.value).toBeInstanceOf(Color)
    expect(material.uniforms.uFlowColor.value).toBeInstanceOf(Color)
  })
})

describe('createPathMaterial — 颜色线性空间转换（§8.5）', () => {
  it('基础色按 sRGB HSL 解析后转换到线性，与直接 setStyle 一致', () => {
    const material = createPathMaterial(COLOR, FLOW)
    const expected = new Color().setStyle('hsl(200, 85.000%, 55.000%)')
    const actual = material.uniforms.uBaseColor.value as Color
    expect(actual.r).toBeCloseTo(expected.r, 6)
    expect(actual.g).toBeCloseTo(expected.g, 6)
    expect(actual.b).toBeCloseTo(expected.b, 6)
  })

  it('流光高亮色按 sRGB HSL 解析后转换到线性', () => {
    const material = createPathMaterial(COLOR, FLOW)
    const expected = new Color().setStyle('hsl(185, 100.000%, 75.000%)')
    const actual = material.uniforms.uFlowColor.value as Color
    expect(actual.r).toBeCloseTo(expected.r, 6)
    expect(actual.g).toBeCloseTo(expected.g, 6)
    expect(actual.b).toBeCloseTo(expected.b, 6)
  })

  it('基础色线性亮度低于 Bloom 阈值 1.0（不进入 Bloom）', () => {
    const material = createPathMaterial(COLOR, FLOW)
    const c = material.uniforms.uBaseColor.value as Color
    expect(Math.max(c.r, c.g, c.b)).toBeLessThan(1.0)
  })

  it('流光色×强度峰值高于 Bloom 阈值 1.0（进入 Bloom）', () => {
    const material = createPathMaterial(COLOR, FLOW)
    const c = material.uniforms.uFlowColor.value as Color
    const peak = Math.max(c.r, c.g, c.b) * COLOR.flowHighlightIntensity
    expect(peak).toBeGreaterThan(1.0)
  })
})

describe('PATH_SHADER_SOURCE — 着色器源码接线（§7.5、§7.6、§8.3）', () => {
  const { vertex, fragment } = PATH_SHADER_SOURCE

  it('顶点着色器声明 aPathU / aFlowDirection attribute 与对应 varying', () => {
    expect(vertex).toContain('attribute float aPathU;')
    expect(vertex).toContain('attribute float aFlowDirection;')
    expect(vertex).toContain('varying float vPathU;')
    expect(vertex).toContain('varying float vFlowDirection;')
  })

  it('片元着色器声明全部流光 uniform（颜色 vec3、标量 float）', () => {
    expect(fragment).toContain('uniform vec3 uBaseColor;')
    expect(fragment).toContain('uniform vec3 uFlowColor;')
    expect(fragment).toContain('uniform float uFlowOffsetM;')
    expect(fragment).toContain('uniform float uFlowRepeatM;')
    expect(fragment).toContain('uniform float uFlowIntensity;')
  })

  it('片元着色器以 aFlowDirection 翻转流向（与 isBackEdge 无关，§7.6）', () => {
    // flowCoord = vPathU − uFlowOffsetM × vFlowDirection：流向由顶点 attribute 决定，
    // 不引用任何 isBackEdge 派生量。两个符号必须同时出现在流光坐标计算中。
    expect(fragment).toContain('vPathU')
    expect(fragment).toContain('vFlowDirection')
    expect(fragment).toContain('uFlowOffsetM')
    expect(fragment).toContain('uFlowOffsetM * vFlowDirection')
  })

  it('片元着色器按 meshbasic 同序接入色调映射、输出色彩空间、雾（§8.5、§8.3）', () => {
    const tail = fragment
    const tm = tail.indexOf('tonemapping_fragment')
    const cs = tail.indexOf('colorspace_fragment')
    const fog = tail.indexOf('fog_fragment')
    expect(tm).toBeGreaterThan(-1)
    expect(cs).toBeGreaterThan(tm)
    expect(fog).toBeGreaterThan(cs)
  })

  it('顶点/片元均内联雾着色器块（USE_FOG 保护，无场景雾时为空）', () => {
    expect(vertex).toContain('fog_pars_vertex')
    expect(vertex).toContain('fog_vertex')
    expect(fragment).toContain('fog_pars_fragment')
    expect(fragment).toContain('fog_fragment')
  })
})
