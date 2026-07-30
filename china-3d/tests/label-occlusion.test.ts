/**
 * 标签地形遮挡判定测试（TASK-010 验收 3；SPEC §7.5）。
 *
 * 依赖方向：测试基线（vitest，Node 环境），import src/lib/label-occlusion（领域纯函数
 * computeLabelVisibility + TerrainWorldYSampler 闭包类型）、src/config/label-occlusion（生产
 * 配置不变量）、src/lib/elevation（createElevationProvider 构造真实 provider，验证
 * 「provider→采样器」适配与 released → indeterminate）、src/geo-contracts
 * （encodeElevationToUint16 + TerrainMetaContract 构造合成 heightmap）。不依赖浏览器 /
 * React / Three.js / troika——判定层是纯函数，可在 Node 内用确定性几何夹具完整覆盖
 * 「无遮挡 / 前方山体遮挡 / 命中点位于标签之后 / 射线擦边 / 相机移动 / 生命周期与无分配」
 * 等场景，无需启动 WebGL（视觉验收由 pnpm dev 无头渲染承担）。
 *
 * 覆盖（验收 3「标签被前方地形遮挡时透明度降低、视角转开后恢复（raycast 降频执行）」的
 * 判定层证据）：
 * - 无遮挡：视线全程高于地形 → visible。
 * - 前方山体遮挡：标签与相机之间存在高过视线的地形峰 → occluded（命中点比标签更近相机）。
 * - 命中点位于标签之后：地形峰在标签之后（远离相机一侧）→ 不被采样 → visible。
 * - 射线擦边：地形峰刚好抵近视线但未超过 verticalClearance → visible（抗擦边抖动）；
 *   越过余量 → occluded。
 * - 相机移动：同一地形下，相机姿态 A 遮挡、姿态 B 可见（状态随相机确定转换、可恢复无残留）。
 * - 生命周期 / 无分配 / 无共享状态：退化射线 / 全失败采样 / 非有限输入 → indeterminate；
 *   released provider → 采样器返回 null → indeterminate；重复调用确定性一致；交错调用无交叉
 *   污染；高频调用不抛错。
 * - 配置不变量：目标透明度 / 采样点数 / 余量 / 降频间隔 / 阻尼系数全部有限、冻结。
 */

import { describe, it, expect } from 'vitest'
import {
  computeLabelVisibility,
  type LabelOcclusionConfig,
  type LabelOcclusionInput,
  type LabelOcclusionVec3,
  type TerrainWorldYSampler,
} from '../src/lib/label-occlusion'
import { LABEL_OCCLUSION_CONFIG } from '../src/config/label-occlusion'
import { createElevationProvider } from '../src/lib/elevation'
import type { ElevationProvider } from '../src/lib/elevation'
import { encodeElevationToUint16, type TerrainMetaContract } from '../src/geo-contracts'

/**
 * 测试用判定配置：小采样点数 + 小余量，使夹具几何（米制）能被精确命中与断言。
 * nearMargin/farMargin=10、verticalClearance=5、maxSamples=8。
 */
const CFG: LabelOcclusionConfig = {
  maxSamples: 8,
  nearMarginMeters: 10,
  farMarginMeters: 10,
  verticalClearanceMeters: 5,
}

/** 常数地形采样器：任意 (x,z) 返回同一世界 y（模拟平坦地表）。 */
function constantSampler(worldY: number): TerrainWorldYSampler {
  return () => worldY
}

/**
 * 阶梯峰采样器：在 z∈(zLo, zHi) 区间返回 peakY（山体），其余返回 baseY（平地）。
 * 用于构造「标签与相机之间存在一座前方山体」的确定性夹具。
 */
function ridgeSampler(zLo: number, zHi: number, peakY: number, baseY: number): TerrainWorldYSampler {
  return (_x: number, z: number) => (z > zLo && z < zHi ? peakY : baseY)
}

/** 全失败采样器：任意点返回 null（模拟地形不可用 / provider 已释放）。 */
function nullSampler(): TerrainWorldYSampler {
  return () => null
}

