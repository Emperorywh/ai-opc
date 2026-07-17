/*
 * 动态 near / far 裁剪面推导（camera 层，SPEC 12.3 / 16）。
 *
 * 信任边界定位（TASK-017）：
 *   - 本模块消费 fit 的 expandedContentBounds（contentBounds 每侧扩张 0.50m 的结果，由
 *     CameraFit.expandedBounds 直接复用，不再扩张或重算）、TASK-017 的 groundBounds 与
 *     当前相机位置 / 目标 / 拟合半径，按相机空间深度推导动态 near / far。
 *   - 所有裁剪值由当前场景范围与拟合半径推导，禁止任意大常量、无限地面或无限 far plane。
 *   - 纯数值推导：不创建 Three / R3F / React 对象，不接触 projection matrix；
 *     后续相机控制器负责把结果写入 PerspectiveCamera near / far 并 updateProjectionMatrix。
 *
 * 裁剪范围不变量（SPEC 12.3 step 1）：
 *   - clipBounds = expanded content bounds ∪ Ground bounds。Ground 只参与裁剪面推导，不参与 fit。
 *   - expanded content bounds 由调用方从 CameraFit.expandedBounds 传入（contentBounds + 0.50m），
 *     本模块不再持有 padding 常量，避免与 cameraFit 形成第二套扩张语义。
 *   - 把 clipBounds 八角转换到相机空间，正深度 depth = -cameraSpace.z。
 *
 * 裁剪深度推导不变量（SPEC 12.3 step 3~4 / 任务约束）：
 *   - 任一点 depth ≤ 0（相机位于范围内或贴近近端）时 near = MIN_NEAR_METERS（合法分支，非错误）；
 *     否则 near = max(MIN_NEAR_METERS, minDepth × NEAR_DEPTH_RATIO)。
 *   - far = max(near + FAR_MIN_SLACK_METERS, maxDepth × FAR_DEPTH_RATIO,
 *     |position - target| + FAR_TARGET_RADIUS_MULTIPLE × fitRadius)；
 *     每项均由当前场景推导，不使用任意大常量。
 *   - 合法分支 near 下限恒为 MIN_NEAR_METERS（0.02m），且最终断言 0 < near < far。
 *
 * 无效输入不变量（SPEC 16 / 任务约束）：
 *   - expandedContentBounds / groundBounds / 相机位置 / 目标 / fitRadius 任一非有限、
 *     bounds min > max、或相机与目标重合（基未定义）时返回 null，
 *     调用方不得提交 projection matrix，禁止产生 NaN / Infinity。
 *   - 非正深度（depth ≤ 0）属于合法分支（near 回落到 0.02m），不视为无效输入。
 *
 * 依赖方向（SPEC 3.3）：仅依赖 domain（NumericBox3）与 camera（cameraFit 的 Vec3 类型），
 *   是纯函数；不依赖 Three / R3F / React / 浏览器 API。
 */
import type { NumericBox3 } from '../domain/sceneMap'
import type { Vec3 } from './cameraFit'
import { isValidContentBounds } from './cameraFit'

/*
 * SPEC 12.3 step 3：near 下限（米）。
 * 任一点 depth ≤ 0 或 minDepth × NEAR_DEPTH_RATIO 不足该下限时取该下限。
 */
export const MIN_NEAR_METERS = 0.02

/*
 * SPEC 12.3 step 3：合法正深度的 near 收缩比（near = minDepth × 0.8，留出近端余量，
 * 避免紧贴最近顶点导致 z-fighting 或近裁切）。
 */
export const NEAR_DEPTH_RATIO = 0.8

/*
 * SPEC 12.3 step 4：far 相对最大深度的放大量（far ≥ maxDepth × 1.2）。
 */
export const FAR_DEPTH_RATIO = 1.2

/*
 * SPEC 12.3 step 4：far 相对 near 的最小余量（far ≥ near + 1m），保证退化场景仍有可用深度区间。
 */
export const FAR_MIN_SLACK_METERS = 1

/*
 * SPEC 12.3 step 4：far 相对 camera-target 距离 + 2 × R 的项。
 * R 来自当前 fit 半径；保证以 target 为球心、R 为半径的拟合球完整落在远端内。
 */
