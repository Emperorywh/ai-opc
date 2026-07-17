/*
 * 标签按需帧协调纯逻辑（scene 装配层的纯核心，SPEC 11.3 第 8 项 / 11.4 / 13 / 任务约束）。
 *
 * 信任边界定位（TASK-022）：
 *   - 本模块是“相机逐帧状态 → 是否查询可见集 + 朝向写入”的纯决策核心，集中两类时序决策：
 *       1. 把相机逐帧运动映射为可见集调度事件（controls-change / controls-end / resize），
 *          复用 TASK-021 的 decideVisibilityQuery（10Hz 节流 / end 与 resize 立即）。
 *       2. 把 camera quaternion 与标签局部屏幕偏移推导为 Text 的逐帧世界位姿（billboard）。
 *   - 纯函数：不接触 R3F / OrbitControls / DOM / 全局可变状态；时钟显式传入（nowMs），
 *     camera 数值（位置 / 四元数 / 画布尺寸）由调用方从 useThree 提取后传入，保证确定性可单测。
 *
 * 运动映射不变量（SPEC 11.3 第 8 项 / 任务“demand 调度显式可推导”）：
 *   - 相机相对上一帧发生位移 → 'controls-change'（受 10Hz 节流）。
 *   - 相机本帧未位移、但上一帧仍在位移 → 'controls-end'（手势 / 惯性刚结束，立即查询不被节流吞掉）。
 *   - 否则（持续静止）→ 无事件、不查询；demand 帧模式下持续静止不产生帧、不持续提交（SPEC §15.5）。
 *   - resize：画布尺寸变化 → 'resize'（立即查询，独立于运动判定）。
 *   - 该映射在帧协调器内消费 OrbitControls 实际产生的渲染帧：controls 持续 change / damping 期间
 *     相机逐帧位移 → 'controls-change'；当本帧位姿变化已低于 OrbitControls 的 'change' 派发阈值
 *     （即 OrbitControls 不再派发 'change'，demand 模式下该帧即为最后被调度的一帧）时判定为静止，
 *     若上一帧仍在位移则产出 'controls-end'。运动阈值与 OrbitControls 对齐是闭合本映射的根因
 *     （见 signaturesDiffer 注释）；位移阈值取大（1e-3 量级）而非 1e-9，使“OrbitControls 不再
 *     派发 change 的首帧”即被判定为静止并由上一帧 'change' → invalidate 调度，从而产出
 *     'controls-end' 立即查询。等价于订阅 controls 的 'change' / 'end' 事件，但无需把
 *     OrbitControls 暴露给标签层（任务“不得把 Three 可变对象暴露为全局状态”、不形成 controls 跨层耦合）。
 *
 * 字体门禁接入不变量（SPEC 11.1 / 4.2 / 任务约束）：
 *   - planLabelFrame 接受 fontReady 显式参数；fontReady = false 时不产出任何查询计划，
 *     调用方据此跳过可见集计算与文字挂载，字体门禁失败信号不产生任何部分标签。
 *
 * 差量挂载不变量（SPEC 11.3 第 7 项 / 任务约束）：
 *   - applyVisibilityTarget 只在目标集合与当前已挂载集合不同时返回 changed = true；
 *     调用方据此决定是否 setMountedIds + invalidate，避免无变化时的多余 React 重渲染与帧请求。
 *   - 实际 create / destroy Text 的差量由 React 按 key 调和对 targetIds 完成，
 *     不重建整个列表、不预创建隐藏 Text（SPEC 11.3 第 7 项 / 任务约束）。
 *
 * billboard 位姿不变量（SPEC 11.4 / 11.2 / 任务约束）：
 *   - Text quaternion 逐帧批量复制 camera world quaternion（始终面向相机）。
 *   - Text world position = 世界锚点 + cameraRight × localOffsetX + cameraUp × localOffsetY：
 *     localOffset 是屏幕语义（节点标签屏幕右下方、边标签 0），只有沿相机右轴 / 上轴偏移才正确表达
 *     “屏幕右下方”，禁止用固定世界 +X/+Y 当屏幕方向（SPEC 11.2 / 11.4 / 任务约束）。
 *
 * 退化不变量（SPEC 16 / 任务约束）：
 *   - 相机位姿非有限时，readCameraSignature 返回 null；planLabelFrame 对 null 签名不查询、
 *     不产出朝向写入，调用方跳过本帧，禁止 NaN 进入可见集或 Text 位姿。
 *
 * 依赖方向（SPEC 3.3）：three（Vector3 / Quaternion 纯数学，scene 允许）+ labels（调度器 / 描述符 /
 *   相机输入类型）；不依赖 R3F / troika / DOM / 全局状态。
 */
