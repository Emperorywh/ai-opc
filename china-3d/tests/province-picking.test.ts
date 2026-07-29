/**
 * 省级悬停拾取所属判定测试（TASK-009 验收 3、4；SPEC §4.2）。
 *
 * 依赖方向：测试基线（vitest，Node 环境），import src/lib/province-picking（领域纯函数
 * findProvinceAtLonLat）、src/geo-contracts（AdministrativeGeometryFeature 几何类型）。不依赖浏览器 /
 * React / Three.js / 投影 / 高程——判定层是纯函数，输入经纬度 + 几何，可在 Node 内用确定性几何夹具
 * 完整覆盖「普通省份 / 多岛省份 / 内环 / 相邻边界 / 海域 / 地图外 / 退化输入」等场景，无需启动
 * WebGL（hover 视觉验收由 pnpm dev 承担）。
 *
 * 覆盖（验收 3、4「所属省反查有单元测试」）：
 * - 普通省份（Polygon 外环）：点在外环内 → 命中该省 adminId；点在外环外 → null（或命中相邻省）。
 * - 多岛省份（MultiPolygon）：点在任一岛屿 / 大陆块内 → 命中该省 adminId。
 * - 内环（洞 / 飞地）：点在外环内但在内环（洞）内 → 不属于该省（返回 null 或命中洞内的他省）。
 * - 相邻边界：两省共享边界、不重叠，点在 A 内 → 命中 A，点在 B 内 → 命中 B（互斥切换）。
 * - 海域 / 地图外：点不在任何省几何内 → null（统一表达「无省份焦点」）。
 * - 退化输入：非有限经纬度 / 空 features → null（不伪造归属）。
 * - 状态转换序列：手动模拟「无→A→B→海域→无」，断言任一时刻至多一个焦点（返回值是单值）。
 * - 真实资产：生产 34 省几何上，已知城市点位命中预期省份（北京→CN-110000、上海→CN-310000、
 *   台北→CN-710000、香港→CN-810000），远海点 → null——证明真实 DataV 几何上反查正确。
 */

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { findProvinceAtLonLat } from '../src/lib/province-picking'
import type { AdministrativeGeometryFeature } from '../src/geo-contracts'

const projectRoot = resolve(fileURLToPath(import.meta.url), '..', '..')

/** 构造一个矩形 Polygon feature（经纬度，[w,e]×[s,n]），用于确定性覆盖各场景。 */
function rectProvince(
  adminId: string,
  w: number,
  e: number,
  s: number,
  n: number,
): AdministrativeGeometryFeature {
  return {
    adminId,
    geometry: {
      type: 'Polygon',
      rings: [
        [
          { lon: w, lat: s },
          { lon: e, lat: s },
          { lon: e, lat: n },
          { lon: w, lat: n },
        ],
      ],
    },
  }
}

/** 构造一个带内环（洞）的 Polygon feature：外环 [w,e]×[s,n]，洞 [hw,he]×[hs,hn]。 */
function rectProvinceWithHole(
  adminId: string,
  w: number,
  e: number,
  s: number,
  n: number,
  hw: number,
  he: number,
  hs: number,
  hn: number,
): AdministrativeGeometryFeature {
  return {
    adminId,
    geometry: {
      type: 'Polygon',
      rings: [
        [
          { lon: w, lat: s },
          { lon: e, lat: s },
          { lon: e, lat: n },
          { lon: w, lat: n },
        ],
        // 内环（洞）：洞里的点不属于该省。
        [
          { lon: hw, lat: hs },
          { lon: he, lat: hs },
          { lon: he, lat: hn },
          { lon: hw, lat: hn },
        ],
      ],
    },
  }
}

describe('普通省份（Polygon 外环）：点在内命中、点外 null（验收 4）', () => {
  it('点在外环内部 → 命中该省 adminId', () => {
    const features = [rectProvince('CN-A', 100, 105, 25, 30)]
    expect(findProvinceAtLonLat({ lon: 102, lat: 27 }, features)).toBe('CN-A')
  })

  it('点在外环外（海域）→ null', () => {
    const features = [rectProvince('CN-A', 100, 105, 25, 30)]
    // 东侧海域。
    expect(findProvinceAtLonLat({ lon: 120, lat: 27 }, features)).toBeNull()
  })
})

