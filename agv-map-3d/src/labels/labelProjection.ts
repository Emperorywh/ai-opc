/*
 * 标签投影数学：视锥、NDC 投影与屏幕向上方向（labels 层，SPEC 11.3 / 7.1 / 16）。
 *
 * 信任边界定位（TASK-021）：
 *   - 本模块把 SPEC §11.3 第 1、2、3、4 项的纯投影数学集中为可脱离浏览器 / React / Three 单测的函数：
 *     从 view-projection 矩阵提取 6 平面视锥、AABB / 点的视锥测试、NDC 投影、
 *     由相机世界四元数推导 cameraScreenUp、投影字号与距视口中心屏幕距离。
 *   - 只消费显式数值输入（列主序 16 元素矩阵、四元数、画布像素尺寸），不创建 Three / R3F / Troika /
 *     React 对象，不读取全局相机单例或原始 JSON（任务约束）。
 *
 * 约定不变量（与 Three.js 一一对应，保证运行时与单测确定性一致）：
 *   - 矩阵为列主序 16 元素（Three Matrix4.elements 布局，elements[col*4+row]）。
 *   - 视锥平面提取用 Gribb-Hartmann 法，以 clip空间不等式（-w≤x,y,z≤w，WebGL z∈[-1,1]）推导；
 *     与 Three Frustum.setFromProjectionMatrix 对同一矩阵产生相同的 6 平面（归一化后）。
 *   - “平面内侧”判定向量 p 满足 a·x+b·y+c·z+d >= 0；AABB 测试用正顶点（p-vertex）法，
 *     与 Three Frustum.intersectsBox 同口径，保守且不漏判。
 *   - cameraScreenUp = 把相机局部 +Y 经世界四元数旋转后的世界方向，禁止把固定世界 +Y 当屏幕竖直
 *     （SPEC 11.3 第 4 项 / 任务约束）。
 *
 * 退化输入不变量（SPEC 16 / 任务约束）：
 *   - 矩阵 / 四元数任一非有限、画布宽高非正或非有限时，LabelCameraInput 校验返回 false；
 *     调用方不得据退化输入生成可见集，禁止产生 NaN / Infinity。
 *   - NDC 投影遇到 clip.w <= 0（点在相机后方 / 退化）返回 null；投影字号归零、距中心距离视作无穷，
 *     使退化标签不进入候选、排序落最后，绝不参与 NaN 比较。
 *
 * 依赖方向（SPEC 3.3）：仅依赖本层（labelVisibilityConfig），外部仅 Node 内置；纯函数无副作用。
 */
import { LABEL_FONT_SIZE_METERS } from './labelVisibilityConfig'

/*
 * 列主序 4×4 矩阵（Three Matrix4.elements 布局）。
 * 约定 m[col*4+row]：列 0 = m[0..3]、列 1 = m[4..7]、列 2 = m[8..11]、列 3 = m[12..15]。
 */
export type ViewProjectionMatrix = ReadonlyArray<number>

/*
 * 相机世界四元数 [x, y, z, w]（与 THREE.Quaternion 同布局）。
 * 用于把相机局部 +Y 旋转到世界 cameraScreenUp（SPEC 11.3 第 4 项）。
 */
export type CameraQuaternion = readonly [number, number, number, number]

/*
 * 标签可见集的显式相机数值输入（任务“只消费显式相机数值输入”）。
 *   - viewProjectionMatrix：projectionMatrix × matrixWorldInverse（列主序 16 元素）。
 *   - cameraWorldQuaternion：相机世界四元数 [x,y,z,w]，决定 cameraScreenUp。
 *   - canvasWidthPx / canvasHeightPx：画布像素尺寸，用于投影字号与屏幕中心距离换算。
 */
export interface LabelCameraInput {
  readonly viewProjectionMatrix: ViewProjectionMatrix
  readonly cameraWorldQuaternion: CameraQuaternion
  readonly canvasWidthPx: number
  readonly canvasHeightPx: number
}

/*
 * 视锥平面（归一化）：内侧满足 a·x + b·y + c·z + d >= 0。
 * 6 个平面顺序固定为 [left, right, bottom, top, near, far]，索引见 FRUSTUM_PLANE_*。
 */
export interface FrustumPlane {
  readonly a: number
  readonly b: number
  readonly c: number
  readonly d: number
}

export const FRUSTUM_PLANE_LEFT = 0
export const FRUSTUM_PLANE_RIGHT = 1
export const FRUSTUM_PLANE_BOTTOM = 2
export const FRUSTUM_PLANE_TOP = 3
export const FRUSTUM_PLANE_NEAR = 4
export const FRUSTUM_PLANE_FAR = 5
export const FRUSTUM_PLANE_COUNT = 6

/*
 * 相机屏幕向上方向（世界系单位向量）。
 * 由相机局部 +Y 经世界四元数旋转得到（SPEC 11.3 第 4 项）。
 */
export interface ScreenUp {
  readonly x: number
  readonly y: number
  readonly z: number
}

/*
 * NDC 投影结果。clip.w <= 0（点在相机后方 / 退化）时为 null。
 */
