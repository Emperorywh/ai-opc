/*
 * 统一键盘导航意图（camera 层，SPEC §12.5 / §16 / 任务约束）。
 *
 * 信任边界定位（TASK-020）：
 *   - 本模块是“物理按键 → 结构化相机意图”与“相机平面平移步长”的纯决策核心：把 SPEC §12.5
 *     的键位映射、平移方向、缩放比例、旋转角度与焦点边界规则集中为可脱离浏览器与 React
 *     单测的纯函数。事件接线和 Three 写入归 app-root 的 MapCameraController，不在本层依赖
 *     React / R3F / 浏览器 API。
 *
 * 键盘意图映射不变量（SPEC §12.5 / 任务约束）：
 *   - 方向键沿相机平面的 right / forward，每次平移当前距离的 5%（KEY_PAN_STEP_RATIO）。
 *   - +/- 按 0.9 / 1.1 比例缩放距离（KEY_ZOOM_IN_FACTOR / KEY_ZOOM_OUT_FACTOR）。
 *   - Q/E 每次绕 target 旋转 5°（KEY_ROTATE_STEP_DEG）。
 *   - Home 执行标准 3/4 复位（具体 fit 由 MapCameraController 复用 applyStandardFit）。
 *   - 其余按键映射为 none：未消费按键不得触发渲染或阻止默认行为。
 *
 * 平移方向不变量（SPEC §12.5 / 任务“平移方向必须来自当前相机平面，不能写死世界轴”）：
 *   - 平移基准向量由调用方从当前相机姿态（camera.quaternion）提取后传入；本函数只负责把
 *     right / forward 投影到地面平面（Y = 0）并按 5% 距离归一化为世界 XZ 步长。
 *   - 不得在此处写死 +X / +Z；水平投影退化为零（近乎正俯视）时返回 null，调用方不提交。
 *
 * 焦点边界与默认行为抑制不变量（SPEC §12.5 / 任务约束）：
 *   - decideKeyConsumption 把“是否来自可编辑控件”作为显式入参：来自 input / textarea /
 *     contenteditable 的按键一律不消费，避免劫持页面文本输入。
 *   - 容器是否拥有焦点由事件接线层（MapCameraController）依据 document.activeElement 判定，
 *     本函数只表达“键位 + 可编辑来源 → 是否消费 + 意图”，保持纯函数可单测。
 *
 * 状态复用不变量（SPEC §12.5 / 任务“所有键盘操作复用 controls 的 clamp 与 near/far 更新函数”）：
 *   - 本模块只产出意图与步长，不复制 target clamp / fit / near-far / 矩阵计算；具体相机写入
 *     由 MapCameraController 复用 commitCameraState / controls.update / applyStandardFit 完成。
 *
 * 无效输入不变量（SPEC §16 / 任务约束）：
 *   - 非有限距离、零水平投影等退化输入返回 null，调用方保持未提交，禁止产生 NaN / Infinity。
 *
 * 依赖方向（SPEC 3.3）：仅依赖 camera（cameraFit 的 Vec3 类型），是纯函数；
 *   不依赖 Three 运行时 / R3F / React / 浏览器 API。
 */
import type { Vec3 } from './cameraFit'

/*
 * SPEC §12.5：方向键每次平移当前距离的比例（5%）。
 * 步长 = 当前 camera-target 距离 × KEY_PAN_STEP_RATIO。
 */
export const KEY_PAN_STEP_RATIO = 0.05

/*
 * SPEC §12.5：+ 键缩放比例（距离 × 0.9，靠近 = 放大）。
 */
export const KEY_ZOOM_IN_FACTOR = 0.9

/*
 * SPEC §12.5：- 键缩放比例（距离 × 1.1，远离 = 缩小）。
 */
export const KEY_ZOOM_OUT_FACTOR = 1.1

/*
 * SPEC §12.5：Q / E 每次绕 target 旋转的角度（度）。
 * Q = 向左（逆时针，俯视），E = 向右（顺时针，俯视）。
 */
export const KEY_ROTATE_STEP_DEG = 5

/*
 * 方向键平移基准轴：right = 相机右轴；forward = 相机前向（视线方向）。
 */
