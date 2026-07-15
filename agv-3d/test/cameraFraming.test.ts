import { describe, expect, it } from 'vitest'
import {
  computeCameraBasis,
  computeCameraFrame,
  computeBoundsCornerNdcPeak,
  computeOrbitDistanceLimits,
  computePanBounds,
} from '../src/features/agv-map/presentation/scene/cameraFraming'
import {
  CAMERA_FOV_DEG,
  CAMERA_HALF_FOV_RAD,
  CAMERA_NEAR_M,
  FRAMING_MARGIN,
  FRAMING_REFERENCE_ASPECT,
  INITIAL_AZIMUTH_DEG,
  INITIAL_POLAR_DEG,
  MAX_DISTANCE_RADIUS_FACTOR,
  MAX_POLAR_DEG,
  MIN_DISTANCE_FLOOR_M,
  MIN_DISTANCE_RADIUS_FACTOR,
  MIN_POLAR_DEG,
  PAN_BOUND_EXPANSION,
} from '../src/features/agv-map/config/cameraConfig'
import type { Bounds3Data } from '../src/features/agv-map/domain/renderPacket'

/**
 * 相机自动框选与受控范围测试（SPEC §9.1、§9.2，TASK-011）。
 *
 * 核心验收：以 16:9 参考宽高比求解的相机距离，须使 renderBounds 八角点在 16:9 与 21:9 画面下
 * 都落在 5% 安全区内（SPEC §9.1、§16.2）。computeBoundsCornerNdcPeak 返回值已除以 (1−margin)，
 * 故峰值 ≤ 1 等价于角点位于安全区内。
 */

/** 接近 V76 实际尺寸的代表边界（世界空间，中心近原点，Y 贴地）。 */
const v76LikeBounds: Bounds3Data = {
  min: [-210, 0, -130],
  max: [210, 0.6, 130],
}

/** 包围球半径（空间对角线之半）。 */
function boundsRadius(bounds: Bounds3Data): number {
  const [minX, minY, minZ] = bounds.min
  const [maxX, maxY, maxZ] = bounds.max
  return Math.hypot(maxX - minX, maxY - minY, maxZ - minZ) / 2
}

/** 三向量点积。 */
function dot(a: readonly number[], b: readonly number[]): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
}

describe('computeCameraBasis — 相机正交基（SPEC §9.1）', () => {
  it('dir/right/up 两两正交且单位长度（初始极角/方位角）', () => {
    const polar = (INITIAL_POLAR_DEG * Math.PI) / 180
    const az = (INITIAL_AZIMUTH_DEG * Math.PI) / 180
    const { dir, right, up } = computeCameraBasis(polar, az)
    expect(Math.abs(dot(dir, right))).toBeCloseTo(0, 10)
    expect(Math.abs(dot(dir, up))).toBeCloseTo(0, 10)
    expect(Math.abs(dot(right, up))).toBeCloseTo(0, 10)
    expect(Math.hypot(dir[0], dir[1], dir[2])).toBeCloseTo(1, 10)
    expect(Math.hypot(right[0], right[1], right[2])).toBeCloseTo(1, 10)
    expect(Math.hypot(up[0], up[1], up[2])).toBeCloseTo(1, 10)
  })

  it('dir 从 target 指向相机斜上方（Y 分量为正）', () => {
    const polar = (INITIAL_POLAR_DEG * Math.PI) / 180
    const az = (INITIAL_AZIMUTH_DEG * Math.PI) / 180
    const { dir } = computeCameraBasis(polar, az)
    expect(dir[1]).toBeGreaterThan(0)
  })
})

