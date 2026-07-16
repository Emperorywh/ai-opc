import { describe, expect, it } from 'vitest'
import type { Bounds3Data } from '../src/features/agv-map/domain/renderPacket'
import { computeEnvironmentLayout } from '../src/features/agv-map/presentation/scene/environmentLayout'
import {
  DIRECTIONAL_LIGHT_AZIMUTH_RAD,
  DIRECTIONAL_LIGHT_DISTANCE_FACTOR,
  DIRECTIONAL_LIGHT_ELEVATION_RAD,
  ENVIRONMENT_MARGIN_M,
  FOG_FAR_FACTOR,
  FOG_NEAR_FACTOR,
  GRID_FADE_INNER_FACTOR,
  GRID_FADE_OUTER_FACTOR,
} from '../src/features/agv-map/config/environmentConfig'

/**
 * 环境空间布局纯函数测试（SPEC §6.3、§8.4，TASK-012）。
 *
 * 核心验收：
 * - environmentBounds = renderBounds 各轴外扩统一边距 ENVIRONMENT_MARGIN_M（§6.3 统一环境边距）。
 * - 地面/网格尺寸、雾近远、阴影范围、光目标全部由 renderBounds 推导，不写死世界坐标。
 * - 改变渲染边界尺寸与中心时，所有范围同步推导、无硬编码裁切（TASK-012 异常路径）。
 * - 有限性：对任意有限 renderBounds，全部输出为有限值且 near<far、inner<outer、extent>0。
 */

/** 构造一个世界空间 AABB。 */
function bounds(min: readonly [number, number, number], max: readonly [number, number, number]): Bounds3Data {
  return { min: [...min] as [number, number, number], max: [...max] as [number, number, number] }
}

/** V76 量级的代表性边界：约 50 m 跨度、贴地、节点高度 0.6 m。 */
const V76_LIKE = bounds([-25, 0, -22], [25, 0.6, 18])

describe('computeEnvironmentLayout — 统一环境边距外扩（SPEC §6.3）', () => {
  it('environmentBounds = renderBounds 各轴外扩 ENVIRONMENT_MARGIN_M（X/Z 两侧）', () => {
    const { environmentBounds } = computeEnvironmentLayout(V76_LIKE)
    expect(environmentBounds.min[0]).toBeCloseTo(V76_LIKE.min[0] - ENVIRONMENT_MARGIN_M, 6)
    expect(environmentBounds.max[0]).toBeCloseTo(V76_LIKE.max[0] + ENVIRONMENT_MARGIN_M, 6)
    expect(environmentBounds.min[2]).toBeCloseTo(V76_LIKE.min[2] - ENVIRONMENT_MARGIN_M, 6)
    expect(environmentBounds.max[2]).toBeCloseTo(V76_LIKE.max[2] + ENVIRONMENT_MARGIN_M, 6)
  })

  it('environmentBounds Y 顶部外扩边距、底部不低于地面 y=0', () => {
    const { environmentBounds } = computeEnvironmentLayout(V76_LIKE)
    expect(environmentBounds.max[1]).toBeCloseTo(V76_LIKE.max[1] + ENVIRONMENT_MARGIN_M, 6)
    expect(environmentBounds.min[1]).toBeGreaterThanOrEqual(0)
    expect(environmentBounds.min[1]).toBeLessThanOrEqual(V76_LIKE.min[1])
  })
})

describe('computeEnvironmentLayout — 地面与网格尺寸（SPEC §8.4）', () => {
  it('地面宽度/深度等于 environmentBounds XZ 跨度', () => {
    const layout = computeEnvironmentLayout(V76_LIKE)
    const env = layout.environmentBounds
    expect(layout.groundWidthM).toBeCloseTo(env.max[0] - env.min[0], 6)
    expect(layout.groundDepthM).toBeCloseTo(env.max[2] - env.min[2], 6)
  })

  it('网格与地面共面同尺寸', () => {
    const layout = computeEnvironmentLayout(V76_LIKE)
    expect(layout.gridWidthM).toBe(layout.groundWidthM)
    expect(layout.gridDepthM).toBe(layout.groundDepthM)
  })

  it('中心 = environmentBounds XZ 中心', () => {
    const layout = computeEnvironmentLayout(V76_LIKE)
    const env = layout.environmentBounds
    expect(layout.center[0]).toBeCloseTo((env.min[0] + env.max[0]) / 2, 6)
    expect(layout.center[1]).toBeCloseTo((env.min[2] + env.max[2]) / 2, 6)
  })
})

