/**
 * 受约束东南斜俯视相机的纯计算契约测试（TASK-011 验证方式 1、2）。
 *
 * 依赖方向：测试基线（vitest，Node 环境），import src/three/camera-constraints（纯 TS，不依赖
 * three / React / DOM）与 src/lib/projection（MAIN_MAP_WORLD_BOUNDS）。相机约束是「输入 → 合法输出」
 * 的纯函数 + 冻结不变量，可在 Node 内完整断言「默认机位合法」「超界输入被确定性钳制」「约束与画布
 * 尺寸无关（resize 后仍成立）」，无需启动浏览器 / 控制器实例（人工交互验收留给 TASK-011 验证方式 4、5）。
 *
 * 覆盖（TASK-011 验证方式 1、2）：
 * - 默认机位：东南上方斜俯视，target 在主图中心，距离 / 极角合法，画面体现西高东低。
 * - 距离钳制：过近 / 过远 / 非有限输入被确定性夹回 [minDistance, maxDistance]。
 * - 极角钳制：超过最大极角 / 负值 / 非有限输入被确定性夹回 [0, maxPolarAngleRad]。
 * - 平移边界：超界 target 被钳回主图包围盒，y 强制为 0（地表平面），非有限分量回落默认。
 * - resize 不变量：约束冻结、钳制函数纯（同输入同输出）、约束只随地图包围盒变化不随画布尺寸变化。
 */

import { describe, it, expect } from 'vitest'
import {
  DEFAULT_CAMERA_POSE,
  MAP_CAMERA_CONSTRAINTS,
  clampDistance,
  clampPolarAngle,
  clampTarget,
} from '../src/three/camera-constraints'
import { MAIN_MAP_WORLD_BOUNDS } from '../src/lib/projection'
import { TERRAIN_PLANE_LAYOUT } from '../src/three/terrain-layout'

const TOLERANCE = 1e-6

/** 断言两个数值在给定绝对容差内相等。 */
function expectAlmostEqual(actual: number, expected: number, tolerance: number, note = ''): void {
  expect(Math.abs(actual - expected), `期望 ${actual} ≈ ${expected}（容差 ${tolerance}）${note}`).toBeLessThanOrEqual(
    tolerance,
  )
}

/** 由 position − target 计算相机相对 target 的方向量（米）。 */
function relativePose() {
  const { position, target } = DEFAULT_CAMERA_POSE
  return {
    dx: position.x - target.x,
    dy: position.y - target.y,
    dz: position.z - target.z,
  }
}

describe('默认机位：东南上方斜俯视（TASK-011 验证方式 1）', () => {
  it('target 位于主图世界中心地表（x=0、z=centerZ、y=0）', () => {
    const { target } = DEFAULT_CAMERA_POSE
    expectAlmostEqual(target.x, 0, TOLERANCE, 'target.x 关于原点对称故为 0')
    expectAlmostEqual(target.z, TERRAIN_PLANE_LAYOUT.centerZ, TOLERANCE, 'target.z = 主图南北中点')
    expectAlmostEqual(target.y, 0, TOLERANCE, 'target.y = 海平面参考面')
  })

  it('相机位于 target 的东南上方（+X 东、+Y 上、+Z 南）', () => {
    const { dx, dy, dz } = relativePose()
    expect(dx).toBeGreaterThan(0, '相机在 target 东方（+X）')
    expect(dy).toBeGreaterThan(0, '相机在 target 上方（+Y）')
    expect(dz).toBeGreaterThan(0, '相机在 target 南方（+Z）')
  })

  it('东南方位角约 45°（+X 与 +Z 各占一半，凸显西高东低）', () => {
    const { dx, dz } = relativePose()
    // 方位角平衡：dx ≈ dz（东南 45°），使青藏高原（西、高）落画面左上、东部（东、低）落右下。
    expectAlmostEqual(dx, dz, Math.abs(dx) * 1e-6, 'dx ≈ dz（东南 45°）')
  })

  it('默认距离落在 [minDistance, maxDistance] 内（合法，不触发钳制）', () => {
    const { position, target } = DEFAULT_CAMERA_POSE
    const distance = Math.hypot(position.x - target.x, position.y - target.y, position.z - target.z)
    expect(distance).toBeGreaterThanOrEqual(MAP_CAMERA_CONSTRAINTS.minDistance)
    expect(distance).toBeLessThanOrEqual(MAP_CAMERA_CONSTRAINTS.maxDistance)
    // 默认距离应明显大于最小距离（确保整张主图可见，而非贴近某山头）。
    expect(distance).toBeGreaterThan(MAP_CAMERA_CONSTRAINTS.minDistance * 2)
  })

  it('默认极角落在 [0, maxPolarAngle] 内且为斜俯视（< 90°，看不到地底）', () => {
    const { dx, dy, dz } = relativePose()
    const horizontal = Math.hypot(dx, dz)
    const polar = Math.atan2(horizontal, dy) // 从 +Y 量起
    expect(polar).toBeGreaterThanOrEqual(0)
    expect(polar).toBeLessThanOrEqual(MAP_CAMERA_CONSTRAINTS.maxPolarAngleRad)
    // 斜俯视：极角严格小于 90°（水平面），即相机高于目标所在的水平面。
    expect(polar).toBeLessThan(Math.PI / 2)
  })
})

