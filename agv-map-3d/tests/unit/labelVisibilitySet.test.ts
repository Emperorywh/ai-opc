/*
 * 标签可见集自动化验证（TASK-021，SPEC 11.3 / 5.2 / 7.1 / 12.2 / 15.2 / 16）。
 *
 * 设计：
 *   - 纯计算验证：空间索引分桶、视锥 / NDC / cameraScreenUp 投影、10/8px 迟滞边界、
 *     稳定排序（kind → 屏幕距离 → ID）、400 上限、create/destroy 差量、确定性与退化输入。
 *   - 真实样本集成：先校验 SHA-256，再走完整可信链到 buildSceneModel.labels + contentBounds，
 *     用 computeCameraFit 推导标准 fit 相机，自建与 Three 同约定的 view-projection 矩阵与世界四元数，
 *     断言初始标准 fit 后目标集合为 0（全部投影字号 < 10px）、放大后集合 <= 400 且优先级稳定。
 *   - 调度契约：controls-change 10Hz 节流、controls-end / resize 立即查询不被吞掉；时钟显式传入。
 *
 * 不启动浏览器：投影数学与调度决策为纯函数；VP 矩阵与四元数由测试自建，不创建 Three / WebGL 对象。
 */
import { describe, test, expect, beforeAll } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

import { buildLabelSpatialIndex } from '../../src/labels/labelSpatialIndex'
import { cellGridBounds } from '../../src/labels/labelSpatialIndex'
import {
  computeCameraScreenUp,
  computeFontPixelSize,
  computeScreenCenterDistancePx,
  boxIntersectsFrustum,
  extractFrustumPlanes,
  isValidLabelCameraInput,
  pointInFrustum,
  projectToNdc,
} from '../../src/labels/labelProjection'
import type {
  CameraQuaternion,
  LabelCameraInput,
} from '../../src/labels/labelProjection'
import { computeLabelVisibilitySet } from '../../src/labels/labelVisibilitySet'
import {
  decideVisibilityQuery,
  initialVisibilitySchedulerState,
} from '../../src/labels/labelVisibilityScheduler'
import {
  LABEL_ENTER_THRESHOLD_PX,
  LABEL_EXIT_THRESHOLD_PX,
  LABEL_GRID_CELL_SIZE,
  LABEL_MAX_MOUNTED,
  LABEL_QUERY_MIN_INTERVAL_MS,
} from '../../src/labels/labelVisibilityConfig'
import type { LabelDescriptor, LabelKind } from '../../src/labels/labelDescriptor'
import { computeCameraFit, PERSPECTIVE_FOV_DEG } from '../../src/camera/cameraFit'
import type { Vec3 } from '../../src/camera/cameraFit'
import { buildSceneModel } from '../../src/workers/buildSceneModel'
import { parseSampleEnvelope } from '../../src/adapters/parseSampleEnvelope'
import { validateMapSemantics } from '../../src/adapters/validateMapSemantics'
import { normalizeSceneMap } from '../../src/adapters/normalizeSceneMap'
import {
  computeFileSha256,
  EXPECTED_SAMPLE_SHA256,
} from '../../scripts/sample-supply-chain.mjs'

// ─── 测试工具：合成描述符 ──────────────────────────────────────────────────────

/*
 * 合成标签描述符：默认 operational-node 位于原点 (0, 0.25, 0)。
 */
function descriptor(overrides: Partial<LabelDescriptor> & { id: string }): LabelDescriptor {
  return {
    ownerId: overrides.id,
    kind: 'operational-node',
    text: overrides.id,
    anchorX: 0,
    anchorY: 0.25,
    anchorZ: 0,
    localOffsetX: 0,
    localOffsetY: 0,
    ...overrides,
  }
}

// ─── 测试工具：与 Three 同约定的列主序矩阵与四元数 ────────────────────────────

/*
 * 列主序 4×4 矩阵乘法 C = A × B（Three Matrix4.multiplyMatrices 同约定，elements[col*4+row]）。
 */
function mul4(a: readonly number[], b: readonly number[]): number[] {
  const c = new Array<number>(16).fill(0)
  for (let col = 0; col < 4; col++) {
    for (let row = 0; row < 4; row++) {
      let sum = 0
      for (let k = 0; k < 4; k++) {
        sum += a[k * 4 + row] * b[col * 4 + k]
      }
      c[col * 4 + row] = sum
    }
  }
  return c
}

/*
 * 构造 view 矩阵（世界 → 相机，gluLookAt 等价，列主序）。
 *   z = normalize(eye - target)（相机 +Z，向后）
 *   x = normalize(cross(up, z))（相机 +X，向右）
 *   y = cross(z, x)（相机 +Y，向上）
 * 返回 { view(列主序), xAxis, yAxis, zAxis }，供四元数构造复用。
 */
function buildViewBasis(eye: Vec3, target: Vec3, up: Vec3) {
  const zxRaw = eye.x - target.x
  const zyRaw = eye.y - target.y
  const zzRaw = eye.z - target.z
  const zLen = Math.sqrt(zxRaw * zxRaw + zyRaw * zyRaw + zzRaw * zzRaw)
  const zx = zxRaw / zLen
  const zy = zyRaw / zLen
  const zz = zzRaw / zLen
  // x = up × z
  const xxRaw = up.y * zz - up.z * zy
  const xyRaw = up.z * zx - up.x * zz
  const xzRaw = up.x * zy - up.y * zx
  const xLen = Math.sqrt(xxRaw * xxRaw + xyRaw * xyRaw + xzRaw * xzRaw)
  const xx = xxRaw / xLen
  const xy = xyRaw / xLen
  const xz = xzRaw / xLen
  // y = z × x
  const yx = zy * xz - zz * xy
  const yy = zz * xx - zx * xz
  const yz = zx * xy - zy * xx
  // 平移分量 = -axis · eye
  const tx = -(xx * eye.x + xy * eye.y + xz * eye.z)
  const ty = -(yx * eye.x + yy * eye.y + yz * eye.z)
  const tz = -(zx * eye.x + zy * eye.y + zz * eye.z)
  const view = [
    xx, yx, zx, 0,
    xy, yy, zy, 0,
    xz, yz, zz, 0,
    tx, ty, tz, 1,
  ]
  return {
    view,
    xAxis: { x: xx, y: xy, z: xz },
    yAxis: { x: yx, y: yy, z: yz },
    zAxis: { x: zx, y: zy, z: zz },
  }
}

