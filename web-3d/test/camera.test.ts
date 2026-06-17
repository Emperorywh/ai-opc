/**
 * Task 09 · SandboxControls 边界约束单测（SPEC §6.6 验收：pan 不出界 / pitch 不翻转）。
 *
 * 覆盖 cameraState 纯函数：clampTarget / clampDistance / clampPitch / clampYaw /
 * distanceToZoom / damp / computeCameraPosition / initialCameraState。
 */
import { describe, it, expect } from 'vitest'
import { cameraConfig } from '../src/config/camera'
import {
  initialCameraState,
  clampTarget,
  clampDistance,
  clampPitch,
  clampYaw,
  distanceToZoom,
  damp,
  computeCameraPosition,
} from '../src/three/camera/cameraState'

const D2R = Math.PI / 180

describe('clampTarget（SPEC §6.6 pan 边界：pan 不出界）', () => {
  const { xMin, xMax, zMin, zMax } = cameraConfig.panBounds
  it('边界内原样返回', () => {
    expect(clampTarget(0, 0)).toEqual([0, 0])
    expect(clampTarget(0.5, -0.3)).toEqual([0.5, -0.3])
  })
  it('双轴越界 clamp 到边界', () => {
    expect(clampTarget(5, 5)).toEqual([xMax, zMax])
    expect(clampTarget(-5, -5)).toEqual([xMin, zMin])
  })
  it('单轴越界仅 clamp 该轴', () => {
    expect(clampTarget(2, 0)).toEqual([xMax, 0])
    expect(clampTarget(0, 2)).toEqual([0, zMax])
  })
  it('四角精确落点', () => {
    expect(clampTarget(xMax, zMax)).toEqual([xMax, zMax])
    expect(clampTarget(xMin, zMin)).toEqual([xMin, zMin])
  })
  it('大力推入仍落在框内（pan 不出界核心断言）', () => {
    for (const [x, z] of [
      [1e6, -1e6],
      [-1e3, 1e3],
      [9, 9],
      [-9, -9],
    ]) {
      const [cx, cz] = clampTarget(x, z)
      expect(cx).toBeGreaterThanOrEqual(xMin)
      expect(cx).toBeLessThanOrEqual(xMax)
      expect(cz).toBeGreaterThanOrEqual(zMin)
      expect(cz).toBeLessThanOrEqual(zMax)
    }
  })
  it('边界值与 SPEC §6.6 一致（x±1.1, z±0.6）', () => {
    expect(xMin).toBe(-1.1)
    expect(xMax).toBe(1.1)
    expect(zMin).toBe(-0.6)
    expect(zMax).toBe(0.6)
  })
})

describe('clampDistance（SPEC §6.6 zoom 区间）', () => {
  const { min, max } = cameraConfig.zoom
  it('区间内原样返回', () => {
    expect(clampDistance((min + max) / 2)).toBeCloseTo((min + max) / 2)
  })
  it('越过 max clamp 回 max', () => {
    expect(clampDistance(1e9)).toBe(max)
  })
  it('跌破 min clamp 回 min', () => {
    expect(clampDistance(0)).toBe(min)
    expect(clampDistance(-5)).toBe(min)
  })
})

describe('clampPitch（SPEC §6.6 pitch 锁定：不翻转）', () => {
  const lo = cameraConfig.pitchMinDeg * D2R
  const hi = cameraConfig.pitchMaxDeg * D2R
  it('锁定值 pitchDeg 在区间内不变', () => {
    expect(clampPitch(cameraConfig.pitchDeg * D2R)).toBeCloseTo(cameraConfig.pitchDeg * D2R)
  })
  it('平视(0°)/仰视(<0°) 低于下界 → 压回 pitchMin（不翻转）', () => {
    expect(clampPitch(0)).toBe(lo)
    expect(clampPitch(-45 * D2R)).toBe(lo)
  })
  it('过顶(>90°)/翻背面(135°) 高于上界 → 压回 pitchMax（不翻转）', () => {
    expect(clampPitch(135 * D2R)).toBe(hi)
  })
  it('任意输入结果始终 ∈ [pitchMin, pitchMax]（永不翻转核心：不会 ≤0 或 ≥90）', () => {
    for (const p of [0, -45 * D2R, 135 * D2R, 89 * D2R, Math.PI, -Math.PI / 2, 1e6, -1e6]) {
      const r = clampPitch(p)
      expect(r).toBeGreaterThanOrEqual(lo)
      expect(r).toBeLessThanOrEqual(hi)
    }
  })
  it('过陡(接近90°)压回 pitchMax', () => {
    expect(clampPitch(89 * D2R)).toBe(hi)
  })
  it('过缓(低于 pitchMin)压回 pitchMin', () => {
    expect(clampPitch(lo - 0.1)).toBeCloseTo(lo)
  })
})