import { Quaternion, Vector3 } from 'three'
import type { LabelDescriptor } from '../labels/labelDescriptor'
import type { LabelCameraInput } from '../labels/labelProjection'
import {
  decideVisibilityQuery,
  initialVisibilitySchedulerState,
} from '../labels/labelVisibilityScheduler'
import type {
  VisibilitySchedulerState,
  VisibilityQueryEvent,
} from '../labels/labelVisibilityScheduler'

/*
 * 相机位姿签名：位置 + 世界四元数，用于逐帧比较判定相机是否位移。
 * 全部为有限数时有效；readCameraSignature 对非有限位姿返回 null。
 */
export interface CameraSignature {
  readonly px: number
  readonly py: number
  readonly pz: number
  readonly qx: number
  readonly qy: number
  readonly qz: number
  readonly qw: number
}

/*
 * 画布尺寸签名（CSS 像素），用于 resize 判定。
 */
export interface CanvasSize {
  readonly width: number
  readonly height: number
}

/*
 * 帧协调器可变状态（调用方以唯一实例持有，每次决策接收新状态）。
 *   - prevSignature：上一帧相机签名（null 表示首帧，首帧必然视为位移以触发首次查询）。
 *   - wasMoving：上一帧是否仍在位移（用于位移刚结束时产出 'controls-end'）。
 *   - scheduler：可见集调度器状态（复用 TASK-021，10Hz 节流时钟的唯一持有）。
 *   - prevSize：上一帧画布尺寸（null 表示尚未观测，首帧必然视为 resize 以触发首次查询）。
 */
export interface LabelCoordinatorState {
  prevSignature: CameraSignature | null
  wasMoving: boolean
  scheduler: VisibilitySchedulerState
  prevSize: CanvasSize | null
}

/*
 * 单帧决策计划。
 *   - shouldQuery：本帧是否应执行一次可见集查询（调用方据此计算可见集并更新挂载集合）。
 *   - state：决策后的新协调器状态（无论是否查询，调用方都应持有新状态）。
 *   - invalidate：本帧是否应在完成朝向写入后显式请求一次 demand 帧。
 *     首帧 / resize / 字体刚就绪等无位移但需确保首屏正确的情形下为 true。
 */
export interface LabelFramePlan {
  readonly shouldQuery: boolean
  readonly state: LabelCoordinatorState
  readonly invalidate: boolean
}

/*
 * 相机位姿“是否仍在位移”判定阈值，刻意与 OrbitControls（three 0.185.1）的 'change' 派发阈值对齐。
 *
 * OrbitControls.update() 仅在下列任一成立时派发 'change'（其内部 _EPS = 1e-6）：
 *   - 位置：_lastPosition.distanceToSquared(camera.position) > 1e-6  → 3D 距离 > 1e-3 m
 *   - 朝向：8 * (1 - _lastQuaternion.dot(camera.quaternion)) > 1e-6  → 半角小角近似下 > 1e-3 rad
 * 本协调器用同一组阈值判定“相机相对上一帧是否仍在位移”。这样判定结果与 OrbitControls 是否仍会
 * 派发 'change' 一致：当本帧位姿变化低于阈值时，OrbitControls 也不会再派发 'change'，demand 模式下
 * 该帧即为由上一帧 'change' → commitCameraState → invalidate 调度的“最后会被运行的一帧”。在此帧
 * 观察到 wasMoving && !isMoving → 产出 'controls-end' 立即查询，闭合 SPEC §11.3 第 8 项“end 后立即
 * 更新一次”不变量（TASK-022 根因修复）。
 *
 * 为何不取更小的 1e-9：OrbitControls 在 3D 距离 < 1e-3 时即停止派发 'change'，但 damping 尾段每帧
 * 残余位移仍可达 ~1e-4~1e-3（>>1e-9）。若阈值取 1e-9，协调器会把这种尾段残余误判为“仍在位移”，
 * 而 demand 模式下尾段帧不再被调度，协调器永远观察不到 wasMoving && !isMoving 的终止帧，
 * 'controls-end' 形同死代码（TASK-022 上一轮反馈的 MEDIUM 缺口）。阈值对齐到 OrbitControls 后，
 * 尾段首帧即被判定为静止并产出 'controls-end'，且 < 1e-3 的残余位移在任意合理缩放下均不足 1 像素，
 * 不会触发 10/8px 迟滞下的标签进出（SPEC 11.3 第 5 项），语义安全。
 */