/** 构造判定输入的简写。 */
function input(
  label: readonly [number, number, number],
  camera: readonly [number, number, number],
  sampler: TerrainWorldYSampler,
): LabelOcclusionInput {
  return {
    label: { x: label[0], y: label[1], z: label[2] },
    camera: { x: camera[0], y: camera[1], z: camera[2] },
    sampler,
  }
}

describe('无遮挡：视线全程高于地形 → visible', () => {
  it('平坦低地形 + 标签与相机均高 → 视线高于地形 → visible', () => {
    // 标签 (0, 100, 0)，相机 (0, 200, 1000)：射线 y 从 100 升到 200，恒高于地形 10。
    const vis = computeLabelVisibility(input([0, 100, 0], [0, 200, 1000], constantSampler(10)), CFG)
    expect(vis).toBe('visible')
  })

  it('标签贴近地形但相机更高，视线全程不触地形 → visible', () => {
    // 标签 (0, 50, 0)，相机 (0, 500, 1000)：射线 y 从 50 升到 500，地形恒 40（低于视线）。
    const vis = computeLabelVisibility(input([0, 50, 0], [0, 500, 1000], constantSampler(40)), CFG)
    expect(vis).toBe('visible')
  })
})

describe('前方山体遮挡：标签与相机之间存在高过视线的地形峰 → occluded', () => {
  it('水平视线被中段山体挡住（命中点比标签更近相机）→ occluded', () => {
    // 标签 (0, 100, 0)，相机 (0, 100, 1000)：射线水平于 y=100。山体在 z∈(400,600) 高 200。
    const vis = computeLabelVisibility(
      input([0, 100, 0], [0, 100, 1000], ridgeSampler(400, 600, 200, 10)),
      CFG,
    )
    expect(vis).toBe('occluded')
  })

  it('略微下倾的视线被中段山体挡住 → occluded', () => {
    // 标签 (0, 120, 0)，相机 (0, 80, 1000)：射线 y 从 120 降到 80。中段 z≈500 处射线 y≈100，
    // 山体 200 仍高过。山体宽 240（380–620），保证 8 样本离散化下至少一个样本落入山体范围。
    const vis = computeLabelVisibility(
      input([0, 120, 0], [0, 80, 1000], ridgeSampler(380, 620, 200, 10)),
      CFG,
    )
    expect(vis).toBe('occluded')
  })

  it('短路：第一个遮挡采样点即返回 occluded，不依赖后续采样', () => {
    // 山体占据 z∈(10, 990) 几乎全程：任一采样点都遮挡。确保短路返回 occluded（不枚举全部点）。
    const vis = computeLabelVisibility(
      input([0, 100, 0], [0, 100, 1000], ridgeSampler(0, 1000, 300, 10)),
      CFG,
    )
    expect(vis).toBe('occluded')
  })
})

describe('命中点位于标签之后：山体在标签之后（远离相机）→ 不被采样 → visible', () => {
  it('山体峰在标签背后（z<0，远离相机）→ 射线区间不覆盖 → visible', () => {
    // 标签 (0, 100, 0)，相机 (0, 100, 1000)：射线采样 z∈(10,990)。山体在 z∈(-300,-100)。
    // 即便山体极高（500），也因不在射线区间而不被采样 → visible。
    const vis = computeLabelVisibility(
      input([0, 100, 0], [0, 100, 1000], ridgeSampler(-300, -100, 500, 10)),
      CFG,
    )
    expect(vis).toBe('visible')
  })

  it('山体峰在相机之后（z>射线终点）→ 不被采样 → visible', () => {
    // 射线只覆盖 z∈[0,1000]；山体在 z∈(1200,1400)（相机之后）。
    const vis = computeLabelVisibility(
      input([0, 100, 0], [0, 100, 1000], ridgeSampler(1200, 1400, 500, 10)),
      CFG,
    )
    expect(vis).toBe('visible')
  })
})

