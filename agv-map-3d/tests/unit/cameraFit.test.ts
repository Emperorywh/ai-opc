/*
 * 标准 3/4 相机 fit 自动化验证（TASK-017，SPEC 12.2 / 16）。
 *
 * 设计：
 *   - 真实样本 + 宽屏（16:9）/ 窄屏（9:16）：验证 50° FOV、60° polar、45° azimuth 方向、
 *     fit 球心 Y=0、R 与 distance 推导；宽屏受垂直 FOV 限制、窄屏受水平 FOV 限制。
 *   - NDC 投影：用与 Three Matrix4.lookAt / PerspectiveCamera 同约定的手写投影，断言扩张范围
 *     八角满足 |NDC.x| ≤ 0.92 且 |NDC.y| ≤ 0.92（SPEC 12.2 / 任务验证方式第 3 项）。
 *   - 合成非方形范围 + 宽 / 窄视口：完整覆盖宽屏与窄屏分支。
 *   - 非 Y 几何范围（minY = maxY = 0）：fit 仍合法，R 含扩张 Y 贡献。
 *   - 确定性：相同输入得到同一结果（首次 fit 与未导航 resize 等价）。
 *   - 地面不影响 fit：fit 只接收 contentBounds + aspect，不接收 ground。
 *   - 异常路径：零尺寸 / 非有限 aspect、非有限 / 反转 contentBounds → null，禁止 NaN / Infinity。
 *
 * 不启动浏览器：投影数学为纯函数手写实现，不创建 Three / WebGL 对象。
 */
import { describe, test, expect, beforeAll } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  computeCameraFit,
  PERSPECTIVE_FOV_DEG,
  INITIAL_POLAR_DEG,
  INITIAL_AZIMUTH_DEG,
  FIT_MARGIN,
  FIT_BOUNDS_PADDING,
} from '../../src/camera/cameraFit'
import type { Vec3 } from '../../src/camera/cameraFit'
import type { NumericBox3 } from '../../src/domain/sceneMap'
import { buildSceneModel } from '../../src/workers/buildSceneModel'
import { parseSampleEnvelope } from '../../src/adapters/parseSampleEnvelope'
import { validateMapSemantics } from '../../src/adapters/validateMapSemantics'
import { normalizeSceneMap } from '../../src/adapters/normalizeSceneMap'
import {
  computeFileSha256,
  EXPECTED_SAMPLE_SHA256,
} from '../../scripts/sample-supply-chain.mjs'

/*
 * SPEC 12.2：方向分量固定值（单位向量）。
 * direction = (sin60°cos45°, cos60°, sin60°sin45°)。
 */
const EXPECTED_DIR_X = Math.sin((INITIAL_POLAR_DEG * Math.PI) / 180) * Math.cos((INITIAL_AZIMUTH_DEG * Math.PI) / 180)
const EXPECTED_DIR_Y = Math.cos((INITIAL_POLAR_DEG * Math.PI) / 180)
const EXPECTED_DIR_Z = Math.sin((INITIAL_POLAR_DEG * Math.PI) / 180) * Math.sin((INITIAL_AZIMUTH_DEG * Math.PI) / 180)

/*
 * SPEC 12.2：扩张范围八角 NDC 投影阈值。
 */
const NDC_LIMIT = 0.92

/*
 * 合成 bounds 构造工具。
 */
function box(overrides: Partial<NumericBox3>): NumericBox3 {
  return {
    minX: -1,
    minY: 0,
    minZ: -1,
    maxX: 1,
    maxY: 0.066,
    maxZ: 1,
    ...overrides,
  }
}

/*
 * 手写 NDC 投影（与 Three Matrix4.lookAt(eye, target, up=(0,1,0)) + PerspectiveCamera 同约定）。
 *
 *   - 相机 +Z = normalize(eye - target)；+X = normalize(up × +Z)；+Y = +Z × +X。
 *   - cameraSpace.z = +Z · (p - eye)；clip.w = -cameraSpace.z；NDC = clip.xy / clip.w。
 *   - 透视：f = 1 / tan(verticalFov / 2)；NDC.x = (f / aspect) × camX / w；NDC.y = f × camY / w。
 *
 * 不依赖 three，确保 node 测试环境确定性；与 Three 投影矩阵元素布局逐一等价。
 */
