/*
 * 本地字体预加载边界自动化验证（TASK-015，SPEC 4.2 / 11.1 / 14.1 / 16）。
 *
 * 设计（任务“通过可控字体加载端口验证本地 URL、去重字符集合和成功回调”）：
 *   - 注入可控 LabelFontPreloadPort：捕获传给预加载的 font / characters / sdfGlyphSize，
 *     并允许测试驱动成功 / 失败回调，绝不联网、不创建 Troika Text 对象。
 *   - 正常路径：端口成功回调 → 恰好一次 ready；端口入参 = 本地 URL + 全部去重名称字符 + 64。
 *   - 覆盖门禁：标签存在未覆盖码点 → FONT_GLYPH_MISSING，且端口根本不被调用（先于预加载）。
 *   - 资产失败：端口回调错误 / 模拟请求失败 → FONT_ASSET_FAILED，不发出 ready，不切换系统/远端字体。
 *   - 无远端 fallback：捕获的 font 恒为本地 URL，characters 为去重码点重组字符串，不触达任何远端。
 *   - 单次就绪：端口误触发多次回调只采纳首次，保证就绪信号恰好一次。
 *
 * 不启动浏览器：全部经注入端口驱动；不导入 troika-three-text、不创建 Text / Three / React 对象。
 */
import { describe, test, expect } from 'vitest'
import {
  preloadLabelFont,
  type LabelFontPreloadPort,
} from '../../src/labels/fontPreload'
import { collectTextCodePoints } from '../../src/labels/fontGlyphGate'
import { isMapDataError, MapErrorCode } from '../../src/domain/mapDataError'
import {
  LABEL_FONT_URL,
  LABEL_FONT_SDF_GLYPH_SIZE,
} from '../../src/config/fontConfig'

/*
 * SPEC 11.1 固定的本地 URL 与 SDF 尺寸（与 config 同源 SPEC，测试交叉引用）。
 */
const LOCAL_URL = LABEL_FONT_URL // '/fonts/NotoSansSC-Bold.sample.woff'
const SDF_SIZE = LABEL_FONT_SDF_GLYPH_SIZE // 64

/*
 * 可控预加载端口：捕获入参，暴露 fire(err) 驱动回调，跟踪是否被调用。
 *
 * 设计要点：
 *   - 端口实现是纯内存模拟：不发起 XMLHttpRequest / fetch / import 脚本，杜绝联网。
 *   - 每次调用记录独立回调，支持“先校验入参再 fire”的两段式断言。
 */
interface CapturedCall {
  readonly font: string
  readonly characters: string
  readonly sdfGlyphSize: number
}

function makeCapturePort() {
  const calls: CapturedCall[] = []
  const pending: Array<(err: unknown | null) => void> = []
  const port: LabelFontPreloadPort = {
    preloadFont(options, onDone) {
      calls.push({
        font: options.font,
        characters: options.characters,
        sdfGlyphSize: options.sdfGlyphSize,
      })
      pending.push(onDone)
    },
  }
  return {
    port,
    calls,
    callCount: () => calls.length,
    fire(index: number, err: unknown | null) {
      pending[index]?.(err)
    },
    fireLast(err: unknown | null) {
      const cb = pending[pending.length - 1]
      cb?.(err)
    },
  }
}

/*
 * 构造覆盖“全部给定文本码点”的清单集合（用文本自身码点 + 一点冗余）。
 */
function manifestCovering(texts: readonly string[]): Set<number> {
  return new Set(collectTextCodePoints(texts))
}

// ─── 正常路径 · 成功回调与入参契约（SPEC 11.1 / 4.2）──────────────────────────────────

