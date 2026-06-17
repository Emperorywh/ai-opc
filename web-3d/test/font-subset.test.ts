// Task 12 · 字体子集化 charset 单测 + woff2 产物校验
//
// 验收（ROADMAP Task 12）：woff2 < 100KB、无缺字。
//   - 「无缺字」根因断言：charset 覆盖七大洲四大洋所有名字形（collectCodepoints 完整性）+
//     subset-font（harfbuzz hb-subset）契约保留传入 code point（pipeline 运行即证明）。
//   - woff2 体积/magic：仅当产物存在时校验（agent 产出后即存在；CI 无源字体则 it.skipIf 跳过）。
import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  CONTINENT_NAMES,
  OCEAN_NAMES,
  BASE_CHARS,
  collectCodepoints,
  codepointsToString,
  buildCharsetString,
  DEFAULT_CHARSET,
} from '../scripts/font-subset/charset.mjs';

const WOFF2 = resolve(__dirname, '../public/fonts/map-zh.woff2');

describe('charset · 七大洲四大洋中文名', () => {
  it('数量正确', () => {
    expect(CONTINENT_NAMES).toHaveLength(7);
    expect(OCEAN_NAMES).toHaveLength(4);
  });

  it('七大洲中文名为固定常识值', () => {
    expect(CONTINENT_NAMES).toEqual([
      '亚洲',
      '欧洲',
      '非洲',
      '北美洲',
      '南美洲',
      '大洋洲',
      '南极洲',
    ]);
  });

  it('四大洋中文名为固定常识值（标准四大洋）', () => {
    expect(OCEAN_NAMES).toEqual(['太平洋', '大西洋', '印度洋', '北冰洋']);
  });
});

describe('charset · 无缺字（根因断言）', () => {
  it('默认 charset 覆盖七大洲四大洋所有名字形', () => {
    const cps = new Set(collectCodepoints());
    for (const name of [...CONTINENT_NAMES, ...OCEAN_NAMES]) {
      for (const ch of name) {
        expect(cps.has(ch.codePointAt(0) as number), `charset 缺字「${ch}」`).toBe(true);
      }
    }
  });

  it('BASE_CHARS 含 ASCII 字母、数字与常用标点', () => {
    expect(BASE_CHARS).toContain('0');
    expect(BASE_CHARS).toContain('9');
    expect(BASE_CHARS).toContain('A');
    expect(BASE_CHARS).toContain('Z');
    expect(BASE_CHARS).toContain('a');
    expect(BASE_CHARS).toContain('z');
    expect(BASE_CHARS).toContain('°'); // 度号
    expect(BASE_CHARS).toContain('·'); // 中点（复合名分隔）
    expect(BASE_CHARS).toContain(' '); // 空格
  });
});

describe('charset · 纯函数正确性', () => {
  it('collectCodepoints 去重', () => {
    // names 内重复字
    const cps1 = collectCodepoints(['亚亚洲'], '');
    expect(new Set(cps1).size).toBe(cps1.length);
    // names 与 extra 跨界重复
    const cps2 = collectCodepoints(['A'], 'A');
    expect(new Set(cps2).size).toBe(cps2.length);
    expect(cps2).toEqual(['A'.codePointAt(0)]);
  });

  it('collectCodepoints 升序排序', () => {
    const cps = collectCodepoints();
    const sorted = [...cps].sort((a, b) => a - b);
    expect(cps).toEqual(sorted);
  });

  it('collectCodepoints 接收自定义 names/extra（可扩展，供 Task 13 衔接）', () => {
    const cps = collectCodepoints(['测试名'], 'X');
    expect(cps).toContain('测'.codePointAt(0));
    expect(cps).toContain('试'.codePointAt(0));
    expect(cps).toContain('名'.codePointAt(0));
    expect(cps).toContain('X'.codePointAt(0));
    expect(cps).not.toContain('亚'.codePointAt(0)); // 默认大洲大洋未注入
  });

  it('codepointsToString 与 collectCodepoints 同源（按 code point 1:1）', () => {
    const cps = collectCodepoints();
    const str = codepointsToString(cps);
    expect([...str].map((c) => c.codePointAt(0) as number)).toEqual(cps);
  });

  it('buildCharsetString 与 collectCodepoints 一致', () => {
    expect(buildCharsetString()).toBe(codepointsToString(collectCodepoints()));
    expect(DEFAULT_CHARSET).toBe(buildCharsetString());
  });
});

describe('woff2 产物（map-zh.woff2）', () => {
  // CI/无源字体环境跳过；本地 `pnpm gen:font` 产出后即存在。
  it.skipIf(!existsSync(WOFF2))('体积 < 100KB（SPEC §6.5 / ROADMAP Task 12 验收）', () => {
    expect(statSync(WOFF2).size).toBeLessThan(100 * 1024);
  });

  it.skipIf(!existsSync(WOFF2))('体积 > 0（非空产物）', () => {
    expect(statSync(WOFF2).size).toBeGreaterThan(0);
  });

  it.skipIf(!existsSync(WOFF2))('合法 woff2（magic number "wOF2" = 0x77 0x4F 0x46 0x32）', () => {
    const head = readFileSync(WOFF2).subarray(0, 4);
    expect(Array.from(head)).toEqual([0x77, 0x4f, 0x46, 0x32]);
  });
});