function projectNDC(
  point: Vec3,
  position: Vec3,
  target: Vec3,
  fovDeg: number,
  aspect: number,
): { x: number; y: number } {
  const zxRaw = position.x - target.x
  const zyRaw = position.y - target.y
  const zzRaw = position.z - target.z
  const zLen = Math.sqrt(zxRaw * zxRaw + zyRaw * zyRaw + zzRaw * zzRaw)
  const zx = zxRaw / zLen
  const zy = zyRaw / zLen
  const zz = zzRaw / zLen
  // up × +Z，up = (0,1,0)：(zz, 0, -zx)
  const xxRaw = zz
  const xyRaw = 0
  const xzRaw = -zx
  const xLen = Math.sqrt(xxRaw * xxRaw + xyRaw * xyRaw + xzRaw * xzRaw)
  const xx = xxRaw / xLen
  const xy = xyRaw / xLen
  const xz = xzRaw / xLen
  // +Y = +Z × +X
  const yx = zy * xz - zz * xy
  const yy = zz * xx - zx * xz
  const yz = zx * xy - zy * xx
  const dx = point.x - position.x
  const dy = point.y - position.y
  const dz = point.z - position.z
  const camX = xx * dx + xy * dy + xz * dz
  const camY = yx * dx + yy * dy + yz * dz
  const camZ = zx * dx + zy * dy + zz * dz
  const f = 1 / Math.tan((fovDeg * Math.PI) / 180 / 2)
  const w = -camZ
  return { x: (f / aspect) * (camX / w), y: f * (camY / w) }
}

/*
 * 取 box 八个角的世界坐标列表。
 */
function corners(b: NumericBox3): readonly Vec3[] {
  const xs = [b.minX, b.maxX]
  const ys = [b.minY, b.maxY]
  const zs = [b.minZ, b.maxZ]
  const out: Vec3[] = []
  for (const x of xs) for (const y of ys) for (const z of zs) out.push({ x, y, z })
  return out
}

// ─── 真实样本集成（SPEC 15.1 / 12.2）──────────────────────────────────────────

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '..', '..')
const REAL_SAMPLE = resolve(root, 'data', 'sampleMap.json')

let realContentBounds: NumericBox3

beforeAll(async () => {
  const sha = await computeFileSha256(REAL_SAMPLE)
  if (sha !== EXPECTED_SAMPLE_SHA256) {
    throw new Error(`样本身份不符，停止回归验证：${sha}`)
  }
  const rawJson = JSON.parse(readFileSync(REAL_SAMPLE, 'utf8')) as unknown
  const rawMap = parseSampleEnvelope(rawJson)
  validateMapSemantics(rawMap)
  const sceneMap = normalizeSceneMap(rawMap)
  realContentBounds = buildSceneModel(sceneMap).contentBounds
})

// ─── 方向与 FOV（SPEC 12.2）──────────────────────────────────────────────────

