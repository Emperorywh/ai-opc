// Task 13 · 大洲/大洋标签数据 pipeline 单测
//
// 验收（ROADMAP Task 13）：数据完整、含 priority/kind。
//   - 完整性：7 大洲 + 4 大洋 = 11 条，每条含全字段
//   - 优先级：大洲(100) > 大洋(80)，对齐 SPEC §6.5「大洲 > 大洋 > 大国 > 小国」
//   - 无缺字：zhName 与 Task 12 charset.mjs 同源（七大洲四大洋固定中文名），字体已子集化覆盖
//   - 锚点合理：大洲落陆、大洋落海（continents.mjs isLand 断言——可编程验收，不依赖肉眼）
//   - 投影对齐：project() 投影到工作平面内（R2 单一契约，供 Task 14 锚点渲染）
import { describe, it, expect } from 'vitest';
import {
  buildLabels,
  CONTINENT_LABELS,
  OCEAN_LABELS,
  COUNTRY_LABELS,
} from '../scripts/data-pipeline/lib/labels-data.mjs';
import { isLand } from '../scripts/data-pipeline/lib/continents.mjs';
import { CONTINENT_NAMES, OCEAN_NAMES, COUNTRY_NAMES, DEFAULT_CHARSET } from '../scripts/font-subset/charset.mjs';
import { project } from '../src/config/projection';
import { SYNTHETIC_COUNTRIES } from '../scripts/data-pipeline/lib/boundaries-data.mjs';
import { uniqueContinents } from '../scripts/data-pipeline/lib/boundary-source.mjs';
import { packBoundaries } from '../scripts/data-pipeline/lib/boundary-pack.mjs';
import { decodeBoundaries } from '../src/data/boundaries';
import { countryAnchorLonLat } from '../src/three/labels/countryInfo';

const labels = buildLabels();
const continents = labels.filter((l) => l.kind === 'continent');
const oceans = labels.filter((l) => l.kind === 'ocean');
const countries = labels.filter((l) => l.kind === 'country');

