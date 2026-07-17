/*
 * OrbitControls 固定契约（camera 层，SPEC §12.4 / §16 / 任务约束）。
 *
 * 信任边界定位（TASK-019）：
 *   - 本模块集中表达 SPEC §12.4 对只读轨道浏览的全部固定参数：距离上下限、polar 角范围、阻尼、
 *     rotate / pan / zoom 速度与开关。控制器与测试只消费本模块导出的常量与构造 / 应用函数，
 *     禁止在事件回调或组件内复制同义参数或引入样本专用常量。
 *   - 纯数值与结构化推导：不创建 OrbitControls / Three / R3F / React 对象，不接触 DOM；
 *     applyOrbitContract 写入任意符合 OrbitControlsLike 的可变对象，使契约可在纯对象上单测。
 *
 * 固定参数不变量（SPEC §12.4 / 任务约束）：
 *   - minDistance = 0.50m；maxDistance = 8 × R（R 为 fit 拟合半径，由 computeCameraFit 推导）。
 *   - minPolarAngle = 15°、maxPolarAngle = 85°（从 +Y 量起）；dampingFactor = 0.08。
 *   - rotateSpeed = 0.6、panSpeed = 1.0、zoomSpeed = 0.8；rotate / pan / zoom 全部启用。
 *   - screenSpacePanning = false：pan 沿地面平面（target.y = 0 的水平面），符合地图浏览语义。
 *
 * maxDistance 依赖 R 不变量（SPEC §12.4 / 任务约束）：
 *   - maxDistance 依赖 fit 半径 R，故静态契约以 +∞ 占位（等价于“创建时尚未限制”），
 *     控制器在首次标准 fit 得到 R 后用 computeMaxDistance(R) 覆盖为 8 × R；
 *     不在创建时引入第二套距离常量，也不把 R 散落为魔法数。
 *
 * 无效输入不变量（SPEC §16 / 任务约束）：
 *   - computeMaxDistance 对非有限或非正 R 返回 null，调用方保持未提交，禁止产生 NaN / Infinity。
 *
 * 依赖方向（SPEC 3.3）：仅依赖本层自身，是纯数据 / 纯函数；
 *   不依赖 Three / R3F / React / 浏览器 API。
 */

/*
 * SPEC §12.4：最小距离（米）。相机不能无限靠近 target。
 */
export const ORBIT_MIN_DISTANCE_METERS = 0.5

/*
 * SPEC §12.4：最大距离相对 fit 半径 R 的倍数（maxDistance = 8 × R）。
 */
export const ORBIT_MAX_DISTANCE_RADIUS_MULTIPLE = 8

/*
 * SPEC §12.4：polar 角范围（度，从 +Y 量起）。15° 防止正俯视丢失立体感，85° 防止贴地。
 */
export const ORBIT_MIN_POLAR_DEG = 15
export const ORBIT_MAX_POLAR_DEG = 85

/*
 * SPEC §12.4：阻尼系数。
 */
export const ORBIT_DAMPING_FACTOR = 0.08

/*
 * SPEC §12.4：rotate / pan / zoom 速度。
 */
export const ORBIT_ROTATE_SPEED = 0.6
export const ORBIT_PAN_SPEED = 1.0
export const ORBIT_ZOOM_SPEED = 0.8

/*
 * 可被写入轨道契约的可变对象形状（OrbitControls 实例满足该接口，纯测试对象亦满足）。
 * 把“契约应用”与真实的 OrbitControls 类型解耦，使本模块可在不依赖 three 运行时的情况下单测。
 */
export interface OrbitControlsLike {
  enableDamping: boolean
  dampingFactor: number
  enableRotate: boolean
  enablePan: boolean
  enableZoom: boolean
  rotateSpeed: number
  panSpeed: number
  zoomSpeed: number
  minDistance: number
  maxDistance: number
  minPolarAngle: number
  maxPolarAngle: number
  screenSpacePanning: boolean
}

/*
 * SPEC §12.4 固定轨道契约（不可变）。
 * maxDistance 在静态契约中为 +∞ 占位，由 computeMaxDistance(R) 在首次 fit 后覆盖。
 */