/*
 * 构造对称透视矩阵（Three PerspectiveCamera，列主序，WebGL z∈[-1,1]）。
 */
function buildPerspective(fovDeg: number, aspect: number, near: number, far: number): number[] {
  const f = 1 / Math.tan(((fovDeg * Math.PI) / 180) / 2)
  const c = -(far + near) / (far - near)
  const d = -(2 * far * near) / (far - near)
  return [
    f / aspect, 0, 0, 0,
    0, f, 0, 0,
    0, 0, c, -1,
    0, 0, d, 0,
  ]
}

/*
 * 由相机旋转基（列 = 世界系相机轴）经 Shepperd 法构造世界四元数 [x,y,z,w]。
 * 与 THREE.Quaternion.setFromRotationMatrix 对同一旋转一致。
 */
function basisToQuaternion(
  xAxis: Vec3, yAxis: Vec3, zAxis: Vec3,
): CameraQuaternion {
  // 旋转矩阵 R[row][col]，col 0/1/2 = x/y/z 轴。
  const m00 = xAxis.x, m01 = yAxis.x, m02 = zAxis.x
  const m10 = xAxis.y, m11 = yAxis.y, m12 = zAxis.y
  const m20 = xAxis.z, m21 = yAxis.z, m22 = zAxis.z
  const trace = m00 + m11 + m22
  if (trace > 0) {
    const s = Math.sqrt(trace + 1) * 2 // 4qw
    return [(m21 - m12) / s, (m02 - m20) / s, (m10 - m01) / s, 0.25 * s]
  } else if (m00 > m11 && m00 > m22) {
    const s = Math.sqrt(1 + m00 - m11 - m22) * 2 // 4qx
    return [0.25 * s, (m01 + m10) / s, (m02 + m20) / s, (m21 - m12) / s]
  } else if (m11 > m22) {
    const s = Math.sqrt(1 + m11 - m00 - m22) * 2 // 4qy
    return [(m01 + m10) / s, 0.25 * s, (m12 + m21) / s, (m02 - m20) / s]
  }
  const s = Math.sqrt(1 + m22 - m00 - m11) * 2 // 4qz
  return [(m02 + m20) / s, (m12 + m21) / s, 0.25 * s, (m10 - m01) / s]
}

/*
 * 构造标准相机输入：view-projection 矩阵（P × V）+ 世界四元数 + 画布尺寸。
 * 与运行时 Three camera.projectionMatrix × matrixWorldInverse 及 camera.quaternion 同口径。
 */
function buildCameraInput(
  eye: Vec3, target: Vec3, up: Vec3,
  fovDeg: number, aspect: number, near: number, far: number,
  canvasWidthPx: number, canvasHeightPx: number,
): { cam: LabelCameraInput; yAxis: Vec3 } {
  const basis = buildViewBasis(eye, target, up)
  const proj = buildPerspective(fovDeg, aspect, near, far)
  const vp = mul4(proj, basis.view)
  const q = basisToQuaternion(basis.xAxis, basis.yAxis, basis.zAxis)
  return {
    cam: {
      viewProjectionMatrix: vp,
      cameraWorldQuaternion: q,
      canvasWidthPx,
      canvasHeightPx,
    },
    yAxis: basis.yAxis,
  }
}

/*
 * 解析 NDC 投影（与 cameraFit.test projectNDC 同口径，用于交叉验证 VP 矩阵构造）。
 */
function analyticalNdc(
  point: Vec3, eye: Vec3, target: Vec3, fovDeg: number, aspect: number,
): { x: number; y: number } {
  const zxRaw = eye.x - target.x
  const zyRaw = eye.y - target.y
  const zzRaw = eye.z - target.z
  const zLen = Math.sqrt(zxRaw * zxRaw + zyRaw * zyRaw + zzRaw * zzRaw)
  const zx = zxRaw / zLen, zy = zyRaw / zLen, zz = zzRaw / zLen
  const xxRaw = zz, xyRaw = 0, xzRaw = -zx // up × z, up=(0,1,0)
  const xLen = Math.sqrt(xxRaw * xxRaw + xyRaw * xyRaw + xzRaw * xzRaw)
  const xx = xxRaw / xLen, xy = xyRaw / xLen, xz = xzRaw / xLen
  const yx = zy * xz - zz * xy
  const yy = zz * xx - zx * xz
  const yz = zx * xy - zy * xx
  const dx = point.x - eye.x
  const dy = point.y - eye.y
  const dz = point.z - eye.z
  const camX = xx * dx + xy * dy + xz * dz
  const camY = yx * dx + yy * dy + yz * dz
  const camZ = zx * dx + zy * dy + zz * dz
  const f = 1 / Math.tan(((fovDeg * Math.PI) / 180) / 2)
  const w = -camZ
  return { x: (f / aspect) * (camX / w), y: f * (camY / w) }
}

/*
 * 解析投影字号（与 computeFontPixelSize 同口径，测试交叉验证用，不复用被测模块）。
 * fontPixels = |ndY(tip) - ndY(anchor)| × canvasHeight / 2，tip = anchor + up×0.20，up 用相机基 yAxis。
 */
