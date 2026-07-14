import type { Bounds3Data } from '../../domain/renderPacket'
import {
  CAMERA_HALF_FOV_RAD,
  FAR_MIN_M,
  FAR_RADIUS_FACTOR,
  FRAMING_MARGIN,
  INITIAL_AZIMUTH_RAD,
  INITIAL_POLAR_RAD,
  MAX_DISTANCE_RADIUS_FACTOR,
  MIN_DISTANCE_FLOOR_M,
  MIN_DISTANCE_RADIUS_FACTOR,
  PAN_BOUND_EXPANSION,
} from '../../config/cameraConfig'

/**
 * 相机自动框选（SPEC §9.1，TASK-011）。
 *
 * 职责：由 renderBounds 推算初始倾斜沙盘视角的相机位置、目标点与远裁面，保证包围盒八角点
 * 在指定 aspect 下全部落在 5% 安全区内。该模块是纯函数，相同边界与 aspect 产生相同相机参数，
 * 不读取系统时间、相机或任何展示状态（SPEC §7.1 同类纯函数约束、§9.1 framing 数学）。
 *
 * 它取代 TASK-009 的 basicFraming（包围球近似）：后者只保证整体入画，无法保证 5% 安全区与
 * 16:9/21:9 双比例约束；本模块以包围盒八角点在相机空间的水平/垂直投影需求精确求解相机距离。
 *
 * === 坐标约定与不变量 ===
 *
 * 相机朝向由极角 polar（从世界 +Y 轴起算的天顶角）与方位角 azimuth（XZ 平面内自 +X 起）
 * 决定。从 target 指向相机的单位方向 dir 为：
 *
 *   dir = ( sinPolar·cosAz,  cosPolar,  sinPolar·sinAz )
 *
 * 相机看向 target，故视线 forward = −dir。以世界 +Y 为 up，相机正交基为：
 *
 *   right = normalize(forward × worldUp) = ( sinAz,  0,  −cosAz )
 *   up    = right × forward              = ( −cosAz·cosPolar,  sinPolar,  −sinAz·cosPolar )
 *
 * （以上三式在 §6 注释中已用点积与叉积校验正交且单位化。）
 *
 * 对包围盒任一角点 P，令 vec = P − target（target 的 Y=0 为地面投影），则：
 *
 *   dAlong = vec · dir           （角点沿 dir 方向相对 target 的有符号偏移）
 *   xProj  = vec · right         （角点在相机右向上的水平投影，与 distance 无关，因 dir⊥right）
 *   yProj  = vec · up            （角点在相机上向上的垂直投影，同理与 distance 无关）
 *   depth  = distance − dAlong   （角点沿视线到相机的正向距离，须 > 0）
 *
 * 透视投影下角点的归一化设备坐标（无近平面缩放）：
 *
 *   ndcX = (xProj / depth) / ( tan(vHalf) · aspect )
 *   ndcY = (yProj / depth) / ( tan(vHalf) )
 *
 * 其中水平半视场正切 = tan(vHalf)·aspect（标准透视关系）。角点入画且位于 (1−margin) 安全区
 * 内要求 |ndcX| ≤ 1−margin 且 |ndcY| ≤ 1−margin，等价于：
 *
 *   depth ≥ |xProj| / ( tan(vHalf) · aspect · (1−margin) )     ……水平约束
 *   depth ≥ |yProj| / ( tan(vHalf) · (1−margin) )              ……垂直约束
 *
 * 把 depth = distance − dAlong 代入，解出每角点对 distance 的下界，取八角点最大值即所需距离。
 * 这是一个解析解，无需迭代；垂直约束与 aspect 无关，水平约束随 aspect 增大而放宽。
 */

/** 相机正交基：dir 从 target 指向相机，right/up 为相机右向与上向（均单位、互相正交）。 */
export interface CameraBasis {
  readonly dir: readonly [number, number, number]
  readonly right: readonly [number, number, number]
  readonly up: readonly [number, number, number]
}

/** 框选产物：相机位置、目标点、远裁面与初始轨道参数，供 Canvas 与 OrbitControls 消费。 */
export interface CameraFrame {
  /** 相机世界位置 [x, y, z]。 */
  readonly position: readonly [number, number, number]
  /** 目标点（renderBounds 中心在地面 y=0 的投影）[x, 0, z]。 */
  readonly target: readonly [number, number, number]
  /** 远裁面：max(1000, 包围球半径 × 10)（SPEC §9.1）。 */
  readonly far: number
  /** 初始相机到 target 的距离，米；落入 OrbitControls 的 [minDistance, maxDistance] 区间。 */
  readonly distance: number
  /** 初始极角，弧度（从 +Y 起算）。 */
  readonly polarRad: number
  /** 初始方位角，弧度。 */
  readonly azimuthRad: number
}

