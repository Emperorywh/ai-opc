import { describe, it, expect } from 'vitest'
import { detectWebGL, type CanvasFactory } from '../src/ui/webgl'

/** 构造 mock canvas：getContext(type) 按预设表返回（未列出 → null）。 */
function mockCanvas(contexts: Record<string, unknown>): CanvasFactory {
  return () => ({
    getContext: (type: string) => (type in contexts ? contexts[type] : null),
  })
}

describe('detectWebGL', () => {
  it('WebGL2 可用 → webgl2=true / webgl=false / supported=true', () => {
    const r = detectWebGL(mockCanvas({ webgl2: {} }))
    expect(r.webgl2).toBe(true)
    expect(r.webgl).toBe(false)
    expect(r.supported).toBe(true)
  })

  it('仅 WebGL1 可用 → webgl2=false / webgl=true / supported=true', () => {
    const r = detectWebGL(mockCanvas({ webgl: {} }))
    expect(r.webgl2).toBe(false)
    expect(r.webgl).toBe(true)
    expect(r.supported).toBe(true)
  })

  it('都不支持 → supported=false', () => {
    const r = detectWebGL(mockCanvas({}))
    expect(r.webgl2).toBe(false)
    expect(r.webgl).toBe(false)
    expect(r.supported).toBe(false)
  })

  it('getContext 返回 null → 不支持', () => {
    const r = detectWebGL(mockCanvas({ webgl2: null, webgl: null }))
    expect(r.supported).toBe(false)
  })

  it('getContext 抛错 → 视为不可用（不崩溃）', () => {
    const r = detectWebGL(() => ({
      getContext: () => {
        throw new Error('WebGL 被禁用')
      },
    }))
    expect(r.webgl2).toBe(false)
    expect(r.webgl).toBe(false)
    expect(r.supported).toBe(false)
  })

  it('canvas factory 抛错 → unsupported', () => {
    const r = detectWebGL(() => {
      throw new Error('无 document')
    })
    expect(r.webgl2).toBe(false)
    expect(r.webgl).toBe(false)
    expect(r.supported).toBe(false)
  })

  it('WebGL2 可用时不再探测 WebGL1（避免多余 getContext 调用）', () => {
    const calls: string[] = []
    const r = detectWebGL(() => ({
      getContext: (t: string) => {
        calls.push(t)
        return t === 'webgl2' ? {} : null
      },
    }))
    expect(r.webgl2).toBe(true)
    expect(r.supported).toBe(true)
    expect(calls).toEqual(['webgl2'])
  })

  it('默认工厂在无 document 时安全回退 unsupported（不抛错）', () => {
    // Node 单测环境无 document.createElement → 默认工厂应安全返回 unsupported
    const r = detectWebGL()
    expect(r.supported).toBe(false)
  })
})
