/**
 * 4K 大屏渲染性能预算的不变量测试（TASK-023 验证方式 1）。
 *
 * 依赖方向：测试基线（vitest，Node 环境），import src/config/render-budget（纯 TS，不依赖 three / React /
 * DOM）、src/config/terrain-config（生产默认 / 上限网格分段唯一源）。性能预算配置是冻结常量 + 纯函数，
 * 可在 Node 内完整断言「DPR 上限 ≤ 2」「渲染目标为标准 1080p / 4K 档」「显存预算有限且与 SPEC §7.2
 * 量级一致」「draw call 预算为正整数」「4096² 默认不启用且无自动升级」「无运行时流式 / 低清 fallback」
 * 「逐帧分配被禁止」等不变量，无需启动浏览器 / WebGL（人工 1080p / 4K 持续帧率验收留给 TASK-023 验证
 * 方式 3、4、5，由用户在目标独显设备手动执行并记录到 docs/performance-measurement-record.md）。
 *
 * 覆盖（TASK-023 验证方式 1「DPR 上限、生产默认/上限网格档位、无自动升级和性能配置边界测试通过」）：
 * - DPR 上限 ≤ 2、下限 ≥ 1、下限 ≤ 上限（SPEC §7.3、TASK-023 输出约束）。
 * - 渲染目标为标准 1080p（1920×1080）/ 4K（3840×2160）档。
 * - 显存预算：heightmap 纹理 ≈ 32MB、默认档 plane ≈ 134MB、上限档 plane ≈ 537MB，均有限且与 SPEC §7.2
 *   量级一致；默认档顶点数 << 上限档。
 * - draw call 预算：省界 / 十段线预算为正整数，与结构性计数一致。
 * - 4096² 不自动升级：UPPER_TIER_AUTO_UPGRADE_ENABLED=false；resolveTerrainConfig 默认 = 2048、不会
 *   因任何入参「自动」升到 4096（必须显式 meshSegments=4096）。
 * - 无运行时流式 / 低清 fallback：两个开关结构性 false。
 * - 逐帧分配被禁止：PER_FRAME_ALLOCATION_FORBIDDEN=true。
 * - 绘制缓冲像素数在 DPR 上限内有限（4K @ DPR 2 ≈ 33.2M，可枚举）。
 * - 配置冻结：预算对象运行时不可被偷偷放宽（如把 dprMax 改 3、把 autoUpgrade 改 true）。
 */

import { describe, it, expect } from 'vitest'
import {
  AUTO_LOW_RES_FALLBACK_ENABLED,
  HEIGHTMAP_TEXTURE_BYTES_EXPECTED,
  HEIGHTMAP_TEXTURE_TEXELS_PER_SIDE,
  HEIGHTMAP_TEXEL_BYTES,
  NINE_DASH_LINE_DRAW_CALL_BUDGET,
  PER_FRAME_ALLOCATION_FORBIDDEN,
  PLANE_GEOMETRY_BYTES_DEFAULT,
  PLANE_GEOMETRY_BYTES_UPPER,
  PLANE_VERTEX_ATTRIBUTE_BYTES,
  PLANE_VERTEX_COUNT_DEFAULT,
  PLANE_VERTEX_COUNT_UPPER,
  PROVINCE_ADMIN_REGION_COUNT_MAX,
  PROVINCE_BORDER_DRAW_CALL_BUDGET,
  RENDER_BUDGET_CONFIG,
  RENDER_DPR_MAX,
  RENDER_DPR_MIN,
  RENDER_TARGET_1080P,
  RENDER_TARGET_4K,
  RUNTIME_STREAMING_ENABLED,
  UPPER_TIER_AUTO_UPGRADE_ENABLED,
  UPPER_TIER_MESH_SEGMENTS,
  computeDrawBufferPixels,
  planeVertexCount,
} from '../src/config/render-budget'
import {
  PRODUCTION_TERRAIN_CONFIG,
  TERRAIN_MESH_SEGMENTS_DEFAULT,
  TERRAIN_MESH_SEGMENTS_MAX,
  TEST_TERRAIN_CONFIG,
  resolveTerrainConfig,
} from '../src/config/terrain-config'

describe('DPR 上限：生产渲染 DPR ≤ 2（SPEC §7.3、TASK-023 输出约束）', () => {
  it('dprMax = 2（不超过 2）', () => {
    expect(RENDER_DPR_MAX).toBe(2)
    expect(RENDER_BUDGET_CONFIG.dprMax).toBe(2)
  })

  it('dprMin = 1（保证最低绘制不模糊）', () => {
    expect(RENDER_DPR_MIN).toBe(1)
    expect(RENDER_BUDGET_CONFIG.dprMin).toBe(1)
  })

  it('dprMin ≤ dprMax（区间合法）', () => {
    expect(RENDER_DPR_MIN).toBeLessThanOrEqual(RENDER_DPR_MAX)
    expect(RENDER_BUDGET_CONFIG.dprMin).toBeLessThanOrEqual(RENDER_BUDGET_CONFIG.dprMax)
  })
})