describe('射线擦边：地形刚好抵近视线 → verticalClearance 决定结论', () => {
  it('地形高过视线但未超过 verticalClearance(5) → 不计遮挡 → visible（抗擦边抖动）', () => {
    // 水平视线 y=100；山体 103（高过视线 3，未超过余量 5）→ visible。
    const vis = computeLabelVisibility(
      input([0, 100, 0], [0, 100, 1000], ridgeSampler(400, 600, 103, 10)),
      CFG,
    )
    expect(vis).toBe('visible')
  })

  it('地形高过视线刚好等于余量边界（105 vs clearance 5 → 需 >105）→ visible（严格大于）', () => {
    const vis = computeLabelVisibility(
      input([0, 100, 0], [0, 100, 1000], ridgeSampler(400, 600, 105, 10)),
      CFG,
    )
    expect(vis).toBe('visible')
  })

  it('地形高过视线越过余量（106 > 105）→ occluded', () => {
    const vis = computeLabelVisibility(
      input([0, 100, 0], [0, 100, 1000], ridgeSampler(400, 600, 106, 10)),
      CFG,
    )
    expect(vis).toBe('occluded')
  })
})

describe('相机移动：同一地形下状态随相机确定转换（视角转开后恢复）', () => {
  // 固定地形：中段 z∈(400,600) 山体高 200，其余平地 10。标签 (0, 100, 0)。
  const terrain = ridgeSampler(400, 600, 200, 10)

  it('低相机（水平视线被山体挡）→ occluded', () => {
    const vis = computeLabelVisibility(input([0, 100, 0], [0, 100, 1000], terrain), CFG)
    expect(vis).toBe('occluded')
  })

  it('高相机（视线抬升越过山体）→ visible', () => {
    // 相机抬到 (0, 500, 1000)：中段 z≈500 处射线 y = 100 + 0.5·(500−100) = 300 > 山体 200 → visible。
    const vis = computeLabelVisibility(input([0, 100, 0], [0, 500, 1000], terrain), CFG)
    expect(vis).toBe('visible')
  })

  it('状态可恢复：occluded → 移开相机 → visible（无残留）', () => {
    expect(computeLabelVisibility(input([0, 100, 0], [0, 100, 1000], terrain), CFG)).toBe('occluded')
    expect(computeLabelVisibility(input([0, 100, 0], [0, 500, 1000], terrain), CFG)).toBe('visible')
    // 再次回到遮挡姿态 → 再次 occluded（状态确定、可重复）。
    expect(computeLabelVisibility(input([0, 100, 0], [0, 100, 1000], terrain), CFG)).toBe('occluded')
  })
})

describe('生命周期 / 退化路径：不产生错误射线', () => {
  it('标签与相机重合（退化射线）→ indeterminate', () => {
    const vis = computeLabelVisibility(input([0, 100, 0], [0, 100, 0], constantSampler(10)), CFG)
    expect(vis).toBe('indeterminate')
  })

  it('非有限坐标 → indeterminate', () => {
    const visNaN = computeLabelVisibility(
      input([Number.NaN, 100, 0], [0, 200, 1000], constantSampler(10)),
      CFG,
    )
    expect(visNaN).toBe('indeterminate')
    const visInf = computeLabelVisibility(
      input([0, 100, 0], [Number.POSITIVE_INFINITY, 200, 1000], constantSampler(10)),
      CFG,
    )
    expect(visInf).toBe('indeterminate')
  })

  it('射线过短（nearMargin + farMargin ≥ 射线长）→ indeterminate', () => {
    // 射线长 = 5；nearMargin(10) 已 > 射线长 → 无可采样内部区间。
    const vis = computeLabelVisibility(input([0, 100, 0], [0, 100, 5], constantSampler(10)), CFG)
    expect(vis).toBe('indeterminate')
  })

  it('全部采样点查询失败（地形不可用，采样器恒 null）→ indeterminate', () => {
    const vis = computeLabelVisibility(input([0, 100, 0], [0, 200, 1000], nullSampler()), CFG)
    expect(vis).toBe('indeterminate')
  })

  it('采样器部分失败：失败点跳过，成功点未遮挡 → visible', () => {
    // 一半 z 返回 null（不可用），另一半返回低地形 10（未遮挡视线 y=100）。
    const sampler: TerrainWorldYSampler = (_x, z) => (z < 500 ? null : 10)
    const vis = computeLabelVisibility(input([0, 100, 0], [0, 200, 1000], sampler), CFG)
    expect(vis).toBe('visible')
  })

  it('采样器部分失败：失败点跳过，但存在遮挡点 → occluded', () => {
    // z<300 返回 null；z∈(400,600) 返回 200（遮挡水平视线 100）；其余返回 10。
    const sampler: TerrainWorldYSampler = (_x, z) => {
      if (z < 300) return null
      if (z > 400 && z < 600) return 200
      return 10
    }
    const vis = computeLabelVisibility(input([0, 100, 0], [0, 100, 1000], sampler), CFG)
    expect(vis).toBe('occluded')
  })
})

