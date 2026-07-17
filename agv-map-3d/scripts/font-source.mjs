/*
 * 本地字体来源身份与子集字符范围（SPEC 2.5 / 3.2 / 11.1 / 14.1）。
 *
 * 本模块是字体资产的“可审计来源记录”单一事实源，供一次性生成脚本
 * scripts/build-font-subset.mjs 消费；不参与运行时、不进入 src 分层、不作为构建依赖。
 *
 * 来源身份（SPEC 11.1 “字体来源、上游版本或提交身份必须可审计”）：
 *   - 字族：Noto Sans SC（思源黑体简体中文），weight = 700（Bold）。
 *   - 上游：Google Fonts 分发的 Noto 项目产物（SIL OFL 1.1）。
 *   - 固定下载 URL：来自 Google Fonts CSS API 在 weight=700 下解析出的 gstatic 直链，
 *     路径中的 v40 与文件名哈希共同锁定字节级身份。
 *   - 固定源二进制 SHA-256：下载后必须与此值一致，任何偏移直接失败。
 *
 * 子集字符范围（SPEC 11.1 “至少包含 ASCII U+0020–U+007E 与样本中文集合”）：
 *   - ASCII 可打印区：U+0020–U+007E（95 个码点）。
 *   - 样本中文字符集合：SPEC 2.5 的 丝充制口抛桩点电碱站绒网门（13 个码点）。
 *   - 子集 = ASCII 可打印区 ∪ 样本中文字符集合，去重后升序输出。
 *   - 运行时与构建期均不引入除此之外的字符；缺字由字形门禁拦截（FONT_GLYPH_MISSING）。
 *
 * 不变量：
 *   - 本文件只描述来源与范围，不下载、不写文件、不修改环境。
 *   - 源 URL 与 SHA-256 一旦确定即不可变；升级字体时先更新本文件与许可证，再重新生成。
 */
import { readFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '..')

/*
 * SPEC 11.1：本地字体资产、许可证、字形清单与来源记录的固定相对路径（相对工程根）。
 */
export const FONT_ASSET_RELATIVE = 'public/fonts/NotoSansSC-Bold.sample.woff'
export const FONT_GLYPHS_MANIFEST_RELATIVE = 'public/fonts/glyphs.json'
export const FONT_LICENSE_RELATIVE = 'public/fonts/LICENSE'
export const FONT_SOURCE_RECORD_RELATIVE = 'public/fonts/SOURCE.md'
export const FONT_README_RELATIVE = 'public/fonts/README.md'

/*
 * 运行时（浏览器）请求的本地字体 URL：与 public/ 同源、不指向任何远端。
 * Vite 把 public/ 下文件原样映射到根路径，故运行时 URL 为 /fonts/...（SPEC 3.1 / 11.1）。
 */
export const FONT_RUNTIME_URL = '/fonts/NotoSansSC-Bold.sample.woff'

/*
 * 源字体固定下载 URL（Google Fonts gstatic 直链，weight=700）。
 * 路径中的 v40 与文件名哈希锁定字节级身份；不可换为 latest 或无哈希别名。
 */
export const FONT_SOURCE_URL =
  'https://fonts.gstatic.com/s/notosanssc/v40/k3kCo84MPvpLmixcA63oeAL7Iqp5IZJF9bmaGzjCnYw.ttf'

/*
 * 源二进制固定 SHA-256（大写十六进制）。
 * 下载后必须与此值一致；任何偏移视为来源被篡改，立即失败、不生成子集。
 */
export const FONT_SOURCE_SHA256 =
  '0066A522A1AC007C1D72BC4FCCB114F80FF7294641C78CEAD9715BD14D43B9EA'

/*
 * 源字体可审计标签：字族、weight、上游分发渠道与许可证类型。
 * 写入 SOURCE.md 作为不可篡改的来源身份记录。
 */
export const FONT_SOURCE_IDENTITY = Object.freeze({
  family: 'Noto Sans SC',
  weight: 700,
  distribution: 'Google Fonts (gstatic)',
  license: 'SIL Open Font License 1.1',
  upstream: 'https://github.com/notofonts/noto-cjk',
})

/*
 * SPEC 2.5：样本中文字符集合（丝充制口抛桩点电碱站绒网门）。
 * 与 tests/fixture/sampleBaseline.ts 的 SAMPLE_NAME_BASELINE.chineseCharset 同源 SPEC，
 * 此处按码点升序排列以稳定子集生成顺序。
 */
export const SAMPLE_CHINESE_CHARSET = '丝充制口抛桩点电碱站绒网门'

/*
 * SPEC 11.1：ASCII 可打印区固定范围（U+0020–U+007E）。
 * 子集必须完整覆盖该范围，不按样本实际用量裁剪，确保预加载门禁不会因“看似用不到”
 * 的可打印字符被 Troika 触发远端补字。
 */
export const ASCII_PRINTABLE_START = 0x20
export const ASCII_PRINTABLE_END = 0x7e

/*
 * 构建子集码点集合：ASCII 可打印区 ∪ 样本中文字符集合（去重、升序）。
 *
 * 这是子集生成与 glyphs.json 清单的唯一来源；任何“额外字符”需求必须先更新本函数，
 * 不允许在生成脚本里散落第二套码点表。
 */
export function computeSubsetCodePoints() {
  const set = new Set()
  for (let cp = ASCII_PRINTABLE_START; cp <= ASCII_PRINTABLE_END; cp++) {
    set.add(cp)
  }
  for (const ch of SAMPLE_CHINESE_CHARSET) {
    set.add(ch.codePointAt(0))
  }
  return [...set].sort((a, b) => a - b)
}

/*
 * 把码点集合格式化为 pyftsubset 的 --unicodes 参数（逗号分隔的 0xXXXX，无空格）。
 * pyftsubset 接受该格式并确定性地产出子集。
 */
export function formatUnicodesArg(codePoints) {
  return codePoints.map((cp) => '0x' + cp.toString(16).toUpperCase()).join(',')
}

/*
 * 读取真实样本的全部节点名 + 边名（构建期字形门禁与生成脚本交叉校验用）。
 *
 * 与运行时不同：这里是构建期一次性校验，直接从已校验的 sampleMap.json 提取
 * response.data.currentMapInfoVersion.mapJson.{nodes,edges}[].name，不经过 src 适配层
 * （.mjs 无法导入 .ts）；运行时字体预加载才严格只消费 LabelDescriptor 文本契约。
 */
export function readSampleNames(samplePath = resolve(root, 'data', 'sampleMap.json')) {
  const raw = JSON.parse(readFileSync(samplePath, 'utf8'))
  const mapJson = raw.data.currentMapInfoVersion.mapJson
  const names = []
  for (const node of mapJson.nodes) names.push(node.name)
  for (const edge of mapJson.edges) names.push(edge.name)
  return names
}