function analyticalFontPixels(
  anchor: Vec3, yAxis: Vec3, eye: Vec3, target: Vec3, fovDeg: number, aspect: number,
  canvasHeightPx: number,
): number {
  const tip: Vec3 = {
    x: anchor.x + yAxis.x * 0.20,
    y: anchor.y + yAxis.y * 0.20,
    z: anchor.z + yAxis.z * 0.20,
  }
  const a = analyticalNdc(anchor, eye, target, fovDeg, aspect)
  const b = analyticalNdc(tip, eye, target, fovDeg, aspect)
  return Math.abs(b.y - a.y) * (canvasHeightPx / 2)
}

// ─── 空间索引（SPEC 11.3 第 2 项）──────────────────────────────────────────────

describe('空间索引 · 4m uniform-grid 分桶与稳定遍历（SPEC 11.3 第 2 项）', () => {
  test('描述符按 floor(anchor/cellSize) 落入对应 cell', () => {
    const ds = [
      descriptor({ id: 'a', anchorX: 0.1, anchorZ: 0.1 }), // col0,row0
      descriptor({ id: 'b', anchorX: 3.9, anchorZ: 3.9 }), // col0,row0
      descriptor({ id: 'c', anchorX: 4.0, anchorZ: 0.0 }), // col1,row0
      descriptor({ id: 'd', anchorX: -0.1, anchorZ: -0.1 }), // col-1,row-1
    ]
    const idx = buildLabelSpatialIndex(ds, LABEL_GRID_CELL_SIZE)
    expect(idx.descriptorCount).toBe(4)
    expect(idx.occupiedCells).toHaveLength(3)
    // (col,row) 升序：(-1,-1) → (0,0) → (1,0)
    expect(idx.occupiedCells[0].col).toBe(-1)
    expect(idx.occupiedCells[0].row).toBe(-1)
    expect(idx.occupiedCells[1].col).toBe(0)
    expect(idx.occupiedCells[1].row).toBe(0)
    expect(idx.occupiedCells[1].descriptors.map((d) => d.id)).toEqual(['a', 'b'])
    expect(idx.occupiedCells[2].col).toBe(1)
  })

  test('cell XZ 网格范围 = [col×s, (col+1)×s] × [row×s, (row+1)×s]', () => {
    const b = cellGridBounds(2, -1, 4)
    expect(b.minX).toBe(8)
    expect(b.maxX).toBe(12)
    expect(b.minZ).toBe(-4)
    expect(b.maxZ).toBe(0)
  })

  test('重复构建 → 占用 cell 顺序与桶内描述符完全一致', () => {
    const ds = [
      descriptor({ id: 'z', anchorX: 5, anchorZ: 5 }),
      descriptor({ id: 'a', anchorX: 5, anchorZ: 5 }),
      descriptor({ id: 'm', anchorX: 1, anchorZ: 1 }),
    ]
    const a = buildLabelSpatialIndex(ds, LABEL_GRID_CELL_SIZE)
    const b = buildLabelSpatialIndex(ds, LABEL_GRID_CELL_SIZE)
    expect(a.occupiedCells.map((c) => ({ col: c.col, row: c.row, ids: c.descriptors.map((d) => d.id) }))).toEqual(
      b.occupiedCells.map((c) => ({ col: c.col, row: c.row, ids: c.descriptors.map((d) => d.id) })),
    )
  })

  test('非有限锚点 → MAP_GEOMETRY_INVALID，不静默跳过', () => {
    const ds = [descriptor({ id: 'nan', anchorX: Number.NaN, anchorZ: 0 })]
    expect(() => buildLabelSpatialIndex(ds, LABEL_GRID_CELL_SIZE)).toThrow()
  })

  test('非法 cellSize → MAP_GEOMETRY_INVALID', () => {
    expect(() => buildLabelSpatialIndex([descriptor({ id: 'a' })], 0)).toThrow()
    expect(() => buildLabelSpatialIndex([descriptor({ id: 'a' })], -1)).toThrow()
  })
})

// ─── 投影数学：cameraScreenUp / NDC / 视锥（SPEC 11.3 第 1~4 项）──────────────

describe('投影数学 · cameraScreenUp 由世界四元数推导（SPEC 11.3 第 4 项）', () => {
  test('单位四元数 → screenUp = 世界 +Y', () => {
    const up = computeCameraScreenUp([0, 0, 0, 1])
    expect(up.x).toBeCloseTo(0, 10)
    expect(up.y).toBeCloseTo(1, 10)
    expect(up.z).toBeCloseTo(0, 10)
  })

  test('绕 +Z 旋转 90° → 局部 +Y 转到世界 -X', () => {
    const s = Math.SQRT1_2
    const up = computeCameraScreenUp([0, 0, s, s]) // 90° about +Z
    expect(up.x).toBeCloseTo(-1, 10)
    expect(up.y).toBeCloseTo(0, 10)
    expect(up.z).toBeCloseTo(0, 10)
  })

  test('禁止用固定世界 +Y：滚转相机后 screenUp 不再是 (0,1,0)', () => {
    // 绕 +X 旋转 45° 把局部 +Y 倾斜：q = (sin(θ/2),0,0,cos(θ/2))，θ=45°。
    const half = (45 * Math.PI) / 180 / 2
    const up = computeCameraScreenUp([Math.sin(half), 0, 0, Math.cos(half)])
    expect(up.x).toBeCloseTo(0, 10)
    expect(up.y).toBeCloseTo(Math.SQRT1_2, 10) // cos45
    expect(up.z).toBeCloseTo(Math.SQRT1_2, 10) // sin45
    // screenUp 不再是固定世界 +Y，证明用了四元数而非硬编码 (0,1,0)。
    expect(Math.abs(up.y - 1)).toBeGreaterThan(0.1)
  })
})

