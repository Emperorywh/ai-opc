/*
 * 标准 3/4 初始相机 fit 推导（camera 层，SPEC 12.2 / 12.3 / 16）。
 *
 * 信任边界定位（TASK-017）：
 *   - 本模块消费 TASK-012 交付的唯一数值内容包围盒 contentBounds，按 SPEC 12.2 固定规则
 *     推导标准 3/4 视角的相机位置、观察目标、拟合半径 R 与距离；地面不参与 fit。
 *   - 先固定 50° FOV、60° polar、45° azimuth 的方向，再按受限 FOV 与目标到扩张包围盒八角
 *     的最大距离求距离；扩张量 0.50m、margin 1.10（SPEC 12.2 / 任务约束）。
 *   - 纯数值推导：不创建 Three / R3F / React 对象，不接触 DOM；方向与距离全部由数值推导，
 *     后续相机控制器把结果写入 Three PerspectiveCamera 与 OrbitControls。
 *
 * fit 球心不变量（SPEC 12.2 / 任务约束）：
 *   - R 明确以 controls target 为球心：target = (boundsCenterX, 0, boundsCenterZ)，Y 固定为 0，
 *     不使用 bounds Y 中心略高于地面的默认 bounding sphere。
 *   - R = target 到 expandedBounds 八角的最大距离；先定 3/4 方向再算距离，
 *     禁止先俯视 fit 再旋转到 3/4 视角。
 *
 * 受限 FOV 不变量（SPEC 12.2）：
 *   - verticalFov = radians(50)；horizontalFov = 2 × atan(tan(verticalFov/2) × aspect)。
 *   - limitedFov = min(verticalFov, horizontalFov)：宽屏由垂直 FOV 限制，窄屏由水平 FOV 限制。
 *   - distance = FIT_MARGIN × R / sin(limitedFov / 2)，margin = 1.10。
 *
 * 无效输入不变量（SPEC 16 / 任务约束）：
 *   - aspect ≤ 0、非有限、contentBounds 非有限或 min > max 时返回 null，
 *     调用方不得提交相机状态，禁止产生 NaN / Infinity。
 *   - 首次 fit 只能在画布尺寸非零（aspect > 0 且有限）且场景数据 ready 后提交；
 *     无效输入保持未提交，不写入相机或 controls。
 *
 * 依赖方向（SPEC 3.3）：仅依赖 domain（NumericBox3），是纯函数；
 *   不依赖 Three / R3F / React / 浏览器 API。
 */
import type { NumericBox3 } from '../domain/sceneMap'

/*
 * SPEC 12.2：透视相机垂直 FOV（度，全角）。
 */
export const PERSPECTIVE_FOV_DEG = 50

/*
 * SPEC 12.2：初始 polar 角（度，从 +Y 量起）与 azimuth 角（度，从 +X 朝 +Z）。
 * 方向（单位向量）= (sin60°cos45°, cos60°, sin60°sin45°) ≈ (0.6124, 0.5, 0.6124)。
 */
export const INITIAL_POLAR_DEG = 60
export const INITIAL_AZIMUTH_DEG = 45

/*
 * SPEC 12.2：fit margin 与 bounds 扩张 padding（米）。
 *   - expandedBounds = contentBounds 每侧（六面）扩张 FIT_BOUNDS_PADDING。
 *   - distance = FIT_MARGIN × R / sin(limitedFov / 2)。
 * 该 padding 同时被动态裁剪面复用为 expanded content bounds 的扩张量（SPEC 12.3 step 1），
 * 是 fit 与 clip 共享的唯一扩张常量，不形成第二套 padding。
 */
export const FIT_MARGIN = 1.1
export const FIT_BOUNDS_PADDING = 0.5

/*
 * 只读三维向量（camera 层局部用），避免在纯函数中引入 three 依赖；与 ScenePoint 同风格。
 * 后续相机控制器（TASK-019）负责把该结构转换为 THREE.Vector3。
 */
export interface Vec3 {
  readonly x: number
  readonly y: number
  readonly z: number
}