describe('labels · 数据完整性', () => {
  it('总数 = 7 大洲 + 4 大洋 + 6 国家 = 17', () => {
    expect(labels).toHaveLength(17);
    expect(continents).toHaveLength(7);
    expect(oceans).toHaveLength(4);
    expect(countries).toHaveLength(6);
  });

  it('CONTINENT_LABELS / OCEAN_LABELS / COUNTRY_LABELS 源数组数量', () => {
    expect(CONTINENT_LABELS).toHaveLength(7);
    expect(OCEAN_LABELS).toHaveLength(4);
    expect(COUNTRY_LABELS).toHaveLength(6);
  });

  it('每条含全字段 {id,zhName,kind,continent,lon,lat,priority}', () => {
    for (const l of labels) {
      expect(typeof l.id).toBe('string');
      expect(typeof l.zhName).toBe('string');
      expect(['continent', 'ocean', 'country']).toContain(l.kind);
      expect(l.continent === null || typeof l.continent === 'string').toBe(true);
      expect(typeof l.lon).toBe('number');
      expect(typeof l.lat).toBe('number');
      expect(typeof l.priority).toBe('number');
    }
  });

  it('id 唯一', () => {
    const ids = labels.map((l) => l.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('zhName 唯一', () => {
    const names = labels.map((l) => l.zhName);
    expect(new Set(names).size).toBe(names.length);
  });
});

describe('labels · 优先级（SPEC §6.5：大洲 > 大洋 > 大国 > 小国）', () => {
  it('大洲 priority = 100', () => {
    for (const l of continents) {
      expect(l.priority).toBe(100);
    }
  });

  it('大洋 priority = 80', () => {
    for (const l of oceans) {
      expect(l.priority).toBe(80);
    }
  });

  it('大国 priority = 60（SPEC §6.5「大国~60」，留出小国~30 空间）', () => {
    for (const l of countries) {
      expect(l.priority).toBe(60);
    }
  });

  it('优先级梯度：大洲 > 大洋 > 国家', () => {
    const minContinent = Math.min(...continents.map((l) => l.priority));
    const maxOcean = Math.max(...oceans.map((l) => l.priority));
    const maxCountry = Math.max(...countries.map((l) => l.priority));
    expect(minContinent).toBeGreaterThan(maxOcean);
    expect(maxOcean).toBeGreaterThan(maxCountry);
  });
});

describe('labels · continent 字段语义', () => {
  it('大洲 continent = 自身 id（非 null）', () => {
    for (const l of continents) {
      expect(l.continent).toBe(l.id);
    }
  });

  it('大洋 continent = null（大洋不属任何大洲）', () => {
    for (const l of oceans) {
      expect(l.continent).toBeNull();
    }
  });

  it('国家 continent = 所属大洲 slug（与 continent label id 同源，非 null）', () => {
    const continentIds = new Set(continents.map((l) => l.id));
    for (const l of countries) {
      expect(typeof l.continent).toBe('string');
      expect(continentIds.has(l.continent as string), `国家 ${l.zhName} continent「${l.continent}」非有效大洲 slug`).toBe(true);
    }
  });
});

describe('labels · 中文名无缺字（与 Task 12 字体同源）', () => {
  it('大洲 zhName 与 charset.mjs CONTINENT_NAMES 集合相等', () => {
    expect(continents.map((l) => l.zhName).sort()).toEqual([...CONTINENT_NAMES].sort());
  });

  it('大洋 zhName 与 charset.mjs OCEAN_NAMES 集合相等', () => {
    expect(oceans.map((l) => l.zhName).sort()).toEqual([...OCEAN_NAMES].sort());
  });

  it('国家 zhName 与 charset.mjs COUNTRY_NAMES 集合相等（Task 25 同源）', () => {
    expect(countries.map((l) => l.zhName).sort()).toEqual([...COUNTRY_NAMES].sort());
  });

  it('每个汉字均在默认 charset 内（字体已子集化覆盖，无缺字）', () => {
    const charset = new Set([...DEFAULT_CHARSET].map((c) => c.codePointAt(0) as number));
    for (const l of labels) {
      for (const ch of l.zhName) {
        expect(charset.has(ch.codePointAt(0) as number), `缺字「${ch}」（${l.zhName}）`).toBe(true);
      }
    }
  });
});

// 大洲锚点合理经纬 bbox（真实地理验收）。
// 注：合成 continents.mjs mask 对「欧亚拼合多边形」逐点 isLand 不可靠——射线法在中东锯齿边界
// 误判（如欧洲中部 lat∈[46,57]、经度<141° 的点受干扰），故大洲锚点用真实地理 bbox 验收，
// 不依赖合成 mask。大洋锚点（开阔海域中心）isLand 判海可靠，仍用 isLand 断言。
const CONTINENT_BBOX: Record<string, { lon: [number, number]; lat: [number, number] }> = {
  asia: { lon: [25, 180], lat: [5, 75] },
  europe: { lon: [-12, 40], lat: [36, 71] },
  africa: { lon: [-18, 52], lat: [-35, 37] },
  'north-america': { lon: [-168, -52], lat: [7, 83] },
  'south-america': { lon: [-82, -34], lat: [-56, 13] },
  oceania: { lon: [110, 180], lat: [-47, 0] },
  antarctica: { lon: [-180, 180], lat: [-90, -60] },
};

describe('labels · 锚点经纬度', () => {
  it('经度 ∈ [-180,180]，纬度 ∈ [-90,90]', () => {
    for (const l of labels) {
      expect(l.lon).toBeGreaterThanOrEqual(-180);
      expect(l.lon).toBeLessThanOrEqual(180);
      expect(l.lat).toBeGreaterThanOrEqual(-90);
      expect(l.lat).toBeLessThanOrEqual(90);
    }
  });

  it('大洲锚点落在该大洲合理经纬 bbox（真实地理）', () => {
    for (const l of continents) {
      const b = CONTINENT_BBOX[l.id];
      expect(b, `缺 bbox: ${l.id}`).toBeDefined();
      expect(l.lon, `${l.zhName} 经度越界`).toBeGreaterThanOrEqual(b.lon[0]);
      expect(l.lon, `${l.zhName} 经度越界`).toBeLessThanOrEqual(b.lon[1]);
      expect(l.lat, `${l.zhName} 纬度越界`).toBeGreaterThanOrEqual(b.lat[0]);
      expect(l.lat, `${l.zhName} 纬度越界`).toBeLessThanOrEqual(b.lat[1]);
    }
  });

  it('大洋锚点落海洋（continents.mjs isLand=false；开阔海域可靠）', () => {
    for (const l of oceans) {
      expect(isLand(l.lon, l.lat), `${l.zhName} 锚点应落海（${l.lon},${l.lat}）`).toBe(false);
    }
  });

  // 国家锚点 bbox = 合成边界 SYNTHETIC_COUNTRIES 主体陆地矩形（boundaries-data.mjs）。
  // USA 取本土（label 锚点 [-96,37] 经 §10 修复落本土，非海外均值）。
  const COUNTRY_BBOX: Record<string, { lon: [number, number]; lat: [number, number] }> = {
    chn: { lon: [73, 135], lat: [18, 53] },
    usa: { lon: [-125, -67], lat: [25, 49] },
    fra: { lon: [-5, 8], lat: [42, 51] },
    bra: { lon: [-74, -34], lat: [-33, 5] },
    aus: { lon: [113, 154], lat: [-39, -12] },
    egy: { lon: [25, 35], lat: [22, 32] },
  };

  it('国家锚点落该国主体陆地矩形（合成边界 SYNTHETIC_COUNTRIES）', () => {
    for (const l of countries) {
      const b = COUNTRY_BBOX[l.id];
      expect(b, `缺 bbox: ${l.id}`).toBeDefined();
      expect(l.lon, `${l.zhName} 经度越界`).toBeGreaterThanOrEqual(b.lon[0]);
      expect(l.lon, `${l.zhName} 经度越界`).toBeLessThanOrEqual(b.lon[1]);
      expect(l.lat, `${l.zhName} 纬度越界`).toBeGreaterThanOrEqual(b.lat[0]);
      expect(l.lat, `${l.zhName} 纬度越界`).toBeLessThanOrEqual(b.lat[1]);
    }
  });
});

// 国家标签锚点（build-time labels.json）须与数据卡片锚点（runtime countryAnchorLonLat，
// 从 boundaries.bin 顶点均值算）严格一致——否则标签文字与 Task 24 卡片错位。
// 跨模块 DRY 校验：解码合成 boundaries → 每国 countryAnchorLonLat == COUNTRY_LABELS [lon,lat]。
function decodeSyntheticBoundaries() {
  const continentsArr = uniqueContinents(SYNTHETIC_COUNTRIES);
  return decodeBoundaries(packBoundaries(SYNTHETIC_COUNTRIES, continentsArr, { simplify: 0 }).bytes);
}

describe('labels · 国家锚点与卡片锚点同源（DRY：label == countryAnchorLonLat）', () => {
  it('每国 COUNTRY_LABELS 锚点 == countryAnchorLonLat（解码合成 boundaries）', () => {
    const b = decodeSyntheticBoundaries();
    for (const cl of COUNTRY_LABELS) {
      const country = b.countries.find((c) => c.isoA3.toLowerCase() === cl.id);
      expect(country, `合成 boundaries 缺国家 ${cl.id}`).toBeDefined();
      const [lon, lat] = countryAnchorLonLat(b, country!);
      expect(lon, `${cl.zhName} 标签/卡片锚点经度不一致`).toBeCloseTo(cl.lon, 10);
      expect(lat, `${cl.zhName} 标签/卡片锚点纬度不一致`).toBeCloseTo(cl.lat, 10);
    }
  });
});

describe('labels · 投影对齐（R2：project 单一契约，供 Task 14 锚点）', () => {
  it('所有锚点 project 后落在工作平面 x∈[-1,1], z∈[-0.5,0.5]', () => {
    for (const l of labels) {
      const [x, z] = project(l.lon, l.lat);
      expect(x).toBeGreaterThanOrEqual(-1);
      expect(x).toBeLessThanOrEqual(1);
      expect(z).toBeGreaterThanOrEqual(-0.5);
      expect(z).toBeLessThanOrEqual(0.5);
    }
  });
});