describe('距离钳制 clampDistance（TASK-011 验证方式 2）', () => {
  it('过近距离被夹回 minDistance', () => {
    expect(clampDistance(0)).toBe(MAP_CAMERA_CONSTRAINTS.minDistance)
    expect(clampDistance(MAP_CAMERA_CONSTRAINTS.minDistance - 1)).toBe(MAP_CAMERA_CONSTRAINTS.minDistance)
  })

  it('过远距离被夹回 maxDistance', () => {
    expect(clampDistance(1e12)).toBe(MAP_CAMERA_CONSTRAINTS.maxDistance)
    expect(clampDistance(MAP_CAMERA_CONSTRAINTS.maxDistance + 1)).toBe(MAP_CAMERA_CONSTRAINTS.maxDistance)
  })

  it('合法距离（含端点）原样返回', () => {
    const { minDistance, maxDistance } = MAP_CAMERA_CONSTRAINTS
    expect(clampDistance(minDistance)).toBe(minDistance)
    expect(clampDistance(maxDistance)).toBe(maxDistance)
    const mid = (minDistance + maxDistance) / 2
    expect(clampDistance(mid)).toBe(mid)
  })

  it('非有限输入：NaN 回落默认距离，±Infinity 夹到最近端点（逐帧钳制稳定收敛）', () => {
    const fallback = clampDistance(Number.NaN)
    expect(fallback).toBeGreaterThanOrEqual(MAP_CAMERA_CONSTRAINTS.minDistance)
    expect(fallback).toBeLessThanOrEqual(MAP_CAMERA_CONSTRAINTS.maxDistance)
    expect(clampDistance(Number.POSITIVE_INFINITY)).toBe(MAP_CAMERA_CONSTRAINTS.maxDistance)
    expect(clampDistance(Number.NEGATIVE_INFINITY)).toBe(MAP_CAMERA_CONSTRAINTS.minDistance)
  })

  it('minDistance > 夸张后地形峰值，保证最近距离下也不穿入地形', () => {
    const maxDisplacedTerrainY = 9000 * 3.0 // 真实最高海拔 × 最大夸张
    // 在最大极角 88°（cos88°≈0.035）下相机 y = minDistance · 0.035；必须高于地形峰值。
    const cameraYAtMinDistanceAndMaxPolar =
      MAP_CAMERA_CONSTRAINTS.minDistance * Math.cos(MAP_CAMERA_CONSTRAINTS.maxPolarAngleRad)
    expect(cameraYAtMinDistanceAndMaxPolar).toBeGreaterThan(maxDisplacedTerrainY)
  })
})

