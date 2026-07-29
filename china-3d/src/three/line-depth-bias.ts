/**
 * 省界 NDC 深度偏移的着色器注入逻辑（TASK-009 抗 z-fighting，SPEC §3.6）。
 *
 * 角色与依赖方向：
 * - 本模块是「把 NDC 深度偏移注入 three-stdlib LineMaterial（ShaderMaterial 子类）顶点着色器」的
 *   封装，只依赖 three 的**类型**（`import type`，运行时擦除——本模块不把 three 拉进运行时依赖图，
 *   故可在 Node 环境（vitest，无需 WebGL / React / drei）被自动化覆盖）。它把「字符串变换 + 注入点
 *   命中校验」从 ProvinceBorders 渲染组件里抽出来：组件层（src/three/ProvinceBorders）只负责把偏移
 *   挂到 Line 材质（调用本模块的 applyLineDepthBias），不再内联正则替换。
 *
 * 为什么需要 NDC 深度偏移（大屏地图尺度的 z-fighting 结构性消除）：
 * - 地图尺度下相机远、24 位深度量化粗（默认视距下一桶约数公里），省界与同位置地表的 NDC z 落在
 *   同一深度桶 → z-fighting（闪烁）。领域层的米级 epsilon（PROVINCE_BORDERS_CONFIG.
 *   terrainEpsilonMeters）远不足以跨越一个深度桶，只承担 CPU/GPU 采样浮点对齐的辅助防线。
 * - 本模块在 LineMaterial 顶点着色器内从 gl_Position.z 减去 depthBiasNdc × clip.w（等价于在 NDC
 *   空间把省界片元推近约 80 个深度 ULP）：使其恒胜过同位置地表（消除闪烁），仍被真正更近的山体
 *   （NDC 差远大于偏移）正确遮挡——不会错误穿透前方地形。
 *
 * 为什么每步独立校验（结构性安全网）：
 * - 注入分两步：① 在 `void main() {` 前声明 `uniform float uLineDepthBias;`；② 在
 *   `gl_Position = clip;` 后追加 `gl_Position.z -= uLineDepthBias * gl_Position.w;`。**②才是抗
 *   z-fighting 的实质语句**。若只做「整串是否变化」的整体校验，则 ①命中而②未命中时整串已被①
 *   改变、整体校验通过，但深度偏移静默失效、z-fighting 复发。故对每个 replace 独立比较前后串：
 *   任一步未命中（three-stdlib 升级改了着色器结构）即抛对应 code 的错暴露，绝不静默继续。
 * - 当前 three-stdlib@2.36.1 两处标记均稳定存在（顶点着色器 `void main() {` 与
 *   `gl_Position = clip;`），注入会成功；本安全网的作用是未来 three-stdlib 升级一旦改动标记，
 *   CI（注入逻辑单测）与运行时（抛错）双重暴露，而非静默复发 z-fighting。
 */

import type * as THREE from 'three'