const POSITION_MOVE_EPSILON_SQ = 1e-6 // 位置 3D 距离平方阈值，与 OrbitControls distanceToSquared 同口径
const QUATERNION_MOVE_EPSILON = 1e-6 // 用于 8 * (1 - dot) 形式，与 OrbitControls 朝向判定同口径

/*
 * 帧协调器初始状态。
 * prevSignature / prevSize 为 null 使首帧必然视为位移 + resize，触发首次可见集查询；
 * scheduler 初始 lastQueryMs = -∞ 使首个 'controls-change' 必然通过 10Hz 节流（SPEC 11.3 第 8 项）。
 */
export function initialLabelCoordinatorState(): LabelCoordinatorState {
  return {
    prevSignature: null,
    wasMoving: false,
    scheduler: initialVisibilitySchedulerState(),
    prevSize: null,
  }
}

/*
 * 从显式相机数值提取位姿签名（调用方从 Three camera 提取后传入）。
 * 任一分量非有限时返回 null（退化位姿，本帧跳过决策）。
 */
export function makeCameraSignature(
  px: number, py: number, pz: number,
  qx: number, qy: number, qz: number, qw: number,
): CameraSignature | null {
  if (
    !Number.isFinite(px) || !Number.isFinite(py) || !Number.isFinite(pz) ||
    !Number.isFinite(qx) || !Number.isFinite(qy) || !Number.isFinite(qz) || !Number.isFinite(qw)
  ) {
    return null
  }
  return { px, py, pz, qx, qy, qz, qw }
}

/*
 * 判定两个相机签名是否“仍在位移”（位置 3D 距离平方 + 朝向 8*(1-dot)）。
 *
 * 阈值与 OrbitControls 的 'change' 派发阈值对齐（POSITION_MOVE_EPSILON_SQ / QUATERNION_MOVE_EPSILON），
 * 故 signaturesDiffer(prev, current) === false ⟺ “本帧位姿变化已不足以让 OrbitControls 再派发 'change'”。
 * 任一为 null 视为仍在位移（首帧 prevSignature = null → 视为位移，触发首次查询）。
 *
 * 位置用 3D 距离平方（而非逐分量 abs）：OrbitControls 用 distanceToSquared 判定，逐分量 abs 会在
 * 位移均匀分摊到三分量时（各分量 < 阈值但合成 > 阈值）与 OrbitControls 不一致；同口径判定保证
 * 协调器的“静止”与 OrbitControls“不再 change”完全对齐，是闭合 controls-end 的根因。
 */
function signaturesDiffer(a: CameraSignature | null, b: CameraSignature): boolean {
  if (a === null) return true
  const dpx = a.px - b.px
  const dpy = a.py - b.py
  const dpz = a.pz - b.pz
  if (dpx * dpx + dpy * dpy + dpz * dpz > POSITION_MOVE_EPSILON_SQ) return true
  // 四元数点积：连续相机运动中 q 与 -q 不发生半球翻转，dot 与 OrbitControls 同口径；
  // 8*(1-dot) 在小角下 ≈ Δangle²，与位置距离平方同量级。
  const dot = a.qx * b.qx + a.qy * b.qy + a.qz * b.qz + a.qw * b.qw
  return 8 * (1 - dot) > QUATERNION_MOVE_EPSILON
}

