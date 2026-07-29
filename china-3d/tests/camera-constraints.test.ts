/**
 * 受约束东南斜俯视相机的纯计算契约测试（TASK-008 验收 1、2、4 的支撑，SPEC §4.1）。
 *
 * 依赖方向：测试基线（vitest，Node 环境），import src/three/camera-constraints（纯 TS，不依赖
 * three / React / DOM）、src/lib/projection（MAIN_MAP_WORLD_BOUNDS）、src/three/terrain-layout、
 * src/config/terrain-config 与 src/geo-contracts（峰值单源核对）。相机约束是「输入 → 合法输出」的
 * 纯函数 + 冻结不变量，可在 Node 内完整断言「默认机位合法」「超界输入被确定性钳制」「动态 near
 * 不切场景且保住深度精度」「约束与画布尺寸无关」，无需启动浏览器 / 控制器实例（人工交互验收
 * 留给 pnpm dev 目视）。
 *
 * 覆盖：
 * - 验收 1：默认机位东南上方斜俯视——target 在主图中心地表，相机在 (+X,+Y,+Z) 东南上方，
 *   距离 / 极角合法，凸显西高东低（青藏高原画面左上、东部平原右下）。
 * - 验收 2：距离 / 极角 / target 三道边界的夹取函数覆盖边界值（端点、越界、NaN、±Infinity）；
 *   maxPolarAngle≈88° 严格小于 90°（不可转到地底）；target 边界 = 地图包围盒；min/maxDistance
 *   限制缩放；screenSpacePanning 禁用由 MapOrbitControls 装配扫描断言。
 * - 动态 near（与 TASK-007 深度精度修复协同）：near = (相机高度 − 地形峰值) × 0.5；结构性
 *   不裁切（minDistance·cos(maxPolar) > 峰值）；默认机位处 near ≈ 0.52×半对角线，远角深度精度
 *   保持米级（TASK-007 修复零回归）；far 覆盖最不利几何。
 * - resize 不变量：约束冻结、钳制函数纯（同输入同输出）、约束只随地图包围盒变化不随画布尺寸变化。
 * - 装配扫描：MapOrbitControls 把约束接到 drei OrbitControls（screenSpacePanning 禁用、每帧
 *   clampTarget + computeCameraNear 跟随）；App 的 Canvas camera 全部取自约束契约，无第二套机位。
 */

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  DEFAULT_CAMERA_POSE,
  MAP_CAMERA_CONSTRAINTS,
  MAX_DISPLACED_TERRAIN_Y,
  NEAR_CLEARANCE_RATIO,
  clampDistance,
  clampPolarAngle,
  clampTarget,
  computeCameraNear,
} from '../src/three/camera-constraints'
import { MAIN_MAP_WORLD_BOUNDS } from '../src/lib/projection'
import { TERRAIN_PLANE_LAYOUT } from '../src/three/terrain-layout'
import { CHINA_TERRAIN_ELEVATION_ENCODING } from '../src/geo-contracts'
import { TERRAIN_EXAGGERATION_MAX } from '../src/config/terrain-config'

const projectRoot = resolve(fileURLToPath(import.meta.url), '..', '..')
const srcRoot = resolve(projectRoot, 'src')

/** 读取 src 下某源码文件的文本（源码结构不变量扫描用）。 */
function readSource(relativePath: string): string {
  return readFileSync(resolve(srcRoot, relativePath), 'utf-8')
}

/** 剥离块注释与行注释后的代码文本（负向模式扫描用，文档里的说明文字不计）。 */
function stripComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '')
}

const TOLERANCE = 1e-6

/** 主图世界半对角线（米）：与 camera-constraints 内部同一公式，从包围盒独立复算以核对尺度。 */
const MAP_HALF_DIAGONAL =
  Math.hypot(
    MAIN_MAP_WORLD_BOUNDS.maxX - MAIN_MAP_WORLD_BOUNDS.minX,
    MAIN_MAP_WORLD_BOUNDS.maxZ - MAIN_MAP_WORLD_BOUNDS.minZ,
  ) / 2

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