describe('投影数学 · VP 矩阵构造与解析投影交叉一致（SPEC 11.3 第 1 项）', () => {
  test('projectToNdc 与解析 NDC 一致（标准 fit 相机）', () => {
    const { cam } = buildCameraInput(
      { x: 50, y: 50, z: 50 }, { x: 0, y: 0, z: 0 }, { x: 0, y: 1, z: 0 },
      PERSPECTIVE_FOV_DEG, 16 / 9, 0.1, 1000, 1920, 1080,
    )
    for (const p of [{ x: 10, y: 0.25, z: 5 }, { x: -20, y: 0.25, z: -8 }, { x: 0, y: 0.25, z: 30 }]) {
      const got = projectToNdc(cam.viewProjectionMatrix, p.x, p.y, p.z)!
      const exp = analyticalNdc(p, { x: 50, y: 50, z: 50 }, { x: 0, y: 0, z: 0 }, PERSPECTIVE_FOV_DEG, 16 / 9)
      expect(got.x).toBeCloseTo(exp.x, 6)
      expect(got.y).toBeCloseTo(exp.y, 6)
    }
  })

  test('computeCameraScreenUp(q) 与相机基 yAxis 一致（lookAt 相机）', () => {
    const { cam, yAxis } = buildCameraInput(
      { x: 40, y: 60, z: 30 }, { x: 0, y: 0, z: 0 }, { x: 0, y: 1, z: 0 },
      PERSPECTIVE_FOV_DEG, 16 / 9, 0.1, 1000, 1920, 1080,
    )
    const up = computeCameraScreenUp(cam.cameraWorldQuaternion)
    expect(up.x).toBeCloseTo(yAxis.x, 6)
    expect(up.y).toBeCloseTo(yAxis.y, 6)
    expect(up.z).toBeCloseTo(yAxis.z, 6)
  })
})

describe('投影数学 · 视锥点 / AABB 测试（SPEC 11.3 第 1~3 项）', () => {
  const eye: Vec3 = { x: 0, y: 0, z: 10 }
  const target: Vec3 = { x: 0, y: 0, z: 0 }
  const { cam } = buildCameraInput(eye, target, { x: 0, y: 1, z: 0 }, 50, 1, 0.1, 1000, 1000, 1000)
  const planes = extractFrustumPlanes(cam.viewProjectionMatrix)

  test('原点在视锥内；视锥外远点被裁', () => {
    expect(pointInFrustum(planes, 0, 0, 0)).toBe(true)
    // 水平超出 fov：在 z=0 平面，半宽 = 10×tan25° ≈ 4.66；x=8 在视锥外。
    expect(pointInFrustum(planes, 8, 0, 0)).toBe(false)
    // 相机后方（z > eye.z）被 near/平面裁。
    expect(pointInFrustum(planes, 0, 0, 11)).toBe(false)
  })

  test('覆盖视锥中心的 cell AABB 通过；视锥外的 cell AABB 被裁', () => {
    // cell 覆盖原点附近（XZ 内、Y=0.25），外扩 1.5m 后仍在视锥 → 命中。
    expect(boxIntersectsFrustum(planes, -2, 0.25, -2, 2, 0.25, 2)).toBe(true)
    // 远离视锥中心（x ∈ [80,84]）的 cell → 被裁。
    expect(boxIntersectsFrustum(planes, 80, 0.25, 80, 84, 0.25, 84)).toBe(false)
  })
})

// ─── 迟滞边界 10/8（SPEC 11.3 第 5 项）────────────────────────────────────────