describe('渲染目标尺寸：标准 1080p / 4K 档（TASK-023 输出约束「明确的渲染目标」）', () => {
  it('1080p = 1920×1080（FHD 标准档）', () => {
    expect(RENDER_TARGET_1080P.width).toBe(1920)
    expect(RENDER_TARGET_1080P.height).toBe(1080)
    expect(RENDER_BUDGET_CONFIG.target1080p.width).toBe(1920)
    expect(RENDER_BUDGET_CONFIG.target1080p.height).toBe(1080)
  })

  it('4K = 3840×2160（UHD-1 标准档）', () => {
    expect(RENDER_TARGET_4K.width).toBe(3840)
    expect(RENDER_TARGET_4K.height).toBe(2160)
    expect(RENDER_BUDGET_CONFIG.target4k.width).toBe(3840)
    expect(RENDER_BUDGET_CONFIG.target4k.height).toBe(2160)
  })

  it('4K 像素数 = 1080p 的 4 倍（标准档位关系，验收不以自定义分辨率绕过）', () => {
    const ratio =
      (RENDER_TARGET_4K.width * RENDER_TARGET_4K.height) /
      (RENDER_TARGET_1080P.width * RENDER_TARGET_1080P.height)
    expect(ratio).toBe(4)
  })
})

describe('绘制缓冲：DPR 上限内像素数有限（SPEC §7.3 爆显存防护）', () => {
  it('1080p @ DPR 2 = 1920·1080·4 ≈ 8.3M 像素（独显无压力）', () => {
    const pixels = computeDrawBufferPixels(RENDER_TARGET_1080P, RENDER_DPR_MAX)
    expect(pixels).toBe(1920 * 1080 * 4)
    expect(pixels).toBeLessThan(10_000_000)
  })

  it('4K @ DPR 2 = 3840·2160·4 ≈ 33.2M 像素（大屏独显合理上限）', () => {
    const pixels = computeDrawBufferPixels(RENDER_TARGET_4K, RENDER_DPR_MAX)
    expect(pixels).toBe(3840 * 2160 * 4)
    // 33.2M 量级，断言有限且在合理上限内（远低于 1 亿）。
    expect(pixels).toBeLessThan(100_000_000)
  })

  it('DPR 越大绘制缓冲越大（DPR 上限的预算意义）', () => {
    const atDpr1 = computeDrawBufferPixels(RENDER_TARGET_4K, 1)
    const atDpr2 = computeDrawBufferPixels(RENDER_TARGET_4K, 2)
    expect(atDpr2).toBe(atDpr1 * 4)
  })
})