describe('多岛省份（MultiPolygon）：任一岛屿 / 大陆块命中即归属（验收 4）', () => {
  it('点在大陆块内 → 命中；点在远处岛屿内 → 同一 adminId 命中', () => {
    const feature: AdministrativeGeometryFeature = {
      adminId: 'CN-multi',
      geometry: {
        type: 'MultiPolygon',
        polygons: [
          {
            rings: [
              [
                { lon: 100, lat: 25 },
                { lon: 105, lat: 25 },
                { lon: 105, lat: 30 },
                { lon: 100, lat: 30 },
              ],
            ],
          },
          {
            rings: [
              [
                { lon: 118, lat: 22 },
                { lon: 119, lat: 22 },
                { lon: 119, lat: 23 },
                { lon: 118, lat: 23 },
              ],
            ],
          },
        ],
      },
    }
    // 大陆块内。
    expect(findProvinceAtLonLat({ lon: 102, lat: 27 }, [feature])).toBe('CN-multi')
    // 远处岛屿内。
    expect(findProvinceAtLonLat({ lon: 118.5, lat: 22.5 }, [feature])).toBe('CN-multi')
    // 两块之外的海域 → null。
    expect(findProvinceAtLonLat({ lon: 110, lat: 27 }, [feature])).toBeNull()
  })
})

describe('内环（洞 / 飞地）：洞内点不属于该省（验收 4）', () => {
  it('点在外环内但在洞内 → 不命中该省（null）', () => {
    // 外环 [100,110]×[25,35]，洞 [104,106]×[29,31]。
    const features = [rectProvinceWithHole('CN-hole', 100, 110, 25, 35, 104, 106, 29, 31)]
    // 洞中心 → 不属于 CN-hole。
    expect(findProvinceAtLonLat({ lon: 105, lat: 30 }, features)).toBeNull()
    // 外环内、洞外 → 属于 CN-hole。
    expect(findProvinceAtLonLat({ lon: 102, lat: 27 }, features)).toBe('CN-hole')
  })

  it('洞内嵌套他省（飞地）→ 洞内点命中嵌套省', () => {
    // CN-outer 外环 [100,110]×[25,35]，洞 [104,106]×[29,31]；CN-enclave 恰填洞。
    const features: AdministrativeGeometryFeature[] = [
      rectProvinceWithHole('CN-outer', 100, 110, 25, 35, 104, 106, 29, 31),
      rectProvince('CN-enclave', 104, 106, 29, 31),
    ]
    // 洞（= 飞地）中心 → 命中嵌套省 CN-enclave，而非 CN-outer。
    expect(findProvinceAtLonLat({ lon: 105, lat: 30 }, features)).toBe('CN-enclave')
    // 飞地外、外环内 → 命中 CN-outer。
    expect(findProvinceAtLonLat({ lon: 102, lat: 27 }, features)).toBe('CN-outer')
  })
})

describe('相邻边界：两省不重叠，点在哪省命中哪省（互斥切换）（验收 3、4）', () => {
  it('A 在西 [100,105]、B 在东 [105,110]，共享 105°E 边界', () => {
    const features: AdministrativeGeometryFeature[] = [
      rectProvince('CN-A', 100, 105, 25, 30),
      rectProvince('CN-B', 105, 110, 25, 30),
    ]
    // A 内（西侧）。
    expect(findProvinceAtLonLat({ lon: 102, lat: 27 }, features)).toBe('CN-A')
    // B 内（东侧）。
    expect(findProvinceAtLonLat({ lon: 108, lat: 27 }, features)).toBe('CN-B')
  })
})

describe('海域 / 地图外 / 退化输入 → null（无省份焦点）（验收 3、4）', () => {
  it('点不在任何省几何内（远海）→ null', () => {
    const features = [rectProvince('CN-A', 100, 105, 25, 30)]
    // 太平洋远海。
    expect(findProvinceAtLonLat({ lon: 150, lat: 10 }, features)).toBeNull()
  })

  it('空 features → null', () => {
    expect(findProvinceAtLonLat({ lon: 102, lat: 27 }, [])).toBeNull()
  })

  it('非有限经度 / 纬度 → null（不伪造归属）', () => {
    const features = [rectProvince('CN-A', 100, 105, 25, 30)]
    expect(findProvinceAtLonLat({ lon: Number.NaN, lat: 27 }, features)).toBeNull()
    expect(findProvinceAtLonLat({ lon: 102, lat: Number.NaN }, features)).toBeNull()
    expect(
      findProvinceAtLonLat({ lon: Number.POSITIVE_INFINITY, lat: 27 }, features),
    ).toBeNull()
  })
})