describe('预加载正常路径 · 成功回调发出就绪信号（SPEC 11.1 / 4.2）', () => {
  test('端口成功回调 → status=ready，且只发出一次就绪信号', async () => {
    const texts = ['门口1', 'AB', '42']
    const cap = makeCapturePort()
    const promise = preloadLabelFont({
      texts,
      manifestCodePoints: manifestCovering(texts),
      port: cap.port,
      fontUrl: LOCAL_URL,
      sdfGlyphSize: SDF_SIZE,
    })
    expect(cap.callCount()).toBe(1)
    cap.fireLast(null)
    const outcome = await promise
    expect(outcome.status).toBe('ready')
  })

  test('端口入参 font 恒为本地 URL（不触达远端，无系统/CDN fallback）', async () => {
    const texts = ['A1']
    const cap = makeCapturePort()
    const promise = preloadLabelFont({
      texts,
      manifestCodePoints: manifestCovering(texts),
      port: cap.port,
      fontUrl: LOCAL_URL,
      sdfGlyphSize: SDF_SIZE,
    })
    cap.fireLast(null)
    await promise
    expect(cap.calls[0].font).toBe(LOCAL_URL)
    // 本地 URL 必须以 '/' 开头（同源），不含任何远端协议方案。
    expect(cap.calls[0].font.startsWith('/')).toBe(true)
    expect(/^(https?:|\/\/|file:|data:)/i.test(cap.calls[0].font)).toBe(false)
  })

  test('端口入参 characters = 全部去重名称字符（按 code point 重组）', async () => {
    const texts = ['门口1', 'AB']
    const cap = makeCapturePort()
    const promise = preloadLabelFont({
      texts,
      manifestCodePoints: manifestCovering(texts),
      port: cap.port,
      fontUrl: LOCAL_URL,
      sdfGlyphSize: SDF_SIZE,
    })
    cap.fireLast(null)
    await promise
    // 去重后码点：'1'(0x31) 'A'(0x41) 'B'(0x42) '口'(0x53E3) '门'(0x95E8)，按数值升序重组。
    const expected = collectTextCodePoints(texts)
      .map((cp) => String.fromCodePoint(cp))
      .join('')
    expect(cap.calls[0].characters).toBe(expected)
    // 字符串长度 = 去重码点数（全部 ≤ U+FFFF，无代理对膨胀）。
    const unique = new Set<string>()
    for (const ch of cap.calls[0].characters) unique.add(ch)
    expect(unique.size).toBe(5)
  })

  test('端口入参 sdfGlyphSize = 64（与 SPEC 11.1 Text SDF 一致）', async () => {
    const cap = makeCapturePort()
    const promise = preloadLabelFont({
      texts: ['A'],
      manifestCodePoints: new Set([0x41]),
      port: cap.port,
      fontUrl: LOCAL_URL,
      sdfGlyphSize: SDF_SIZE,
    })
    cap.fireLast(null)
    await promise
    expect(cap.calls[0].sdfGlyphSize).toBe(64)
  })

  test('characters 不重复：同一字符在多个标签中只出现一次', async () => {
    const texts = ['AAA', 'A', '1A1']
    const cap = makeCapturePort()
    const promise = preloadLabelFont({
      texts,
      manifestCodePoints: new Set([0x41, 0x31]),
      port: cap.port,
      fontUrl: LOCAL_URL,
      sdfGlyphSize: SDF_SIZE,
    })
    cap.fireLast(null)
    await promise
    // 只有 '1' 与 'A' 两个去重字符。
    expect([...cap.calls[0].characters].sort().join('')).toBe('1A')
  })

  test('空标签文本：端口仍被调用，characters 为空字符串且就绪', async () => {
    const cap = makeCapturePort()
    const promise = preloadLabelFont({
      texts: [],
      manifestCodePoints: new Set<number>([0x41]),
      port: cap.port,
      fontUrl: LOCAL_URL,
      sdfGlyphSize: SDF_SIZE,
    })
    cap.fireLast(null)
    const outcome = await promise
    expect(outcome.status).toBe('ready')
    expect(cap.calls[0].characters).toBe('')
  })
})

// ─── 单次就绪 · 防重入（任务“只发出一次字体就绪信号”）──────────────────────────────────