/*
 * 标准 3/4 fit 结果（SPEC 12.2）。
 *
 * 字段语义：
 *   - target：观察目标，Y 固定为 0，XZ 为内容中心（fit 球心）。
 *   - position：相机世界位置 = target + direction × distance。
 *   - direction：单位方向向量（polar 60°、azimuth 45°），y > 0 保证相机位于地面上方。
 *   - radius：拟合半径 R（target 到 expandedBounds 八角最大距离），供 OrbitControls maxDistance
 *     与动态裁剪面 far 推导共享。
 *   - distance：相机到 target 的距离 = FIT_MARGIN × R / sin(limitedFov / 2)。
 *   - verticalFov / horizontalFov / limitedFov：受限 FOV 推导中间值（弧度，全角），
 *     limitedFov = min(垂直, 水平)。
 *   - expandedBounds：contentBounds 每侧扩张 FIT_BOUNDS_PADDING 后的范围；
 *     八角用于求 R，亦作为动态裁剪面的 expanded content bounds 直接复用（SPEC 12.3 step 1），
 *     调用方无需再次扩张或重算。
 *   - aspect：传入的有效画布宽高比。
 */
export interface CameraFit {
  readonly target: Vec3
  readonly position: Vec3
  readonly direction: Vec3
  readonly radius: number
  readonly distance: number
  readonly verticalFov: number
  readonly horizontalFov: number
  readonly limitedFov: number
  readonly expandedBounds: NumericBox3
  readonly aspect: number
}

/*
 * 校验 contentBounds 合法性（SPEC 16 / 任务约束）。
 * 六分量均有限且 min ≤ max 才视为合法；与 groundBounds / clipPlanes 共用同一不变量。
 */
export function isValidContentBounds(b: NumericBox3): boolean {
  return (
    Number.isFinite(b.minX) &&
    Number.isFinite(b.minY) &&
    Number.isFinite(b.minZ) &&
    Number.isFinite(b.maxX) &&
    Number.isFinite(b.maxY) &&
    Number.isFinite(b.maxZ) &&
    b.minX <= b.maxX &&
    b.minY <= b.maxY &&
    b.minZ <= b.maxZ
  )
}

/*
 * 把角度（度）转为弧度。
 */
function toRadians(deg: number): number {
  return (deg * Math.PI) / 180
}

/*
 * 推导单位方向向量（SPEC 12.2：polar 从 +Y 量起，azimuth 从 +X 朝 +Z）。
 * 球坐标到直角坐标：
 *   y = cos(polar)，水平投影 = sin(polar)，
 *   x = sin(polar) × cos(azimuth)，z = sin(polar) × sin(azimuth)。
 * 默认 (polar=60°, azimuth=45°) 得到单位向量，y = 0.5 > 0 保证相机位于地面上方。
 */
function directionFromAngles(polarDeg: number, azimuthDeg: number): Vec3 {
  const polar = toRadians(polarDeg)
  const azimuth = toRadians(azimuthDeg)
  const sinPolar = Math.sin(polar)
  return {
    x: sinPolar * Math.cos(azimuth),
    y: Math.cos(polar),
    z: sinPolar * Math.sin(azimuth),
  }
}

/*
 * contentBounds 每侧（六面）扩张固定 padding，得到 expandedBounds（SPEC 12.2）。
 * 调用方保证 contentBounds 合法；扩张后六分量仍有限。
 */
function expandBounds(b: NumericBox3, padding: number): NumericBox3 {
  return {
    minX: b.minX - padding,
    minY: b.minY - padding,
    minZ: b.minZ - padding,
    maxX: b.maxX + padding,
    maxY: b.maxY + padding,
    maxZ: b.maxZ + padding,
  }
}

/*
 * 计算 target 到 box 八个角的最大距离（SPEC 12.2 R 推导）。
 *
 * fit 球心：target Y 固定为 0；八角覆盖 box 的 (min/max X, min/max Y, min/max Z) 全组合。
 * 取最大欧氏距离作为拟合半径 R，使整个 expandedBounds 落在以 target 为球心、R 为半径的球内。
 */
function maxCornerDistance(box: NumericBox3, target: Vec3): number {
  const xs: readonly number[] = [box.minX, box.maxX]
  const ys: readonly number[] = [box.minY, box.maxY]
  const zs: readonly number[] = [box.minZ, box.maxZ]
  let maxDistSq = 0
  for (const x of xs) {
    for (const y of ys) {
      for (const z of zs) {
        const dx = x - target.x
        const dy = y - target.y
        const dz = z - target.z
        const distSq = dx * dx + dy * dy + dz * dz
        if (distSq > maxDistSq) maxDistSq = distSq
      }
    }
  }
  return Math.sqrt(maxDistSq)
}