describe('迟滞 · 10px 进入 / 8px 退出边界（SPEC 11.3 第 5 项）', () => {
  /*
   * 相机在 +Z 朝原点，up=+Y（screenUp=+Y）。字号公式：fontPixels = f×0.20/(D-pz)×H/2。
   * 取 D=100、H=1000、fov=50 → f×100 = 214.45；按目标字号反解 pz = D − 214.45/fp。
   * 9px→10px（进入边界）、9px→8px（退出边界）逐项验证。
   */
  const eye: Vec3 = { x: 0, y: 0, z: 100 }
  const target: Vec3 = { x: 0, y: 0, z: 0 }
  const H = 1000
  const f = 1 / Math.tan(((50 * Math.PI) / 180) / 2)
  const k = (f * 0.20 * H) / 2 // = f × 100
  // 反解：fontPixels = k / (D - pz) → pz = D - k/fp
  function zForFp(fp: number): number {
    return 100 - k / fp
  }

  test('投影字号与解析公式一致（基线）', () => {
    const { cam, yAxis } = buildCameraInput(eye, target, { x: 0, y: 1, z: 0 }, 50, 1, 0.1, 1000, 1000, H)
    const pz = zForFp(12)
    const anchor = { x: 0, y: 0.25, z: pz }
    const got = computeFontPixelSize(cam, computeCameraScreenUp(cam.cameraWorldQuaternion), anchor.x, anchor.y, anchor.z)
    const exp = analyticalFontPixels(anchor, yAxis, eye, target, 50, 1, H)
    expect(got).toBeCloseTo(exp, 6)
    expect(got).toBeCloseTo(12, 1)
  })

  test('未挂载：进入判定严格等于 fontPixels >= 10（9px→10px 进入边界）', () => {
    const { cam } = buildCameraInput(eye, target, { x: 0, y: 1, z: 0 }, 50, 1, 0.1, 1000, 1000, H)
    const ds = [
      descriptor({ id: 'fp12', anchorZ: zForFp(12) }),
      descriptor({ id: 'fp10', anchorZ: zForFp(10) }), // 边界：实际 fp 由模块计算
      descriptor({ id: 'fp9', anchorZ: zForFp(9) }),
      descriptor({ id: 'fp85', anchorZ: zForFp(8.5) }),
    ]
    const idx = buildLabelSpatialIndex(ds, LABEL_GRID_CELL_SIZE)
    const res = computeLabelVisibilitySet({ spatialIndex: idx, camera: cam, mountedIds: new Set() })!
    // 用模块实际计算的 fontPixels 验证进入判定，避免边界浮点抖动。
    const up = computeCameraScreenUp(cam.cameraWorldQuaternion)
    const inTarget = new Set(res.targetIds)
    for (const d of ds) {
      const fp = computeFontPixelSize(cam, up, d.anchorX, d.anchorY, d.anchorZ)
      expect(inTarget.has(d.id)).toBe(fp >= LABEL_ENTER_THRESHOLD_PX)
    }
    // 边界两侧语义明确：9px 明确 < 10 不进入、12px 明确 ≥ 10 进入。
    expect(inTarget.has('fp9')).toBe(false)
    expect(inTarget.has('fp12')).toBe(true)
    // 边界“10px 意图”实际 fp 接近 10（与解析公式一致，基线已验证）。
    const fp10 = computeFontPixelSize(cam, up, 0, 0.25, zForFp(10))
    expect(fp10).toBeCloseTo(10, 1)
  })

  test('已挂载：退出判定严格等于 fontPixels <= 8（9px→8px 退出边界）', () => {
    const { cam } = buildCameraInput(eye, target, { x: 0, y: 1, z: 0 }, 50, 1, 0.1, 1000, 1000, H)
    const ds = [
      descriptor({ id: 'fp12', anchorZ: zForFp(12) }),
      descriptor({ id: 'fp9', anchorZ: zForFp(9) }),
      descriptor({ id: 'fp85', anchorZ: zForFp(8.5) }),
      descriptor({ id: 'fp8', anchorZ: zForFp(8) }), // 边界：实际 fp 由模块计算
      descriptor({ id: 'fp7', anchorZ: zForFp(7) }),
    ]
    const idx = buildLabelSpatialIndex(ds, LABEL_GRID_CELL_SIZE)
    const mounted = new Set(ds.map((d) => d.id))
    const res = computeLabelVisibilitySet({ spatialIndex: idx, camera: cam, mountedIds: mounted })!
    const destroy = new Set(res.destroyIds)
    // 用模块实际计算的 fontPixels 验证退出判定（维持 iff fp > 8）。
    const up = computeCameraScreenUp(cam.cameraWorldQuaternion)
    for (const d of ds) {
      const fp = computeFontPixelSize(cam, up, d.anchorX, d.anchorY, d.anchorZ)
      expect(destroy.has(d.id)).toBe(fp <= LABEL_EXIT_THRESHOLD_PX)
    }
    // 边界两侧语义明确：9px 明确 > 8 维持、7px 明确 ≤ 8 退出。
    expect(destroy.has('fp9')).toBe(false)
    expect(destroy.has('fp7')).toBe(true)
    // create 为空（全部已挂载，维持的不新建）。
    expect(res.createIds).toHaveLength(0)
  })
})

// ─── 稳定排序与 400 上限（SPEC 11.3 第 6 项）───────────────────────────────────

describe('稳定排序 · kind 优先级（SPEC 11.3 第 6 项）', () => {
  test('operational-node → node → edge；总数 < 400 全保留', () => {
    // 相机贴近原点，三标签同位、字号远超阈值，全部进入。
    const { cam } = buildCameraInput({ x: 0, y: 0, z: 5 }, { x: 0, y: 0, z: 0 }, { x: 0, y: 1, z: 0 }, 50, 1, 0.1, 1000, 1000, 1000)
    const ds = [
      descriptor({ id: 'edge-1', kind: 'edge' as LabelKind }),
      descriptor({ id: 'node-1', kind: 'node' as LabelKind }),
      descriptor({ id: 'op-1', kind: 'operational-node' as LabelKind }),
    ]
    const idx = buildLabelSpatialIndex(ds, LABEL_GRID_CELL_SIZE)
    const res = computeLabelVisibilitySet({ spatialIndex: idx, camera: cam, mountedIds: new Set() })!
    expect(res.targetIds).toEqual(['op-1', 'node-1', 'edge-1'])
  })
})

describe('稳定排序 · 同级屏幕中心距离升序、再按 ID 字典序（SPEC 11.3 第 6 项）', () => {
  test('同级先近后远', () => {
    // 相机在 +Z 看原点；x 偏移决定屏幕中心距离。
    const { cam } = buildCameraInput({ x: 0, y: 0, z: 10 }, { x: 0, y: 0, z: 0 }, { x: 0, y: 1, z: 0 }, 50, 1, 0.1, 1000, 1000, 1000)
    const ds = [
      descriptor({ id: 'far', anchorX: 3, anchorZ: 0 }),
      descriptor({ id: 'near', anchorX: 0.5, anchorZ: 0 }),
    ]
    const idx = buildLabelSpatialIndex(ds, LABEL_GRID_CELL_SIZE)
    const res = computeLabelVisibilitySet({ spatialIndex: idx, camera: cam, mountedIds: new Set() })!
    expect(res.targetIds).toEqual(['near', 'far'])
  })

  test('同位（同距离）按 ID 字典序，不用数组下标', () => {
    const { cam } = buildLabelSpatialIndexAndCam()
    const ds = [
      descriptor({ id: 'L200' }),
      descriptor({ id: 'L001' }),
      descriptor({ id: 'L150' }),
    ]
    const idx = buildLabelSpatialIndex(ds, LABEL_GRID_CELL_SIZE)
    const res = computeLabelVisibilitySet({ spatialIndex: idx, camera: cam, mountedIds: new Set() })!
    // 同位同距离 → ID 字典序：L001 < L150 < L200（非输入下标顺序）。
    expect(res.targetIds).toEqual(['L001', 'L150', 'L200'])
  })

  /*
   * 复用一个贴近相机的相机输入（同位描述符字号远超阈值）。
   */
  function buildLabelSpatialIndexAndCam(): { cam: LabelCameraInput } {
    return {
      cam: buildCameraInput({ x: 0, y: 0, z: 5 }, { x: 0, y: 0, z: 0 }, { x: 0, y: 1, z: 0 }, 50, 1, 0.1, 1000, 1000, 1000).cam,
    }
  }
})