export type PanAlong = 'right' | 'forward'

/*
 * 方向键平移方向符号：+1 = 右 / 前；-1 = 左 / 后。
 */
export type PanSign = -1 | 1

/*
 * 方向键平移意图（SPEC §12.5）。along 决定相机平面基准轴，sign 决定方向。
 */
export interface PanIntent {
  readonly kind: 'pan'
  readonly along: PanAlong
  readonly sign: PanSign
}

/*
 * +/- 缩放意图（SPEC §12.5）。factor 为距离乘数（0.9 靠近 / 1.1 远离）。
 */
export interface ZoomIntent {
  readonly kind: 'zoom'
  readonly factor: number
}

/*
 * Q/E 旋转意图（SPEC §12.5）。deltaRadians 为方位角增量（正 = 左 / 逆时针，俯视）。
 */
export interface RotateIntent {
  readonly kind: 'rotate'
  readonly deltaRadians: number
}

/*
 * 结构化键盘意图（SPEC §12.5）。
 *
 * 字段语义：
 *   - none：未消费按键（不触发渲染、不阻止默认行为）。
 *   - pan：方向键平移，along 决定基准轴、sign 决定方向。
 *   - zoom：+/- 缩放，factor 为距离乘数（0.9 / 1.1）。
 *   - rotate：Q/E 绕 target 旋转，deltaRadians 为方位角增量（正 = 左 / 逆时针）。
 *   - home：Home 复位，由调用方执行标准 3/4 fit。
 */
export type KeyboardIntent =
  | { readonly kind: 'none' }
  | PanIntent
  | ZoomIntent
  | RotateIntent
  | { readonly kind: 'home' }

/*
 * 把 SPEC §12.5 的旋转步长（度）换算为弧度，供 Q/E 意图与调用方共用同一来源。
 */
export function rotateStepRadians(): number {
  return (KEY_ROTATE_STEP_DEG * Math.PI) / 180
}

/*
 * 物理按键 → 结构化意图（SPEC §12.5）。
 *
 * 采用 event.key 逻辑字符判定（布局相关但语义直观）：
 *   - ArrowLeft / ArrowRight：沿相机 right 轴左右平移。
 *   - ArrowUp / ArrowDown：沿相机 forward 轴前后平移。
 *   - '+' / '='：缩放靠近（+ 在多数布局需 Shift，'=' 为同键未 Shift 形态，一并接受）。
 *   - '-' / '_'：缩放远离（'_' 为同键 Shift 形态，一并接受）。
 *   - 'q' / 'Q'：向左旋转（方位角 +5°）。
 *   - 'e' / 'E'：向右旋转（方位角 -5°）。
 *   - 'Home'：标准复位。
 *   - 其余：none。
 *
 * 纯函数：不接触事件对象或 DOM，只消费字符串，可在 node 环境单测。
 */
export function interpretKey(key: string): KeyboardIntent {
  switch (key) {
    case 'ArrowLeft':
      return { kind: 'pan', along: 'right', sign: -1 }
    case 'ArrowRight':
      return { kind: 'pan', along: 'right', sign: 1 }
    case 'ArrowUp':
      return { kind: 'pan', along: 'forward', sign: 1 }
    case 'ArrowDown':
      return { kind: 'pan', along: 'forward', sign: -1 }
    case '+':
    case '=':
      return { kind: 'zoom', factor: KEY_ZOOM_IN_FACTOR }
    case '-':
    case '_':
      return { kind: 'zoom', factor: KEY_ZOOM_OUT_FACTOR }
    case 'q':
    case 'Q':
      // Q 向左：方位角正向（逆时针，俯视），调用方 controls.rotateLeft(+step)。
      return { kind: 'rotate', deltaRadians: rotateStepRadians() }
    case 'e':
    case 'E':
      // E 向右：方位角负向（顺时针，俯视），调用方 controls.rotateLeft(-step)。
      return { kind: 'rotate', deltaRadians: -rotateStepRadians() }
    case 'Home':
      return { kind: 'home' }
    default:
      return { kind: 'none' }
  }
}