export interface NdcPoint {
  readonly x: number
  readonly y: number
}

/*
 * 校验 LabelCameraInput 合法性（SPEC 16 / 任务约束）。
 * 矩阵恰 16 个有限数、四元数 4 个有限数、画布宽高均为正有限数时为合法。
 */
export function isValidLabelCameraInput(cam: LabelCameraInput): boolean {
  if (cam.viewProjectionMatrix.length !== 16) return false
  for (let i = 0; i < 16; i++) {
    if (!Number.isFinite(cam.viewProjectionMatrix[i])) return false
  }
  const q = cam.cameraWorldQuaternion
  if (!Number.isFinite(q[0]) || !Number.isFinite(q[1]) || !Number.isFinite(q[2]) || !Number.isFinite(q[3])) {
    return false
  }
  if (!Number.isFinite(cam.canvasWidthPx) || !(cam.canvasWidthPx > 0)) return false
  if (!Number.isFinite(cam.canvasHeightPx) || !(cam.canvasHeightPx > 0)) return false
  return true
}

/*
 * 从 view-projection 矩阵提取归一化视锥 6 平面（SPEC 11.3 第 1 项，Gribb-Hartmann 法）。
 *
 * 列主序矩阵 m，对世界点 p=(x,y,z,1)：
 *   clip.x = m[0]x+m[4]y+m[8]z+m[12]、clip.y = m[1]x+m[5]y+m[9]z+m[13]、
 *   clip.z = m[2]x+m[6]y+m[10]z+m[14]、clip.w = m[3]x+m[7]y+m[11]z+m[15]。
 * WebGL 裁剪空间可见条件：-w≤x≤w、-w≤y≤w、-w≤z≤w，改写为“内侧 ≥ 0”平面：
 *   left:   x+w≥0  → (m0+m3,  m4+m7,  m8+m11,  m12+m15)
 *   right:  w-x≥0  → (m3-m0,  m7-m4,  m11-m8,  m15-m12)
 *   bottom: y+w≥0  → (m1+m3,  m5+m7,  m9+m11,  m13+m15)
 *   top:    w-y≥0  → (m3-m1,  m7-m5,  m11-m9,  m15-m13)
 *   near:   z+w≥0  → (m2+m3,  m6+m7,  m10+m11, m14+m15)
 *   far:    w-z≥0  → (m3-m2,  m7-m6,  m11-m10, m15-m14)
 * 与 Three Frustum.setFromProjectionMatrix 对同一矩阵产生等价 6 平面。
 */
export function extractFrustumPlanes(vp: ViewProjectionMatrix): readonly FrustumPlane[] {
  const m0 = vp[0], m1 = vp[1], m2 = vp[2], m3 = vp[3]
  const m4 = vp[4], m5 = vp[5], m6 = vp[6], m7 = vp[7]
  const m8 = vp[8], m9 = vp[9], m10 = vp[10], m11 = vp[11]
  const m12 = vp[12], m13 = vp[13], m14 = vp[14], m15 = vp[15]

  const planes: FrustumPlane[] = new Array<FrustumPlane>(FRUSTUM_PLANE_COUNT)
  planes[FRUSTUM_PLANE_LEFT] = normalizePlane(m0 + m3, m4 + m7, m8 + m11, m12 + m15)
  planes[FRUSTUM_PLANE_RIGHT] = normalizePlane(m3 - m0, m7 - m4, m11 - m8, m15 - m12)
  planes[FRUSTUM_PLANE_BOTTOM] = normalizePlane(m1 + m3, m5 + m7, m9 + m11, m13 + m15)
  planes[FRUSTUM_PLANE_TOP] = normalizePlane(m3 - m1, m7 - m5, m11 - m9, m15 - m13)
  planes[FRUSTUM_PLANE_NEAR] = normalizePlane(m2 + m3, m6 + m7, m10 + m11, m14 + m15)
  planes[FRUSTUM_PLANE_FAR] = normalizePlane(m3 - m2, m7 - m6, m11 - m10, m15 - m14)
  return planes
}

/*
 * 把平面系数 (a,b,c,d) 归一化（除以法线长度），保持内侧符号不变。
 * 法线长度为 0（退化矩阵）时返回零平面（测试恒为 0 ≥ 0，不裁剪），避免除零产生 NaN。
 */
function normalizePlane(a: number, b: number, c: number, d: number): FrustumPlane {
  const len = Math.sqrt(a * a + b * b + c * c)
  if (!(len > 0)) {
    return { a: 0, b: 0, c: 0, d: 0 }
  }
  return { a: a / len, b: b / len, c: c / len, d: d / len }
}

/*
 * AABB 视锥粗筛（SPEC 11.3 第 2 项，正顶点 p-vertex 法，与 Three Frustum.intersectsBox 同口径）。
 *
 * 对每个平面取 box 在该平面法线方向最远的角（正顶点）：分量法线 >= 0 取 max，否则取 min；
 * 若正顶点的有符号距离 < 0，则整个 box 在该平面外侧 → 被裁剪返回 false。
 * 6 平面全部不裁剪时返回 true（保守：可能含略多的 cell，由精确点测试再过滤）。
 */