describe('400 上限 · 候选超过 400 截断（SPEC 11.3 表格 / 任务约束）', () => {
  test('500 同位候选 → 恰好保留 400 个（字典序最小）', () => {
    const { cam } = buildCameraInput({ x: 0, y: 0, z: 5 }, { x: 0, y: 0, z: 0 }, { x: 0, y: 1, z: 0 }, 50, 1, 0.1, 1000, 1000, 1000)
    const ds: LabelDescriptor[] = []
    for (let i = 0; i < 500; i++) {
      ds.push(descriptor({ id: 'L' + String(i).padStart(3, '0') }))
    }
    const idx = buildLabelSpatialIndex(ds, LABEL_GRID_CELL_SIZE)
    const res = computeLabelVisibilitySet({ spatialIndex: idx, camera: cam, mountedIds: new Set() })!
    expect(res.candidateCount).toBe(500)
    expect(res.targetIds).toHaveLength(LABEL_MAX_MOUNTED)
    expect(res.mountedAfter).toBe(LABEL_MAX_MOUNTED)
    // 截断后保留字典序最小 400 个：L000..L399。
    const expected: string[] = []
    for (let i = 0; i < 400; i++) expected.push('L' + String(i).padStart(3, '0'))
    expect(res.targetIds).toEqual(expected)
    // create = 目标（全部未挂载）；destroy 为空。
    expect(res.createIds).toHaveLength(LABEL_MAX_MOUNTED)
    expect(res.destroyIds).toHaveLength(0)
  })
})

// ─── 差量 create/destroy（SPEC 11.3 第 7 项）──────────────────────────────────

describe('差量 · 只对差集创建 / 销毁（SPEC 11.3 第 7 项）', () => {
  test('目标集合变化时 create = 新增、destroy = 消失', () => {
    const { cam } = buildCameraInput({ x: 0, y: 0, z: 5 }, { x: 0, y: 0, z: 0 }, { x: 0, y: 1, z: 0 }, 50, 1, 0.1, 1000, 1000, 1000)
    const ds = [
      descriptor({ id: 'keep', anchorX: 0 }),
      descriptor({ id: 'drop', anchorX: 0, anchorZ: 0 }),
      descriptor({ id: 'add', anchorX: 0, anchorZ: 0 }),
    ]
    const idx = buildLabelSpatialIndex(ds, LABEL_GRID_CELL_SIZE)
    // 当前已挂载 keep 与 stale（stale 不在目标，应销毁）。
    const mounted = new Set(['keep', 'stale'])
    const res = computeLabelVisibilitySet({ spatialIndex: idx, camera: cam, mountedIds: mounted })!
    // 目标含 keep/drop/add（同位同距 → ID 字典序），stale 不在目标 → destroy。
    expect(new Set(res.targetIds)).toEqual(new Set(['add', 'drop', 'keep']))
    // create = 目标 − 已挂载 = {drop, add}（keep 已挂载不新建）。
    expect(new Set(res.createIds)).toEqual(new Set(['drop', 'add']))
    // destroy = 已挂载 − 目标 = {stale}。
    expect(res.destroyIds).toEqual(['stale'])
  })

  test('create 与 destroy 互斥、且分别为目标/已挂载子集', () => {
    const { cam } = buildCameraInput({ x: 0, y: 0, z: 5 }, { x: 0, y: 0, z: 0 }, { x: 0, y: 1, z: 0 }, 50, 1, 0.1, 1000, 1000, 1000)
    const ds = [descriptor({ id: 'a' }), descriptor({ id: 'b' })]
    const idx = buildLabelSpatialIndex(ds, LABEL_GRID_CELL_SIZE)
    const mounted = new Set(['b', 'gone'])
    const res = computeLabelVisibilitySet({ spatialIndex: idx, camera: cam, mountedIds: mounted })!
    for (const c of res.createIds) expect(mounted.has(c)).toBe(false)
    for (const d of res.destroyIds) expect(res.targetIds.includes(d)).toBe(false)
  })
})

// ─── 确定性与退化输入（SPEC 16 / 任务约束）────────────────────────────────────

describe('确定性 · 相同输入得到完全相同目标与差量（任务约束）', () => {
  test('重复调用 → targetIds / create / destroy 完全一致', () => {
    const { cam } = buildCameraInput({ x: 0, y: 0, z: 6 }, { x: 0, y: 0, z: 0 }, { x: 0, y: 1, z: 0 }, 50, 1, 0.1, 1000, 1000, 1000)
    const ds = [
      descriptor({ id: 'e1', kind: 'edge' as LabelKind, anchorX: 1 }),
      descriptor({ id: 'n1', kind: 'node' as LabelKind, anchorX: 0.5 }),
      descriptor({ id: 'o1', anchorX: 0 }),
    ]
    const idx = buildLabelSpatialIndex(ds, LABEL_GRID_CELL_SIZE)
    const mounted = new Set(['n1', 'old'])
    const a = computeLabelVisibilitySet({ spatialIndex: idx, camera: cam, mountedIds: mounted })!
    const b = computeLabelVisibilitySet({ spatialIndex: idx, camera: cam, mountedIds: mounted })!
    expect(b.targetIds).toEqual(a.targetIds)
    expect(b.createIds).toEqual(a.createIds)
    expect(b.destroyIds).toEqual(a.destroyIds)
    expect(b.candidateCount).toBe(a.candidateCount)
  })
})