/**
 * 由极角与方位角计算相机正交基（SPEC §9.1 朝向约定）。
 *
 * 推导见模块顶部注释。极角从世界 +Y 起算（与 Three.js OrbitControls polarAngle 一致），
 * 方位角在 XZ 平面自 +X 起、朝 +Z 为正。极角位于 (0, π) 内时 right/up 单位正交。
 *
 * 纯函数：相同角度产生相同基，不依赖任何运行时状态。
 */
export function computeCameraBasis(
  polarRad: number,
  azimuthRad: number,
): CameraBasis {
  const sinPolar = Math.sin(polarRad)
  const cosPolar = Math.cos(polarRad)
  const sinAz = Math.sin(azimuthRad)
  const cosAz = Math.cos(azimuthRad)
  return {
    dir: [sinPolar * cosAz, cosPolar, sinPolar * sinAz],
    right: [sinAz, 0, -cosAz],
    up: [-cosAz * cosPolar, sinPolar, -sinAz * cosPolar],
  }
}

/** renderBounds 的包围球半径：取包围盒空间对角线之半（覆盖全部角点）。 */
function boundsRadius(bounds: Bounds3Data): number {
  const dx = bounds.max[0] - bounds.min[0]
  const dy = bounds.max[1] - bounds.min[1]
  const dz = bounds.max[2] - bounds.min[2]
  return Math.hypot(dx, dy, dz) / 2
}

/**
 * 计算 renderBounds 八角点在给定相机参数下的最大归一化设备坐标绝对值（供 framing 内部
 * 自洽与测试验证，纯函数）。
 *
 * 返回 { maxAbsX, maxAbsY }：八角点中 |ndcX|、|ndcY| 的峰值。当二者均 ≤ 1 − margin 时，
 * 完整 renderBounds 位于画面的 (1−margin) 安全区内（SPEC §9.1、§16.2）。
 *
 * @param bounds 渲染边界。
 * @param target 相机目标点（Y 通常为 0）。
 * @param basis 相机正交基（dir/right/up）。
 * @param distance 相机到 target 的距离。
 * @param halfFovRad 垂直半视场，弧度。
 * @param aspect 画面宽高比（水平/垂直）。
 */
export function computeBoundsCornerNdcPeak(
  bounds: Bounds3Data,
  target: readonly [number, number, number],
  basis: CameraBasis,
  distance: number,
  halfFovRad: number,
  aspect: number,
): { readonly maxAbsX: number; readonly maxAbsY: number } {
  const tanHalf = Math.tan(halfFovRad)
  const tanHalfAspect = tanHalf * aspect
  const safe = 1 - FRAMING_MARGIN
  const dir = basis.dir
  const right = basis.right
  const up = basis.up
  let maxAbsX = 0
  let maxAbsY = 0
  // 八角点遍历：x/y/z 各取 min/max。vec = corner − target（target.y=0）。
  for (let ix = 0; ix < 2; ix += 1) {
    const vx = (ix === 0 ? bounds.min[0] : bounds.max[0]) - target[0]
    for (let iy = 0; iy < 2; iy += 1) {
      const vy = (iy === 0 ? bounds.min[1] : bounds.max[1]) - target[1]
      for (let iz = 0; iz < 2; iz += 1) {
        const vz = (iz === 0 ? bounds.min[2] : bounds.max[2]) - target[2]
        const dAlong = vx * dir[0] + vy * dir[1] + vz * dir[2]
        const xProj = vx * right[0] + vy * right[1] + vz * right[2]
        const yProj = vx * up[0] + vy * up[1] + vz * up[2]
        // depth = distance − dAlong；framing 已保证 depth > 0，保守取绝对值避免除零。
        const depth = Math.max(distance - dAlong, 1e-6)
        const ndcX = Math.abs(xProj / depth) / tanHalfAspect
        const ndcY = Math.abs(yProj / depth) / tanHalf
        if (ndcX > maxAbsX) maxAbsX = ndcX
        if (ndcY > maxAbsY) maxAbsY = ndcY
      }
    }
  }
  // 归一化到安全区阈值：峰值 ≤ 1 等价于 maxAbs ≤ safe（因下面除以 safe）。
  return { maxAbsX: maxAbsX / safe, maxAbsY: maxAbsY / safe }
}

/**
 * 由渲染边界与参考宽高比推算初始相机框选（SPEC §9.1，TASK-011 核心）。
 *
 * 求解步骤：
 * 1. target = renderBounds 中心在地面 y=0 的投影。
 * 2. 由初始极角/方位角算相机正交基。
 * 3. 对八角点解析求满足 (1−margin) 安全区的最小 distance，取最大值。
 * 4. 相机位置 = target + distance·dir；far = max(1000, 包围球半径 × 10)。
 *
 * @param bounds 渲染边界（世界空间 AABB）。
 * @param aspect 参考宽高比；运行期以 FRAMING_REFERENCE_ASPECT（16:9）调用，
 *   保证 16:9 与 21:9 画面均完整容纳（见 cameraConfig 文档）。
 */