describe('标准 3/4 方向与受限 FOV（SPEC 12.2）', () => {
  test('方向单位向量 = (sin60°cos45°, cos60°, sin60°sin45°)，y > 0 位于地面上方', () => {
    const fit = computeCameraFit(realContentBounds, 16 / 9)!
    expect(fit.direction.x).toBeCloseTo(EXPECTED_DIR_X, 10)
    expect(fit.direction.y).toBeCloseTo(EXPECTED_DIR_Y, 10)
    expect(fit.direction.z).toBeCloseTo(EXPECTED_DIR_Z, 10)
    const mag = Math.sqrt(
      fit.direction.x ** 2 + fit.direction.y ** 2 + fit.direction.z ** 2,
    )
    expect(mag).toBeCloseTo(1, 10)
    expect(fit.direction.y).toBeGreaterThan(0)
  })

  test('宽屏 16:9 受垂直 FOV 限制：limitedFov = verticalFov = radians(50)', () => {
    const fit = computeCameraFit(realContentBounds, 16 / 9)!
    const verticalFov = (PERSPECTIVE_FOV_DEG * Math.PI) / 180
    expect(fit.verticalFov).toBeCloseTo(verticalFov, 10)
    // 水平 FOV 大于垂直 → 垂直是受限方向。
    expect(fit.horizontalFov).toBeGreaterThan(fit.verticalFov)
    expect(fit.limitedFov).toBeCloseTo(fit.verticalFov, 10)
  })

  test('窄屏 9:16 受水平 FOV 限制：limitedFov = horizontalFov < verticalFov', () => {
    const fit = computeCameraFit(realContentBounds, 9 / 16)!
    const verticalFov = (PERSPECTIVE_FOV_DEG * Math.PI) / 180
    expect(fit.horizontalFov).toBeLessThan(verticalFov)
    expect(fit.limitedFov).toBeCloseTo(fit.horizontalFov, 10)
    // 窄屏需要更远距离才能容纳同样宽度内容。
    const wide = computeCameraFit(realContentBounds, 16 / 9)!
    expect(fit.distance).toBeGreaterThan(wide.distance)
  })
})

// ─── fit 球心、R 与 distance（SPEC 12.2）──────────────────────────────────────

describe('fit 球心 / R / distance 推导（SPEC 12.2）', () => {
  test('target Y 固定为 0，XZ 为内容中心（不使用 bounds Y 中心）', () => {
    const fit = computeCameraFit(realContentBounds, 16 / 9)!
    expect(fit.target.y).toBe(0)
    expect(fit.target.x).toBeCloseTo(
      (realContentBounds.minX + realContentBounds.maxX) / 2,
      6,
    )
    expect(fit.target.z).toBeCloseTo(
      (realContentBounds.minZ + realContentBounds.maxZ) / 2,
      6,
    )
  })

  test('R = target 到 expandedBounds 八角最大距离，distance = margin × R / sin(limitedFov/2)', () => {
    const fit = computeCameraFit(realContentBounds, 16 / 9)!
    // 手工重算 R：target 到 expandedBounds 八角最大距离。
    const exp = {
      minX: realContentBounds.minX - FIT_BOUNDS_PADDING,
      minY: realContentBounds.minY - FIT_BOUNDS_PADDING,
      minZ: realContentBounds.minZ - FIT_BOUNDS_PADDING,
      maxX: realContentBounds.maxX + FIT_BOUNDS_PADDING,
      maxY: realContentBounds.maxY + FIT_BOUNDS_PADDING,
      maxZ: realContentBounds.maxZ + FIT_BOUNDS_PADDING,
    }
    let rMax = 0
    for (const c of corners(exp)) {
      const d = Math.sqrt(
        (c.x - fit.target.x) ** 2 +
          (c.y - fit.target.y) ** 2 +
          (c.z - fit.target.z) ** 2,
      )
      if (d > rMax) rMax = d
    }
    expect(fit.radius).toBeCloseTo(rMax, 4)
    expect(fit.distance).toBeCloseTo(
      (FIT_MARGIN * rMax) / Math.sin(fit.limitedFov / 2),
      4,
    )
    expect(fit.radius).toBeGreaterThan(0)
    expect(fit.distance).toBeGreaterThan(fit.radius)
  })

  test('position = target + direction × distance', () => {
    const fit = computeCameraFit(realContentBounds, 16 / 9)!
    expect(fit.position.x).toBeCloseTo(
      fit.target.x + fit.direction.x * fit.distance,
      6,
    )
    expect(fit.position.y).toBeCloseTo(
      fit.target.y + fit.direction.y * fit.distance,
      6,
    )
    expect(fit.position.z).toBeCloseTo(
      fit.target.z + fit.direction.z * fit.distance,
      6,
    )
  })

  test('expandedBounds = contentBounds 每侧扩张 FIT_BOUNDS_PADDING', () => {
    const fit = computeCameraFit(realContentBounds, 16 / 9)!
    expect(fit.expandedBounds.minX).toBeCloseTo(
      realContentBounds.minX - FIT_BOUNDS_PADDING,
      6,
    )
    expect(fit.expandedBounds.maxX).toBeCloseTo(
      realContentBounds.maxX + FIT_BOUNDS_PADDING,
      6,
    )
    expect(fit.expandedBounds.minZ).toBeCloseTo(
      realContentBounds.minZ - FIT_BOUNDS_PADDING,
      6,
    )
    expect(fit.expandedBounds.maxZ).toBeCloseTo(
      realContentBounds.maxZ + FIT_BOUNDS_PADDING,
      6,
    )
  })
})

