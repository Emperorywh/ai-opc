/*
 * 字体字形覆盖纯门禁（labels 层，SPEC 2.5 / 11.1 / 14.1 / 任务约束）。
 *
 * 信任边界定位（TASK-015）：
 *   - 本模块是“标签文本 → 是否被字形清单完整覆盖”的唯一纯函数实现。
 *   - 输入只有两样：标签文本数组（LabelDescriptor.text 契约）与字形清单覆盖的码点集合。
 *     不读取原始 JSON、不重建标签描述符、不维护第二套名称来源（任务约束）。
 *   - 以 Unicode code point 为单位迭代（for...of），不以 UTF-16 码元为单位，
 *     正确处理 > U+FFFF 的代理对（即便本样本不存在，也保证规则不被绕过）。
 *
 * 失败语义（SPEC 14.1 / 任务约束）：
 *   - 任一标签文本存在未覆盖码点 → 返回 ok=false 与缺失码点清单（含码点、字符与首次出现的文本）。
 *   - 调用方据此构造 FONT_GLYPH_MISSING 结构化错误；本纯函数不抛错、不读 MapDataError，
 *     保持可被任意层（含构建期脚本与测试）无副作用复用。
 *
 * 依赖方向（SPEC 3.3）：仅依赖本层自身，无内部依赖；不依赖 React / Three / Troika / 浏览器 API。
 */

/*
 * 单个缺失码点的结构化记录。
 *   - codePoint：Unicode 码点数值。
 *   - hex：稳定十六进制表示（U+XXXX，便于 overlay / 日志与断言匹配）。
 *   - char：码点对应字符（仅供可读性；码点才是稳定键）。
 *   - firstText：该码点首次出现的标签文本（定位用，可能为多个标签共用）。
 */
export interface MissingGlyphInfo {
  readonly codePoint: number
  readonly hex: string
  readonly char: string
  readonly firstText: string
}

/*
 * 字形覆盖结果。
 *   - ok=true：全部标签文本的每个码点都在字形清单内。
 *   - ok=false：至少一个码点缺失；missing 列表按“首次出现顺序”去重，长度 ≥ 1。
 */
export type GlyphCoverageResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly missing: readonly MissingGlyphInfo[] }

/*
 * 把码点格式化为稳定十六进制（U+XXXX），与 public/fonts/glyphs.json 的 hex 字段同口径。
 * 用于错误上下文与自动化断言的稳定匹配。
 */
export function formatCodePointHex(codePoint: number): string {
  return 'U+' + codePoint.toString(16).toUpperCase().padStart(4, '0')
}

/*
 * 从一份标签文本数组中收集全部 Unicode code point（去重、升序）。
 *
 * 这是运行时字体预加载把“全部去重名称字符”交给 Troika preloadFont 的唯一派生路径：
 *   - 以 code point 为单位去重，不以字符为单位（代理对的两个码元应分别并入码点集合）。
 *   - 升序输出仅用于稳定测试断言；preloadFont 不依赖顺序。
 */
export function collectTextCodePoints(
  texts: readonly string[],
): number[] {
  const set = new Set<number>()
  for (const text of texts) {
    for (const ch of text) {
      // for...of 保证 ch 非空（至少 1 个 UTF-16 码元），codePointAt(0) 必有值。
      set.add(ch.codePointAt(0) as number)
    }
  }
  return [...set].sort((a, b) => a - b)
}

/*
 * 字形覆盖门禁主入口（SPEC 11.1 / 任务约束）。
 *
 * 调用方契约：
 *   - texts：标签文本数组（LabelDescriptor.text 或实体名称），每个元素为 string。
 *   - manifestCodePoints：字形清单覆盖的码点集合（从 public/fonts/glyphs.json 派生）。
 *   - 返回 GlyphCoverageResult：不抛错、不副作用；由调用方映射为 FONT_GLYPH_MISSING 或放行。
 *
 * 迭代规则：
 *   - 对每个 text 用 for...of 以 Unicode code point 迭代（非 UTF-16 码元）。
 *   - 首次发现某码点未覆盖时记录；后续重复同一码点不再追加，保证 missing 列表精简且稳定。
 *   - 空文本数组与空字符串不会产生缺失记录（没有需要渲染的码点）。
 */
export function checkLabelGlyphCoverage(
  texts: readonly string[],
  manifestCodePoints: ReadonlySet<number>,
): GlyphCoverageResult {
  const seenMissing = new Set<number>()
  const missing: MissingGlyphInfo[] = []

  for (const text of texts) {
    for (const ch of text) {
      // for...of 保证 ch 非空（至少 1 个 UTF-16 码元），codePointAt(0) 必有值。
      const codePoint = ch.codePointAt(0) as number
      if (manifestCodePoints.has(codePoint)) {
        continue
      }
      if (seenMissing.has(codePoint)) {
        continue
      }
      seenMissing.add(codePoint)
      missing.push({
        codePoint,
        hex: formatCodePointHex(codePoint),
        char: ch,
        firstText: text,
      })
    }
  }

  if (missing.length > 0) {
    return { ok: false, missing }
  }
  return { ok: true }
}