describe('computeCameraFrame — 自动框选（SPEC §9.1）', () => {
  it('target 为边界中心在地面 y=0 的投影', () => {
    const f = computeCameraFrame(v76LikeBounds, FRAMING_REFERENCE_ASPECT)
    expect(f.target[0]).toBeCloseTo(0, 6)
    expect(f.target[1]).toBe(0)
    expect(f.target[2]).toBeCloseTo(0, 6)
  })

  it('相机位于 target 斜上方，极角 45°（高度与水平距离相等）', () => {
    const f = computeCameraFrame(v76LikeBounds, FRAMING_REFERENCE_ASPECT)
    expect(f.polarRad).toBeCloseTo((INITIAL_POLAR_DEG * Math.PI) / 180, 10)
    expect(f.position[1]).toBeGreaterThan(0)
    const horiz = Math.hypot(f.position[0] - f.target[0], f.position[2] - f.target[2])
    // 极角 45°：高度 = 水平距离（cos45 = sin45）。
    expect(f.position[1] / horiz).toBeCloseTo(1, 2)
  })

  it('远裁面不小于 1000 m 且不小于包围球半径的 10 倍', () => {
    const f = computeCameraFrame(v76LikeBounds, FRAMING_REFERENCE_ASPECT)
    const radius = boundsRadius(v76LikeBounds)
    expect(f.far).toBeGreaterThanOrEqual(1000)
    expect(f.far).toBeGreaterThanOrEqual(radius * 10)
  })

  it('近裁面 0.1 m、FOV 45°', () => {
    // 近裁面与 FOV 在 cameraConfig 中固定，这里断言常量与 SPEC 一致。
    expect(CAMERA_NEAR_M).toBe(0.1)
    expect(CAMERA_FOV_DEG).toBe(45)
  })

  it('初始距离落在 OrbitControls 的 [minDistance, maxDistance] 内', () => {
    const f = computeCameraFrame(v76LikeBounds, FRAMING_REFERENCE_ASPECT)
    const limits = computeOrbitDistanceLimits(v76LikeBounds)
    expect(f.distance).toBeGreaterThanOrEqual(limits.min)
    expect(f.distance).toBeLessThanOrEqual(limits.max)
  })

  it('16:9 画面下八角点全部位于 5% 安全区内', () => {
    const f = computeCameraFrame(v76LikeBounds, FRAMING_REFERENCE_ASPECT)
    const basis = computeCameraBasis(f.polarRad, f.azimuthRad)
    const peak = computeBoundsCornerNdcPeak(
      v76LikeBounds,
      f.target,
      basis,
      f.distance,
      CAMERA_HALF_FOV_RAD,
      16 / 9,
    )
    // peak 已除以 (1−margin)，≤ 1 等价于 ndc ≤ 1−margin。
    expect(peak.maxAbsX).toBeLessThanOrEqual(1 + 1e-9)
    expect(peak.maxAbsY).toBeLessThanOrEqual(1 + 1e-9)
  })

  it('21:9 画面下八角点同样位于 5% 安全区内（同一 framing 距离）', () => {
    const f = computeCameraFrame(v76LikeBounds, FRAMING_REFERENCE_ASPECT)
    const basis = computeCameraBasis(f.polarRad, f.azimuthRad)
    const peak = computeBoundsCornerNdcPeak(
      v76LikeBounds,
      f.target,
      basis,
      f.distance,
      CAMERA_HALF_FOV_RAD,
      21 / 9,
    )
    expect(peak.maxAbsX).toBeLessThanOrEqual(1 + 1e-9)
    expect(peak.maxAbsY).toBeLessThanOrEqual(1 + 1e-9)
  })

  it('16:9 下垂直峰值达到安全区边界（验证 5% 边距被精确使用而非过度留白）', () => {
    const f = computeCameraFrame(v76LikeBounds, FRAMING_REFERENCE_ASPECT)
    const basis = computeCameraBasis(f.polarRad, f.azimuthRad)
    const peak = computeBoundsCornerNdcPeak(
      v76LikeBounds,
      f.target,
      basis,
      f.distance,
      CAMERA_HALF_FOV_RAD,
      16 / 9,
    )
    // 至少一个方向的峰值贴近 1（安全区边界），证明距离由安全区约束求解而非随意放大。
    expect(Math.max(peak.maxAbsX, peak.maxAbsY)).toBeGreaterThan(1 - 1e-6)
  })

  it('极窄屏（4:3）下角点仍被有效钳制（不产生 NaN 或无穷）', () => {
    const f = computeCameraFrame(v76LikeBounds, 4 / 3)
    const basis = computeCameraBasis(f.polarRad, f.azimuthRad)
    const peak = computeBoundsCornerNdcPeak(
      v76LikeBounds,
      f.target,
      basis,
      f.distance,
      CAMERA_HALF_FOV_RAD,
      4 / 3,
    )
    expect(Number.isFinite(peak.maxAbsX)).toBe(true)
    expect(Number.isFinite(peak.maxAbsY)).toBe(true)
  })

  it('极端竖屏（运行期 aspect 远小于 16:9）下 framing 参数有限且场景未整体丢失（TASK-011 一致安全策略）', () => {
    // framing 距离以 16:9 参考求解、固定不变；运行期遇到极窄竖屏时水平方向可能被裁，
    // 但相机参数恒有限、垂直方向仍完整容纳，场景不会整体丢失，也不触发重算（§9.3）。
    const f = computeCameraFrame(v76LikeBounds, FRAMING_REFERENCE_ASPECT)
    for (const v of [...f.position, ...f.target, f.far, f.distance]) {
      expect(Number.isFinite(v)).toBe(true)
    }
    const basis = computeCameraBasis(f.polarRad, f.azimuthRad)
    const portraitPeak = computeBoundsCornerNdcPeak(
      v76LikeBounds,
      f.target,
      basis,
      f.distance,
      CAMERA_HALF_FOV_RAD,
      9 / 16, // 竖屏：水平更紧
    )
    expect(Number.isFinite(portraitPeak.maxAbsX)).toBe(true)
    expect(Number.isFinite(portraitPeak.maxAbsY)).toBe(true)
    // 垂直方向与 aspect 无关，仍位于安全区内；水平方向可能超出（允许 letterbox/裁切，§9.3）。
    expect(portraitPeak.maxAbsY).toBeLessThanOrEqual(1 + 1e-9)
  })

  it('退化零尺寸边界（min=max）下 framing 不产生 NaN/负距离（仅稳健性，上游不触发）', () => {
    const f = computeCameraFrame({ min: [5, 0, 7], max: [5, 0, 7] }, FRAMING_REFERENCE_ASPECT)
    for (const v of [...f.position, ...f.target, f.far, f.distance]) {
      expect(Number.isFinite(v)).toBe(true)
    }
    expect(f.distance).toBeGreaterThan(0)
    expect(f.far).toBeGreaterThanOrEqual(1000)
  })

  it('所有相机参数为有限值', () => {
    const f = computeCameraFrame({ min: [-1, 0, -1], max: [1, 0.5, 1] }, 16 / 9)
    for (const v of [...f.position, ...f.target, f.far, f.distance]) {
      expect(Number.isFinite(v)).toBe(true)
    }
  })

  it('相同输入两次计算结果一致（纯函数）', () => {
    const a = computeCameraFrame(v76LikeBounds, FRAMING_REFERENCE_ASPECT)
    const b = computeCameraFrame(v76LikeBounds, FRAMING_REFERENCE_ASPECT)
    expect(a.position).toEqual(b.position)
    expect(a.target).toEqual(b.target)
    expect(a.far).toBe(b.far)
    expect(a.distance).toBe(b.distance)
  })

  it('配置常量与 SPEC §9.1/§9.2 一致', () => {
    expect(INITIAL_POLAR_DEG).toBe(45)
    expect(MIN_POLAR_DEG).toBe(25)
    expect(MAX_POLAR_DEG).toBe(70)
    expect(FRAMING_MARGIN).toBe(0.05)
    expect(MIN_DISTANCE_FLOOR_M).toBe(2)
    expect(MIN_DISTANCE_RADIUS_FACTOR).toBe(0.05)
    expect(MAX_DISTANCE_RADIUS_FACTOR).toBe(4)
    expect(PAN_BOUND_EXPANSION).toBe(0.2)
  })
})