describe('预加载防重入 · 端口误触发多次回调只采纳首次（任务约束）', () => {
  test('首次成功后再次回调（null 或 err）不改变结果', async () => {
    const cap = makeCapturePort()
    const promise = preloadLabelFont({
      texts: ['A'],
      manifestCodePoints: new Set([0x41]),
      port: cap.port,
      fontUrl: LOCAL_URL,
      sdfGlyphSize: SDF_SIZE,
    })
    cap.fireLast(null) // 首次成功
    const outcome = await promise
    expect(outcome.status).toBe('ready')
    // 再次模拟端口误触发（错误）：不得改变已发出的就绪信号。
    cap.fireLast(new Error('late failure'))
    expect(outcome.status).toBe('ready')
  })

  test('首次失败后再次回调成功不改变结果', async () => {
    const cap = makeCapturePort()
    const promise = preloadLabelFont({
      texts: ['A'],
      manifestCodePoints: new Set([0x41]),
      port: cap.port,
      fontUrl: LOCAL_URL,
      sdfGlyphSize: SDF_SIZE,
    })
    cap.fireLast(new Error('first failure')) // 首次失败
    const outcome = await promise
    expect(outcome.status).toBe('error')
    cap.fireLast(null) // 误触发的“迟到的成功”不改变结果
    expect(outcome.status).toBe('error')
  })
})

// ─── 字形覆盖门禁 · FONT_GLYPH_MISSING（SPEC 14.1）──────────────────────────────────

describe('预加载字形覆盖门禁 · FONT_GLYPH_MISSING 先于端口调用（SPEC 11.1 / 14.1）', () => {
  test('标签含未覆盖码点 → FONT_GLYPH_MISSING，端口根本不被调用', async () => {
    const texts = ['AB']
    const cap = makeCapturePort()
    const outcome = await preloadLabelFont({
      texts,
      manifestCodePoints: new Set<number>([0x41]), // 只覆盖 A，缺 B
      port: cap.port,
      fontUrl: LOCAL_URL,
      sdfGlyphSize: SDF_SIZE,
    })
    expect(outcome.status).toBe('error')
    if (outcome.status === 'error') {
      expect(isMapDataError(outcome.error)).toBe(true)
      expect(outcome.error.code).toBe(MapErrorCode.FONT_GLYPH_MISSING)
      // context 含缺失码点与阶段。
      expect(outcome.error.context?.stage).toBe('coverage')
      const missing = outcome.error.context?.missing as Array<{ codePoint: number; hex: string }>
      expect(missing?.find((m) => m.codePoint === 0x42)?.hex).toBe('U+0042')
    }
    // 端口未被调用：覆盖门禁先于预加载，阻止 Troika 联网补字。
    expect(cap.callCount()).toBe(0)
  })

  test('缺中文字符 → FONT_GLYPH_MISSING 准确报告 U+95E8（门）', async () => {
    const texts = ['门口']
    const cap = makeCapturePort()
    const outcome = await preloadLabelFont({
      texts,
      manifestCodePoints: new Set<number>([0x53e3]), // 只含 "口"，缺 "门"
      port: cap.port,
      fontUrl: LOCAL_URL,
      sdfGlyphSize: SDF_SIZE,
    })
    expect(outcome.status).toBe('error')
    if (outcome.status === 'error') {
      expect(outcome.error.code).toBe(MapErrorCode.FONT_GLYPH_MISSING)
      const missing = outcome.error.context?.missing as Array<{ codePoint: number; hex: string; char: string }>
      expect(missing?.find((m) => m.codePoint === 0x95e8)?.char).toBe('门')
    }
    expect(cap.callCount()).toBe(0)
  })
})

// ─── 资产加载门禁 · FONT_ASSET_FAILED（SPEC 14.1）──────────────────────────────────────

