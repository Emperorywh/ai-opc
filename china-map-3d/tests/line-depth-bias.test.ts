/**
 * 省界 NDC 深度偏移注入的纯逻辑测试（TASK-014 验证方式 1、2）。
 *
 * 依赖方向：vitest Node 环境，import src/three/line-depth-bias（纯字符串变换 + 逐步命中校验 +
 * applyLineDepthBias 胶水，运行时**不**依赖 three / React / drei / WebGL——本模块仅 `import type * as THREE`，
 * 运行时擦除）。该模块把「正则替换 + 注入点未命中即抛错」从 ProvinceBorders 渲染组件抽出，使 three-stdlib
 * 升级一旦改动着色器标记，CI 能在 Node 内（无需浏览器 / 视觉验收）捕获注入回归（补上一轮 [low] 反馈
 * 「渲染层无自动化覆盖」），同时锁定上一轮 [medium] 反馈的「逐步独立校验」修复。
 *
 * 覆盖：
 * - 正常注入：真实 three-stdlib LineMaterial 顶点着色器片段（含 `void main() {` 与 `gl_Position = clip;`，
 *   并前置一个 `void trimSegment(...)` 非入口函数以验证锚点正则只命中 main）→ 两处注入都落位、顺序正确、
 *   原标记保留。
 * - 逐步独立校验（[medium] 回归用例）：①命中 uniform、②缺 `gl_Position = clip;` 时，旧的整体校验
 *   （`if (result === before)`）会因①已改变整串而漏判通过、z-fighting 静默复发；新实现必须抛
 *   depth-bias-marker-missed。
 * - ①缺 `void main() {` → uniform-marker-missed；两处都缺 → 仍抛 uniform-marker-missed（①先校验）。
 * - applyLineDepthBias 胶水：uniform 挂载值正确、needsUpdate=true、onBeforeCompile 为函数；onBeforeCompile
 *   调用时桥接同一 uniform 引用（供 hover 更新传播）、注入落位；注入失败经 onBeforeCompile 抛错传播。
 */

import { describe, it, expect } from 'vitest'
import type * as THREE from 'three'
import {
  injectLineDepthBiasIntoVertexShader,
  applyLineDepthBias,
  LineDepthBiasInjectionError,
} from '../src/three/line-depth-bias'

/**
 * 取自 three-stdlib@2.36.1 LineMaterial 顶点着色器的代表性片段。
 *
 * 刻意保留两处稳定注入锚点（`void main() {` 与 `gl_Position = clip;`），并在 main 之前前置一个
 * `void trimSegment(...)` 非入口函数——验证锚点正则 `/void\s+main\s*\(\s*\)\s*\{/` 只命中真正的 main
 * （trimSegment 因函数名不同、带参括号而不被误匹配），与真实着色器结构一致。
 */
const REAL_LINE_MATERIAL_VERTEX_EXCERPT = `
        #include <common>
        uniform float linewidth;
        uniform vec2 resolution;
        attribute vec3 instanceStart;
        attribute vec3 instanceEnd;

        void trimSegment( const in vec4 start, inout vec4 end ) {
            // 真实着色器里位于 main 之前的辅助函数；锚点正则不应命中它。
        }

        void main() {
            vec4 clip = projectionMatrix * modelViewMatrix * vec4( 0.0, 0.0, 0.0, 1.0 );
            clip.xy += offset;
            gl_Position = clip;
        }
    `

/** ①命中 uniform 锚点、但缺 ②`gl_Position = clip;` 锚点的着色器（[medium] 回归用例的核心场景）。 */
const VERTEX_WITHOUT_CLIP_ASSIGNMENT = `
        void main() {
            // 用了别的裁剪空间赋值写法（非 three-stdlib LineMaterial 的 clip 赋值锚点）。
            gl_Position = projectionMatrix * modelViewMatrix * vec4( position, 1.0 );
        }
    `

/** 缺 ①`void main() {` 锚点（但含 ②锚点）的着色器。 */
const VERTEX_WITHOUT_MAIN = `
        // 缺少顶点着色器入口（例如只剩片段着色器片段，无 main）。
        gl_Position = clip;
    `

/** ①② 锚点都缺的着色器（注释刻意不写出锚点字面量，避免锚点正则误命中注释）。 */
const VERTEX_WITHOUT_ANY_MARKER = `
        // 既无顶点入口，也无 clip 赋值（两个注入锚点都不存在）。
        varying vec3 vColor;
    `

