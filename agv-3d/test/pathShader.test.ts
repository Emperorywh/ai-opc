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

/**
 * 流向公式方向语义验证（SPEC §7.6、§16.2，TASK-010 关键异常路径"反向流动正确"）。
 *
 * GLSL 无法在 Node 执行，这里以与片元着色器逐字等价的纯 JS 计算复现脉冲场，
 * 断言脉冲峰值随 offset 增大的推进方向，把"source→target"从人工观察降级为自动化断言：
 * - 规范/单向车道（flowDirection=+1）：源在低弧长、目标在高弧长，峰值向高弧长推进。
 * - 反向车道（flowDirection=−1）：共享规范中心线，源在高弧长、目标在低弧长，
 *   峰值向低弧长推进。两车道方向相反，二者均表达各自 source→target。
 *
 * 公式镜像（与 pathShader PATH_FRAGMENT_SHADER 完全一致）：
 *   flowCoord = pathU − offset × flowDirection
 *   pattern   = fract(flowCoord / repeat)   // GLSL fract 恒落在 [0,1)，负输入亦然
 *   wave      = 0.5 + 0.5·cos(pattern·2π)
 *   pulse     = pow(wave, 6)
 */
const FLOW_PI = Math.PI * 2
const FLOW_REPEAT = FLOW.flowRepeatM

/** 等价于 GLSL fract：x − floor(x)，结果恒落在 [0,1)（负输入经 floor 回正）。 */
function fract(x: number): number {
  return x - Math.floor(x)
}

/** 复现片元着色器的脉冲强度（pathShader）。 */
function shaderPulse(pathU: number, offset: number, flowDirection: number): number {
  const flowCoord = pathU - offset * flowDirection
  const pattern = fract(flowCoord / FLOW_REPEAT)
  const wave = 0.5 + 0.5 * Math.cos(pattern * FLOW_PI)
  return wave ** 6
}

/**
 * 在 centerU 的 ±windowM 邻域内细粒度搜索脉冲峰值位置（pathU）。
 *
 * 用邻域而非整周期搜索，是为了跨 offset 跟踪"同一个"峰值，避免周期缠绕把反向推进
 * 误判为正向（反向峰值在整周期 [0,repeat) 内会从 0 缠绕到 repeat−δ，数值反而增大）。
 * offset 步长远小于 windowM，峰值始终留在邻域内，跟踪稳定。
 */
function trackedPeak(centerU: number, offset: number, flowDirection: number, windowM: number): number {
  const samples = 2001
  let bestU = centerU
  let bestV = -1
  for (let i = 0; i <= samples; i += 1) {
    const u = centerU - windowM + (2 * windowM) * (i / samples)
    const v = shaderPulse(u, offset, flowDirection)
    if (v > bestV) {
      bestV = v
      bestU = u
    }
  }
  return bestU
}

describe('流向公式 — source→target 脉冲推进（§7.6、§16.2）', () => {
  // 跟踪初始位于 pathU=FLOW_REPEAT 的峰值，邻域半宽 0.5 m；offset 步长 0.2 m 远小于邻域。
  const CENTER = FLOW_REPEAT
  const WINDOW = 0.5
  const STEP = 0.2

  it('规范/单向车道（+1）：峰值随 offset 增大向高弧长推进（源→目标）', () => {
    const at0 = trackedPeak(CENTER, 0, 1, WINDOW)
    const at1 = trackedPeak(CENTER, STEP, 1, WINDOW)
    // 峰值从 CENTER 移到 CENTER+STEP（向 target / 高弧长）；幅度约等于 offset 步长，
    // 容差吸收邻域网格采样量化（2001 点 / 1.0 m 邻域 ≈ 0.0005 m 分辨率）。
    expect(at1).toBeGreaterThan(at0)
    expect(at1 - at0).toBeCloseTo(STEP, 1)
  })

  it('反向车道（-1）：峰值随 offset 增大向低弧长推进（反向源→目标）', () => {
    const at0 = trackedPeak(CENTER, 0, -1, WINDOW)
    const at1 = trackedPeak(CENTER, STEP, -1, WINDOW)
    // 峰值从 CENTER 移到 CENTER−STEP（向反向 target / 低弧长），方向与 +1 相反。
    expect(at1).toBeLessThan(at0)
    expect(at0 - at1).toBeCloseTo(STEP, 1)
  })

  it('+1 与 −1 同 offset 下峰值推进方向相反（双向组流向对立，§7.6）', () => {
    const deltaPlus = trackedPeak(CENTER, STEP, 1, WINDOW) - trackedPeak(CENTER, 0, 1, WINDOW)
    const deltaMinus = trackedPeak(CENTER, STEP, -1, WINDOW) - trackedPeak(CENTER, 0, -1, WINDOW)
    expect(deltaPlus).toBeGreaterThan(0)
    expect(deltaMinus).toBeLessThan(0)
  })

  it('fract 对负 flowCoord 恒落 [0,1)：规范车道源点（pathU=0、offset>0）脉冲有限', () => {
    // 规范车道源点 flowCoord = 0 − offset < 0；验证 GLSL fract 负输入分支不产生越界脉冲。
    for (let i = 1; i <= 20; i += 1) {
      const v = shaderPulse(0, i * 0.05, 1)
      expect(v).toBeGreaterThanOrEqual(0)
      expect(v).toBeLessThanOrEqual(1)
    }
  })
})

describe('createPathMaterial — 释放生命周期（SPEC §5.4，TASK-010）', () => {
  it('dispose 触发 dispose 事件，使释放路径可被自动化验证', () => {
    const mat = createPathMaterial(COLOR, FLOW)
    let disposed = false
    mat.addEventListener('dispose', () => {
      disposed = true
    })
    // PathLayer 的卸载 effect 调用 material.dispose()；此处验证该调用确实释放资源。
    mat.dispose()
    expect(disposed).toBe(true)
  })

  it('dispose 幂等：重复调用不抛错', () => {
    const mat = createPathMaterial(COLOR, FLOW)
    expect(() => {
      mat.dispose()
      mat.dispose()
    }).not.toThrow()
  })
})