describe('显存预算：与 SPEC §7.2 量级一致且有限（TASK-023 输出约束「显存预算」）', () => {
  it('heightmap 纹理源数据 ≈ 32MB（4096²·2 字节，SPEC §7.2「R16 ≈ 32MB」）', () => {
    expect(HEIGHTMAP_TEXTURE_TEXELS_PER_SIDE).toBe(4096)
    expect(HEIGHTMAP_TEXEL_BYTES).toBe(2)
    const mb = HEIGHTMAP_TEXTURE_BYTES_EXPECTED / (1024 * 1024)
    // 4096·4096·2 = 33_554_432 字节 ≈ 32.0 MiB / 33.55 MB。
    expect(HEIGHTMAP_TEXTURE_BYTES_EXPECTED).toBe(4096 * 4096 * 2)
    expect(mb).toBeGreaterThan(31)
    expect(mb).toBeLessThan(34)
    expect(RENDER_BUDGET_CONFIG.heightmapTextureBytesExpected).toBe(HEIGHTMAP_TEXTURE_BYTES_EXPECTED)
  })

  it('plane 每顶点属性 = 32 字节（position 3 + uv 2 + normal 3 = 8 float）', () => {
    expect(PLANE_VERTEX_ATTRIBUTE_BYTES).toBe(32)
  })

  it('planeVertexCount(seg) = (seg+1)²（PlaneGeometry 顶点数公式）', () => {
    expect(planeVertexCount(2048)).toBe(2049 * 2049)
    expect(planeVertexCount(4096)).toBe(4097 * 4097)
    expect(planeVertexCount(1)).toBe(4)
  })

  it('默认档（2048²）顶点数 ≈ 4.19M（SPEC §7.2「≈ 4.2M 顶点」）', () => {
    const m = PLANE_VERTEX_COUNT_DEFAULT / 1_000_000
    expect(PLANE_VERTEX_COUNT_DEFAULT).toBe((TERRAIN_MESH_SEGMENTS_DEFAULT + 1) ** 2)
    expect(m).toBeGreaterThan(4.0)
    expect(m).toBeLessThan(4.4)
  })

  it('上限档（4096²）顶点数 ≈ 16.78M（SPEC §7.2「≈ 16.7M 顶点」）', () => {
    const m = PLANE_VERTEX_COUNT_UPPER / 1_000_000
    expect(PLANE_VERTEX_COUNT_UPPER).toBe((TERRAIN_MESH_SEGMENTS_MAX + 1) ** 2)
    expect(m).toBeGreaterThan(16.5)
    expect(m).toBeLessThan(17.0)
  })

  it('默认档 plane 几何预算 ≈ 134MB（SPEC §7.2「≈ 100MB」量级一致）', () => {
    const mb = PLANE_GEOMETRY_BYTES_DEFAULT / (1024 * 1024)
    expect(PLANE_GEOMETRY_BYTES_DEFAULT).toBe(PLANE_VERTEX_COUNT_DEFAULT * PLANE_VERTEX_ATTRIBUTE_BYTES)
    // 4.19M · 32 B ≈ 134.2 MB；SPEC §7.2 的 100MB 是保守估算，本测试按精确系数断言量级（> 100MB）。
    expect(mb).toBeGreaterThan(100)
    expect(mb).toBeLessThan(160)
  })

  it('上限档 plane 几何预算 ≈ 537MB（SPEC §7.2「≈ 400MB」量级一致；临界档）', () => {
    const mb = PLANE_GEOMETRY_BYTES_UPPER / (1024 * 1024)
    expect(PLANE_GEOMETRY_BYTES_UPPER).toBe(PLANE_VERTEX_COUNT_UPPER * PLANE_VERTEX_ATTRIBUTE_BYTES)
    // 16.78M · 32 B ≈ 537 MB；SPEC §7.2 的 400MB 是保守估算，本测试按精确系数断言量级（> 400MB）。
    expect(mb).toBeGreaterThan(400)
    expect(mb).toBeLessThan(700)
  })

  it('默认档顶点数 << 上限档（默认档是「独显无压力」，上限档是「临界」）', () => {
    expect(PLANE_VERTEX_COUNT_DEFAULT).toBeLessThan(PLANE_VERTEX_COUNT_UPPER)
    // 上限档约为默认档的 4 倍（(4097/2049)² ≈ 4.0）。
    const ratio = PLANE_VERTEX_COUNT_UPPER / PLANE_VERTEX_COUNT_DEFAULT
    expect(ratio).toBeGreaterThan(3.9)
    expect(ratio).toBeLessThan(4.1)
  })

  it('所有显存预算字段有限为正（无 NaN / Infinity / 负值混入）', () => {
    for (const v of [
      HEIGHTMAP_TEXTURE_BYTES_EXPECTED,
      PLANE_VERTEX_ATTRIBUTE_BYTES,
      PLANE_VERTEX_COUNT_DEFAULT,
      PLANE_VERTEX_COUNT_UPPER,
      PLANE_GEOMETRY_BYTES_DEFAULT,
      PLANE_GEOMETRY_BYTES_UPPER,
    ]) {
      expect(Number.isFinite(v)).toBe(true)
      expect(v).toBeGreaterThan(0)
    }
  })
})

describe('draw call 预算：结构性计数为正整数（TASK-023 输出约束「关键 draw call」）', () => {
  it('省级行政区上限 = 34（SPEC §2「省级 34 个省级行政区」）', () => {
    expect(PROVINCE_ADMIN_REGION_COUNT_MAX).toBe(34)
    expect(RENDER_BUDGET_CONFIG.provinceAdminRegionCountMax).toBe(34)
  })

  it('省界 draw call 预算 = 34（每行政区一个 LineSegments2，hover 可寻址）', () => {
    expect(PROVINCE_BORDER_DRAW_CALL_BUDGET).toBe(34)
    expect(PROVINCE_BORDER_DRAW_CALL_BUDGET).toBe(PROVINCE_ADMIN_REGION_COUNT_MAX)
    expect(RENDER_BUDGET_CONFIG.provinceBorderDrawCallBudget).toBe(34)
  })

  it('十段线 draw call 预算 = 12（每段一个 LineSegments2，含台湾东侧段独立审计）', () => {
    expect(NINE_DASH_LINE_DRAW_CALL_BUDGET).toBe(12)
    expect(RENDER_BUDGET_CONFIG.nineDashLineDrawCallBudget).toBe(12)
    // 标准十段线（十段画法）为 10 段，预算 ≥ 10 留余量。
    expect(NINE_DASH_LINE_DRAW_CALL_BUDGET).toBeGreaterThanOrEqual(10)
  })

  it('draw call 预算字段为正整数（无分数 / 非有限）', () => {
    for (const v of [PROVINCE_BORDER_DRAW_CALL_BUDGET, NINE_DASH_LINE_DRAW_CALL_BUDGET]) {
      expect(Number.isInteger(v)).toBe(true)
      expect(v).toBeGreaterThan(0)
    }
  })
})

