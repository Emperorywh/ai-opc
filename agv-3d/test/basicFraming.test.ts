import { describe, expect, it } from 'vitest'
import { computeBasicFraming } from '../src/features/agv-map/presentation/scene/basicFraming'
import type { Bounds3Data } from '../src/features/agv-map/domain/renderPacket'

describe('computeBasicFraming — 基础框选（SPEC §9.1、TASK-009 最小可用）', () => {
  const bounds: Bounds3Data = {
    min: [-100, 0, -60],
    max: [100, 5, 60],
  }

  it('target 为边界中心在地面的投影（y=0）', () => {
    const f = computeBasicFraming(bounds)
    expect(f.target[0]).toBeCloseTo(0, 6)
    expect(f.target[1]).toBe(0)
    expect(f.target[2]).toBeCloseTo(0, 6)
  })

  it('相机位于 target 斜上方（极角 45°、高度为正）', () => {
    const f = computeBasicFraming(bounds)
    expect(f.position[1]).toBeGreaterThan(0)
    const dx = f.position[0] - f.target[0]
    const dz = f.position[2] - f.target[2]
    const horiz = Math.hypot(dx, dz)
    // 极角 45°：水平距离与高度大致相等（cos45=sin45）。
    expect(f.position[1] / horiz).toBeCloseTo(1, 1)
  })

  it('远裁面不小于 1000 m 且不小于包围球半径的 10 倍', () => {
    const f = computeBasicFraming(bounds)
    const [minX, minY, minZ] = bounds.min
    const [maxX, maxY, maxZ] = bounds.max
    const radius = Math.hypot(maxX - minX, maxY - minY, maxZ - minZ) / 2
    expect(f.far).toBeGreaterThanOrEqual(1000)
    expect(f.far).toBeGreaterThanOrEqual(radius * 10)
  })

  it('相机到 target 距离足以容纳包围球（含边距）', () => {
    const f = computeBasicFraming(bounds)
    const [minX, minY, minZ] = bounds.min
    const [maxX, maxY, maxZ] = bounds.max
    const radius = Math.hypot(maxX - minX, maxY - minY, maxZ - minZ) / 2
    const dist = Math.hypot(
      f.position[0] - f.target[0],
      f.position[1] - f.target[1],
      f.position[2] - f.target[2],
    )
    // 半 FOV(22.5°) 正弦推算：dist ≥ radius / sin(22.5°)。
    expect(dist).toBeGreaterThan(radius / Math.sin((45 * Math.PI) / 180 / 2))
  })

  it('所有相机参数为有限值', () => {
    const f = computeBasicFraming({ min: [-1, -1, -1], max: [1, 1, 1] })
    for (const v of [...f.position, ...f.target, f.far]) {
      expect(Number.isFinite(v)).toBe(true)
    }
  })

  it('相同输入两次计算结果一致（纯函数）', () => {
    const a = computeBasicFraming(bounds)
    const b = computeBasicFraming(bounds)
    expect(a.position).toEqual(b.position)
    expect(a.target).toEqual(b.target)
    expect(a.far).toBe(b.far)
  })
})