describe('injectLineDepthBiasIntoVertexShader：正常注入（两处锚点都在）', () => {
  it('两处注入语句都落位，且原锚点保留', () => {
    const result = injectLineDepthBiasIntoVertexShader(REAL_LINE_MATERIAL_VERTEX_EXCERPT)
    // step① 注入的 uniform 声明落位。
    expect(result).toContain('uniform float uLineDepthBias;')
    // step② 注入的深度偏移语句落位（抗 z-fighting 的实质语句）。
    expect(result).toContain('gl_Position.z -= uLineDepthBias * gl_Position.w;')
    // 原锚点保留（注入是在锚点前/后追加，不替换锚点本身）。
    expect(result).toContain('void main() {')
    expect(result).toContain('gl_Position = clip;')
  })

  it('注入顺序正确：uniform 声明在 main 之前，深度偏移在 clip 赋值之后', () => {
    const result = injectLineDepthBiasIntoVertexShader(REAL_LINE_MATERIAL_VERTEX_EXCERPT)
    const uniformIdx = result.indexOf('uniform float uLineDepthBias;')
    const mainIdx = result.indexOf('void main() {')
    const clipIdx = result.indexOf('gl_Position = clip;')
    const biasIdx = result.indexOf('gl_Position.z -= uLineDepthBias * gl_Position.w;')
    expect(uniformIdx, 'uniform 声明应存在').toBeGreaterThanOrEqual(0)
    expect(mainIdx, 'main 应存在').toBeGreaterThan(uniformIdx)
    expect(clipIdx, 'clip 赋值应存在').toBeGreaterThan(mainIdx)
    expect(biasIdx, '深度偏移应在 clip 赋值之后').toBeGreaterThan(clipIdx)
  })

  it('锚点正则只命中真正的 main，不误伤前置的 trimSegment 函数', () => {
    const result = injectLineDepthBiasIntoVertexShader(REAL_LINE_MATERIAL_VERTEX_EXCERPT)
    // trimSegment 定义应原样保留（不被注入 uniform 声明）。
    expect(result).toContain('void trimSegment( const in vec4 start, inout vec4 end ) {')
    // uniform 声明只应出现一次（仅 main 前一处），不重复注入到 trimSegment 前。
    const uniformOccurrences = result.split('uniform float uLineDepthBias;').length - 1
    expect(uniformOccurrences).toBe(1)
    // 深度偏移语句也只出现一次（仅 clip 赋值后一处）。
    const biasOccurrences = result.split('gl_Position.z -= uLineDepthBias * gl_Position.w;').length - 1
    expect(biasOccurrences).toBe(1)
  })
})

describe('injectLineDepthBiasIntoVertexShader：逐步独立校验（[medium] 回归防护）', () => {
  it('①命中、②未命中 → 抛 depth-bias-marker-missed（旧整体校验会漏判此情形）', () => {
    // 关键回归场景：step① 成功（整串已被 uniform 声明改变），但 step② 缺锚点。
    // 旧实现 `if (result === before)` 只比整体串，①命中即整串已变 → 校验通过 → 深度偏移静默失效、
    // z-fighting 复发。新实现对 step② 独立比较，必须抛 depth-bias-marker-missed。
    try {
      injectLineDepthBiasIntoVertexShader(VERTEX_WITHOUT_CLIP_ASSIGNMENT)
      expect.unreachable('缺 gl_Position = clip; 应抛 depth-bias-marker-missed')
    } catch (e) {
      expect(e).toBeInstanceOf(LineDepthBiasInjectionError)
      expect((e as LineDepthBiasInjectionError).code).toBe('line-depth-bias.depth-bias-marker-missed')
    }
  })

  it('①未命中（无 void main）→ 抛 uniform-marker-missed', () => {
    try {
      injectLineDepthBiasIntoVertexShader(VERTEX_WITHOUT_MAIN)
      expect.unreachable('缺 void main() { 应抛 uniform-marker-missed')
    } catch (e) {
      expect(e).toBeInstanceOf(LineDepthBiasInjectionError)
      expect((e as LineDepthBiasInjectionError).code).toBe('line-depth-bias.uniform-marker-missed')
    }
  })

  it('①② 都未命中 → 仍抛 uniform-marker-missed（step① 先校验）', () => {
    // 两锚点都缺：step① 先检查，故抛 uniform-marker-missed（而非 depth-bias-marker-missed）。
    try {
      injectLineDepthBiasIntoVertexShader(VERTEX_WITHOUT_ANY_MARKER)
      expect.unreachable('两锚点都缺应抛错')
    } catch (e) {
      expect(e).toBeInstanceOf(LineDepthBiasInjectionError)
      expect((e as LineDepthBiasInjectionError).code).toBe('line-depth-bias.uniform-marker-missed')
    }
  })
})