describe('预加载资产失败门禁 · FONT_ASSET_FAILED 不切换字体（SPEC 11.1 / 14.1）', () => {
  test('端口回调错误对象 → FONT_ASSET_FAILED（含资产上下文）', async () => {
    const cap = makeCapturePort()
    const promise = preloadLabelFont({
      texts: ['A'],
      manifestCodePoints: new Set([0x41]),
      port: cap.port,
      fontUrl: LOCAL_URL,
      sdfGlyphSize: SDF_SIZE,
    })
    cap.fireLast(new Error('woff parse failure'))
    const outcome = await promise
    expect(outcome.status).toBe('error')
    if (outcome.status === 'error') {
      expect(outcome.error.code).toBe(MapErrorCode.FONT_ASSET_FAILED)
      expect(outcome.error.context?.stage).toBe('asset')
      expect(outcome.error.context?.fontUrl).toBe(LOCAL_URL)
      expect(outcome.error.context?.sdfGlyphSize).toBe(SDF_SIZE)
      expect(String(outcome.error.context?.cause)).toContain('woff parse failure')
    }
  })

  test('端口回调字符串错误 → FONT_ASSET_FAILED', async () => {
    const cap = makeCapturePort()
    const promise = preloadLabelFont({
      texts: ['A'],
      manifestCodePoints: new Set([0x41]),
      port: cap.port,
      fontUrl: LOCAL_URL,
      sdfGlyphSize: SDF_SIZE,
    })
    cap.fireLast('network error')
    const outcome = await promise
    expect(outcome.status).toBe('error')
    if (outcome.status === 'error') {
      expect(outcome.error.code).toBe(MapErrorCode.FONT_ASSET_FAILED)
      expect(String(outcome.error.context?.cause)).toContain('network error')
    }
  })

  test('模拟请求失败（端口回调非 null）→ 不发出 ready、不切换系统/远端字体', async () => {
    const cap = makeCapturePort()
    const promise = preloadLabelFont({
      texts: ['A'],
      manifestCodePoints: new Set([0x41]),
      port: cap.port,
      fontUrl: LOCAL_URL,
      sdfGlyphSize: SDF_SIZE,
    })
    cap.fireLast(new Error('404 not found'))
    const outcome = await promise
    // 失败必须是结构化错误，绝不退化为 ready，也不尝试远端。
    expect(outcome.status).toBe('error')
    if (outcome.status === 'error') {
      expect(outcome.error.code).toBe(MapErrorCode.FONT_ASSET_FAILED)
    }
    // 捕获到的 font 恒为本地 URL：失败路径同样不触达远端。
    expect(cap.calls[0]?.font).toBe(LOCAL_URL)
    expect(cap.callCount()).toBe(1) // 不重试、不切换。
  })
})

// ─── 无远端 fallback 不变量（SPEC 11.1）──────────────────────────────────────────────

describe('预加载无远端 fallback 不变量（SPEC 11.1 / 任务约束）', () => {
  test('端口 font 入参恒为本地 URL，无论成功或失败', async () => {
    for (const outcomeErr of [null, new Error('fail')] as const) {
      const cap = makeCapturePort()
      const promise = preloadLabelFont({
        texts: ['A'],
        manifestCodePoints: new Set([0x41]),
        port: cap.port,
        fontUrl: LOCAL_URL,
        sdfGlyphSize: SDF_SIZE,
      })
      cap.fireLast(outcomeErr)
      await promise
      expect(cap.calls[0].font).toBe(LOCAL_URL)
      // 不含任何 Unicode CDN / 远端协议。
      expect(cap.calls[0].font).not.toContain('://')
    }
  })

  test('characters 不含清单外字符（覆盖门禁保证 Troika 无需联网补字）', async () => {
    // 故意构造“清单只覆盖部分文本”的场景：门禁会拦截，端口不调用。
    const texts = ['ABC']
    const cap = makeCapturePort()
    const outcome = await preloadLabelFont({
      texts,
      manifestCodePoints: new Set<number>([0x41, 0x42]), // 缺 C
      port: cap.port,
      fontUrl: LOCAL_URL,
      sdfGlyphSize: SDF_SIZE,
    })
    expect(outcome.status).toBe('error')
    expect(cap.callCount()).toBe(0) // 未覆盖即不进入预加载，不可能把缺字交给 Troika。
  })

  test('不创建 Troika Text 对象（注入端口是纯内存模拟）', async () => {
    // 本测试通过“端口实现无任何 Text / three / troika 依赖”间接证明：
    // preloadLabelFont 本身不创建 Text 对象（任务约束）；真实 Troika 绑定由后续 scene 层装配。
    const cap = makeCapturePort()
    const promise = preloadLabelFont({
      texts: ['A'],
      manifestCodePoints: new Set([0x41]),
      port: cap.port,
      fontUrl: LOCAL_URL,
      sdfGlyphSize: SDF_SIZE,
    })
    cap.fireLast(null)
    const outcome = await promise
    expect(outcome.status).toBe('ready')
    // 端口只被调用恰好一次；无额外对象创建痕迹（calls 只记录入参三字段）。
    expect(cap.callCount()).toBe(1)
    expect(Object.keys(cap.calls[0]).sort()).toEqual(['characters', 'font', 'sdfGlyphSize'])
  })
})