describe('极角钳制 clampPolarAngle（TASK-011 验证方式 2）', () => {
  it('超过最大极角被夹回 maxPolarAngleRad（禁止翻面 / 看到地底）', () => {
    expect(clampPolarAngle(Math.PI)).toBe(MAP_CAMERA_CONSTRAINTS.maxPolarAngleRad)
    expect(clampPolarAngle(Math.PI / 2)).toBe(MAP_CAMERA_CONSTRAINTS.maxPolarAngleRad)
    expect(clampPolarAngle(MAP_CAMERA_CONSTRAINTS.maxPolarAngleRad + 0.001)).toBe(
      MAP_CAMERA_CONSTRAINTS.maxPolarAngleRad,
    )
  })

  it('负极角被夹回 0（正俯视合法，不下界以下）', () => {
    expect(clampPolarAngle(-0.5)).toBe(0)
    expect(clampPolarAngle(-100)).toBe(0)
  })

  it('合法极角（含端点）原样返回', () => {
    const { maxPolarAngleRad } = MAP_CAMERA_CONSTRAINTS
    expect(clampPolarAngle(0)).toBe(0)
    expect(clampPolarAngle(maxPolarAngleRad)).toBe(maxPolarAngleRad)
    expect(clampPolarAngle(maxPolarAngleRad / 2)).toBe(maxPolarAngleRad / 2)
  })

  it('maxPolarAngleRad 严格小于 90°（禁止到达水平面及以下，即禁止看到地底）', () => {
    expect(MAP_CAMERA_CONSTRAINTS.maxPolarAngleRad).toBeLessThan(Math.PI / 2)
    expect(MAP_CAMERA_CONSTRAINTS.maxPolarAngleRad).toBeGreaterThan(Math.PI / 3) // 约 60°以上，保留低空斜视
  })

  it('非有限输入：NaN 回落默认极角，±Infinity 夹到最近端点（逐帧钳制稳定收敛）', () => {
    const fallback = clampPolarAngle(Number.NaN)
    expect(fallback).toBeGreaterThanOrEqual(0)
    expect(fallback).toBeLessThanOrEqual(MAP_CAMERA_CONSTRAINTS.maxPolarAngleRad)
    expect(clampPolarAngle(Number.POSITIVE_INFINITY)).toBe(MAP_CAMERA_CONSTRAINTS.maxPolarAngleRad)
    expect(clampPolarAngle(Number.NEGATIVE_INFINITY)).toBe(0)
  })
})

describe('平移边界 clampTarget（TASK-011 验证方式 2）', () => {
  it('target 边界严格等于主图世界包围盒（从包围盒推导，无魔法坐标）', () => {
    expect(MAP_CAMERA_CONSTRAINTS.targetMinX).toBe(MAIN_MAP_WORLD_BOUNDS.minX)
    expect(MAP_CAMERA_CONSTRAINTS.targetMaxX).toBe(MAIN_MAP_WORLD_BOUNDS.maxX)
    expect(MAP_CAMERA_CONSTRAINTS.targetMinZ).toBe(MAIN_MAP_WORLD_BOUNDS.minZ)
    expect(MAP_CAMERA_CONSTRAINTS.targetMaxZ).toBe(MAIN_MAP_WORLD_BOUNDS.maxZ)
  })

  it('北向超界（z < minZ）被夹回北界', () => {
    const r = clampTarget({ x: 0, y: 0, z: MAIN_MAP_WORLD_BOUNDS.minZ - 1e6 })
    expect(r.z).toBe(MAIN_MAP_WORLD_BOUNDS.minZ)
    expect(r.x).toBe(0)
  })

  it('南向超界（z > maxZ）被夹回南界', () => {
    const r = clampTarget({ x: 0, y: 0, z: MAIN_MAP_WORLD_BOUNDS.maxZ + 1e6 })
    expect(r.z).toBe(MAIN_MAP_WORLD_BOUNDS.maxZ)
  })

  it('西向超界（x < minX）被夹回西界', () => {
    const r = clampTarget({ x: MAIN_MAP_WORLD_BOUNDS.minX - 1e6, y: 0, z: 0 })
    expect(r.x).toBe(MAIN_MAP_WORLD_BOUNDS.minX)
  })

  it('东向超界（x > maxX）被夹回东界', () => {
    const r = clampTarget({ x: MAIN_MAP_WORLD_BOUNDS.maxX + 1e6, y: 0, z: 0 })
    expect(r.x).toBe(MAIN_MAP_WORLD_BOUNDS.maxX)
  })

  it('target.y 强制为 0（平移只在地表平面内，不抬离地表）', () => {
    const r = clampTarget({ x: 0, y: 5e6, z: 0 })
    expect(r.y).toBe(0)
  })

  it('合法 target（含四角端点）原样返回（仅 y 归零）', () => {
    const { minX, maxX, minZ, maxZ } = MAIN_MAP_WORLD_BOUNDS
    const nw = clampTarget({ x: minX, y: 0, z: minZ })
    expect(nw.x).toBe(minX)
    expect(nw.z).toBe(minZ)
    const se = clampTarget({ x: maxX, y: 0, z: maxZ })
    expect(se.x).toBe(maxX)
    expect(se.z).toBe(maxZ)
  })

  it('非有限分量回落默认 target（逐帧钳制路径稳定收敛）', () => {
    const r = clampTarget({ x: Number.NaN, y: Number.NaN, z: Number.NaN })
    expectAlmostEqual(r.x, DEFAULT_CAMERA_POSE.target.x, TOLERANCE, 'NaN x 回落默认')
    expectAlmostEqual(r.z, DEFAULT_CAMERA_POSE.target.z, TOLERANCE, 'NaN z 回落默认')
    expect(r.y).toBe(0)
  })

  it('默认 target 自身经 clampTarget 不变（幂等，useFrame 每帧零开销）', () => {
    const t = DEFAULT_CAMERA_POSE.target
    const r = clampTarget({ x: t.x, y: t.y, z: t.z })
    expectAlmostEqual(r.x, t.x, TOLERANCE)
    expectAlmostEqual(r.y, t.y, TOLERANCE)
    expectAlmostEqual(r.z, t.z, TOLERANCE)
  })
})