describe('computeOrbitDistanceLimits — 距离范围（SPEC §9.2）', () => {
  it('min = max(2 m, 包围球半径 × 0.05)', () => {
    const limits = computeOrbitDistanceLimits(v76LikeBounds)
    const radius = boundsRadius(v76LikeBounds)
    const expectedMin = Math.max(MIN_DISTANCE_FLOOR_M, radius * MIN_DISTANCE_RADIUS_FACTOR)
    expect(limits.min).toBeCloseTo(expectedMin, 10)
  })

  it('max = 包围球半径 × 4', () => {
    const limits = computeOrbitDistanceLimits(v76LikeBounds)
    const radius = boundsRadius(v76LikeBounds)
    expect(limits.max).toBeCloseTo(radius * MAX_DISTANCE_RADIUS_FACTOR, 10)
  })

  it('小边界下 min 至少为 2 m 下限', () => {
    const limits = computeOrbitDistanceLimits({ min: [-1, 0, -1], max: [1, 0.5, 1] })
    expect(limits.min).toBeGreaterThanOrEqual(MIN_DISTANCE_FLOOR_M)
  })

  it('min < max', () => {
    const limits = computeOrbitDistanceLimits(v76LikeBounds)
    expect(limits.min).toBeLessThan(limits.max)
  })
})

describe('computePanBounds — 平移边界（SPEC §9.2）', () => {
  it('target 水平范围 = renderBounds 水平范围向外扩展 20%', () => {
    const pan = computePanBounds(v76LikeBounds)
    const dx = v76LikeBounds.max[0] - v76LikeBounds.min[0]
    const dz = v76LikeBounds.max[2] - v76LikeBounds.min[2]
    const extX = dx * PAN_BOUND_EXPANSION
    const extZ = dz * PAN_BOUND_EXPANSION
    expect(pan.minX).toBeCloseTo(v76LikeBounds.min[0] - extX, 10)
    expect(pan.maxX).toBeCloseTo(v76LikeBounds.max[0] + extX, 10)
    expect(pan.minZ).toBeCloseTo(v76LikeBounds.min[2] - extZ, 10)
    expect(pan.maxZ).toBeCloseTo(v76LikeBounds.max[2] + extZ, 10)
  })

  it('中心为 renderBounds 水平中心', () => {
    const pan = computePanBounds(v76LikeBounds)
    const centerX = (pan.minX + pan.maxX) / 2
    const centerZ = (pan.minZ + pan.maxZ) / 2
    const boundsCenterX = (v76LikeBounds.min[0] + v76LikeBounds.max[0]) / 2
    const boundsCenterZ = (v76LikeBounds.min[2] + v76LikeBounds.max[2]) / 2
    expect(centerX).toBeCloseTo(boundsCenterX, 10)
    expect(centerZ).toBeCloseTo(boundsCenterZ, 10)
  })
})