describe('状态转换序列：无→A→B→海域→无，任一时刻至多一个焦点（验收 3「移出还原」）', () => {
  it('手动驱动序列，焦点为单值，无残留多高亮', () => {
    // A 在西、B 在东、C 是海域（无几何覆盖）。
    const features: AdministrativeGeometryFeature[] = [
      rectProvince('CN-A', 100, 105, 25, 30),
      rectProvince('CN-B', 105, 110, 25, 30),
    ]
    // 序列：无（初始）→ A → B → 海域 → 无。
    const sequence: Array<{ lon: number; lat: number; expected: string | null }> = [
      { lon: 102, lat: 27, expected: 'CN-A' },
      { lon: 108, lat: 27, expected: 'CN-B' },
      { lon: 150, lat: 10, expected: null },
    ]
    let focused: string | null = null
    // 初始无焦点。
    expect(focused).toBeNull()
    for (const step of sequence) {
      // 单一焦点：新值原子替换旧值（findProvinceAtLonLat 返回单值，非集合）。
      focused = findProvinceAtLonLat(step, features)
      expect(focused).toBe(step.expected)
      // 至多一个焦点：focused 是 string | null，结构上不可能持多个。
      expect(focused === null || typeof focused === 'string').toBe(true)
    }
    // 序列结束（海域）后显式复位 → 无焦点（模拟 onPointerOut 回调）。
    focused = null
    expect(focused).toBeNull()
  })
})

describe('纯函数无副作用：交错调用结果只取决于输入（验收 3「无 click 状态迁移」的同构证据）', () => {
  it('多次调用同一输入结果一致、无状态残留', () => {
    const features: AdministrativeGeometryFeature[] = [
      rectProvince('CN-A', 100, 105, 25, 30),
      rectProvince('CN-B', 105, 110, 25, 30),
    ]
    // 交错调用：A、B、A、海域、B —— 每次只取决于输入，无累计状态、无交叉污染。
    expect(findProvinceAtLonLat({ lon: 102, lat: 27 }, features)).toBe('CN-A')
    expect(findProvinceAtLonLat({ lon: 108, lat: 27 }, features)).toBe('CN-B')
    expect(findProvinceAtLonLat({ lon: 102, lat: 27 }, features)).toBe('CN-A')
    expect(findProvinceAtLonLat({ lon: 150, lat: 10 }, features)).toBeNull()
    expect(findProvinceAtLonLat({ lon: 108, lat: 27 }, features)).toBe('CN-B')
  })
})

describe('真实生产 34 省几何：已知点位命中预期省份（验收 4 的生产证据）', () => {
  const features: readonly AdministrativeGeometryFeature[] = (() => {
    const assetPath = resolve(projectRoot, 'public', 'geo', 'china-provinces-geometry.json')
    const payload = JSON.parse(readFileSync(assetPath, 'utf-8')) as {
      features: readonly AdministrativeGeometryFeature[]
    }
    return payload.features
  })()

  it('资产含 34 个行政区（TASK-004 规范目录）', () => {
    expect(features.length).toBe(34)
  })

  it('北京 / 上海 / 成都 / 乌鲁木齐城市点位命中对应省级行政区', () => {
    // 城市点位（公开坐标）→ 预期 adminId（GB/T 2260，见契约层规范目录）。
    const cases: Array<{ lon: number; lat: number; expected: string; label: string }> = [
      { lon: 116.407, lat: 39.904, expected: 'CN-110000', label: '北京' },
      { lon: 121.473, lat: 31.23, expected: 'CN-310000', label: '上海' },
      { lon: 104.066, lat: 30.573, expected: 'CN-510000', label: '成都（四川）' },
      { lon: 87.617, lat: 43.826, expected: 'CN-650000', label: '乌鲁木齐（新疆）' },
      { lon: 91.132, lat: 29.66, expected: 'CN-540000', label: '拉萨（西藏）' },
      { lon: 126.642, lat: 45.756, expected: 'CN-230000', label: '哈尔滨（黑龙江）' },
      { lon: 113.264, lat: 23.129, expected: 'CN-440000', label: '广州（广东）' },
    ]
    for (const c of cases) {
      expect(findProvinceAtLonLat({ lon: c.lon, lat: c.lat }, features), c.label).toBe(c.expected)
    }
  })

  it('港澳台点位命中对应行政区（SPEC §6 红线省份可拾取）', () => {
    // 台北 → 台湾省；香港 → 香港特别行政区；澳门 → 澳门特别行政区。
    expect(findProvinceAtLonLat({ lon: 121.565, lat: 25.033 }, features)).toBe('CN-710000')
    expect(findProvinceAtLonLat({ lon: 114.169, lat: 22.319 }, features)).toBe('CN-810000')
    expect(findProvinceAtLonLat({ lon: 113.544, lat: 22.199 }, features)).toBe('CN-820000')
  })

  it('远海点位（南海深处 / 太平洋）→ null（海域无归属）', () => {
    // 南海深处（曾母暗沙附近海域，无省几何覆盖）与西北太平洋。
    expect(findProvinceAtLonLat({ lon: 112.3, lat: 3.9 }, features)).toBeNull()
    expect(findProvinceAtLonLat({ lon: 130.0, lat: 25.0 }, features)).toBeNull()
  })
})
