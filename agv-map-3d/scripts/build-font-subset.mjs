#!/usr/bin/env node
/*
 * 本地字体子集一次性生成 CLI（SPEC 2.5 / 3.2 / 11.1 / 14.1）。
 *
 * 职责：
 *   - 从固定 gstatic URL 下载 Noto Sans SC Bold 源 TTF，按固定 SHA-256 校验字节身份。
 *   - 用 pyftsubset（Python fonttools，一次性生成工具，不是构建依赖）子集化为本地 .woff，
 *     子集范围 = ASCII U+0020–U+007E ∪ 样本中文字符集合（scripts/font-source.mjs）。
 *   - 生成 glyphs.json 清单（子集码点 + 字符串）、写入 LICENSE 与可审计 SOURCE.md。
 *   - 交叉校验：真实样本全部 4,810 个名称的每个码点都在子集内，缺字直接失败。
 *
 * 何时运行：
 *   - 这是一个“再生”工具，仅在升级源字体或扩展子集范围时手工执行；
 *     正常 npm run build / prebuild 不调用本脚本（构建期字形门禁由 check-font-glyphs.mjs 完成）。
 *   - 产物 NotoSansSC-Bold.sample.woff / glyphs.json / LICENSE / SOURCE.md 随项目提交，
 *     作为 SPEC 11.1 要求的本地字体资产、字形清单与可审计来源记录。
 *
 * 不变量：
 *   - 源 URL / SHA-256 / 子集范围全部来自 font-source.mjs，本脚本不自行猜测或放宽。
 *   - 任一步骤失败立即非零退出，不写入或保留半成品产物。
 *   - 不引入远端字体、系统字体 fallback、WOFF2 或 Unicode CDN；输出格式固定 .woff（Troika 支持）。
 */
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import {
  writeFileSync,
  readFileSync,
  mkdirSync,
  rmSync,
  existsSync,
} from 'node:fs'
import { resolve, dirname } from 'node:path'
import {
  FONT_ASSET_RELATIVE,
  FONT_GLYPHS_MANIFEST_RELATIVE,
  FONT_LICENSE_RELATIVE,
  FONT_SOURCE_RECORD_RELATIVE,
  FONT_SOURCE_URL,
  FONT_SOURCE_SHA256,
  FONT_SOURCE_IDENTITY,
  computeSubsetCodePoints,
  formatUnicodesArg,
  readSampleNames,
} from './font-source.mjs'

