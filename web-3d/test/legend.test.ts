// Task 25 · 图例数据单测（legend.ts 纯常量，SPEC §6.7「Legend 图例（地物配色说明）」）
//
// 验收（ROADMAP Task 25）：图例完整（覆盖地图全部可见地物配色）。
//   - 完整性：海洋 + 地形分层（低→高）+ 国家边界 + 争议虚线，每类可见特征均有项
//   - 配色合法：每项 color 为合法 hex（单色或 [浅,深] 渐变对），取自 palette
//   - 标签：中文非空、唯一
//   - 形状：solid/line/dashed 合法值；边界=line、争议=dashed（语义一致）
import { describe, it, expect } from 'vitest';
import { LEGEND_ITEMS } from '../src/ui/legendData';
import { palette } from '../src/config/palette';

const HEX = /^#[0-9a-f]{6}$/i;

describe('legend · 完整性（覆盖地图全部可见地物）', () => {
  it('非空且项数合理（≥7：海洋+地形层+边界+争议）', () => {
    expect(LEGEND_ITEMS.length).toBeGreaterThanOrEqual(7);
  });

  it('含海洋（配色为浅→深渐变对）', () => {
    const ocean = LEGEND_ITEMS.find((i) => i.label === '海洋');
    expect(ocean, '缺海洋图例项').toBeDefined();
    expect(Array.isArray(ocean!.color)).toBe(true);
    expect(ocean!.color).toEqual([palette.oceanShallow, palette.oceanDeep]);
  });

  it('含国家边界（line）与争议地区（dashed）', () => {
    const border = LEGEND_ITEMS.find((i) => i.label === '国家边界');
    const disputed = LEGEND_ITEMS.find((i) => i.label === '争议地区');
    expect(border, '缺国家边界图例项').toBeDefined();
    expect(disputed, '缺争议地区图例项').toBeDefined();
    expect(border!.shape).toBe('line');
    expect(disputed!.shape).toBe('dashed');
    expect(border!.color).toBe(palette.border);
    expect(disputed!.color).toBe(palette.disputed);
  });

  it('含地形分层（平原/丘陵/山脉/雪线，solid）', () => {
    const expected = ['平原', '丘陵', '山脉', '雪线'];
    for (const label of expected) {
      const item = LEGEND_ITEMS.find((i) => i.label === label);
      expect(item, `缺地形图例项「${label}」`).toBeDefined();
      expect(item!.shape).toBe('solid');
    }
  });
});

describe('legend · 每项字段合法', () => {
  it('label 为非空字符串', () => {
    for (const item of LEGEND_ITEMS) {
      expect(typeof item.label).toBe('string');
      expect(item.label.length).toBeGreaterThan(0);
    }
  });

  it('label 唯一', () => {
    const labels = LEGEND_ITEMS.map((i) => i.label);
    expect(new Set(labels).size).toBe(labels.length);
  });

  it('shape ∈ solid/line/dashed', () => {
    for (const item of LEGEND_ITEMS) {
      expect(['solid', 'line', 'dashed']).toContain(item.shape);
    }
  });

  it('color 为合法 hex 或 [hex,hex] 渐变对', () => {
    for (const item of LEGEND_ITEMS) {
      if (Array.isArray(item.color)) {
        expect(item.color).toHaveLength(2);
        expect(item.color[0]).toMatch(HEX);
        expect(item.color[1]).toMatch(HEX);
      } else {
        expect(item.color).toMatch(HEX);
      }
    }
  });
});
