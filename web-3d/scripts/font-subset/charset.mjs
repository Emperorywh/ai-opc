// Task 12 · 字体子集化 charset 定义（纯函数，可脱离 DOM/浏览器单测）
//
// SPEC §6.5「中文字体子集化（关键，D14）」：构建期提取仅所需字形（七大洲 + 四大洋 + UI 文案 ≈ 数百字）
// → public/fonts/map-zh.woff2（数 KB ~ 数十 KB）。
//
// 本模块被两端共用：
//   - subset.mjs（node pipeline）：buildCharsetString() → subset-font 直接消费。
//   - test/font-subset.test.ts（vitest）：collectCodepoints() 验证「无缺字」（七大洲四大洋字形全覆盖）。
//
// 七大洲/四大洋中文名是固定常识（不依赖 Task 13 的 labels.json 数据 pipeline），故 M4 范围内
// charset 完全确定。Task 13 产出 labels.json 后可扩展 names 重新生成（pipeline 设计为接收任意 names 列表）。

// 七大洲中文名（SPEC §6.5「七大洲+四大洋」）
export const CONTINENT_NAMES = [
  '亚洲',
  '欧洲',
  '非洲',
  '北美洲',
  '南美洲',
  '大洋洲',
  '南极洲',
];

// 四大洋中文名（SPEC §6.5；标准四大洋）
export const OCEAN_NAMES = ['太平洋', '大西洋', '印度洋', '北冰洋'];

// 兜底字符集：ASCII 字母数字 + 常用中英标点/符号。
// M4 大洲大洋标签纯中文，但保留 ASCII/标点作为「无缺字」保险——标签 priority 数字、可能的英文缩写、
// 坐标度数（°）、复合名分隔符（·）等。体积影响极小（数十字形）。
export const BASE_CHARS =
  '0123456789' +
  'ABCDEFGHIJKLMNOPQRSTUVWXYZ' +
  'abcdefghijklmnopqrstuvwxyz' +
  ' .,:;/·°—-' + // 空格 英文标点 中点 度号 em-dash 连字符
  '()（）'; // 半角/全角括号

/**
 * 收集 names 与 extra 中所有 code point，去重并升序排序。
 *
 * @param {string[]} [names] 中文名列表（默认七大洲+四大洋）
 * @param {string} [extra] 额外字符（默认 BASE_CHARS）
 * @returns {number[]} 升序、去重的 code point 数组
 */
export function collectCodepoints(
  names = [...CONTINENT_NAMES, ...OCEAN_NAMES],
  extra = BASE_CHARS,
) {
  const set = new Set();
  for (const s of names) {
    for (const ch of s) set.add(ch.codePointAt(0));
  }
  for (const ch of extra) {
    set.add(ch.codePointAt(0));
  }
  return [...set].sort((a, b) => a - b);
}

/**
 * 由 code point 数组重建字符串（subset-font 要求 text 为 string，按 code point 迭代）。
 * @param {readonly number[]} codepoints
 * @returns {string}
 */
export function codepointsToString(codepoints) {
  return codepoints.map((cp) => String.fromCodePoint(cp)).join('');
}

/**
 * 子集化用的 charset 字符串（subset-font 直接消费）。
 * @param {string[]} [names]
 * @param {string} [extra]
 * @returns {string}
 */
export function buildCharsetString(names, extra) {
  return codepointsToString(collectCodepoints(names, extra));
}

// 默认 charset 字符串（M4：七大洲+四大洋 + BASE_CHARS）
export const DEFAULT_CHARSET = buildCharsetString();