export interface OrbitContract {
  readonly enableDamping: boolean
  readonly dampingFactor: number
  readonly enableRotate: boolean
  readonly enablePan: boolean
  readonly enableZoom: boolean
  readonly rotateSpeed: number
  readonly panSpeed: number
  readonly zoomSpeed: number
  readonly minDistance: number
  readonly maxDistance: number
  readonly minPolarAngle: number
  readonly maxPolarAngle: number
  readonly screenSpacePanning: boolean
}

/*
 * 把度转为弧度。
 */
function degToRad(deg: number): number {
  return (deg * Math.PI) / 180
}

/*
 * SPEC §12.4：minPolarAngle（弧度）。
 */
export function orbitMinPolarAngle(): number {
  return degToRad(ORBIT_MIN_POLAR_DEG)
}

/*
 * SPEC §12.4：maxPolarAngle（弧度）。
 */
export function orbitMaxPolarAngle(): number {
  return degToRad(ORBIT_MAX_POLAR_DEG)
}

/*
 * 由 fit 半径 R 推导 maxDistance = 8 × R（SPEC §12.4）。
 * R 非有限或非正时返回 null，调用方保持未提交，禁止产生 NaN / Infinity。
 */
export function computeMaxDistance(fitRadius: number): number | null {
  if (!Number.isFinite(fitRadius) || !(fitRadius > 0)) return null
  return ORBIT_MAX_DISTANCE_RADIUS_MULTIPLE * fitRadius
}

/*
 * 构造 SPEC §12.4 固定轨道契约（静态部分）。
 *
 * maxDistance 取 +∞ 占位：控制器创建 OrbitControls 时尚未持有 fit 半径 R，此时不限制最大距离；
 * 首次标准 fit 得到 R 后，控制器用 computeMaxDistance(R) 覆盖 maxDistance 为 8 × R。
 * 其余字段为最终值，不随 R 或用户浏览变化。
 *
 * 不可变：返回的对象字段为 readonly 契约；applyOrbitContract 负责把它写入可变目标。
 */
export function buildOrbitContract(): OrbitContract {
  return {
    enableDamping: true,
    dampingFactor: ORBIT_DAMPING_FACTOR,
    enableRotate: true,
    enablePan: true,
    enableZoom: true,
    rotateSpeed: ORBIT_ROTATE_SPEED,
    panSpeed: ORBIT_PAN_SPEED,
    zoomSpeed: ORBIT_ZOOM_SPEED,
    minDistance: ORBIT_MIN_DISTANCE_METERS,
    maxDistance: Number.POSITIVE_INFINITY,
    minPolarAngle: orbitMinPolarAngle(),
    maxPolarAngle: orbitMaxPolarAngle(),
    screenSpacePanning: false,
  }
}

/*
 * 把固定契约写入任意 OrbitControlsLike 目标（SPEC §12.4）。
 *
 * 调用方契约：target 为 OrbitControls 实例或满足 OrbitControlsLike 的纯测试对象。
 * 写入全部固定字段；maxDistance 写入契约中的占位值（+∞），由调用方在首次 fit 后用
 * computeMaxDistance(R) 覆盖。该函数不读 R，故可在创建时即应用静态契约。
 */
export function applyOrbitContract(
  target: OrbitControlsLike,
  contract: OrbitContract,
): void {
  target.enableDamping = contract.enableDamping
  target.dampingFactor = contract.dampingFactor
  target.enableRotate = contract.enableRotate
  target.enablePan = contract.enablePan
  target.enableZoom = contract.enableZoom
  target.rotateSpeed = contract.rotateSpeed
  target.panSpeed = contract.panSpeed
  target.zoomSpeed = contract.zoomSpeed
  target.minDistance = contract.minDistance
  target.maxDistance = contract.maxDistance
  target.minPolarAngle = contract.minPolarAngle
  target.maxPolarAngle = contract.maxPolarAngle
  target.screenSpacePanning = contract.screenSpacePanning
}