export const FAR_TARGET_RADIUS_MULTIPLE = 2

/*
 * 动态裁剪面结果（SPEC 12.3）。
 *
 * 字段语义：
 *   - near / far：透视投影 near / far（米），恒满足 0 < near < far。
 *   - minDepth / maxDepth：clipBounds 八角在相机空间的正深度最小 / 最大值，供诊断与断言。
 */
export interface ClipPlanes {
  readonly near: number
  readonly far: number
  readonly minDepth: number
  readonly maxDepth: number
}

/*
 * 校验有限向量（SPEC 16 / 任务约束）。
 */
function isValidVec3(v: Vec3): boolean {
  return Number.isFinite(v.x) && Number.isFinite(v.y) && Number.isFinite(v.z)
}

/*
 * 合并两个 bounds 为紧致 AABB（SPEC 12.3 step 1）。
 * clipBounds = expanded content bounds ∪ Ground bounds；调用方保证两个 bounds 均合法。
 */
function unionBounds(a: NumericBox3, b: NumericBox3): NumericBox3 {
  return {
    minX: Math.min(a.minX, b.minX),
    minY: Math.min(a.minY, b.minY),
    minZ: Math.min(a.minZ, b.minZ),
    maxX: Math.max(a.maxX, b.maxX),
    maxY: Math.max(a.maxY, b.maxY),
    maxZ: Math.max(a.maxZ, b.maxZ),
  }
}

/*
 * 构造 clipBounds（SPEC 12.3 step 1）。
 *
 * clipBounds = expandedContentBounds ∪ Ground bounds。
 *   - expandedContentBounds 由调用方从 CameraFit.expandedBounds 传入（已含 0.50m 扩张）。
 *   - Ground bounds 来自 computeGroundBounds（contentBounds + 地面 padding，Y = [0, 0]）。
 * 该函数只做并集，不再扩张或重算，保证裁剪范围与 fit / 地面共享同一套范围来源。
 *
 * 无效输入不变量：任一 bounds 非法时返回 null，禁止产生 NaN / Infinity。
 */
export function computeClipBounds(
  expandedContentBounds: NumericBox3,
  groundBounds: NumericBox3,
): NumericBox3 | null {
  if (!isValidContentBounds(expandedContentBounds)) return null
  if (!isValidContentBounds(groundBounds)) return null
  return unionBounds(expandedContentBounds, groundBounds)
}

/*
 * 把 clipBounds 八角转换到相机空间并求正深度范围（SPEC 12.3 step 2）。
 *
 * 裁剪深度推导（SPEC 12.3 step 2）：
 *   - 相机基与 Three Matrix4.lookAt(eye, target, up = (0,1,0)) 同约定：
 *       相机 +Z = normalize(position - target)（从 target 指向 eye，向后）；
 *       相机 +X = normalize(up × +Z)；
 *       相机 +Y = +Z × +X。
 *   - cameraSpace.z = +Z · (p - position)；正深度（在相机前方）= -cameraSpace.z。
 *   - 取八角正深度的最小 / 最大值。
 *
 * 调用方保证 clipBounds 与 position / target 合法且不重合（zLen > 0）。
 */
function computeDepthRange(
  clipBounds: NumericBox3,
  position: Vec3,
  target: Vec3,
  cameraTargetDistance: number,
): { minDepth: number; maxDepth: number } {
  // +Z 轴（从 target 到 eye），用传入的 cameraTargetDistance 归一化（已 > 0）。
  const zx = (position.x - target.x) / cameraTargetDistance
  const zy = (position.y - target.y) / cameraTargetDistance
  const zz = (position.z - target.z) / cameraTargetDistance

  const xs: readonly number[] = [clipBounds.minX, clipBounds.maxX]
  const ys: readonly number[] = [clipBounds.minY, clipBounds.maxY]
  const zs: readonly number[] = [clipBounds.minZ, clipBounds.maxZ]
  let minDepth = Number.POSITIVE_INFINITY
  let maxDepth = Number.NEGATIVE_INFINITY
  for (const x of xs) {
    for (const y of ys) {
      for (const z of zs) {
        // p - position
        const dx = x - position.x
        const dy = y - position.y
        const dz = z - position.z
        // cameraSpace.z = +Z · (p - position)；正深度 = -cameraSpace.z。
        const cameraSpaceZ = zx * dx + zy * dy + zz * dz
        const depth = -cameraSpaceZ
        if (depth < minDepth) minDepth = depth
        if (depth > maxDepth) maxDepth = depth
      }
    }
  }
  return { minDepth, maxDepth }
}