describe('clampYaw（SPEC §6.6 ±yawRange 小范围）', () => {
  const r = cameraConfig.yawRangeDeg * D2R
  it('0 不变（锁定主朝向）', () => {
    expect(clampYaw(0)).toBe(0)
  })
  it('范围内不变', () => {
    expect(clampYaw(r / 2)).toBeCloseTo(r / 2)
  })
  it('正界外 clamp 到 +yawRange', () => {
    expect(clampYaw(Math.PI)).toBeCloseTo(r)
  })
  it('负界外 clamp 到 -yawRange', () => {
    expect(clampYaw(-Math.PI)).toBeCloseTo(-r)
  })
})

describe('distanceToZoom（store cameraZoom 归一化映射）', () => {
  const { min, max } = cameraConfig.zoom
  it('最远(max)=0', () => {
    expect(distanceToZoom(max)).toBe(0)
  })
  it('最近(min)=1', () => {
    expect(distanceToZoom(min)).toBe(1)
  })
  it('中点=0.5', () => {
    expect(distanceToZoom((min + max) / 2)).toBeCloseTo(0.5)
  })
  it('单调：越近 zoom 越大', () => {
    expect(distanceToZoom(max)).toBeLessThan(distanceToZoom((min + max) / 2))
    expect(distanceToZoom((min + max) / 2)).toBeLessThan(distanceToZoom(min))
  })
  it('越界 clamp 到 [0,1]', () => {
    expect(distanceToZoom(1e9)).toBe(0)
    expect(distanceToZoom(-1e9)).toBe(1)
  })
  it('初始距离 zoom ∈ (0,1)', () => {
    const z = distanceToZoom(cameraConfig.initialDistance)
    expect(z).toBeGreaterThan(0)
    expect(z).toBeLessThan(1)
  })
})

describe('damp（帧率无关阻尼）', () => {
  it('delta=0 不动', () => {
    expect(damp(5, 10, 0.1, 0)).toBe(5)
  })
  it('current=target 不动', () => {
    expect(damp(7, 7, 0.1, 0.016)).toBe(7)
  })
  it('向 target 趋近但不越界', () => {
    const v = damp(0, 10, 0.1, 0.016)
    expect(v).toBeGreaterThan(0)
    expect(v).toBeLessThan(10)
  })
  it('大 delta 趋近 target', () => {
    expect(damp(0, 10, 0.1, 10)).toBeCloseTo(10, 0)
  })
  it('帧率无关：两个半帧 ≈ 一个整帧', () => {
    const whole = damp(0, 10, 0.1, 1 / 60)
    let acc = 0
    acc = damp(acc, 10, 0.1, 1 / 120)
    acc = damp(acc, 10, 0.1, 1 / 120)
    expect(acc).toBeCloseTo(whole, 5)
  })
})

describe('initialCameraState', () => {
  it('看中心 / 距离=initialDistance / pitch=pitchDeg / yaw=0', () => {
    const s = initialCameraState()
    expect(s.targetX).toBe(0)
    expect(s.targetZ).toBe(0)
    expect(s.yaw).toBe(0)
    expect(s.distance).toBe(cameraConfig.initialDistance)
    expect(s.pitch).toBeCloseTo(cameraConfig.pitchDeg * D2R)
  })
})

describe('computeCameraPosition（与 Task 04 StaticCamera 同源）', () => {
  it('pitch=45°/yaw=0 = Task 04 静态相机 (0, sin·d, cos·d)', () => {
    const d = cameraConfig.initialDistance
    const p = cameraConfig.pitchDeg * D2R
    const [x, y, z] = computeCameraPosition(initialCameraState())
    expect(x).toBeCloseTo(0, 10)
    expect(y).toBeCloseTo(Math.sin(p) * d, 10)
    expect(z).toBeCloseTo(Math.cos(p) * d, 10)
  })
  it('pan target 时相机跟随（x/z 偏移=target 偏移，y 不变）', () => {
    const s = { ...initialCameraState(), targetX: 0.5, targetZ: -0.2 }
    const base = computeCameraPosition(initialCameraState())
    const [x, y, z] = computeCameraPosition(s)
    expect(x).toBeCloseTo(base[0] + 0.5, 10)
    expect(z).toBeCloseTo(base[2] - 0.2, 10)
    expect(y).toBeCloseTo(base[1], 10)
  })
  it('yaw=0 时水平偏移=0（锁定主朝向不左右歪）', () => {
    expect(computeCameraPosition(initialCameraState())[0]).toBeCloseTo(0, 10)
  })
  it('zoom 改距离仅缩放相机与 target 间距（方向不变）', () => {
    const near = { ...initialCameraState(), distance: cameraConfig.zoom.min }
    const far = { ...initialCameraState(), distance: cameraConfig.zoom.max }
    // 同向（y/z 同号），近处模长 < 远处模长。
    const [nx, ny, nz] = computeCameraPosition(near)
    const [fx, fy, fz] = computeCameraPosition(far)
    expect(Math.sign(ny)).toBe(Math.sign(fy))
    expect(Math.sign(nz)).toBe(Math.sign(fz))
    expect(Math.hypot(nx, ny, nz)).toBeLessThan(Math.hypot(fx, fy, fz))
  })
})
