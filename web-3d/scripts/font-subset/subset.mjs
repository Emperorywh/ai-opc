#!/usr/bin/env node
// Task 12 · 字体子集化 pipeline：
//   读 raw/NotoSansSC[wght].ttf → subset-font（harfbuzz hb-subset）提取所需字形 → public/fonts/map-zh.woff2
//
// 兑现 SPEC §6.5 / §12.5「构建期提取仅所需字形 → map-zh.woff2（数 KB ~ 数十 KB）」。
//
// 用法：pnpm gen:font （需先 pnpm gen:font:fetch 下载源字体）
import subsetFont from 'subset-font';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { collectCodepoints, buildCharsetString } from './charset.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const RAW_FONT = resolve(__dirname, 'raw/NotoSansSC[wght].ttf');
const OUT_DIR = resolve(__dirname, '../../public/fonts');
const OUT_FONT = resolve(OUT_DIR, 'map-zh.woff2');
const MAX_BYTES = 100 * 1024; // SPEC §6.5 验收：woff2 < 100KB

if (!existsSync(RAW_FONT)) {
  console.error(`✗ 源字体缺失：${RAW_FONT}`);
  console.error('  请先运行：pnpm gen:font:fetch （下载 Noto Sans SC OFL 源字体到 raw/）');
  process.exit(1);
}

const codepoints = collectCodepoints();
const charset = buildCharsetString();
console.log(`• charset：${codepoints.length} 字形（七大洲 + 四大洋 + 代表性国家中文名 + ASCII + 标点）`);

const source = readFileSync(RAW_FONT);
console.log(`• 源字体：NotoSansSC[wght].ttf（${(source.length / 1024 / 1024).toFixed(1)}MB，可变字体）`);

// subset-font 第二参数必须为 string（按 code point 迭代）；pin wght=400 把可变字体固化为 Regular
// 静态子集，去掉 glyf variation deltas → 体积最小且确定。
const subset = await subsetFont(source, charset, {
  targetFormat: 'woff2',
  variationAxes: { wght: 400 },
});

mkdirSync(OUT_DIR, { recursive: true });
writeFileSync(OUT_FONT, subset);

const kb = subset.length / 1024;
const ok = subset.length <= MAX_BYTES;
console.log(`${ok ? '✓' : '✗'} 产出 public/fonts/map-zh.woff2：${kb.toFixed(1)}KB（上限 100KB）`);
if (!ok) {
  console.error('  体积超限，需缩减 charset 或检查源字体。');
  process.exit(1);
}
console.log('• 完整无缺字保证：subset-font（harfbuzz hb-subset）保留 charset 全部 code point + GSUB layout closure。');