/*
 * 动态 near / far 裁剪面主入口（SPEC 12.3）。
 *
 * 调用方契约：
 *   - expandedContentBounds：来自 CameraFit.expandedBounds（contentBounds + 0.50m），场景加载后固定。
 *   - groundBounds：来自 computeGroundBounds（contentBounds + 地面 padding），场景加载后固定。
 *   - position / target：当前相机世界位置与观察目标（初始来自 fit，浏览中来自 controls）。
 *   - fitRadius：当前拟合半径 R（初始来自 fit；browse 中保持不变）。
 *   - 成功返回 ClipPlanes（0 < near < far）；任一输入非有限 / bounds min > max /
 *     相机与目标重合时返回 null，不得提交 projection matrix。
 *
 * 算法（SPEC 12.3）：
 *   1. clipBounds = expandedContentBounds ∪ groundBounds，取八角。
 *   2. depth = -cameraSpace.z（相机空间正深度）。
 *   3. 若 minDepth ≤ 0 → near = MIN_NEAR_METERS；否则 near = max(MIN_NEAR_METERS, minDepth × NEAR_DEPTH_RATIO)。
 *   4. far = max(near + FAR_MIN_SLACK_METERS, maxDepth × FAR_DEPTH_RATIO,
 *      |position - target| + FAR_TARGET_RADIUS_MULTIPLE × fitRadius)。
 *   5. 断言 0 < near < far。
 */
export function computeClipPlanes(
  expandedContentBounds: NumericBox3,
  groundBounds: NumericBox3,
  position: Vec3,
  target: Vec3,
  fitRadius: number,
): ClipPlanes | null {
  // 无效输入：bounds / 向量 / R 非有限，或 bounds min > max → 不提交，禁止 NaN / Infinity。
  if (!isValidContentBounds(expandedContentBounds)) return null
  if (!isValidContentBounds(groundBounds)) return null
  if (!isValidVec3(position) || !isValidVec3(target)) return null
  if (!Number.isFinite(fitRadius)) return null

  // 相机与目标重合时基未定义（+Z 归一化除零）；保持未提交。
  const dx = position.x - target.x
  const dy = position.y - target.y
  const dz = position.z - target.z
  const cameraTargetDistance = Math.sqrt(dx * dx + dy * dy + dz * dz)
  if (!(cameraTargetDistance > 0)) return null

  // 1. clipBounds = expanded content bounds ∪ Ground bounds（SPEC 12.3 step 1）。
  const clipBounds = unionBounds(expandedContentBounds, groundBounds)

  // 2. 相机空间正深度范围（SPEC 12.3 step 2）。
  const { minDepth, maxDepth } = computeDepthRange(
    clipBounds,
    position,
    target,
    cameraTargetDistance,
  )

  // 3. near：非正深度分支取下限 0.02m，否则取 minDepth × 0.8 且不低于 0.02m（SPEC 12.3 step 3）。
  let near: number
  if (minDepth <= 0) {
    near = MIN_NEAR_METERS
  } else {
    near = Math.max(MIN_NEAR_METERS, minDepth * NEAR_DEPTH_RATIO)
  }

  // 4. far：由最大深度、near 余量与 camera-target + 2R 三项推导（SPEC 12.3 step 4）。
  //    每一项都由当前场景推导，不使用任意大常量；ground 不参与 fit 但通过 clipBounds 参与 far。
  const far = Math.max(
    near + FAR_MIN_SLACK_METERS,
    maxDepth * FAR_DEPTH_RATIO,
    cameraTargetDistance + FAR_TARGET_RADIUS_MULTIPLE * fitRadius,
  )

  // 5. 断言 0 < near < far：far 公式保证 far ≥ near + 1 > near，near ≥ 0.02 > 0；
  //    此处兜底防止上游 min / maxDepth 退化导致 projection 非法，违例时保持未提交。
  if (!(near > 0 && far > near)) return null

  return { near, far, minDepth, maxDepth }
}
