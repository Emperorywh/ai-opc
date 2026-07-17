#!/usr/bin/env node
/*
 * 构建期字形门禁 CLI（SPEC 11.1 / 14.1）。
 *
 * 职责：
 *   - 读取本地字形清单 public/fonts/glyphs.json。
 *   - 读取真实样本的全部节点名 + 边名（SPEC 2.5 / 11.1：4,810 个名称）。
 *   - 逐 Unicode code point 校验每个名称字符都在字形清单内。
 *   - 缺任一码点立即以非零退出码失败为 FONT_GLYPH_MISSING，并准确报告缺失码点与首次出现位置。
 *
 * 与运行时字体预加载的边界（任务约束）：
 *   - 本脚本是构建期一次性校验工具，从 sampleMap.json 直接提取名称（.mjs 无法导入 .ts 适配层）；
 *   - 运行时（src/labels/fontPreload.ts）才严格“只消费标签文本契约”，不读取原始 JSON。
 *   - 两者码点检查语义一致：以 Unicode code point 为单位，不以 UTF-16 码元为单位。
 *
 * 何时运行：
 *   - 挂载到 prebuild 生命周期（npm run build / prebuild），在 dev server / 构建产物装配前强制校验；
 *   - 也由 tests/unit/fontGlyphGate.test.ts 通过受校验的适配层管线交叉覆盖。
 */
import { readFileSync, existsSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  FONT_GLYPHS_MANIFEST_RELATIVE,
  readSampleNames,
} from './font-source.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const root = process.env.FONT_GATE_ROOT
  ? resolve(process.env.FONT_GATE_ROOT)
  : resolve(here, '..')
const manifestPath = resolve(root, FONT_GLYPHS_MANIFEST_RELATIVE)

// SPEC 14.1：字体字形缺失稳定错误码。
const FONT_GLYPH_MISSING = 'FONT_GLYPH_MISSING'

function fail(message, context) {
  console.error(`[check-font-glyphs] 失败（${FONT_GLYPH_MISSING}）：${message}`)
  if (context) console.error(`[check-font-glyphs]   上下文：${JSON.stringify(context)}`)
  process.exit(1)
}

function main() {
  if (!existsSync(manifestPath)) {
    fail(`字形清单缺失：${manifestPath}（请先运行 node scripts/build-font-subset.mjs）`)
  }
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  if (!Array.isArray(manifest.codePoints)) {
    fail('glyphs.json 的 codePoints 字段不是数组，清单结构损坏。')
  }
  // 构建码点集合：以 Unicode code point 为键，不以 UTF-16 码元为键。
  const covered = new Set(manifest.codePoints.map((entry) => entry.codePoint))

  // 读取全部节点名 + 边名（真实样本固定 1767 + 3043 = 4810 个名称）。
  const names = readSampleNames()

  // 逐 code point 扫描，定位第一个缺失码点及其首次出现的名称。
  const missing = new Map() // codePoint -> { hex, char, firstEntity, firstValue }
  for (const name of names) {
    // for...of 以 Unicode code point 迭代，正确处理 > U+FFFF 的代理对（即使本样本不存在）。
    for (const ch of name) {
      const cp = ch.codePointAt(0)
      if (!covered.has(cp) && !missing.has(cp)) {
        missing.set(cp, {
          hex: 'U+' + cp.toString(16).toUpperCase().padStart(4, '0'),
          char: ch,
          firstName: name,
        })
      }
    }
  }

  if (missing.size > 0) {
    const list = [...missing.values()]
    fail(
      `样本存在未打包进字形清单的码点（共 ${missing.size} 个），Troika 无法本地渲染且禁止联网补字。`,
      { missing: list },
    )
  }

  console.log(
    `[check-font-glyphs] 通过：${names.length} 个名称、${covered.size} 个子集码点全部覆盖。`,
  )
}

main()