/*
 * 把“相机是否位移”映射为可见集调度事件（SPEC 11.3 第 8 项）。
 *   - 本帧位移 → 'controls-change'（10Hz 节流）。
 *   - 本帧未位移但上一帧位移 → 'controls-end'（立即查询，确保手势 / 惯性末态不漏）。
 *   - 持续静止 → null（不查询、不产出事件）。
 */
function motionEvent(isMoving: boolean, wasMoving: boolean): VisibilityQueryEvent | null {
  if (isMoving) return 'controls-change'
  if (wasMoving) return 'controls-end'
  return null
}

/*
 * 帧协调器主决策（SPEC 11.3 第 8 项 / 11.4 / 任务约束）。
 *
 * 调用方契约：
 *   - state 为上次决策返回的新状态（唯一持有）；currentSignature 为本帧相机签名（null 则跳过）。
 *   - size 为本帧画布尺寸；nowMs 为当前单调时钟（毫秒，显式传入）。
 *   - fontReady 为字体门禁是否通过；false 时不产出查询计划（不挂载任何标签）。
 *
 * 决策（确定性，相同时钟与位姿得到完全相同计划）：
 *   1. 字体未就绪 → 不查询、invalidate=false（不挂载标签、不请求帧）。
 *   2. 退化位姿（currentSignature=null）→ 不查询、保留状态、invalidate=false。
 *   3. resize：画布尺寸变化 → 'resize' 立即查询（独立于运动）；首帧 prevSize=null 视为 resize。
 *   4. 运动：位移 → 'controls-change'（10Hz 节流）；位移刚结束 → 'controls-end'（立即）。
 *   5. 把上述事件喂给 decideVisibilityQuery；shouldQuery 由其节流决定。
 *   6. invalidate：首帧（prevSignature=null）或 resize 或 shouldQuery 时为 true，
 *      确保 demand 帧模式下首屏与尺寸变化后必有一次渲染。
 */
export function planLabelFrame(params: {
  readonly state: LabelCoordinatorState
  readonly currentSignature: CameraSignature | null
  readonly size: CanvasSize
  readonly nowMs: number
  readonly fontReady: boolean
}): LabelFramePlan {
  const { state, currentSignature, size, nowMs, fontReady } = params

  // 字体门禁未通过：不查询、不请求帧（任务“失败信号不产生任何部分标签”）。
  if (!fontReady) {
    return { shouldQuery: false, state, invalidate: false }
  }
  // 退化位姿：保留状态、不查询、不请求帧（禁止 NaN 进入可见集）。
  if (currentSignature === null) {
    return { shouldQuery: false, state, invalidate: false }
  }

  const isFirstFrame = state.prevSignature === null
  let scheduler = state.scheduler
  let shouldQuery = false
  let invalidate = false

  // resize：尺寸变化（含首帧 prevSize=null）→ 'resize' 立即查询（SPEC 11.3 第 8 项）。
  const sizeChanged =
    state.prevSize === null ||
    state.prevSize.width !== size.width ||
    state.prevSize.height !== size.height
  if (sizeChanged) {
    const d = decideVisibilityQuery(scheduler, 'resize', nowMs)
    scheduler = d.state
    if (d.shouldQuery) shouldQuery = true
    invalidate = true
  }

  // 运动映射：位移 → change（10Hz）、位移刚结束 → end（立即）、持续静止 → 无（SPEC 11.3 第 8 项）。
  const isMoving = signaturesDiffer(state.prevSignature, currentSignature)
  const event = motionEvent(isMoving, state.wasMoving)
  if (event !== null) {
    const d = decideVisibilityQuery(scheduler, event, nowMs)
    scheduler = d.state
    if (d.shouldQuery) shouldQuery = true
  }

  // 首帧必然 invalidate：确保 demand 帧模式下首屏可见集计算后有一次渲染。
  if (isFirstFrame) invalidate = true

  const nextState: LabelCoordinatorState = {
    prevSignature: currentSignature,
    wasMoving: isMoving,
    scheduler,
    prevSize: size,
  }
  return { shouldQuery, state: nextState, invalidate }
}

/*
 * 应用可见集目标到当前已挂载集合（SPEC 11.3 第 7 项）。
 *
 * - 只在目标与当前已挂载不同时返回 changed = true；调用方据此决定是否 setMountedIds + invalidate。
 * - 实际 create / destroy Text 的差量由 React 按 key 调和对 nextMounted 完成（不重建整个列表）。
 * - 目标集合已被可见集截断到 LABEL_MAX_MOUNTED(400)，故 nextMounted.length 恒 <= 400。
 */
