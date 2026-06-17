/**
 * WebGL 能力检测（SPEC §13.5 / §10「WebGL 不支持 → 降级静态预览图 + 提示」，Task 17）。
 *
 * 纯函数：尝试创建 test canvas 的 WebGL2 / WebGL1 context；任一成功即「支持」。
 * three 0.184 默认 WebGL2（SPEC §13.5），极老设备 / WebGL 被禁用 / 驱动黑名单时降级提示。
 *
 * 依赖注入 makeCanvas：Node 单测无 document/DOM → 注入 mock canvas factory 验证判定逻辑；
 * 运行时默认用 document.createElement('canvas')（SSR 无 document 时安全回退 unsupported）。
 */

/** 最小 canvas 契约：仅用 getContext。 */
export interface CanvasLike {
  getContext: (type: string) => unknown
}

/** canvas 工厂（可注入便于单测）。 */
export type CanvasFactory = () => CanvasLike

export interface WebGLSupport {
  /** WebGL2 可用（three 0.184 默认）。 */
  webgl2: boolean
  /** WebGL1 可用（WebGL2 不可用时探测）。 */
  webgl: boolean
  /** 任一可用即 true（App 据此决定渲染 Canvas 或降级）。 */
  supported: boolean
}

/** 运行时默认 canvas 工厂：浏览器 document.createElement；无 document（SSR）回退不支持。 */
function defaultCanvasFactory(): CanvasLike {
  if (typeof document === 'undefined' || typeof document.createElement !== 'function') {
    return { getContext: () => null }
  }
  return document.createElement('canvas')
}

/** 尝试获取某 context 类型，成功（非 null）即 true；异常视为不可用。 */
function hasContext(canvas: CanvasLike, type: string): boolean {
  try {
    const ctx = canvas.getContext(type)
    return ctx != null
  } catch {
    return false
  }
}

/**
 * 检测 WebGL 支持。优先 WebGL2，不可用再探测 WebGL1（避免重复创建）。
 * @param makeCanvas 可选 canvas 工厂（单测注入 mock；运行时默认 document.createElement）。
 */
export function detectWebGL(makeCanvas?: CanvasFactory): WebGLSupport {
  let canvas: CanvasLike
  try {
    canvas = (makeCanvas ?? defaultCanvasFactory)()
  } catch {
    return { webgl2: false, webgl: false, supported: false }
  }
  const webgl2 = hasContext(canvas, 'webgl2')
  // WebGL2 已可用则不再探测 WebGL1（three 用 WebGL2）；仅 WebGL2 缺失时回退探测 WebGL1。
  const webgl = !webgl2 && hasContext(canvas, 'webgl')
  return { webgl2, webgl, supported: webgl2 || webgl }
}