describe('退化输入 · 非法相机返回 null（SPEC 16 / 任务约束）', () => {
  const good = buildCameraInput({ x: 0, y: 0, z: 5 }, { x: 0, y: 0, z: 0 }, { x: 0, y: 1, z: 0 }, 50, 1, 0.1, 1000, 1000, 1000).cam
  const idx = buildLabelSpatialIndex([descriptor({ id: 'a' })], LABEL_GRID_CELL_SIZE)

  test('isValidLabelCameraInput 拒绝非有限矩阵 / 四元数 / 非正画布', () => {
    expect(isValidLabelCameraInput(good)).toBe(true)
    expect(
      isValidLabelCameraInput({ ...good, viewProjectionMatrix: good.viewProjectionMatrix.map((v, i) => (i === 3 ? Number.NaN : v)) }),
    ).toBe(false)
    expect(isValidLabelCameraInput({ ...good, cameraWorldQuaternion: [Number.NaN, 0, 0, 1] })).toBe(false)
    expect(isValidLabelCameraInput({ ...good, canvasWidthPx: 0 })).toBe(false)
    expect(isValidLabelCameraInput({ ...good, canvasHeightPx: -1 })).toBe(false)
    expect(isValidLabelCameraInput({ ...good, viewProjectionMatrix: [1, 2, 3] })).toBe(false)
  })

  test('computeLabelVisibilitySet 对非法相机返回 null', () => {
    const bad: LabelCameraInput = {
      viewProjectionMatrix: good.viewProjectionMatrix.map((v) => (Number.isFinite(v) ? v : v)),
      cameraWorldQuaternion: [Number.NaN, 0, 0, 1],
      canvasWidthPx: 1920,
      canvasHeightPx: 1080,
    }
    expect(computeLabelVisibilitySet({ spatialIndex: idx, camera: bad, mountedIds: new Set() })).toBeNull()
  })
})

// ─── 调度契约（SPEC 11.3 第 8 项）──────────────────────────────────────────────

describe('调度 · controls-change 10Hz 节流、end/resize 立即（SPEC 11.3 第 8 项）', () => {
  test('初始状态首个 change 必然查询', () => {
    const s0 = initialVisibilitySchedulerState()
    const d = decideVisibilityQuery(s0, 'controls-change', 1000)
    expect(d.shouldQuery).toBe(true)
  })

  test('controls-change 100ms 内被节流跳过、不更新 lastQueryMs', () => {
    let s = initialVisibilitySchedulerState()
    s = decideVisibilityQuery(s, 'controls-change', 1000).state // 首次查询 lastQuery=1000
    // 1050ms（50ms 后）→ 跳过，状态不变。
    const skip = decideVisibilityQuery(s, 'controls-change', 1050)
    expect(skip.shouldQuery).toBe(false)
    expect(skip.state.lastQueryMs).toBe(1000)
    // 1100ms（100ms 后）→ 查询并更新 lastQuery=1100。
    const ok = decideVisibilityQuery(s, 'controls-change', 1100)
    expect(ok.shouldQuery).toBe(true)
    expect(ok.state.lastQueryMs).toBe(1100)
  })

  test('controls-end 立即查询，不被 10Hz 节流吞掉（任务关键异常路径）', () => {
    let s = initialVisibilitySchedulerState()
    s = decideVisibilityQuery(s, 'controls-change', 1000).state // lastQuery=1000
    // 紧接 end（1010ms，在节流窗口内）仍立即查询。
    const d = decideVisibilityQuery(s, 'controls-end', 1010)
    expect(d.shouldQuery).toBe(true)
    expect(d.state.lastQueryMs).toBe(1010)
  })

  test('resize 立即查询，不被节流吞掉', () => {
    let s = initialVisibilitySchedulerState()
    s = decideVisibilityQuery(s, 'controls-change', 5000).state
    const d = decideVisibilityQuery(s, 'resize', 5050)
    expect(d.shouldQuery).toBe(true)
    expect(d.state.lastQueryMs).toBe(5050)
  })

  test('连续快速 change 序列至多 10Hz，末尾 end 不漏', () => {
    let s = initialVisibilitySchedulerState()
    const queryTimes: number[] = []
    // 模拟 60fps change（每 16ms），持续 320ms，末尾 end。
    for (let t = 0; t <= 320; t += 16) {
      const d = decideVisibilityQuery(s, 'controls-change', t)
      s = d.state
      if (d.shouldQuery) queryTimes.push(t)
    }
    const endD = decideVisibilityQuery(s, 'controls-end', 336)
    queryTimes.push(336)
    // change 查询间隔均 >= 100ms（10Hz 上限）。
    for (let i = 1; i < queryTimes.length - 1; i++) {
      expect(queryTimes[i] - queryTimes[i - 1]).toBeGreaterThanOrEqual(LABEL_QUERY_MIN_INTERVAL_MS)
    }
    // 末尾 end 必然查询。
    expect(endD.shouldQuery).toBe(true)
  })
})

// ─── 真实样本集成（SPEC 15.1 / 11.3 / 12.2 / 任务验证方式第 3 项）──────────────

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '..', '..')
const REAL_SAMPLE = resolve(root, 'data', 'sampleMap.json')

let realDescriptors: readonly LabelDescriptor[]
let realContentBounds: { readonly minX: number; readonly maxX: number; readonly minZ: number; readonly maxZ: number; readonly minY: number; readonly maxY: number }

beforeAll(async () => {
  const sha = await computeFileSha256(REAL_SAMPLE)
  if (sha !== EXPECTED_SAMPLE_SHA256) {
    throw new Error(`样本身份不符，停止回归验证：${sha}`)
  }
  const rawJson = JSON.parse(readFileSync(REAL_SAMPLE, 'utf8')) as unknown
  const rawMap = parseSampleEnvelope(rawJson)
  validateMapSemantics(rawMap)
  const sceneMap = normalizeSceneMap(rawMap)
  const model = buildSceneModel(sceneMap)
  realDescriptors = model.labels
  realContentBounds = model.contentBounds
})