export function applyVisibilityTarget(
  currentMounted: readonly string[],
  targetIds: readonly string[],
): { readonly nextMounted: readonly string[]; readonly changed: boolean } {
  if (currentMounted.length !== targetIds.length) {
    return { nextMounted: targetIds, changed: true }
  }
  for (let i = 0; i < targetIds.length; i++) {
    if (currentMounted[i] !== targetIds[i]) {
      return { nextMounted: targetIds, changed: true }
    }
  }
  return { nextMounted: currentMounted, changed: false }
}

/*
 * 计算单个标签 Text 的逐帧世界位姿（SPEC 11.4 / 11.2）。
 *
 * - quaternion = camera world quaternion（始终面向相机）。
 * - position = 世界锚点 + cameraRight × localOffsetX + cameraUp × localOffsetY（屏幕语义偏移）。
 *   cameraRight / cameraUp 由 camera quaternion 把局部 +X / +Y 旋转到世界系得到。
 *
 * 返回位置数组与四元数数组，供协调器批量写入 Text 对象（不触发 React setState）。
 */
export function computeLabelTextTransform(
  cameraWorldQuaternion: { readonly x: number; readonly y: number; readonly z: number; readonly w: number },
  descriptor: LabelDescriptor,
): {
  readonly position: readonly [number, number, number]
  readonly quaternion: readonly [number, number, number, number]
} {
  const q = new Quaternion(cameraWorldQuaternion.x, cameraWorldQuaternion.y, cameraWorldQuaternion.z, cameraWorldQuaternion.w)
  // cameraRight = 局部 +X 经世界四元数旋转；cameraUp = 局部 +Y 经世界四元数旋转。
  const right = new Vector3(1, 0, 0).applyQuaternion(q)
  const up = new Vector3(0, 1, 0).applyQuaternion(q)
  const ox = descriptor.localOffsetX
  const oy = descriptor.localOffsetY
  return {
    position: [
      descriptor.anchorX + right.x * ox + up.x * oy,
      descriptor.anchorY + right.y * ox + up.y * oy,
      descriptor.anchorZ + right.z * ox + up.z * oy,
    ],
    quaternion: [cameraWorldQuaternion.x, cameraWorldQuaternion.y, cameraWorldQuaternion.z, cameraWorldQuaternion.w],
  }
}

/*
 * 从 Three 相机的矩阵构建 LabelCameraInput（列主序 view-projection + 世界四元数 + 画布尺寸）。
 *
 * 调用方在查询可见集前调用本函数，把 R3F camera + size 适配为 labels 层纯函数消费的数值输入；
 * 与 labelProjection 的列主序矩阵与四元数约定一致。调用方需保证 camera 矩阵已更新（updateMatrixWorld）。
 */
export function buildLabelCameraInput(params: {
  readonly projectionMatrix: ReadonlyArray<number>
  readonly matrixWorldInverse: ReadonlyArray<number>
  readonly quaternion: { readonly x: number; readonly y: number; readonly z: number; readonly w: number }
  readonly size: CanvasSize
}): LabelCameraInput {
  const { projectionMatrix, matrixWorldInverse, quaternion, size } = params
  // view-projection = P × V（列主序，Three Matrix4.multiplyMatrices(elements = P × V)）。
  const vp = multiplyMatrix4(projectionMatrix, matrixWorldInverse)
  return {
    viewProjectionMatrix: vp,
    cameraWorldQuaternion: [quaternion.x, quaternion.y, quaternion.z, quaternion.w],
    canvasWidthPx: size.width,
    canvasHeightPx: size.height,
  }
}

/*
 * 列主序 4×4 矩阵乘法 C = A × B（Three Matrix4.multiplyMatrices 同约定，elements[col*4+row]）。
 * 与 labelVisibilitySet.test 的 mul4 同口径，保证 VP 矩阵与纯投影数学一致。
 */
function multiplyMatrix4(a: ReadonlyArray<number>, b: ReadonlyArray<number>): number[] {
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
