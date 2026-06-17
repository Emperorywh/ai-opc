#!/usr/bin/env node
// Task 12 · 下载 Noto Sans SC（思源黑体简中，SIL OFL）源字体到 raw/，供 subset.mjs 子集化。
//
// GEBCO 同款模式（同 scripts/data-pipeline/raw/gebco/）：原始资产（~17MB 可变字体）不进 git
// （scripts/font-subset/raw/ 已 .gitignore），仅子集化产物 public/fonts/map-zh.woff2（数 KB）进 git。
//
// 用法：pnpm gen:font:fetch
import { existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const RAW_DIR = resolve(__dirname, 'raw');
const OUT = resolve(RAW_DIR, 'NotoSansSC[wght].ttf');

// google/fonts 官方仓库，Noto Sans SC 可变字体（OFL，含完整简中字库，wght 100-900）。
// 选可变字体是因为它是 google/fonts 唯一稳定托管的 NotoSansSC 源文件；subset.mjs 会 pin wght=400
// 固化为 Regular 静态子集（去 variation space，体积最小且确定）。
const URL =
  'https://raw.githubusercontent.com/google/fonts/main/ofl/notosanssc/NotoSansSC%5Bwght%5D.ttf';
const EXPECTED_MIN = 10 * 1024 * 1024; // 可变字体约 17MB，下限 10MB 防 CDN 截断

if (existsSync(OUT) && statSync(OUT).size >= EXPECTED_MIN) {
  console.log(`✓ 源字体已存在：${OUT}（${(statSync(OUT).size / 1024 / 1024).toFixed(1)}MB），跳过下载`);
  console.log('  如需重新下载，先删除该文件。');
  process.exit(0);
}

mkdirSync(RAW_DIR, { recursive: true });
console.log(`• 下载 Noto Sans SC（OFL）→ ${OUT}`);
console.log(`  ${URL}`);

const res = await fetch(URL);
if (!res.ok) {
  console.error(`✗ 下载失败：HTTP ${res.status} ${res.statusText}`);
  console.error('  可手动下载该 URL 到 scripts/font-subset/raw/NotoSansSC[wght].ttf');
  process.exit(1);
}

const buf = Buffer.from(await res.arrayBuffer());
writeFileSync(OUT, buf);

const size = statSync(OUT).size;
const ok = size >= EXPECTED_MIN;
console.log(`${ok ? '✓' : '✗'} 完成：${(size / 1024 / 1024).toFixed(1)}MB`);
if (!ok) {
  console.error('  体积异常（< 10MB），疑似 CDN 截断；请删除后重试或手动下载。');
  process.exit(1);
}