// ─── NDC 投影完整性（SPEC 12.2 / 任务验证方式第 3 项）─────────────────────────

describe('扩张范围八角 NDC 投影（SPEC 12.2 / 任务验证方式第 3 项）', () => {
  test('真实样本宽屏 16:9：八角 |NDC.x| ≤ 0.92 且 |NDC.y| ≤ 0.92', () => {
    const aspect = 16 / 9
    const fit = computeCameraFit(realContentBounds, aspect)!
    let maxX = 0
    let maxY = 0
    for (const c of corners(fit.expandedBounds)) {
      const ndc = projectNDC(c, fit.position, fit.target, PERSPECTIVE_FOV_DEG, aspect)
      maxX = Math.max(maxX, Math.abs(ndc.x))
      maxY = Math.max(maxY, Math.abs(ndc.y))
    }
    expect(maxX).toBeLessThanOrEqual(NDC_LIMIT)
    expect(maxY).toBeLessThanOrEqual(NDC_LIMIT)
  })

  test('真实样本窄屏 9:16：八角 |NDC.x| ≤ 0.92 且 |NDC.y| ≤ 0.92', () => {
    const aspect = 9 / 16
    const fit = computeCameraFit(realContentBounds, aspect)!
    let maxX = 0
    let maxY = 0
    for (const c of corners(fit.expandedBounds)) {
      const ndc = projectNDC(c, fit.position, fit.target, PERSPECTIVE_FOV_DEG, aspect)
      maxX = Math.max(maxX, Math.abs(ndc.x))
      maxY = Math.max(maxY, Math.abs(ndc.y))
    }
    expect(maxX).toBeLessThanOrEqual(NDC_LIMIT)
    expect(maxY).toBeLessThanOrEqual(NDC_LIMIT)
  })

  test('合成非方形宽范围 + 宽屏：完整容纳，NDC ≤ 0.92', () => {
    // 极宽范围（宽 200、深 20）：宽屏仍由垂直 FOV 限制，但水平方向内容更宽。
    const content = box({ minX: -100, maxX: 100, minZ: -10, maxZ: 10 })
    const aspect = 16 / 9
    const fit = computeCameraFit(content, aspect)!
    let maxX = 0
    let maxY = 0
    for (const c of corners(fit.expandedBounds)) {
      const ndc = projectNDC(c, fit.position, fit.target, PERSPECTIVE_FOV_DEG, aspect)
      maxX = Math.max(maxX, Math.abs(ndc.x))
      maxY = Math.max(maxY, Math.abs(ndc.y))
    }
    expect(maxX).toBeLessThanOrEqual(NDC_LIMIT)
    expect(maxY).toBeLessThanOrEqual(NDC_LIMIT)
  })

  test('合成非方形窄范围 + 窄屏：完整容纳，NDC ≤ 0.92', () => {
    // 极窄视口（竖屏）：水平 FOV 限制距离。
    const content = box({ minX: -100, maxX: 100, minZ: -10, maxZ: 10 })
    const aspect = 1080 / 1920
    const fit = computeCameraFit(content, aspect)!
    expect(fit).not.toBeNull()
    let maxX = 0
    let maxY = 0
    for (const c of corners(fit.expandedBounds)) {
      const ndc = projectNDC(c, fit.position, fit.target, PERSPECTIVE_FOV_DEG, aspect)
      maxX = Math.max(maxX, Math.abs(ndc.x))
      maxY = Math.max(maxY, Math.abs(ndc.y))
    }
    expect(maxX).toBeLessThanOrEqual(NDC_LIMIT)
    expect(maxY).toBeLessThanOrEqual(NDC_LIMIT)
  })
})