export function boxIntersectsFrustum(
  planes: readonly FrustumPlane[],
  minX: number, minY: number, minZ: number,
  maxX: number, maxY: number, maxZ: number,
): boolean {
  for (let i = 0; i < FRUSTUM_PLANE_COUNT; i++) {
    const p = planes[i]
    const px = p.a >= 0 ? maxX : minX
    const py = p.b >= 0 ? maxY : minY
    const pz = p.c >= 0 ? maxZ : minZ
    if (p.a * px + p.b * py + p.c * pz + p.d < 0) return false
  }
  return true
}

/*
 * 点视锥精确测试（SPEC 11.3 第 3 项）：点在 6 平面内侧（距离均 ≥ 0）时为可见。
 */
export function pointInFrustum(
  planes: readonly FrustumPlane[],
  x: number, y: number, z: number,
): boolean {
  for (let i = 0; i < FRUSTUM_PLANE_COUNT; i++) {
    const p = planes[i]
    if (p.a * x + p.b * y + p.c * z + p.d < 0) return false
  }
  return true
}

/*
 * 把世界点投影到 NDC（SPEC 11.3 第 4 项投影前置）。
 *
 * clip.w <= 0（点在相机后方 / 共面退化）或非有限时返回 null；调用方据此把投影字号归零。
 */
export function projectToNdc(
  vp: ViewProjectionMatrix,
  x: number, y: number, z: number,
): NdcPoint | null {
  const clipX = vp[0] * x + vp[4] * y + vp[8] * z + vp[12]
  const clipY = vp[1] * x + vp[5] * y + vp[9] * z + vp[13]
  const clipW = vp[3] * x + vp[7] * y + vp[11] * z + vp[15]
  if (!(clipW > 0)) return null
  if (!Number.isFinite(clipX) || !Number.isFinite(clipY)) return null
  return { x: clipX / clipW, y: clipY / clipW }
}

/*
 * 由相机世界四元数推导 cameraScreenUp（SPEC 11.3 第 4 项 / 任务约束）。
 *
 * 把相机局部 +Y=(0,1,0) 经四元数 (x,y,z,w) 旋转到世界系，等价于旋转矩阵第二列：
 *   screenUp = ( 2(xy - wz), 1 - 2(x² + z²), 2(yz + wx) )
 * 该公式与 THREE.Vector3(0,1,0).applyQuaternion(q) 逐分量一致；
 * 禁止用固定世界 +Y 当屏幕竖直，避免相机滚转后字号投影失真。
 */
export function computeCameraScreenUp(q: CameraQuaternion): ScreenUp {
  const x = q[0], y = q[1], z = q[2], w = q[3]
  return {
    x: 2 * (x * y - w * z),
    y: 1 - 2 * (x * x + z * z),
    z: 2 * (y * z + w * x),
  }
}

/*
 * 计算标签锚点的投影字号（像素，SPEC 11.3 第 4 项）。
 *
 * 流水：
 *   1. 锚点 p 投影到 NDC 得 ndY1；p + cameraScreenUp × 0.20m 投影到 NDC 得 ndY2。
 *   2. fontPixels = |ndY2 - ndY1| × canvasHeight / 2。
 * 任一投影退化（点在相机后方）返回 0，使该标签不满足进入阈值。
 */
export function computeFontPixelSize(
  cam: LabelCameraInput,
  screenUp: ScreenUp,
  anchorX: number, anchorY: number, anchorZ: number,
): number {
  const base = projectToNdc(cam.viewProjectionMatrix, anchorX, anchorY, anchorZ)
  if (base === null) return 0
  const tipX = anchorX + screenUp.x * LABEL_FONT_SIZE_METERS
  const tipY = anchorY + screenUp.y * LABEL_FONT_SIZE_METERS
  const tipZ = anchorZ + screenUp.z * LABEL_FONT_SIZE_METERS
  const tip = projectToNdc(cam.viewProjectionMatrix, tipX, tipY, tipZ)
  if (tip === null) return 0
  const delta = Math.abs(tip.y - base.y)
  return delta * (cam.canvasHeightPx / 2)
}

/*
 * 计算标签锚点到视口中心的屏幕距离（像素，SPEC 11.3 第 6 项同级排序键）。
 *
 * NDC 中心为 (0,0)；屏幕偏移 = (ndcX × W/2, ndcY × H/2)，距离取欧氏长度。
 * 投影退化（点在相机后方）返回 +Infinity，使退化标签在稳定排序中落最后。
 */
export function computeScreenCenterDistancePx(
  cam: LabelCameraInput,
  anchorX: number, anchorY: number, anchorZ: number,
): number {
  const p = projectToNdc(cam.viewProjectionMatrix, anchorX, anchorY, anchorZ)
  if (p === null) return Number.POSITIVE_INFINITY
  const dx = p.x * (cam.canvasWidthPx / 2)
  const dy = p.y * (cam.canvasHeightPx / 2)
  return Math.sqrt(dx * dx + dy * dy)
}