describe('applyLineDepthBias：胶水层（uniform 挂载 / onBeforeCompile 桥接 / needsUpdate）', () => {
  /** onBeforeCompile 回调收到的 shader 参数的最小结构形态（桥接 + 注入只用到 vertexShader 与 uniforms）。 */
  interface StubShader {
    vertexShader: string
    uniforms: Record<string, { readonly value: unknown }>
  }
  /** applyLineDepthBias 操作的 LineMaterial 的最小结构形态（仅用到 uniforms / onBeforeCompile / needsUpdate）。 */
  interface StubMaterial {
    uniforms: Record<string, { readonly value: unknown }>
    onBeforeCompile: null | ((shader: StubShader) => void)
    needsUpdate: boolean
  }
  /** 构造一个可被 applyLineDepthBias 操作的材质 stub（结构形态等价于 THREE.ShaderMaterial 的相关切片）。 */
  function makeMaterialStub(): StubMaterial {
    return {
      uniforms: {},
      onBeforeCompile: null,
      needsUpdate: false,
    }
  }

  it('挂载 uniform 值、置 needsUpdate=true、设置 onBeforeCompile 为函数', () => {
    const stub = makeMaterialStub()
    applyLineDepthBias(stub as unknown as THREE.ShaderMaterial, 1e-5)
    // uniform 挂载了传入的偏移值（结构性抗 z-fighting 的参数源）。
    expect((stub.uniforms.uLineDepthBias as { value: number }).value).toBe(1e-5)
    // 强制重编译，使注入在下一帧（程序重编译触发 onBeforeCompile）生效。
    expect(stub.needsUpdate).toBe(true)
    // onBeforeCompile 已被设置为注入回调。
    expect(typeof stub.onBeforeCompile).toBe('function')
  })

  it('onBeforeCompile 注入两处语句，并把同一 uniform 引用桥接到 shader.uniforms', () => {
    const stub = makeMaterialStub()
    applyLineDepthBias(stub as unknown as THREE.ShaderMaterial, 2e-5)
    // 模拟 three 编译程序时调用 onBeforeCompile：传入待注入的 shader 参数。
    const shader: StubShader = {
      vertexShader: REAL_LINE_MATERIAL_VERTEX_EXCERPT,
      uniforms: {},
    }
    stub.onBeforeCompile!(shader)
    // 两处注入落位到 shader.vertexShader。
    expect(shader.vertexShader).toContain('uniform float uLineDepthBias;')
    expect(shader.vertexShader).toContain('gl_Position.z -= uLineDepthBias * gl_Position.w;')
    // 桥接同一 uniform 引用：shader.uniforms.uLineDepthBias === material.uniforms.uLineDepthBias
    //   —— 使后续 hover（TASK-018）更新 material.uniforms 上的值能传播到编译后的 shader。
    expect(shader.uniforms.uLineDepthBias).toBe(stub.uniforms.uLineDepthBias)
  })

  it('onBeforeCompile 注入失败（②锚点缺失）时抛 depth-bias-marker-missed 并向上传播', () => {
    const stub = makeMaterialStub()
    applyLineDepthBias(stub as unknown as THREE.ShaderMaterial, 1e-5)
    // 模拟 three 编译一个不含 `gl_Position = clip;` 的着色器（three-stdlib 升级改标记的退化情形）：
    // onBeforeCompile 应抛 depth-bias-marker-missed，使该次编译明确失败暴露而非静默使用未偏移着色器。
    const shader: StubShader = { vertexShader: VERTEX_WITHOUT_CLIP_ASSIGNMENT, uniforms: {} }
    expect(() => stub.onBeforeCompile!(shader)).toThrowError(/深度偏移/)
    try {
      stub.onBeforeCompile!(shader)
    } catch (e) {
      expect((e as LineDepthBiasInjectionError).code).toBe('line-depth-bias.depth-bias-marker-missed')
    }
  })

  it('不同偏移值都被正确挂载（hover 调参时复用同一胶水）', () => {
    for (const bias of [1e-7, 1e-5, 1e-3]) {
      const stub = makeMaterialStub()
      applyLineDepthBias(stub as unknown as THREE.ShaderMaterial, bias)
      expect((stub.uniforms.uLineDepthBias as { value: number }).value).toBe(bias)
    }
  })
})