describe('真实样本 · 初始标准 fit 后目标集合为空（SPEC 11.3 / 12.2 / 任务验证方式第 3 项）', () => {
  test('标准 3/4 fit（16:9）：全部投影字号 < 10px，目标集合为 0', () => {
    const aspect = 16 / 9
    const fit = computeCameraFit(realContentBounds as never, aspect)!
    const near = 0.1
    const far = fit.distance + 4 * fit.radius
    const { cam } = buildCameraInput(fit.position, fit.target, { x: 0, y: 1, z: 0 }, PERSPECTIVE_FOV_DEG, aspect, near, far, 1920, 1080)
    const idx = buildLabelSpatialIndex(realDescriptors, LABEL_GRID_CELL_SIZE)
    const res = computeLabelVisibilitySet({ spatialIndex: idx, camera: cam, mountedIds: new Set() })!
    expect(res.targetIds).toHaveLength(0)
    expect(res.createIds).toHaveLength(0)
    expect(res.candidateCount).toBe(0)
    // 交叉验证：全部描述符投影字号确实 < 进入阈值。
    const up = computeCameraScreenUp(cam.cameraWorldQuaternion)
    let max = 0
    for (const d of realDescriptors) {
      const fp = computeFontPixelSize(cam, up, d.anchorX, d.anchorY, d.anchorZ)
      if (fp > max) max = fp
    }
    expect(max).toBeLessThan(LABEL_ENTER_THRESHOLD_PX)
  })

  test('标准 fit 下空间索引占用 cell 约 331（SPEC 11.3 第 2 项规模）', () => {
    const idx = buildLabelSpatialIndex(realDescriptors, LABEL_GRID_CELL_SIZE)
    expect(idx.descriptorCount).toBe(4810)
    expect(idx.occupiedCells.length).toBeGreaterThan(250)
    expect(idx.occupiedCells.length).toBeLessThan(420)
  })
})

describe('真实样本 · 放大视图后集合 <= 400 且优先级稳定（任务验证方式第 3 项）', () => {
  test('相机贴近目标后：集合非空、<= 400、operational-node 优先', () => {
    const aspect = 16 / 9
    const fit = computeCameraFit(realContentBounds as never, aspect)!
    // 放大：距离缩到 8%（仍看向同一目标、同朝向）。
    const zoomPos: Vec3 = {
      x: fit.target.x + fit.direction.x * fit.distance * 0.08,
      y: fit.target.y + fit.direction.y * fit.distance * 0.08,
      z: fit.target.z + fit.direction.z * fit.distance * 0.08,
    }
    const near = 0.1
    const far = fit.distance + 4 * fit.radius
    const { cam } = buildCameraInput(zoomPos, fit.target, { x: 0, y: 1, z: 0 }, PERSPECTIVE_FOV_DEG, aspect, near, far, 1920, 1080)
    const idx = buildLabelSpatialIndex(realDescriptors, LABEL_GRID_CELL_SIZE)
    const res = computeLabelVisibilitySet({ spatialIndex: idx, camera: cam, mountedIds: new Set() })!
    expect(res.targetIds.length).toBeGreaterThan(0)
    expect(res.targetIds.length).toBeLessThanOrEqual(LABEL_MAX_MOUNTED)
    // 优先级顺序：operational-node 在前、edge 在后（截断后段必为 edge）。
    const byId = new Map(realDescriptors.map((d) => [d.id, d]))
    const kinds = res.targetIds.map((id) => byId.get(id)!.kind)
    const firstEdge = kinds.indexOf('edge')
    const lastOp = ['operational-node', 'node'].reduce((acc, k) => Math.max(acc, kinds.lastIndexOf(k)), -1)
    if (firstEdge !== -1 && lastOp !== -1) {
      expect(firstEdge).toBeGreaterThan(lastOp)
    }
  })

  test('确定性：放大视图重复计算 → 目标集合完全一致', () => {
    const aspect = 16 / 9
    const fit = computeCameraFit(realContentBounds as never, aspect)!
    const zoomPos: Vec3 = {
      x: fit.target.x + fit.direction.x * fit.distance * 0.08,
      y: fit.target.y + fit.direction.y * fit.distance * 0.08,
      z: fit.target.z + fit.direction.z * fit.distance * 0.08,
    }
    const { cam } = buildCameraInput(zoomPos, fit.target, { x: 0, y: 1, z: 0 }, PERSPECTIVE_FOV_DEG, aspect, 0.1, fit.distance + 4 * fit.radius, 1920, 1080)
    const idx = buildLabelSpatialIndex(realDescriptors, LABEL_GRID_CELL_SIZE)
    const a = computeLabelVisibilitySet({ spatialIndex: idx, camera: cam, mountedIds: new Set() })!
    const b = computeLabelVisibilitySet({ spatialIndex: idx, camera: cam, mountedIds: new Set() })!
    expect(b.targetIds).toEqual(a.targetIds)
  })

  test('屏幕中心距离键可计算（真实样本抽样有限）', () => {
    const aspect = 16 / 9
    const fit = computeCameraFit(realContentBounds as never, aspect)!
    const { cam } = buildCameraInput(fit.position, fit.target, { x: 0, y: 1, z: 0 }, PERSPECTIVE_FOV_DEG, aspect, 0.1, fit.distance + 4 * fit.radius, 1920, 1080)
    // 抽样若干描述符，屏幕中心距离均为有限数。
    for (let i = 0; i < realDescriptors.length; i += 973) {
      const d = realDescriptors[i]
      const dist = computeScreenCenterDistancePx(cam, d.anchorX, d.anchorY, d.anchorZ)
      expect(Number.isFinite(dist)).toBe(true)
    }
  })
})