const here = dirname(new URL(import.meta.url).pathname.replace(/^\//, ''))
const root = resolve(process.env.FONT_BUILD_ROOT ?? resolve(here, '..'))
const assetPath = resolve(root, FONT_ASSET_RELATIVE)
const manifestPath = resolve(root, FONT_GLYPHS_MANIFEST_RELATIVE)
const licensePath = resolve(root, FONT_LICENSE_RELATIVE)
const sourceRecordPath = resolve(root, FONT_SOURCE_RECORD_RELATIVE)

/*
 * OFL 1.1 许可证全文（SIL Open Font License 1.1）。
 * Noto 项目在 OFL 1.1 下分发，本工程随字体资产一并保留许可证原文（SPEC 11.1）。
 * 此处内联官方稳定文本，避免生成期联网获取带来来源不可审计风险。
 */
const OFL_11_LICENSE = `SIL OPEN FONT LICENSE Version 1.1 - 26 February 2007
-------------------------------------------------------------------

PREAMBLE
The goals of the Open Font License (OFL) are to stimulate worldwide
development of collaborative font projects, to support the font creation
efforts of academic and linguistic communities, and to provide a free and
open framework in which fonts may be shared and improved in partnership
with others.

The OFL allows the licensed fonts to be used, studied, modified and
redistributed freely as long as they are not themselves sold. The fonts,
including any derivative works, can be bundled, embedded, redistributed
and/or sold with any software provided that any reserved names are not
used by derivative works. The fonts and derivatives, however, cannot be
released under any other type of license. The requirement for fonts to
remain under this license does not apply to any document created using the
fonts or their derivatives.

DEFINITIONS
"Font Software" refers to the set of files released by the Copyright
Holder(s) under this license and clearly marked as such. This may
include source files, build scripts and documentation.

"Reserved Font Name" refers to any names specified as such after the
copyright statement(s).

"Original Version" refers to the collection of Font Software components as
distributed by the Copyright Holder(s).

"Modified Version" refers to any derivative made by adding to, deleting,
or substituting -- in part or in whole -- any of the components of the
Original Version, by changing formats or by porting the Font Software to a
new environment.

"Author" refers to any designer, engineer, programmer, technical writer
or other person who contributed to the Font Software.

PERMISSION & CONDITIONS
Permission is hereby granted, free of charge, to any person obtaining a
copy of the Font Software, to use, study, copy, merge, embed, modify,
redistribute, and sell modified and unmodified copies of the Font
Software, subject to the following conditions:

1) Neither the Font Software nor any of its individual components, in
Original or Modified Versions, may be sold by itself.

2) Original or Modified Versions of the Font Software may be bundled,
redistributed and/or sold with any software, provided that each copy
contains the above copyright notice and this license. These can be
included either as stand-alone text files, human-readable headers or in
the appropriate machine-readable metadata fields within text or binary
files as long as those fields can be easily viewed by the user.

3) No Modified Version of the Font Software may use the Reserved Font
Name(s) unless explicit written permission is granted by the corresponding
Copyright Holder. This restriction only applies to the primary font name
as presented to the users.

4) The name(s) of the Copyright Holder(s) or the Author(s) of the Font
Software shall not be used to promote, endorse or advertise any Modified
Version, except to acknowledge the contribution(s) of the Copyright
Holder(s) and the Author(s) or with their explicit written permission.

5) The Font Software, modified or unmodified, in part or in whole, must be
distributed entirely under this license, and must not be distributed under
any other license. The requirement for fonts to remain under this license
does not apply to any document created using the Font Software.

TERMINATION
This license becomes null and void if any of the above conditions are not
met.

DISCLAIMER
THE FONT SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND,
EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO ANY WARRANTIES OF
MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT OF
COPYRIGHT, PATENT, TRADEMARK, OR OTHER RIGHT. IN NO EVENT SHALL THE
COPYRIGHT HOLDER BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY,
INCLUDING ANY GENERAL, SPECIAL, INDIRECT, INCIDENTAL, OR CONSEQUENTIAL
DAMAGES, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF THE USE OR INABILITY TO USE THE FONT SOFTWARE OR FROM THE DEALINGS
IN THE FONT SOFTWARE.
`

/*
 * 下载源 TTF 并按固定 SHA-256 校验字节身份。
 * 使用 Node fetch（Node 24 内置）；任何网络错误或哈希偏移直接抛出。
 */
async function fetchAndVerifySource() {
  let buf
  try {
    const resp = await fetch(FONT_SOURCE_URL)
    if (!resp.ok) {
      throw new Error(`HTTP ${resp.status} ${resp.statusText}`)
    }
    buf = Buffer.from(await resp.arrayBuffer())
  } catch (err) {
    throw new Error(`下载源字体失败：${err.message}`)
  }
  const sha = createHash('sha256').update(buf).digest('hex').toUpperCase()
  if (sha !== FONT_SOURCE_SHA256) {
    throw new Error(
      `源字体 SHA-256 不匹配：期望 ${FONT_SOURCE_SHA256}，实际 ${sha}`,
    )
  }
  return { buf, sha }
}

/*
 * 调用 pyftsubset 生成 .woff 子集。
 *
 * 参数确定性说明：
 *   --no-hinting / --desubroutinize：去除 hinting 与子程序，最大化子集稳定性与体积收敛。
 *   --flavor=woff：固定输出 WOFF（Troika 明确支持，SPEC 11.1 禁止 woff2）。
 *   --layout-features='*'：保留默认布局特性，避免 CJK 渲染所需特性被剥离。
 *   --unicodes：来自 computeSubsetCodePoints() 的固定码点集合。
 * pyftsubset 不可用或返回非零即失败；本工程不在构建期依赖 Python。
 */
function runPyftSubset(sourceTtfPath, subsetWoffPath, unicodesArg) {
  const args = [
    sourceTtfPath,
    `--output-file=${subsetWoffPath}`,
    '--flavor=woff',
    `--unicodes=${unicodesArg}`,
    '--layout-features=*',
    '--no-hinting',
    '--desubroutinize',
    '--notdef-outline',
    '--recalc-bounds',
  ]
  const result = spawnSync('pyftsubset', args, { encoding: 'utf8' })
  if (result.error) {
    if (result.error.code === 'ENOENT') {
      throw new Error(
        '未找到 pyftsubset。请先安装一次性生成依赖：pip install fonttools brotli',
      )
    }
    throw new Error(`pyftsubset 启动失败：${result.error.message}`)
  }
  if (result.status !== 0) {
    throw new Error(
      `pyftsubset 返回非零退出码 ${result.status}\nstdout: ${result.stdout}\nstderr: ${result.stderr}`,
    )
  }
  if (!existsSync(subsetWoffPath)) {
    throw new Error('pyftsubset 未产出 WOFF 文件')
  }
}

/*
 * 生成 glyphs.json 清单：码点数组 + 码点数字符串 + 来源身份 + 生成参数摘要。
 * 清单是构建期字形门禁与运行时审计的唯一码点来源。
 */
function writeGlyphsManifest(codePoints, sourceSha, assetSha) {
  const manifest = {
    format: 'noto-sans-sc-bold-subset-v1',
    fontAsset: FONT_ASSET_RELATIVE.split('/').pop(),
    fontAssetSha256: assetSha,
    source: {
      ...FONT_SOURCE_IDENTITY,
      url: FONT_SOURCE_URL,
      sha256: sourceSha,
    },
    subset: {
      asciiRange: ['U+0020', 'U+007E'],
      chineseCharset: '丝充制口抛桩点电碱站绒网门',
      codePointCount: codePoints.length,
    },
    codePoints: codePoints.map((cp) => ({
      codePoint: cp,
      hex: 'U+' + cp.toString(16).toUpperCase().padStart(4, '0'),
      char: String.fromCodePoint(cp),
    })),
  }
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n', 'utf8')
}

/*
 * 生成可审计来源记录 SOURCE.md（SPEC 11.1）。
 * 文本必须自包含、可复核：固定 URL、源 SHA-256、子集范围、生成命令与产物 SHA-256。
 */
function writeSourceRecord(codePoints, sourceSha, assetSha, generatedAt) {
  const md = `# NotoSansSC-Bold.sample.woff — 字体来源与子集记录

本文件是 \`public/fonts/NotoSansSC-Bold.sample.woff\` 的可审计来源记录（SPEC 11.1）。
任何升级源字体或扩展子集范围的操作都必须先更新 \`scripts/font-source.mjs\`，再重新运行
\`node scripts/build-font-subset.mjs\`，并把更新的产物与本记录一并提交。

## 来源身份

| 项 | 值 |
|---|---|
| 字族 | ${FONT_SOURCE_IDENTITY.family} |
| weight | ${FONT_SOURCE_IDENTITY.weight}（Bold） |
| 分发渠道 | ${FONT_SOURCE_IDENTITY.distribution} |
| 许可证 | ${FONT_SOURCE_IDENTITY.license} |
| 上游仓库 | ${FONT_SOURCE_IDENTITY.upstream} |
| 固定下载 URL | ${FONT_SOURCE_URL} |
| 源二进制 SHA-256 | \`${sourceSha}\` |

源二进制通过 Google Fonts CSS API（weight=700）解析出的 gstatic 直链获取。
URL 中的 \`v40\` 与文件名哈希共同锁定字节级身份；下载后必须与上述 SHA-256 一致。

## 子集范围

- ASCII 可打印区：U+0020–U+007E（95 个码点）。
- 样本中文字符集合：丝充制口抛桩点电碱站绒网门（13 个码点）。
- 子集合计码点数：${codePoints.length}。
- 输出格式：WOFF（Troika 明确支持；SPEC 11.1 禁止 woff2）。

## 码点清单

完整码点清单见同目录 \`glyphs.json\`。

## 生成方式（一次性，非构建依赖）

\`\`\`sh
pip install fonttools brotli      # 一次性生成工具，不进入构建依赖
node scripts/build-font-subset.mjs
\`\`\`

脚本固定调用 \`pyftsubset --flavor=woff --no-hinting --desubroutinize\`，
码点来自 \`scripts/font-source.mjs\` 的 \`computeSubsetCodePoints()\`。

## 产物校验

| 产物 | 路径 | SHA-256 |
|---|---|---|
| 子集字体 | \`${FONT_ASSET_RELATIVE}\` | \`${assetSha}\` |
| 字形清单 | \`${FONT_GLYPHS_MANIFEST_RELATIVE}\` | — |
| 许可证 | \`${FONT_LICENSE_RELATIVE}\` | — |

生成时间（UTC）：${generatedAt}
`
  writeFileSync(sourceRecordPath, md, 'utf8')
}

/*
 * 交叉校验：真实样本全部名称的每个码点都在子集码点集合内。
 * 这是在生成期就拦截“子集范围不足以覆盖样本”的错误，先于构建期字形门禁。
 */
function crossCheckSampleNames(subsetSet) {
  const names = readSampleNames()
  const missing = new Map() // codePoint -> first name
  for (const name of names) {
    for (const ch of name) {
      const cp = ch.codePointAt(0)
      if (!subsetSet.has(cp)) {
        if (!missing.has(cp)) missing.set(cp, name)
      }
    }
  }
  if (missing.size > 0) {
    const list = [...missing.entries()]
      .map(
        ([cp, name]) =>
          `U+${cp.toString(16).toUpperCase().padStart(4, '0')} (${String.fromCodePoint(cp)}) 首次出现在 "${name}"`,
      )
      .join(', ')
    throw new Error(`子集范围不足以覆盖样本名称，缺失码点：${list}`)
  }
  return names.length
}

async function main() {
  console.log('[build-font-subset] 子集码点数：', computeSubsetCodePoints().length)
  const codePoints = computeSubsetCodePoints()
  const subsetSet = new Set(codePoints)

  // 0. 先交叉校验样本名称（不依赖网络；范围不足立即失败，避免无谓下载）。
  const nameCount = crossCheckSampleNames(subsetSet)
  console.log(`[build-font-subset] 样本 ${nameCount} 个名称码点全部在子集范围内。`)

  // 1. 下载并校验源 TTF 字节身份。
  console.log('[build-font-subset] 下载源字体并校验 SHA-256 ...')
  const { buf: sourceBuf, sha: sourceSha } = await fetchAndVerifySource()
  console.log(`[build-font-subset] 源 SHA-256 校验通过：${sourceSha}`)

  // 2. 准备临时目录，调用 pyftsubset 产出 WOFF。
  mkdirSync(dirname(assetPath), { recursive: true })
  const tmpTtf = resolve(root, 'public/fonts/.source.tmp.ttf')
  writeFileSync(tmpTtf, sourceBuf)
  try {
    console.log('[build-font-subset] 调用 pyftsubset 生成 WOFF 子集 ...')
    runPyftSubset(tmpTtf, assetPath, formatUnicodesArg(codePoints))
  } finally {
    rmSync(tmpTtf, { force: true })
  }
  const assetBuf = readFileSync(assetPath)
  const assetSha = createHash('sha256')
    .update(assetBuf)
    .digest('hex')
    .toUpperCase()
  console.log(
    `[build-font-subset] WOFF 子集生成完成：${assetBuf.byteLength} 字节，SHA-256 ${assetSha}`,
  )

  // 3. 写 glyphs.json 清单、LICENSE 与 SOURCE.md。
  writeGlyphsManifest(codePoints, sourceSha, assetSha)
  writeFileSync(licensePath, OFL_11_LICENSE, 'utf8')
  writeSourceRecord(
    codePoints,
    sourceSha,
    assetSha,
    new Date().toISOString(),
  )
  console.log('[build-font-subset] glyphs.json / LICENSE / SOURCE.md 已写入。')
  console.log('[build-font-subset] 完成。')
}

main().catch((err) => {
  console.error(`[build-font-subset] 失败：${err.message}`)
  process.exit(1)
})