/** step① 的注入锚点：three-stdlib LineMaterial 顶点着色器的入口 main（稳定字符串）。 */
const UNIFORM_DECLARATION_MARKER = /void\s+main\s*\(\s*\)\s*\{/
/** step② 的注入锚点：three-stdlib LineMaterial 顶点着色器末尾的裁剪空间赋值（稳定字符串）。 */
const DEPTH_BIAS_MARKER = /gl_Position\s*=\s*clip\s*;/

/** step① 注入的 uniform 声明语句（置于 main 之前，使 step② 的引用合法）。 */
const INJECTED_UNIFORM_DECLARATION = 'uniform float uLineDepthBias;'
/**
 * step② 注入的深度偏移语句。
 *
 * × gl_Position.w 把 NDC 偏移还原到裁剪空间（裁剪空间 / w = NDC），与投影管线保持一致，故等价于
 * 「在 NDC 空间从 z 减去 depthBiasNdc」。这是结构性消除省界-地表 z-fighting 的实质语句。
 */
const INJECTED_DEPTH_BIAS_STATEMENT = 'gl_Position.z -= uLineDepthBias * gl_Position.w;'

/** 注入失败的稳定错误码（供自动化测试精确断言「哪一步未命中」）。 */
export type LineDepthBiasInjectionErrorCode =
  | 'line-depth-bias.uniform-marker-missed'
  | 'line-depth-bias.depth-bias-marker-missed'

/**
 * 着色器注入失败错误：携带稳定 code 与简体中文说明。
 * 任一注入锚点未命中（three-stdlib 升级改了着色器结构）时抛出，使省界渲染在挂载 / 重编译期明确
 * 失败暴露，而非静默继续（静默继续会让深度偏移失效 → z-fighting 复发）。
 */
export class LineDepthBiasInjectionError extends Error {
  readonly code: LineDepthBiasInjectionErrorCode
  constructor(code: LineDepthBiasInjectionErrorCode, message: string) {
    super(message)
    this.name = 'LineDepthBiasInjectionError'
    this.code = code
  }
}

/**
 * 把 NDC 深度偏移的两处注入应用到给定的顶点着色器源码，返回注入后的源码（纯函数，可在 Node 直接断言）。
 *
 * 逐步独立校验（关键不变量）：
 * - step①：在第一个 `void main() {` 之前声明 `uniform float uLineDepthBias;`（replace 非全局，命中
 *   顶点着色器的入口 main）。若未命中 → 抛 uniform-marker-missed。
 * - step②：在 `gl_Position = clip;` 之后追加深度偏移语句。若未命中 → 抛 depth-bias-marker-missed——
 *   这是关键防御：即便 step① 已命中（整串已变），step② 未命中仍单独抛错，杜绝「①命中、②未命中」
 *   时偏移静默失效（整体校验会漏判此情形）。
 */
export function injectLineDepthBiasIntoVertexShader(vertexShader: string): string {
  // step①：声明 uniform，使 step② 的引用合法。replace 非全局 → 命中第一个 main（顶点入口）。
  const afterUniform = vertexShader.replace(
    UNIFORM_DECLARATION_MARKER,
    `${INJECTED_UNIFORM_DECLARATION}\n$&`,
  )
  // 逐步校验 step①：未命中（整串未变）即抛错，不继续到 step②。
  if (afterUniform === vertexShader) {
    throw new LineDepthBiasInjectionError(
      'line-depth-bias.uniform-marker-missed',
      'ProvinceBorders: 无法在 LineMaterial 顶点着色器注入 uLineDepthBias uniform（未找到 `void main() {`），请核对 three-stdlib 版本。',
    )
  }
  // step②：追加深度偏移（抗 z-fighting 的实质语句）。
  const afterBias = afterUniform.replace(DEPTH_BIAS_MARKER, `$&\n\t${INJECTED_DEPTH_BIAS_STATEMENT}`)
  // 逐步校验 step②：与 step① 的结果独立比较——若未命中（afterBias === afterUniform），偏移静默失效，必须抛错。
  if (afterBias === afterUniform) {
    throw new LineDepthBiasInjectionError(
      'line-depth-bias.depth-bias-marker-missed',
      'ProvinceBorders: 无法在 LineMaterial 顶点着色器注入 NDC 深度偏移（未找到 `gl_Position = clip;`），请核对 three-stdlib 版本。',
    )
  }
  return afterBias
}

/**
 * 把 NDC 深度偏移挂到一个 LineMaterial（ShaderMaterial 子类）：声明 uniform 并在 onBeforeCompile 内
 * 注入两处着色器语句，再 needsUpdate=true 强制重编译使偏移在下一帧生效。
 *
 * - uniform 挂到 material.uniforms（持久，跨重编译保持同一引用）；onBeforeCompile 内把该引用桥接到
 *   shader.uniforms，确保 three 重编译 shader 时偏移值被正确采样。
 * - 注入逻辑委托 injectLineDepthBiasIntoVertexShader（纯函数），故注入点未命中时抛
 *   LineDepthBiasInjectionError 由 onBeforeCompile 传播——three 在编译程序时调用 onBeforeCompile，
 *   注入失败会使该次编译抛错暴露，而非静默使用未偏移的着色器。
 * - 覆盖 material.onBeforeCompile：省界只设单一恒定色（不使用 per-vertex instanceColor），无需
 *   LineMaterial 默认 onBeforeCompile 的 USE_LINE_COLOR_ALPHA define 分支，覆盖语义安全。
 */
export function applyLineDepthBias(material: THREE.ShaderMaterial, depthBiasNdc: number): void {
  // 把偏移值挂到 material.uniforms（持久引用），onBeforeCompile 内把同一引用桥接到 shader.uniforms。
  material.uniforms.uLineDepthBias = { value: depthBiasNdc }
  material.onBeforeCompile = (shader) => {
    // 桥接同一 uniform 引用，使 three 重编译时采样到 material.uniforms 上的值。
    shader.uniforms.uLineDepthBias = material.uniforms.uLineDepthBias
    // 委托纯函数做注入 + 逐步校验；未命中即抛 LineDepthBiasInjectionError。
    shader.vertexShader = injectLineDepthBiasIntoVertexShader(shader.vertexShader)
  }
  // 强制重编译，使注入在下一帧生效（onBeforeCompile 仅在程序（重）编译时触发）。
  material.needsUpdate = true
}