describe('computeEnvironmentLayout — 线性雾近远（SPEC §8.4、§6.3）', () => {
  it('fogNear = envRadius × FOG_NEAR_FACTOR、fogFar = envRadius × FOG_FAR_FACTOR', () => {
    const layout = computeEnvironmentLayout(V76_LIKE)
    const env = layout.environmentBounds
    const dx = env.max[0] - env.min[0]
    const dy = env.max[1] - env.min[1]
    const dz = env.max[2] - env.min[2]
    const envRadius = Math.hypot(dx, dy, dz) / 2
    expect(layout.fogNearM).toBeCloseTo(envRadius * FOG_NEAR_FACTOR, 6)
    expect(layout.fogFarM).toBeCloseTo(envRadius * FOG_FAR_FACTOR, 6)
  })

  it('fogNear < fogFar（拓扑可辨识的单调雾距）', () => {
    const { fogNearM, fogFarM } = computeEnvironmentLayout(V76_LIKE)
    expect(fogNearM).toBeLessThan(fogFarM)
    expect(fogNearM).toBeGreaterThan(0)
  })
})

describe('computeEnvironmentLayout — 方向光位置与目标（SPEC §8.3）', () => {
  it('光目标 = 边界中心地面投影 (cx, 0, cz)', () => {
    const layout = computeEnvironmentLayout(V76_LIKE)
    expect(layout.lightTarget[0]).toBeCloseTo(layout.center[0], 6)
    expect(layout.lightTarget[1]).toBe(0)
    expect(layout.lightTarget[2]).toBeCloseTo(layout.center[1], 6)
  })

  it('光位置 = 中心 + 光距 × (仰角/方位角单位朝向)，且位于地平面上方', () => {
    const layout = computeEnvironmentLayout(V76_LIKE)
    const env = layout.environmentBounds
    const dx = env.max[0] - env.min[0]
    const dy = env.max[1] - env.min[1]
    const dz = env.max[2] - env.min[2]
    const envRadius = Math.hypot(dx, dy, dz) / 2
    const dist = envRadius * DIRECTIONAL_LIGHT_DISTANCE_FACTOR
    const cosE = Math.cos(DIRECTIONAL_LIGHT_ELEVATION_RAD)
    const sinE = Math.sin(DIRECTIONAL_LIGHT_ELEVATION_RAD)
    const cosA = Math.cos(DIRECTIONAL_LIGHT_AZIMUTH_RAD)
    const sinA = Math.sin(DIRECTIONAL_LIGHT_AZIMUTH_RAD)
    expect(layout.lightPosition[0]).toBeCloseTo(layout.center[0] + cosE * cosA * dist, 6)
    expect(layout.lightPosition[1]).toBeCloseTo(sinE * dist, 6)
    expect(layout.lightPosition[2]).toBeCloseTo(layout.center[1] + cosE * sinA * dist, 6)
    expect(layout.lightPosition[1]).toBeGreaterThan(0)
  })
})

describe('computeEnvironmentLayout — 阴影正交相机范围（SPEC §8.3、§11.1）', () => {
  it('阴影水平半范围 = max(environmentBounds X/Z 半跨度)，覆盖整个外扩 AABB', () => {
    const layout = computeEnvironmentLayout(V76_LIKE)
    const env = layout.environmentBounds
    const halfX = (env.max[0] - env.min[0]) / 2
    const halfZ = (env.max[2] - env.min[2]) / 2
    expect(layout.shadowExtentM).toBeCloseTo(Math.max(halfX, halfZ), 6)
    // 覆盖性：extent ≥ 两个半跨度。
    expect(layout.shadowExtentM).toBeGreaterThanOrEqual(halfX - 1e-6)
    expect(layout.shadowExtentM).toBeGreaterThanOrEqual(halfZ - 1e-6)
  })

  it('阴影近/远面紧贴场景前后缘（光距 ∓ envRadius），near < far 且 near > 0', () => {
    const layout = computeEnvironmentLayout(V76_LIKE)
    const env = layout.environmentBounds
    const envRadius = Math.hypot(
      env.max[0] - env.min[0],
      env.max[1] - env.min[1],
      env.max[2] - env.min[2],
    ) / 2
    const dist = envRadius * DIRECTIONAL_LIGHT_DISTANCE_FACTOR
    // near/far 紧贴场景前后缘，把深度精度集中到实际场景段（TASK-012：替代固定 near=0.5）。
    expect(layout.shadowCameraNearM).toBeCloseTo(dist - envRadius, 6)
    expect(layout.shadowCameraFarM).toBeCloseTo(dist + envRadius, 6)
    expect(layout.shadowCameraFarM).toBeGreaterThan(layout.shadowCameraNearM)
    // 光距因子 > 1 保证 lightDistance > envRadius，故近面恒正。
    expect(layout.shadowCameraNearM).toBeGreaterThan(0)
  })
})

describe('computeEnvironmentLayout — 网格径向衰减（SPEC §8.4 不依赖相机）', () => {
  it('衰减内/外半径 = renderBounds 水平半径 × 因子（基于拓扑足迹，非 environmentBounds）', () => {
    const layout = computeEnvironmentLayout(V76_LIKE)
    const topoRadius = Math.hypot(
      V76_LIKE.max[0] - V76_LIKE.min[0],
      V76_LIKE.max[2] - V76_LIKE.min[2],
    ) / 2
    expect(layout.gridFadeInnerM).toBeCloseTo(topoRadius * GRID_FADE_INNER_FACTOR, 6)
    expect(layout.gridFadeOuterM).toBeCloseTo(topoRadius * GRID_FADE_OUTER_FACTOR, 6)
  })

  it('inner < outer（径向衰减单调）', () => {
    const { gridFadeInnerM, gridFadeOuterM } = computeEnvironmentLayout(V76_LIKE)
    expect(gridFadeInnerM).toBeLessThan(gridFadeOuterM)
  })
})