/*
 * 键位消费决策入参（SPEC §12.5 / 任务“焦点边界与默认行为抑制范围”）。
 *   - key：event.key 字符串。
 *   - isFromEditableTarget：按键是否来自 input / textarea / contenteditable 等可编辑控件，
 *     由事件接线层从 DOM 提取后传入；true 时一律不消费，避免劫持页面文本输入。
 */
export interface KeyConsumptionInput {
  readonly key: string
  readonly isFromEditableTarget: boolean
}

/*
 * 键位消费决策结果：consume = 是否消费并阻止默认行为；intent = 对应相机意图。
 * consume = false 时调用方不得 preventDefault、不得触发渲染。
 */
export interface KeyConsumptionDecision {
  readonly consume: boolean
  readonly intent: KeyboardIntent
}

/*
 * 键位消费决策（SPEC §12.5 / 任务约束）。
 *
 * 焦点边界不变量：
 *   - 容器是否拥有焦点由事件接线层判定（document.activeElement），本函数不重复该判定；
 *     但可编辑控件来源在此显式拒绝，保证“输入来自其他可编辑控件”时不消费。
 *   - 未知键映射为 none → 不消费；已知键 + 非可编辑来源 → 消费。
 *
 * 默认行为抑制范围：
 *   - 仅 consume = true 时调用方才 preventDefault；否则放行浏览器默认行为，不劫持全局键盘。
 */
export function decideKeyConsumption(
  input: KeyConsumptionInput,
): KeyConsumptionDecision {
  // 可编辑控件来源：一律不消费，避免劫持文本输入（任务异常路径）。
  if (input.isFromEditableTarget) {
    return { consume: false, intent: { kind: 'none' } }
  }
  const intent = interpretKey(input.key)
  return { consume: intent.kind !== 'none', intent }
}

/*
 * 相机平面平移步长推导入参（SPEC §12.5）。
 *   - cameraRight：相机右轴（局部 +X 经 camera.quaternion 旋转后的世界向量）。
 *   - cameraForward：相机前向（局部 -Z 经 camera.quaternion 旋转后的世界向量，即视线方向）。
 *   - distance：当前 camera-target 距离（米）。
 *   - along / sign：方向键选择的基准轴与方向。
 */
export interface KeyboardPanInput {
  readonly cameraRight: Vec3
  readonly cameraForward: Vec3
  readonly distance: number
  readonly along: PanAlong
  readonly sign: PanSign
}

/*
 * 地面平面（XZ）平移步长（米）。
 */
export interface KeyboardPanOffset {
  readonly dx: number
  readonly dz: number
}

/*
 * 把相机平面 right / forward 投影到地面平面并按当前距离的 5% 推导平移步长（SPEC §12.5）。
 *
 * 平移方向不变量：
 *   - 基准轴由调用方从当前相机姿态传入，本函数投影到 Y = 0 并归一化，保证平移沿地面、
 *     不写死世界轴、不抬升 target.y（target.y 由 commitCameraState 锁回 0）。
 *   - 步长 = distance × KEY_PAN_STEP_RATIO × sign；正负号由方向键决定。
 *
 * 无效输入不变量：distance 非有限 / 非正、或基准轴水平投影长度 < 1e-9（近乎正俯视）时
 *   返回 null，调用方保持未提交，禁止产生 NaN / Infinity 或零向量平移。
 */
export function computeKeyboardPanOffset(
  input: KeyboardPanInput,
): KeyboardPanOffset | null {
  const { distance, along, sign } = input
  // 距离必须为正有限数；否则不提交（禁止 NaN / 负步长）。
  if (!Number.isFinite(distance) || !(distance > 0)) return null

  // 选择基准轴并取其地面平面分量（Y = 0）。
  const src = along === 'right' ? input.cameraRight : input.cameraForward
  let bx = src.x
  let bz = src.z
  const horizLen = Math.hypot(bx, bz)
  // 水平投影退化（相机近乎垂直俯视）时无可用平移方向：不提交。
  if (!Number.isFinite(horizLen) || horizLen < 1e-9) return null

  // 归一化为地面单位方向，乘以 5% 距离与方向符号。
  bx /= horizLen
  bz /= horizLen
  const step = distance * KEY_PAN_STEP_RATIO * sign
  return { dx: bx * step, dz: bz * step }
}