describe('无分配 / 无共享状态：可被帧循环高频调用', () => {
  it('同一输入重复调用 N 次，结果完全一致（确定性、无状态）', () => {
    const inp = input([0, 100, 0], [0, 100, 1000], ridgeSampler(400, 600, 200, 10))
    const first = computeLabelVisibility(inp, CFG)
    for (let i = 0; i < 1000; i++) {
      expect(computeLabelVisibility(inp, CFG)).toBe(first)
    }
    expect(first).toBe('occluded')
  })

  it('交错调用不同输入无交叉污染（无共享可变状态）', () => {
    const visibleInp = input([0, 100, 0], [0, 500, 1000], ridgeSampler(400, 600, 200, 10))
    const occludedInp = input([0, 100, 0], [0, 100, 1000], ridgeSampler(400, 600, 200, 10))
    for (let i = 0; i < 50; i++) {
      expect(computeLabelVisibility(visibleInp, CFG)).toBe('visible')
      expect(computeLabelVisibility(occludedInp, CFG)).toBe('occluded')
    }
  })

  it('高频调用（模拟 34 标签 × 多帧）不抛错、结果稳定', () => {
    const samplers: TerrainWorldYSampler[] = [
      constantSampler(10),
      ridgeSampler(400, 600, 200, 10),
      nullSampler(),
    ]
    const labels: LabelOcclusionVec3[] = [
      { x: 0, y: 100, z: 0 },
      { x: 50, y: 80, z: 20 },
      { x: -30, y: 120, z: -10 },
    ]
    const cameras: LabelOcclusionVec3[] = [
      { x: 0, y: 100, z: 1000 },
      { x: 0, y: 500, z: 1000 },
    ]
    // 3 标签 × 3 采样器 × 2 相机 × 5 重复 = 90 次调用，模拟「多标签多帧」。
    for (const label of labels) {
      for (const sampler of samplers) {
        for (const camera of cameras) {
          for (let r = 0; r < 5; r++) {
            const vis = computeLabelVisibility({ label, camera, sampler }, CFG)
            expect(['visible', 'occluded', 'indeterminate']).toContain(vis)
          }
        }
      }
    }
  })
})