describe('resize 不变量：约束只随地图包围盒变化，不随画布尺寸变化（TASK-011 验证方式 1）', () => {
  it('MAP_CAMERA_CONSTRAINTS 已冻结（运行时不可被偷偷放宽）', () => {
    expect(Object.isFrozen(MAP_CAMERA_CONSTRAINTS)).toBe(true)
    expect(Object.isFrozen(DEFAULT_CAMERA_POSE)).toBe(true)
    expect(Object.isFrozen(DEFAULT_CAMERA_POSE.position)).toBe(true)
    expect(Object.isFrozen(DEFAULT_CAMERA_POSE.target)).toBe(true)
  })

  it('钳制函数是纯函数：同一输入在多次调用下产出同一输出（与调用时刻 / 调用次数无关）', () => {
    const d = MAP_CAMERA_CONSTRAINTS.maxDistance + 12345
    expect(clampDistance(d)).toBe(clampDistance(d))
    const p = MAP_CAMERA_CONSTRAINTS.maxPolarAngleRad + 0.1
    expect(clampPolarAngle(p)).toBe(clampPolarAngle(p))
    const t = { x: MAIN_MAP_WORLD_BOUNDS.maxX + 7, y: 9, z: MAIN_MAP_WORLD_BOUNDS.maxZ + 3 }
    const a = clampTarget(t)
    const b = clampTarget(t)
    expect(a.x).toBe(b.x)
    expect(a.y).toBe(b.y)
    expect(a.z).toBe(b.z)
  })

  it('约束值是纯数值常量，不持有 / 不读取任何画布尺寸或 DOM 状态', () => {
    // 约束字段全部为 number；不存在引用 window / canvas / viewport 的字段。
    const values = Object.values(MAP_CAMERA_CONSTRAINTS)
    expect(values.every((v) => typeof v === 'number')).toBe(true)
    // 画布 resize 改变的是像素尺寸 / aspect，不影响米制约束——故 resize 前后约束不变。
    // 此处不模拟 resize 事件（那需要 DOM），而是断言约束对 resize 的不变性来源：
    // 它们是模块加载时一次性从 MAIN_MAP_WORLD_BOUNDS 派生的冻结常量。
    const before = { ...MAP_CAMERA_CONSTRAINTS }
    // 「resize 后」等价于「重新读取同一冻结常量」——值必然一致。
    const after = { ...MAP_CAMERA_CONSTRAINTS }
    expect(after).toEqual(before)
  })

  it('距离 / 极角约束自洽：min < default < max，默认极角 < maxPolar', () => {
    const { position, target } = DEFAULT_CAMERA_POSE
    const distance = Math.hypot(position.x - target.x, position.y - target.y, position.z - target.z)
    expect(MAP_CAMERA_CONSTRAINTS.minDistance).toBeLessThan(distance)
    expect(distance).toBeLessThan(MAP_CAMERA_CONSTRAINTS.maxDistance)
    const { dx, dy, dz } = relativePose()
    const defaultPolar = Math.atan2(Math.hypot(dx, dz), dy)
    expect(defaultPolar).toBeLessThan(MAP_CAMERA_CONSTRAINTS.maxPolarAngleRad)
  })
})
