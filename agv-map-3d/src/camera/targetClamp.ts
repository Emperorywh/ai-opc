/*
 * 观察目标地面约束（camera 层，SPEC §12.4 / §16 / 任务约束）。
 *
 * 信任边界定位（TASK-019）：
 *   - 本模块消费 TASK-017 computeGroundBounds 交付的有限地面范围（contentBounds + 地面 padding，
 *     Y 恒为 [0, 0]），把 OrbitControls 的观察目标 X/Z 限制在地面内、Y 固定为 0。
 *   - 纯数值推导：不创建 Three / R3F / React 对象，不接触 DOM、不接触 OrbitControls 实例；
 *     后续控制器把返回的修正向量同时加到 camera.position 与 controls.target，保持 offset 不变。
 *
 * target clamp 不变量（SPEC §12.4 / 任务约束）：
 *   - 每次 controls change 后 target.x/z 必须落在 Ground 的 XZ 范围内，target.y 固定为 0；
 *     clamp 产生的修正向量必须同时加到 camera.position，保持 camera-target offset 不变，
 *     使相机不会因 clamp 相对目标发生平移（offset 改变会破坏 OrbitControls 的 spherical 状态）。
 *   - 地面是有限平面：XZ 由 computeGroundBounds 决定；不引入“足量大数”或无限地面。
 *   - 该约束只限制观察目标，不替代 minDistance / maxDistance / polar 角对相机本身的约束。
 *
 * 相机始终位于地面上方不变量（SPEC §12.4 / 任务约束）：
 *   - target.y 固定为 0；polar ∈ [15°, 85°]（由 orbitControlsContract 固定）；
 *     故 camera.y = target.y + distance × cos(polar) ≥ distance × cos(85°) > 0，
 *     相机恒位于 Ground（Y = 0）上方，本模块只负责把 target.y 锁回 0。
 *
 * 无效输入不变量（SPEC §16 / 任务约束）：
 *   - targetX / targetZ 非有限、groundBounds 任一分量非有限或 min > max 时返回 null，
 *     调用方保持未提交，禁止产生 NaN / Infinity。
 *
 * 依赖方向（SPEC 3.3）：仅依赖 domain（NumericBox3）与 camera（cameraFit 的校验函数），是纯函数；
 *   不依赖 Three / R3F / React / 浏览器 API。
 */
import type { NumericBox3 } from '../domain/sceneMap'
import { isValidContentBounds } from './cameraFit'

/*
 * target clamp 结果（SPEC §12.4）。
 *
 * 字段语义：
 *   - clampedX / clampedZ：限制到 Ground XZ 范围后的目标坐标。
 *   - correctionX / correctionZ：clamped - input；控制器把该向量同时加到 camera.position 与
 *     controls.target，保持 camera-target offset 不变（SPEC §12.4）。
 *   - clamped：是否实际发生了限制（correctionX / correctionZ 任一非零）。控制器可据此决定是否
 *     写入，避免对已在范围内的目标做无谓赋值；但写入零修正亦无害。
 */
export interface TargetClampResult {
  readonly clampedX: number
  readonly clampedZ: number
  readonly correctionX: number
  readonly correctionZ: number
  readonly clamped: boolean
}

/*
 * 把观察目标限制到有限地面范围（SPEC §12.4）。
 *
 * 调用方契约：
 *   - targetX / targetZ：当前 controls.target 的 X / Z（Y 由控制器强制为 0，不在本函数入参）。
 *   - groundBounds：TASK-017 computeGroundBounds 交付的只读地面范围（Y 恒为 [0, 0]）。
 *   - 成功返回 TargetClampResult；targetX / targetZ 非有限或 groundBounds 非法时返回 null，
 *     调用方不得提交，禁止产生 NaN / Infinity。
 *
 * 算法：X / Z 分别用 min(max(...)) 夹取到 [groundMin, groundMax]；correction = clamped - input。
 * 该夹取是 SPEC §12.4 唯一的 target 限制规则，不引入第二套边界或样本专用常量。
 */
export function clampTargetToGround(
  targetX: number,
  targetZ: number,
  groundBounds: NumericBox3,
): TargetClampResult | null {
  // 无效输入：target 或地面范围非有限 / 反转 → 不提交，禁止 NaN / Infinity。
  if (!Number.isFinite(targetX) || !Number.isFinite(targetZ)) return null
  if (!isValidContentBounds(groundBounds)) return null

  const clampedX = Math.max(groundBounds.minX, Math.min(groundBounds.maxX, targetX))
  const clampedZ = Math.max(groundBounds.minZ, Math.min(groundBounds.maxZ, targetZ))
  const correctionX = clampedX - targetX
  const correctionZ = clampedZ - targetZ
  return {
    clampedX,
    clampedZ,
    correctionX,
    correctionZ,
    clamped: correctionX !== 0 || correctionZ !== 0,
  }
}