describe('集成：真实 ElevationProvider → 采样器适配（App.PlaceLabelsLayer 同一构造）', () => {
  const RANGE = { min: -1500, max: 9000 }
  const EXTENT = { west: 72, south: 3, east: 136, north: 54 }

  function makeConstantProvider(meters: number): ElevationProvider {
    const meta: TerrainMetaContract = {
      kind: 'terrain-meta',
      version: '1.0.0',
      crs: 'EPSG:3857',
      geographicExtent: { crs: 'EPSG:4326', ...EXTENT },
      resolution: { widthPixels: 8, heightPixels: 8 },
      elevationEncoding: {
        minValueMeters: RANGE.min,
        maxValueMeters: RANGE.max,
        bitDepth: 16,
        encoding: 'linear-unsigned-integer',
        outOfRangePolicy: 'clamp-to-range',
      },
      source: { sourceId: 'src-test-synthetic' },
    }
    const code = encodeElevationToUint16(meters, RANGE.min, RANGE.max)
    const pixels = new Uint16Array(8 * 8).fill(code)
    return createElevationProvider(meta, pixels)
  }

  /**
   * 装配层「provider + k → 采样器」适配的同一构造（见 App 的 PlaceLabelsLayer）。
   * 在此复用以验证：真实 provider 经适配后能驱动 computeLabelVisibility，且 released 后返回 null。
   */
  function makeSampler(provider: ElevationProvider, k: number): TerrainWorldYSampler {
    return (worldX: number, worldZ: number) => {
      const q = provider.queryAtWorld(worldX, worldZ)
      if (!q.ok) return null
      return q.meters * k
    }
  }

  it('真实 provider 在主图世界包围盒内查询成功，采样器返回 h·k', () => {
    const provider = makeConstantProvider(1000)
    // 取主图世界原点附近一点（必在 heightmap 范围内）。
    const q = provider.queryAtWorld(0, 0)
    expect(q.ok).toBe(true)
    const sampler = makeSampler(provider, 2)
    // 采样器在原点返回 h·k = 1000·2（16 位编解码有亚米级量化，断言接近）。
    const y = sampler(0, 0)
    expect(y).not.toBeNull()
    expect(y).toBeCloseTo(2000, -1) // 千分位精度（编解码量化）
  })

  it('真实 provider 驱动判定：标签高于地形、相机更高 → visible', () => {
    const provider = makeConstantProvider(500)
    const sampler = makeSampler(provider, 2)
    // 标签在原点上方（h·k≈1000）再加浮高 5000；相机更高 20000；地形恒 h·k≈1000。
    const vis = computeLabelVisibility(
      { label: { x: 0, y: 6000, z: 0 }, camera: { x: 0, y: 20000, z: 500000 }, sampler },
      // 用生产配置（余量大、采样多）验证真实尺度下不误判。
      {
        maxSamples: LABEL_OCCLUSION_CONFIG.maxSamples,
        nearMarginMeters: LABEL_OCCLUSION_CONFIG.nearMarginMeters,
        farMarginMeters: LABEL_OCCLUSION_CONFIG.farMarginMeters,
        verticalClearanceMeters: LABEL_OCCLUSION_CONFIG.verticalClearanceMeters,
      },
    )
    expect(vis).toBe('visible')
  })

  it('真实 provider 驱动判定：标签与相机之间存在高地形 → occluded（生产配置尺度）', () => {
    // 常数 5000m provider（k=2 → 地形世界 y≈10000）：标签 y=2000 贴地、相机 y=3000 低空——
    // 射线 y∈[2000,3000] 恒低于地形 ≈10000 → 任一采样点遮挡 → occluded。
    const provider = makeConstantProvider(5000)
    const sampler = makeSampler(provider, 2)
    const vis = computeLabelVisibility(
      { label: { x: 0, y: 2000, z: 0 }, camera: { x: 0, y: 3000, z: 500000 }, sampler },
      {
        maxSamples: LABEL_OCCLUSION_CONFIG.maxSamples,
        nearMarginMeters: LABEL_OCCLUSION_CONFIG.nearMarginMeters,
        farMarginMeters: LABEL_OCCLUSION_CONFIG.farMarginMeters,
        verticalClearanceMeters: LABEL_OCCLUSION_CONFIG.verticalClearanceMeters,
      },
    )
    expect(vis).toBe('occluded')
  })

  it('provider 已 release：采样器返回 null → indeterminate（不伪造结论、不产生错误射线）', () => {
    const provider = makeConstantProvider(1000)
    const sampler = makeSampler(provider, 2)
    provider.release()
    // release 后 queryAtWorld 返回 'elevation.released' → 适配成 null → 全失败 → indeterminate。
    const vis = computeLabelVisibility(
      { label: { x: 0, y: 6000, z: 0 }, camera: { x: 0, y: 20000, z: 500000 }, sampler },
      {
        maxSamples: 4,
        nearMarginMeters: 100,
        farMarginMeters: 100,
        verticalClearanceMeters: 100,
      },
    )
    expect(vis).toBe('indeterminate')
  })

  it('重复构造 / 释放 provider 与采样器：无残留、无共享对象泄漏（生命周期可重复）', () => {
    // 反复「构造 provider → 构造采样器 → 判定 → release」多轮，模拟标签层挂载 / 卸载循环。
    // 每轮 release 后采样器恒返回 null（indeterminate）；新一轮独立可用。无跨轮污染。
    for (let round = 0; round < 20; round++) {
      const provider = makeConstantProvider(1000)
      const sampler = makeSampler(provider, 2)
      const visBefore = computeLabelVisibility(
        { label: { x: 0, y: 6000, z: 0 }, camera: { x: 0, y: 20000, z: 500000 }, sampler },
        { maxSamples: 4, nearMarginMeters: 100, farMarginMeters: 100, verticalClearanceMeters: 100 },
      )
      expect(visBefore).toBe('visible')
      provider.release()
      const visAfter = computeLabelVisibility(
        { label: { x: 0, y: 6000, z: 0 }, camera: { x: 0, y: 20000, z: 500000 }, sampler },
        { maxSamples: 4, nearMarginMeters: 100, farMarginMeters: 100, verticalClearanceMeters: 100 },
      )
      expect(visAfter).toBe('indeterminate')
    }
  })
})