/*
 * 标准 3/4 相机 fit 主入口（SPEC 12.2）。
 *
 * 调用方契约：
 *   - contentBounds 为 TASK-012 的唯一数值内容包围盒；aspect 为有效画布宽 / 高（> 0 且有限）。
 *   - 成功返回 CameraFit；aspect ≤ 0 / 非有限 / contentBounds 非法时返回 null，不得提交相机状态。
 *
 * 算法（SPEC 12.2，先定方向再算距离）：
 *   1. verticalFov = radians(50)；horizontalFov = 2 × atan(tan(verticalFov/2) × aspect)；
 *      limitedFov = min(垂直, 水平)。
 *   2. expandedBounds = contentBounds 每侧扩张 FIT_BOUNDS_PADDING（0.50m）。
 *   3. target = (boundsCenterX, 0, boundsCenterZ)（Y 固定为 0，不用 bounds Y 中心）。
 *   4. R = target 到 expandedBounds 八角的最大距离。
 *   5. distance = FIT_MARGIN × R / sin(limitedFov / 2)。
 *   6. direction = (sin60°cos45°, cos60°, sin60°sin45°)。
 *   7. position = target + direction × distance。
 *
 * 确定性不变量：相同 (contentBounds, aspect) 输入恒得到相同输出；首次非零尺寸 fit 与
 *   未发生用户导航时的 resize fit 调用本函数得到同一结果（无内部状态、无随机）。
 */
export function computeCameraFit(
  contentBounds: NumericBox3,
  aspect: number,
): CameraFit | null {
  // 无效输入：aspect 必须为正有限数（画布非零尺寸）；bounds 六分量有限且 min ≤ max。
  // 任一不满足即返回 null，调用方不得提交，禁止产生 NaN / Infinity。
  if (!Number.isFinite(aspect) || aspect <= 0) return null
  if (!isValidContentBounds(contentBounds)) return null

  // 1. 受限 FOV 推导：宽屏受垂直 FOV 限制，窄屏受水平 FOV 限制。
  const verticalFov = toRadians(PERSPECTIVE_FOV_DEG)
  const halfVertical = verticalFov / 2
  const horizontalFov = 2 * Math.atan(Math.tan(halfVertical) * aspect)
  const limitedFov = Math.min(verticalFov, horizontalFov)

  // 2. expandedBounds：contentBounds 每侧扩张固定 padding（SPEC 12.2 bounds 额外世界 padding 0.50m）。
  const expandedBounds = expandBounds(contentBounds, FIT_BOUNDS_PADDING)

  // 3. fit 球心：target 取内容 XZ 中心，Y 固定为 0（不使用 bounds Y 中心略高于地面的默认球心）。
  const target: Vec3 = {
    x: (contentBounds.minX + contentBounds.maxX) / 2,
    y: 0,
    z: (contentBounds.minZ + contentBounds.maxZ) / 2,
  }

  // 4. R = target 到 expandedBounds 八角的最大距离（以 controls target 为球心）。
  const radius = maxCornerDistance(expandedBounds, target)

  // 5. distance = margin × R / sin(limitedFov / 2)；margin 1.10 保证扩张范围八角投影留有余量，
  //    使 |NDC| ≤ 0.92（SPEC 12.2 / 任务验证方式第 3 项）。
  const distance = (FIT_MARGIN * radius) / Math.sin(limitedFov / 2)

  // 6. 方向（polar 60°、azimuth 45°）与相机位置。
  const direction = directionFromAngles(INITIAL_POLAR_DEG, INITIAL_AZIMUTH_DEG)
  const position: Vec3 = {
    x: target.x + direction.x * distance,
    y: target.y + direction.y * distance,
    z: target.z + direction.z * distance,
  }

  return {
    target,
    position,
    direction,
    radius,
    distance,
    verticalFov,
    horizontalFov,
    limitedFov,
    expandedBounds,
    aspect,
  }
}
