/*
 * 标签描述符类型与共享常量（labels 层，SPEC 5.2 / 7.1 / 11.2 / 11.3 / 16）。
 *
 * 信任边界定位（TASK-011）：
 *   - 本模块定义 LabelDescriptor：节点与边标签的轻量、不可变、与渲染技术无关的描述符，
 *     以及标签描述符集合 LabelDescriptorCollection。
 *   - 描述符只承载稳定 ID、所有者 ID、优先级类别、原始文本、世界锚点与局部屏幕偏移；
 *     不创建 Troika Text、Three 对象、React 状态、空间索引或相机可见集（SPEC 11 / 任务约束）。
 *   - 标签不参与内容 bounds 或地面尺寸计算（SPEC 11.2 / 12.1）：本模块不输出任何 bounds。
 *
 * 类别契约（SPEC 11.2 / 11.3 / 任务约束）：
 *   - kind 为 'operational-node' | 'node' | 'edge'，是后续可见集排序与 Troika 文本对齐的唯一键。
 *   - 可见集截断优先级（SPEC 11.3 第 6 项）：'operational-node'（work/park/charge）最高、
 *     'node'（普通节点）次之、'edge' 最低；同级再按屏幕距离、ID 字典序截断。
 *   - Troika 文本对齐由 kind 派生（渲染层消费本契约）：
 *       node / operational-node → anchorX = 'left'、anchorY = 'top'（屏幕右下方）。
 *       edge                     → anchorX = 'center'、anchorY = 'top'。
 *
 * 依赖方向（SPEC 3.3）：仅依赖本层自身，无内部依赖；不依赖 React / Three / Troika / 浏览器 API。
 */

/*
 * SPEC 7.1：Label Anchor Y（米）。节点与边标签的世界锚点 Y 固定 0.250m，
 * 位于节点箭头 Y（0.066）之上，使标签悬浮于所有实体之上。
 * 与 config 视觉常量同源 SPEC 7.1，两层各自引用同一规格，不形成第二套语义。
 */
export const LABEL_ANCHOR_Y = 0.25

/*
 * 标签优先级类别（SPEC 5.2 LabelDescriptor.kind / 11.3 可见集截断顺序）。
 *
 * 字面量语义：
 *   - 'operational-node'：work/park/charge 节点标签，可见集截断优先级最高。
 *   - 'node'：普通节点标签，次高。
 *   - 'edge'：边标签，最低。
 * 本类型只表达类别；截断与文本对齐由后续可见集层与渲染层按本契约实现。
 */
export type LabelKind = 'operational-node' | 'node' | 'edge'

/*
 * 不可变标签描述符（SPEC 5.2 LabelDescriptor）。
 *
 * 字段语义：
 *   - id：标签自身稳定 ID，基于实体身份构造（节点 / 边 ID + 类别前缀），禁止使用数组下标。
 *   - ownerId：所属实体 ID（节点或边）；描述符与实体一一对应。
 *   - kind：优先级类别，决定可见集截断顺序与 Troika 文本对齐（见模块头类别契约）。
 *   - text：原始 Unicode 名称，保持原样，不截断、不转码、不格式化数值名称。
 *   - anchorX/Y/Z：标签 Billboard 世界锚点。节点为节点中心 (x, 0.250, z)；
 *     边为车道偏移后来源点 + 场景平面固定偏移 (x+0.20, 0.250, z+0.20)。
 *   - localOffsetX/Y：Text 局部屏幕偏移。节点为 (radius×1.5, -radius×1.5)（屏幕右下方）；
 *     边为 (0, 0)（平面偏移已烘焙进世界锚点）。
 *
 * 稳定性不变量：
 *   - 同一输入重复构建，id、全部数值与描述符顺序完全一致。
 *   - 所有数值必须为有限数；任一非有限由构建方整体拒绝，不输出部分描述符。
 */
export interface LabelDescriptor {
  readonly id: string
  readonly ownerId: string
  readonly kind: LabelKind
  readonly text: string
  readonly anchorX: number
  readonly anchorY: number
  readonly anchorZ: number
  readonly localOffsetX: number
  readonly localOffsetY: number
}

/*
 * 标签描述符集合与诊断计数（SPEC 5.2 SceneModel.labels /
 * SceneDiagnostics.labelCandidateCount）。
 *
 * 字段语义：
 *   - descriptors：全部标签描述符的只读数组，顺序固定为“节点标签（输入 nodes 顺序）+
 *     边标签（输入 edges 顺序）”，重复构建完全稳定。
 *   - labelCandidateCount：候选标签总数（真实样本固定 4810 = 1767 节点 + 3043 边），
 *     与 descriptors.length 交叉一致。
 *
 * 不变量：本集合不携带任何 bounds；标签锚点不进入内容 bounds 或地面尺寸计算（SPEC 11.2 / 12.1）。
 */
export interface LabelDescriptorCollection {
  readonly descriptors: readonly LabelDescriptor[]
  readonly labelCandidateCount: number
}