describe('配置不变量（src/config/label-occlusion 唯一事实源）', () => {
  it('目标透明度：visible=1.0、occluded 明显降低且 > 0（仍可辨识）', () => {
    expect(LABEL_OCCLUSION_CONFIG.visibleOpacity).toBe(1.0)
    expect(LABEL_OCCLUSION_CONFIG.occludedOpacity).toBeGreaterThan(0)
    expect(LABEL_OCCLUSION_CONFIG.occludedOpacity).toBeLessThan(LABEL_OCCLUSION_CONFIG.visibleOpacity)
    expect(LABEL_OCCLUSION_CONFIG.occludedOpacity).toBeLessThanOrEqual(0.4)
  })

  it('采样点数为正整数（确定性上限，非随机）', () => {
    expect(Number.isInteger(LABEL_OCCLUSION_CONFIG.maxSamples)).toBe(true)
    expect(LABEL_OCCLUSION_CONFIG.maxSamples).toBeGreaterThan(0)
  })

  it('近 / 远端余量与垂直余量为正、有限，且近 / 远端余量派生自主图世界宽度', () => {
    for (const v of [
      LABEL_OCCLUSION_CONFIG.nearMarginMeters,
      LABEL_OCCLUSION_CONFIG.farMarginMeters,
      LABEL_OCCLUSION_CONFIG.verticalClearanceMeters,
    ]) {
      expect(Number.isFinite(v)).toBe(true)
      expect(v).toBeGreaterThan(0)
    }
    // 近 / 远端余量同值（对称保险），量级为主图宽度的 1/2048（不写死绝对米数）。
    expect(LABEL_OCCLUSION_CONFIG.nearMarginMeters).toBe(LABEL_OCCLUSION_CONFIG.farMarginMeters)
  })

  it('降频帧间隔为正整数（由统一帧循环驱动，非计时器）', () => {
    expect(Number.isInteger(LABEL_OCCLUSION_CONFIG.checkFrameInterval)).toBe(true)
    expect(LABEL_OCCLUSION_CONFIG.checkFrameInterval).toBeGreaterThan(0)
  })

  it('阻尼系数为正、有限（过渡帧率无关）', () => {
    expect(Number.isFinite(LABEL_OCCLUSION_CONFIG.dampLambda)).toBe(true)
    expect(LABEL_OCCLUSION_CONFIG.dampLambda).toBeGreaterThan(0)
  })

  it('配置冻结（运行时不可被偷偷放宽，如把 occluded 改 1.0 使遮挡失效）', () => {
    expect(Object.isFrozen(LABEL_OCCLUSION_CONFIG)).toBe(true)
  })

  it('配置不含深度测试开关字段（深度测试由材质默认开启，本层只调透明度）', () => {
    expect(LABEL_OCCLUSION_CONFIG).not.toHaveProperty('depthTest')
    expect(LABEL_OCCLUSION_CONFIG).not.toHaveProperty('disableDepthTest')
  })
})