describe('4096² 档位：显式可选、默认不启用、不自动升级（TASK-023 核心约束）', () => {
  it('UPPER_TIER_AUTO_UPGRADE_ENABLED = false（不自动升级）', () => {
    expect(UPPER_TIER_AUTO_UPGRADE_ENABLED).toBe(false)
    expect(RENDER_BUDGET_CONFIG.upperTierAutoUpgradeEnabled).toBe(false)
  })

  it('UPPER_TIER_MESH_SEGMENTS = 4096（= TERRAIN_MESH_SEGMENTS_MAX，上限档命名锚点）', () => {
    expect(UPPER_TIER_MESH_SEGMENTS).toBe(4096)
    expect(UPPER_TIER_MESH_SEGMENTS).toBe(TERRAIN_MESH_SEGMENTS_MAX)
    expect(RENDER_BUDGET_CONFIG.upperTierMeshSegments).toBe(4096)
  })

  it('生产默认 meshSegments = 2048（未被偷偷改低或改高）', () => {
    expect(PRODUCTION_TERRAIN_CONFIG.meshSegments).toBe(2048)
    expect(TERRAIN_MESH_SEGMENTS_DEFAULT).toBe(2048)
  })

  it('resolveTerrainConfig 默认（省略入参）= 2048，不会自动升到 4096', () => {
    const r = resolveTerrainConfig({})
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.meshSegments).toBe(2048)
      // 显式断言默认不是 4096（捕获任何「默认即上限档」的回归）。
      expect(r.meshSegments).not.toBe(4096)
    }
  })

  it('resolveTerrainConfig 不存在「检测 GPU / 帧率后自动升级」路径：只有显式 meshSegments=4096 才得上限档', () => {
    // 省略 meshSegments → 2048（默认）。
    expect(resolveTerrainConfig({}).ok && (resolveTerrainConfig({}) as { meshSegments: number }).meshSegments).toBe(2048)
    // 显式 2048 → 2048。
    const r2048 = resolveTerrainConfig({ meshSegments: 2048 })
    expect(r2048.ok && r2048.meshSegments).toBe(2048)
    // 显式 4096 → 4096（唯一启用上限档的路径）。
    const r4096 = resolveTerrainConfig({ meshSegments: 4096 })
    expect(r4096.ok && r4096.meshSegments).toBe(4096)
  })

  it('测试档（64²）仍低于生产默认（测试配置与生产配置边界清楚，不污染生产默认）', () => {
    expect(TEST_TERRAIN_CONFIG.meshSegments).toBe(64)
    expect(TEST_TERRAIN_CONFIG.meshSegments).toBeLessThan(PRODUCTION_TERRAIN_CONFIG.meshSegments)
  })
})

describe('无运行时流式 / 自动低清 fallback（TASK-023 输出约束）', () => {
  it('RUNTIME_STREAMING_ENABLED = false（不引入运行时流式网络）', () => {
    expect(RUNTIME_STREAMING_ENABLED).toBe(false)
    expect(RENDER_BUDGET_CONFIG.runtimeStreamingEnabled).toBe(false)
  })

  it('AUTO_LOW_RES_FALLBACK_ENABLED = false（不引入自动低清 fallback 伪造通过）', () => {
    expect(AUTO_LOW_RES_FALLBACK_ENABLED).toBe(false)
    expect(RENDER_BUDGET_CONFIG.autoLowResFallbackEnabled).toBe(false)
  })
})

describe('逐帧分配被禁止（TASK-023 输出约束「禁止逐帧创建几何/纹理、大数组或新的 Clock」）', () => {
  it('PER_FRAME_ALLOCATION_FORBIDDEN = true（结构性不变量锚点）', () => {
    expect(PER_FRAME_ALLOCATION_FORBIDDEN).toBe(true)
    expect(RENDER_BUDGET_CONFIG.perFrameAllocationForbidden).toBe(true)
  })
})

describe('配置冻结：运行时不可被偷偷放宽（TASK-023 完成标准「没有……重复资源或跨层耦合」）', () => {
  it('RENDER_BUDGET_CONFIG 冻结', () => {
    expect(Object.isFrozen(RENDER_BUDGET_CONFIG)).toBe(true)
  })

  it('渲染目标尺寸对象冻结（不被偷偷改成自定义分辨率绕过 1080p / 4K 验收）', () => {
    expect(Object.isFrozen(RENDER_TARGET_1080P)).toBe(true)
    expect(Object.isFrozen(RENDER_TARGET_4K)).toBe(true)
  })
})