describe('computeEnvironmentLayout — 改变渲染边界尺寸与中心（TASK-012 异常路径）', () => {
  it('边界整体平移：所有中心相关输出（地面中心、光位置/目标、衰减中心）同步平移，无硬编码裁切', () => {
    const offset: readonly [number, number, number] = [100, 0, -50]
    const shifted = bounds(
      [V76_LIKE.min[0] + offset[0], 0, V76_LIKE.min[2] + offset[2]],
      [V76_LIKE.max[0] + offset[0], 0.6, V76_LIKE.max[2] + offset[2]],
    )
    const a = computeEnvironmentLayout(V76_LIKE)
    const b = computeEnvironmentLayout(shifted)
    // 中心平移量等于 offset 的 XZ 分量。
    expect(b.center[0] - a.center[0]).toBeCloseTo(offset[0], 6)
    expect(b.center[1] - a.center[1]).toBeCloseTo(offset[2], 6)
    // 光目标/位置同步平移。
    expect(b.lightTarget[0] - a.lightTarget[0]).toBeCloseTo(offset[0], 6)
    expect(b.lightTarget[2] - a.lightTarget[2]).toBeCloseTo(offset[2], 6)
    expect(b.lightPosition[0] - a.lightPosition[0]).toBeCloseTo(offset[0], 6)
    expect(b.lightPosition[2] - a.lightPosition[2]).toBeCloseTo(offset[2], 6)
    // 尺寸不变（只平移未缩放）。
    expect(b.groundWidthM).toBeCloseTo(a.groundWidthM, 6)
    expect(b.groundDepthM).toBeCloseTo(a.groundDepthM, 6)
    expect(b.gridFadeInnerM).toBeCloseTo(a.gridFadeInnerM, 6)
  })

  it('边界等比放大 2 倍：地面尺寸、雾距、阴影范围同步增大（无硬编码世界坐标上限）', () => {
    const scaled = bounds(
      [V76_LIKE.min[0] * 2, 0, V76_LIKE.min[2] * 2],
      [V76_LIKE.max[0] * 2, 0.6 * 2, V76_LIKE.max[2] * 2],
    )
    const a = computeEnvironmentLayout(V76_LIKE)
    const b = computeEnvironmentLayout(scaled)
    // 跨度翻倍 → 地面尺寸、雾距、阴影范围显著增大。统一边距 ENVIRONMENT_MARGIN_M 为固定绝对值，
    // 故放大比例被边距稀释（约 1.7×），此处断言 > 1.5× 足以证明范围随边界同步推导、无硬编码上限。
    expect(b.groundWidthM).toBeGreaterThan(a.groundWidthM * 1.5)
    expect(b.groundDepthM).toBeGreaterThan(a.groundDepthM * 1.5)
    expect(b.fogFarM).toBeGreaterThan(a.fogFarM * 1.5)
    expect(b.shadowExtentM).toBeGreaterThan(a.shadowExtentM * 1.5)
  })
})

describe('computeEnvironmentLayout — 有限性（任意有限 renderBounds）', () => {
  it('V76 量级边界：全部输出为有限值', () => {
    const layout = computeEnvironmentLayout(V76_LIKE)
    const all = [
      ...Object.values(layout.environmentBounds.min),
      ...Object.values(layout.environmentBounds.max),
      layout.groundWidthM,
      layout.groundDepthM,
      layout.gridWidthM,
      layout.gridDepthM,
      ...layout.center,
      layout.fogNearM,
      layout.fogFarM,
      ...layout.lightPosition,
      ...layout.lightTarget,
      layout.shadowExtentM,
      layout.shadowCameraNearM,
      layout.shadowCameraFarM,
      layout.gridFadeInnerM,
      layout.gridFadeOuterM,
    ]
    for (const v of all) {
      expect(Number.isFinite(v)).toBe(true)
    }
  })

  it('极小边界（1 m）仍产出有限且合法的范围', () => {
    const tiny = bounds([-0.5, 0, -0.5], [0.5, 0.1, 0.5])
    const layout = computeEnvironmentLayout(tiny)
    expect(Number.isFinite(layout.groundWidthM)).toBe(true)
    expect(layout.fogNearM).toBeLessThan(layout.fogFarM)
    expect(layout.gridFadeInnerM).toBeLessThan(layout.gridFadeOuterM)
    expect(layout.shadowExtentM).toBeGreaterThan(0)
  })

  it('相同输入产生相同输出（纯函数）', () => {
    const a = computeEnvironmentLayout(V76_LIKE)
    const b = computeEnvironmentLayout(V76_LIKE)
    expect(JSON.stringify(a)).toBe(JSON.stringify(b))
  })
})