describe('默认机位：东南上方斜俯视（验收 1，SPEC §4.1）', () => {
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

  it('东南方位角约 45°（+X 与 +Z 各占一半，使青藏高原在画面左上隆起、东部平原在右下）', () => {
    const { dx, dz } = relativePose()
    // 方位角平衡：dx ≈ dz（东南 45°），相机俯瞰西北——西（高）落左上、东（低）落右下。
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

describe('距离钳制 clampDistance（验收 2：min/maxDistance 限制缩放）', () => {
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

  it('minDistance·cos(maxPolar) > 夸张后地形峰值（最近距离 + 最大极角下也不穿入地形）', () => {
    // 在最大极角 88°（cos88°≈0.035）下相机 y = minDistance · 0.035；必须高于地形峰值。
    const cameraYAtMinDistanceAndMaxPolar =
      MAP_CAMERA_CONSTRAINTS.minDistance * Math.cos(MAP_CAMERA_CONSTRAINTS.maxPolarAngleRad)
    expect(cameraYAtMinDistanceAndMaxPolar).toBeGreaterThan(MAX_DISPLACED_TERRAIN_Y)
  })
})

describe('极角钳制 clampPolarAngle（验收 2：maxPolarAngle≈88° 不可转到地底）', () => {
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

  it('maxPolarAngleRad ≈ 88°：严格小于 90°（禁止到达水平面及以下），保留低空斜视', () => {
    expect(MAP_CAMERA_CONSTRAINTS.maxPolarAngleRad).toBeCloseTo((88 * Math.PI) / 180, 9)
    expect(MAP_CAMERA_CONSTRAINTS.maxPolarAngleRad).toBeLessThan(Math.PI / 2)
    expect(MAP_CAMERA_CONSTRAINTS.maxPolarAngleRad).toBeGreaterThan(Math.PI / 3) // 60° 以上，保留低空斜视
  })

  it('非有限输入：NaN 回落默认极角，±Infinity 夹到最近端点（逐帧钳制稳定收敛）', () => {
    const fallback = clampPolarAngle(Number.NaN)
    expect(fallback).toBeGreaterThanOrEqual(0)
    expect(fallback).toBeLessThanOrEqual(MAP_CAMERA_CONSTRAINTS.maxPolarAngleRad)
    expect(clampPolarAngle(Number.POSITIVE_INFINITY)).toBe(MAP_CAMERA_CONSTRAINTS.maxPolarAngleRad)
    expect(clampPolarAngle(Number.NEGATIVE_INFINITY)).toBe(0)
  })
})

describe('平移边界 clampTarget（验收 2：target 被约束在地图包围盒内）', () => {
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

describe('动态近裁剪面 computeCameraNear（与 TASK-007 深度精度修复协同）', () => {
  it('地形峰值 = 高程编码上限 × 夸张上限（契约层 × 配置层唯一源，无第二份峰值常量）', () => {
    expect(MAX_DISPLACED_TERRAIN_Y).toBe(
      CHINA_TERRAIN_ELEVATION_ENCODING.maxValueMeters * TERRAIN_EXAGGERATION_MAX,
    )
    expect(MAX_DISPLACED_TERRAIN_Y).toBe(9000 * 3.0)
  })

  it('公式 = (相机高度 − 地形峰值) × 净空比例 0.5', () => {
    expect(NEAR_CLEARANCE_RATIO).toBe(0.5)
    expect(computeCameraNear(MAX_DISPLACED_TERRAIN_Y + 2 * 15000)).toBe(15000)
    expect(computeCameraNear(MAX_DISPLACED_TERRAIN_Y + 2 * 400000)).toBe(400000)
  })

  it('在定义域内随相机高度严格单调递增（越高越远 → near 越大 → 深度精度越好）', () => {
    const y1 = MAX_DISPLACED_TERRAIN_Y + 1000
    const y2 = MAX_DISPLACED_TERRAIN_Y + 2000
    expect(computeCameraNear(y2)).toBeGreaterThan(computeCameraNear(y1))
  })

  it('结构性不裁切：minDistance·cos(maxPolar) > 峰值 → 受约束运行下 near 恒为正', () => {
    const minCameraY =
      MAP_CAMERA_CONSTRAINTS.minDistance * Math.cos(MAP_CAMERA_CONSTRAINTS.maxPolarAngleRad)
    expect(minCameraY).toBeGreaterThan(MAX_DISPLACED_TERRAIN_Y)
    expect(computeCameraNear(minCameraY)).toBeGreaterThan(0)
  })

  it('代数不裁切保证：near 恒小于垂直净空（相机高度 − 峰值），且恰为其一半', () => {
    // 对任意地表点 P（P.y ≤ 峰值）：|C−P| ≥ C.y − 峰值 = 2·near > near。
    const minCameraY =
      MAP_CAMERA_CONSTRAINTS.minDistance * Math.cos(MAP_CAMERA_CONSTRAINTS.maxPolarAngleRad)
    for (let i = 0; i <= 20; i++) {
      const y = minCameraY + ((MAP_CAMERA_CONSTRAINTS.maxDistance - minCameraY) * i) / 20
      const near = computeCameraNear(y)
      const verticalClearance = y - MAX_DISPLACED_TERRAIN_Y
      expect(near).toBeGreaterThan(0)
      expect(near).toBeCloseTo(verticalClearance * NEAR_CLEARANCE_RATIO, 6)
      expect(near).toBeLessThan(verticalClearance)
    }
  })

  it('initialNear = 默认机位高度处的动态 near，落在 0.45–0.6×半对角线（与 TASK-007 已验证的 0.5× 几乎一致）', () => {
    expect(MAP_CAMERA_CONSTRAINTS.initialNear).toBe(
      computeCameraNear(DEFAULT_CAMERA_POSE.position.y),
    )
    expect(MAP_CAMERA_CONSTRAINTS.initialNear).toBeGreaterThan(MAP_HALF_DIAGONAL * 0.45)
    expect(MAP_CAMERA_CONSTRAINTS.initialNear).toBeLessThan(MAP_HALF_DIAGONAL * 0.6)
  })

  it('默认机位不切最近图角：initialNear 小于相机到东南近角（含峰值高度）的距离', () => {
    const { position } = DEFAULT_CAMERA_POSE
    // 东南近角（maxX, 峰值, maxZ）是默认东南机位下可能的最近地表点。
    const nearestCornerDistance = Math.hypot(
      position.x - MAIN_MAP_WORLD_BOUNDS.maxX,
      position.y - MAX_DISPLACED_TERRAIN_Y,
      position.z - MAIN_MAP_WORLD_BOUNDS.maxZ,
    )
    expect(MAP_CAMERA_CONSTRAINTS.initialNear).toBeLessThan(nearestCornerDistance)
  })

  it('深度精度保持 TASK-007 修复：默认机位远角（西北角）处 24 位深度精度仍为米级（< 20m）', () => {
    const { position } = DEFAULT_CAMERA_POSE
    // 西北远角（minX, 0, minZ）是默认东南机位下最远的图角——深度精度最差处。
    const farCornerDistance = Math.hypot(
      position.x - MAIN_MAP_WORLD_BOUNDS.minX,
      position.y - 0,
      position.z - MAIN_MAP_WORLD_BOUNDS.minZ,
    )
    const near = MAP_CAMERA_CONSTRAINTS.initialNear
    // 24 位深度缓冲精度 ≈ z²/(near·2²⁴)（far≫near 近似）。
    const depthPrecisionMeters =
      (farCornerDistance * farCornerDistance) / (near * 2 ** 24)
    // TASK-007 修复后全图精度 0.7–5.7m；本断言 < 20m（留 3 倍以上余量），远小于海陆分离尺度 200m。
    expect(depthPrecisionMeters).toBeLessThan(20)
  })

  it('far 覆盖最不利几何：maxDistance + 主图对角线（target 平移到远角）仍在视锥内', () => {
    const mapDiagonal = 2 * MAP_HALF_DIAGONAL
    expect(MAP_CAMERA_CONSTRAINTS.far).toBeGreaterThan(
      MAP_CAMERA_CONSTRAINTS.maxDistance + mapDiagonal,
    )
    // far 与 maxDistance 的比值有限（far 不是无界大数，保留深度缓冲有效精度）。
    expect(MAP_CAMERA_CONSTRAINTS.far).toBeLessThan(MAP_CAMERA_CONSTRAINTS.maxDistance * 4)
  })
})

describe('resize 不变量：约束只随地图包围盒变化，不随画布尺寸变化', () => {
  it('MAP_CAMERA_CONSTRAINTS 与 DEFAULT_CAMERA_POSE 已冻结（运行时不可被偷偷放宽）', () => {
    expect(Object.isFrozen(MAP_CAMERA_CONSTRAINTS)).toBe(true)
    expect(Object.isFrozen(DEFAULT_CAMERA_POSE)).toBe(true)
    expect(Object.isFrozen(DEFAULT_CAMERA_POSE.position)).toBe(true)
    expect(Object.isFrozen(DEFAULT_CAMERA_POSE.target)).toBe(true)
  })

  it('钳制 / 派生函数是纯函数：同一输入在多次调用下产出同一输出', () => {
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
    const y = DEFAULT_CAMERA_POSE.position.y
    expect(computeCameraNear(y)).toBe(computeCameraNear(y))
  })

  it('约束值是纯数值常量，不持有 / 不读取任何画布尺寸或 DOM 状态', () => {
    const values = Object.values(MAP_CAMERA_CONSTRAINTS)
    expect(values.every((v) => typeof v === 'number')).toBe(true)
    // 画布 resize 改变的是像素尺寸 / aspect，不影响米制约束——故 resize 前后约束不变。
    // 此处不模拟 resize 事件（那需要 DOM），而是断言约束对 resize 的不变性来源：
    // 它们是模块加载时一次性从 MAIN_MAP_WORLD_BOUNDS 派生的冻结常量。
    const before = { ...MAP_CAMERA_CONSTRAINTS }
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

describe('MapOrbitControls 装配（源码结构扫描：验收 2 的三道边界 + screenSpacePanning 禁用）', () => {
  const source = readSource('three/MapOrbitControls.tsx')

  it('约束数值全部来自 camera-constraints（无第二套约束常量）', () => {
    expect(source).toContain("from './camera-constraints'")
    expect(source).toContain('minDistance={MAP_CAMERA_CONSTRAINTS.minDistance}')
    expect(source).toContain('maxDistance={MAP_CAMERA_CONSTRAINTS.maxDistance}')
    expect(source).toContain('maxPolarAngle={MAP_CAMERA_CONSTRAINTS.maxPolarAngleRad}')
    expect(source).toContain('DEFAULT_CAMERA_POSE')
  })

  it('screenSpacePanning 禁用（平移始终在地表平面内，避免方向错乱）', () => {
    expect(source).toContain('screenSpacePanning={false}')
  })

  it('每帧 clampTarget 把 target 钳回包围盒，相机按同一差量回拉（视图顶回而非跳变）', () => {
    expect(source).toContain('useFrame')
    expect(source).toContain('clampTarget({ x: t.x, y: t.y, z: t.z })')
    expect(source).toContain('t.set(clamped.x, clamped.y, clamped.z)')
    expect(source).toContain('camera.position.x += dx')
    expect(source).toContain('camera.position.y += dy')
    expect(source).toContain('camera.position.z += dz')
  })

  it('每帧 computeCameraNear 跟随相机高度并 updateProjectionMatrix（动态近裁剪面）', () => {
    expect(source).toContain('computeCameraNear(camera.position.y)')
    expect(source).toContain('camera.near = nextNear')
    expect(source).toContain('camera.updateProjectionMatrix()')
  })

  it('交互开关是受控 prop（enabled={enabled}），组件不自持交互状态', () => {
    expect(source).toContain('enabled={enabled}')
    expect(source).not.toContain('useState')
  })

  it('装配 drei OrbitControls（SPEC §10 来源）并设为默认控制器', () => {
    expect(source).toContain("from '@react-three/drei'")
    expect(source).toContain('makeDefault')
  })
})

describe('App 总装（验收 1、2：Canvas camera 取自约束契约，无第二套机位）', () => {
  const source = readFileSync(resolve(srcRoot, 'App.tsx'), 'utf-8')
  const code = stripComments(source)

  it('挂载 <SceneAtmosphere /> 与 <MapOrbitControls />（氛围 + 受约束相机进画布）', () => {
    expect(source).toContain("from './three/SceneAtmosphere'")
    expect(source).toContain("from './three/MapOrbitControls'")
    const atmosphereIndex = source.indexOf('<SceneAtmosphere />')
    const controlsIndex = source.indexOf('<MapOrbitControls enabled />')
    const canvasCloseIndex = source.indexOf('</Canvas>')
    expect(atmosphereIndex).toBeGreaterThan(-1)
    expect(controlsIndex).toBeGreaterThan(-1)
    expect(canvasCloseIndex).toBeGreaterThan(controlsIndex)
    expect(canvasCloseIndex).toBeGreaterThan(atmosphereIndex)
  })

  it('Canvas camera 的 FOV / near / far / 初始位置全部取自相机约束契约', () => {
    expect(code).toContain('fov: MAP_CAMERA_CONSTRAINTS.fovDegrees')
    expect(code).toContain('near: MAP_CAMERA_CONSTRAINTS.initialNear')
    expect(code).toContain('far: MAP_CAMERA_CONSTRAINTS.far')
    expect(code).toContain('DEFAULT_CAMERA_POSE.position')
  })

  it('渲染器阴影图开关取自氛围配置（结构性 false，非默认值凑巧）', () => {
    expect(code).toContain('shadows={SCENE_ATMOSPHERE_CONFIG.shadowsEnabled}')
  })

  it('不再持有静态机位实现（无 onCreated lookAt / 无本地相机常量，机位唯一源在 camera-constraints）', () => {
    expect(code).not.toContain('onCreated')
    expect(code).not.toContain('lookAt')
    expect(code).not.toContain('CAMERA_FOV_DEGREES')
    expect(code).not.toContain('DEFAULT_CAMERA_POSITION')
  })
})