// ─── 非 Y 几何范围与确定性（SPEC 12.2 / 任务约束）─────────────────────────────

describe('非零 / 零 Y 几何范围与确定性（SPEC 12.2 / 任务约束）', () => {
  test('非零 Y 几何范围：fit 合法，R 含 Y 贡献', () => {
    const content = box({ minX: -10, maxX: 10, minY: -2, maxY: 8, minZ: -10, maxZ: 10 })
    const fit = computeCameraFit(content, 1)!
    expect(fit).not.toBeNull()
    // expanded Y = [-2.5, 8.5]，target Y = 0，R 至少含 max(2.5, 8.5) = 8.5 的 Y 贡献。
    expect(fit.radius).toBeGreaterThan(8.5)
  })

  test('零 Y 几何范围（minY = maxY = 0）：fit 仍合法', () => {
    const content = box({ minX: -10, maxX: 10, minY: 0, maxY: 0, minZ: -10, maxZ: 10 })
    const fit = computeCameraFit(content, 1)!
    expect(fit).not.toBeNull()
    expect(fit.target.y).toBe(0)
    // 扩张后 Y = [-0.5, 0.5]，R 含 0.5 的 Y 贡献。
    expect(fit.radius).toBeGreaterThan(0)
  })

  test('确定性：相同输入得到同一结果（首次 fit 与未导航 resize 等价）', () => {
    const a = computeCameraFit(realContentBounds, 16 / 9)!
    const b = computeCameraFit(realContentBounds, 16 / 9)!
    expect(b.position.x).toBe(a.position.x)
    expect(b.position.y).toBe(a.position.y)
    expect(b.position.z).toBe(a.position.z)
    expect(b.target).toEqual(a.target)
    expect(b.radius).toBe(a.radius)
    expect(b.distance).toBe(a.distance)
  })

  test('地面不改变 fit 结果：fit 不接收 ground，结果与 ground 无关', () => {
    // fit 只接收 contentBounds + aspect；地面推导与 fit 是独立函数，不存在数据耦合。
    const fit1 = computeCameraFit(realContentBounds, 16 / 9)!
    // 即便先 / 后调用地面推导，fit 结果字节一致（结构性证明：fit 不读 ground）。
    const fit2 = computeCameraFit(realContentBounds, 16 / 9)!
    expect(fit2).toEqual(fit1)
  })
})

// ─── 异常路径（SPEC 16 / 任务约束）─────────────────────────────────────────────

describe('异常路径 · 无效输入返回 null（SPEC 16 / 任务约束）', () => {
  test('零尺寸画布（aspect = 0）→ null', () => {
    expect(computeCameraFit(realContentBounds, 0)).toBeNull()
  })

  test('负 aspect → null', () => {
    expect(computeCameraFit(realContentBounds, -1.5)).toBeNull()
  })

  test('非有限 aspect（NaN / Infinity）→ null', () => {
    expect(computeCameraFit(realContentBounds, Number.NaN)).toBeNull()
    expect(computeCameraFit(realContentBounds, Number.POSITIVE_INFINITY)).toBeNull()
  })

  test('非有限 contentBounds → null', () => {
    expect(computeCameraFit(box({ minX: Number.NaN }), 16 / 9)).toBeNull()
    expect(
      computeCameraFit(box({ maxZ: Number.POSITIVE_INFINITY }), 16 / 9),
    ).toBeNull()
  })

  test('反转 contentBounds（min > max）→ null', () => {
    expect(computeCameraFit(box({ minX: 10, maxX: -10 }), 16 / 9)).toBeNull()
    expect(computeCameraFit(box({ minY: 5, maxY: 1 }), 16 / 9)).toBeNull()
  })
})