export function computeCameraFrame(
  bounds: Bounds3Data,
  aspect: number,
): CameraFrame {
  const cx = (bounds.min[0] + bounds.max[0]) / 2
  const cz = (bounds.min[2] + bounds.max[2]) / 2
  const target: readonly [number, number, number] = [cx, 0, cz]

  const basis = computeCameraBasis(INITIAL_POLAR_RAD, INITIAL_AZIMUTH_RAD)
  const dir = basis.dir
  const right = basis.right
  const up = basis.up

  const tanHalf = Math.tan(CAMERA_HALF_FOV_RAD)
  const safe = 1 - FRAMING_MARGIN
  const horizDivisor = tanHalf * aspect * safe
  const vertDivisor = tanHalf * safe

  // 解析求每角点对 distance 的下界，取最大值。
  let minDistance = 0
  for (let ix = 0; ix < 2; ix += 1) {
    const vx = (ix === 0 ? bounds.min[0] : bounds.max[0]) - target[0]
    for (let iy = 0; iy < 2; iy += 1) {
      const vy = (iy === 0 ? bounds.min[1] : bounds.max[1]) - target[1]
      for (let iz = 0; iz < 2; iz += 1) {
        const vz = (iz === 0 ? bounds.min[2] : bounds.max[2]) - target[2]
        const dAlong = vx * dir[0] + vy * dir[1] + vz * dir[2]
        const xProj = vx * right[0] + vy * right[1] + vz * right[2]
        const yProj = vx * up[0] + vy * up[1] + vz * up[2]
        // 水平/垂直约束各自给出 distance ≥ dAlong + 投影/容限。
        const needHoriz = Math.abs(xProj) / horizDivisor
        const needVert = Math.abs(yProj) / vertDivisor
        const bound = dAlong + Math.max(needHoriz, needVert)
        if (bound > minDistance) minDistance = bound
      }
    }
  }

  // 退化保护：bounds 为零尺寸（min=max）时所有角点投影为 0，minDistance 解为 0；
  // 回退到 1 m 保证相机不落在 target 上、depth 为正。上游 V76 数据不会触发（1768 节点），
  // 此处仅使函数对任意有限 bounds 稳健，不产生 NaN 或负距离。
  const distance = Number.isFinite(minDistance) && minDistance > 0 ? minDistance : 1

  const position: readonly [number, number, number] = [
    target[0] + distance * dir[0],
    distance * dir[1],
    target[2] + distance * dir[2],
  ]

  const radius = boundsRadius(bounds)
  const far = Math.max(FAR_MIN_M, radius * FAR_RADIUS_FACTOR)

  return {
    position,
    target,
    far,
    distance,
    polarRad: INITIAL_POLAR_RAD,
    azimuthRad: INITIAL_AZIMUTH_RAD,
  }
}

/**
 * OrbitControls 距离范围（SPEC §9.2）。
 *
 * - min = max(2 m, 包围球半径 × 0.05)：允许贴近查看细节，但不穿越到目标内部。
 * - max = 包围球半径 × 4：允许拉远俯瞰全景，但不会远到内容不可辨识。
 *
 * 纯函数：相同边界产生相同范围。framing 的初始 distance 由安全区求解、独立于本范围，
 * 但在正常 bounds 下必然落入 [min, max]（distance 约为半径的 2～3 倍，远小于 4 倍上限）。
 */
export function computeOrbitDistanceLimits(
  bounds: Bounds3Data,
): { readonly min: number; readonly max: number } {
  const radius = boundsRadius(bounds)
  return {
    min: Math.max(MIN_DISTANCE_FLOOR_M, radius * MIN_DISTANCE_RADIUS_FACTOR),
    max: radius * MAX_DISTANCE_RADIUS_FACTOR,
  }
}

/**
 * OrbitControls 平移 target 的允许区域（SPEC §9.2）。
 *
 * target 的水平 x/z 被限制在 renderBounds 水平范围向外扩展 20% 的矩形内，避免用户把视点
 * 平移到远离整张地图的空白区域。Y 不受约束（地面投影，相机始终看向 y≈0）。
 *
 * 纯函数：相同边界产生相同矩形。CameraRig 每帧把 OrbitControls.target 钳制到该矩形。
 */
export function computePanBounds(bounds: Bounds3Data): {
  readonly minX: number
  readonly maxX: number
  readonly minZ: number
  readonly maxZ: number
} {
  const dx = bounds.max[0] - bounds.min[0]
  const dz = bounds.max[2] - bounds.min[2]
  const extX = dx * PAN_BOUND_EXPANSION
  const extZ = dz * PAN_BOUND_EXPANSION
  return {
    minX: bounds.min[0] - extX,
    maxX: bounds.max[0] + extX,
    minZ: bounds.min[2] - extZ,
    maxZ: bounds.max[2] + extZ,
  }
}
