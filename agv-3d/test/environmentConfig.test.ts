import { describe, expect, it } from 'vitest'
import {
  DIRECTIONAL_LIGHT_AZIMUTH_RAD,
  DIRECTIONAL_LIGHT_DIRECTION,
  DIRECTIONAL_LIGHT_DISTANCE_FACTOR,
  DIRECTIONAL_LIGHT_ELEVATION_RAD,
  ENVIRONMENT_MARGIN_M,
  FOG_FAR_FACTOR,
  FOG_NEAR_FACTOR,
  GRID_COARSE_MULTIPLIER,
  GRID_FADE_INNER_FACTOR,
  GRID_FADE_OUTER_FACTOR,
  GRID_FINE_CELL_M,
  PMREM_BLUR_SIGMA,
  PMREM_FAR_M,
  PMREM_NEAR_M,
  PMREM_RESOLUTION,
  PMREM_SCENE_RADIUS_M,
  SHADOW_BIAS,
  SHADOW_CAMERA_FAR_FACTOR,
  SHADOW_CAMERA_NEAR_M,
  SHADOW_NORMAL_BIAS,
} from '../src/features/agv-map/config/environmentConfig'

/**
 * 环境空间布局配置单元测试（SPEC §6.3、§8.3、§8.4、§11.1、§12，TASK-012）。
 *
 * 断言所有环境布局参数为正有限值、携带合理单位量纲，且关键关系（near<far、inner<outer、
 * 粗>细）成立。数值本身为可微调的视觉/布局初值，测试只锁定不变量与 SPEC 明确规定的量。
 */

describe('environmentConfig — 统一环境边距（SPEC §6.3）', () => {
  it('ENVIRONMENT_MARGIN_M 为正有限值（固定绝对边距，随 renderBounds 线性外扩）', () => {
    expect(Number.isFinite(ENVIRONMENT_MARGIN_M)).toBe(true)
    expect(ENVIRONMENT_MARGIN_M).toBeGreaterThan(0)
  })
})

describe('environmentConfig — 方向光空间朝向（SPEC §8.3）', () => {
  it('仰角位于地平面以上、不超过天顶（0 < elev < 90°）', () => {
    expect(DIRECTIONAL_LIGHT_DIRECTION.elevationDeg).toBeGreaterThan(0)
    expect(DIRECTIONAL_LIGHT_DIRECTION.elevationDeg).toBeLessThan(90)
    expect(DIRECTIONAL_LIGHT_ELEVATION_RAD).toBeCloseTo(
      (DIRECTIONAL_LIGHT_DIRECTION.elevationDeg * Math.PI) / 180,
      10,
    )
  })

  it('方位角为有限值，弧度与度数一致', () => {
    expect(Number.isFinite(DIRECTIONAL_LIGHT_DIRECTION.azimuthDeg)).toBe(true)
    expect(DIRECTIONAL_LIGHT_AZIMUTH_RAD).toBeCloseTo(
      (DIRECTIONAL_LIGHT_DIRECTION.azimuthDeg * Math.PI) / 180,
      10,
    )
  })

  it('光距因子为正（光源位于场景之外）', () => {
    expect(DIRECTIONAL_LIGHT_DISTANCE_FACTOR).toBeGreaterThan(0)
  })
})

describe('environmentConfig — 线性雾距因子（SPEC §8.4）', () => {
  it('near < far 且均为正（保证远端拓扑在初始 framing 下仍可辨识）', () => {
    expect(FOG_NEAR_FACTOR).toBeGreaterThan(0)
    expect(FOG_FAR_FACTOR).toBeGreaterThan(FOG_NEAR_FACTOR)
  })
})

describe('environmentConfig — 阴影正交相机与偏置（SPEC §8.3、§11.1）', () => {
  it('阴影相机近面为正', () => {
    expect(SHADOW_CAMERA_NEAR_M).toBeGreaterThan(0)
  })

  it('阴影相机远面因子 > 1（远面充分覆盖场景深度）', () => {
    expect(SHADOW_CAMERA_FAR_FACTOR).toBeGreaterThan(1)
  })

  it('阴影偏置为负（消除自阴影痤），法线偏置非负', () => {
    expect(SHADOW_BIAS).toBeLessThan(0)
    expect(SHADOW_NORMAL_BIAS).toBeGreaterThanOrEqual(0)
  })
})

describe('environmentConfig — 网格空间参数（SPEC §8.4）', () => {
  it('细网格单元为正有限值（米）', () => {
    expect(Number.isFinite(GRID_FINE_CELL_M)).toBe(true)
    expect(GRID_FINE_CELL_M).toBeGreaterThan(0)
  })

  it('粗网格倍数 > 1（粗线比细线稀疏）', () => {
    expect(GRID_COARSE_MULTIPLIER).toBeGreaterThan(1)
  })

  it('径向衰减 inner < outer 且均为正（满透明度到完全透明的单调区间）', () => {
    expect(GRID_FADE_INNER_FACTOR).toBeGreaterThanOrEqual(0)
    expect(GRID_FADE_OUTER_FACTOR).toBeGreaterThan(GRID_FADE_INNER_FACTOR)
  })
})

describe('environmentConfig — 本地 PMREM 参数（SPEC §8.3 程序化环境）', () => {
  it('PMREM 分辨率为正（受性能预算约束）', () => {
    expect(PMREM_RESOLUTION).toBeGreaterThan(0)
  })

  it('PMREM 模糊半径非负、场景半径与近远面为正', () => {
    expect(PMREM_BLUR_SIGMA).toBeGreaterThanOrEqual(0)
    expect(PMREM_SCENE_RADIUS_M).toBeGreaterThan(0)
    expect(PMREM_NEAR_M).toBeGreaterThan(0)
    expect(PMREM_FAR_M).toBeGreaterThan(PMREM_NEAR_M)
  })
})
