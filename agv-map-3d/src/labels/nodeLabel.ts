/*
 * 节点标签定位纯函数（labels 层，SPEC 5.2 / 7.1 / 11.2 / 16）。
 *
 * 信任边界定位（TASK-011）：
 *   - 本模块消费 TASK-005 交付的不可变 SceneNode（坐标已一次性转换到场景系 x/z），
 *     输出该节点的 LabelDescriptor。
 *   - 纯数值逻辑：不创建 Troika Text / Three / React / 浏览器对象，也不读写全局状态。
 *   - 本模块与 edgeLabel 相互独立：节点与边标签的定位公式由两个纯函数分别实现，
 *     禁止用包含隐式类型分支的巨型逻辑合并两套规则（SPEC 11.2 / 任务约束）。
 *
 * 分类不变量（SPEC 11.2 / 任务约束）：
 *   - 每个节点恰有一个标签；普通节点 'node' → kind = 'node'，
 *     work/park/charge → kind = 'operational-node'。
 *   - kind 由 type 派生，不读取不存在的字段（如 showArrow）。
 *   - 运行时校验类型属于已知闭合四类：绕过类型边界注入的未知字面量（warehouse / shelf 等）
 *     以 MAP_ENTITY_INVALID 整体失败，禁止给默认半径、默认类别或默认样式。
 *
 * 锚点公式不变量（SPEC 11.2）：
 *   - Billboard 世界锚点 = (node.x, 0.250, node.z)；坐标只从 SceneNode.position 直接读取，
 *     不做第二次取负、轴交换或平移（场景坐标已在适配层一次性转换完成）。
 *   - 局部屏幕偏移 = (radius × 1.5, -radius × 1.5)，语义为屏幕右下方（配合 anchorX=left、anchorY=top）。
 *   - radius 按节点类型取 SPEC 7.1 固定值；局部偏移是屏幕语义，不预先写成世界坐标偏移。
 *
 * 异常不变量（SPEC 16 / 任务约束）：
 *   - 节点坐标、半径或偏移任一非有限时整体失败：抛出 MAP_GEOMETRY_INVALID，
 *     不返回部分描述符、不跳过节点、不补默认值。
 *
 * 依赖方向（SPEC 3.3）：仅依赖 domain（MapDataError / NodeType / SceneNode）与本层 labelDescriptor。
 */
import { MapDataError, MapErrorCode } from '../domain/mapDataError'
import type { NodeType } from '../domain/mapPrimitives'
import type { SceneNode } from '../domain/sceneMap'
import { LABEL_ANCHOR_Y } from './labelDescriptor'
import type { LabelDescriptor, LabelKind } from './labelDescriptor'

/*
 * SPEC 7.1：节点半径（米），按类型固定。
 *   - 普通节点 node：0.10m。
 *   - work / park / charge：0.15m。
 * 半径决定节点标签的局部屏幕偏移幅度（radius × 1.5）。
 * 与 nodeInstanceData / nodeArrowData / config 同源 SPEC 7.1，各层各自引用同一规格，
 * 不形成第二套语义；分层约束禁止 labels 导入 geometry 或 config。
 */
const NODE_RADIUS_BY_TYPE: Readonly<Record<NodeType, number>> = {
  node: 0.1,
  work: 0.15,
  park: 0.15,
  charge: 0.15,
}

/*
 * SPEC 11.2：节点标签局部屏幕偏移系数 = radius × 1.5。
 * 与节点半径共同决定 Text 相对 Billboard 锚点的屏幕右下方偏移（X 正向 / Y 负向）。
 */
const NODE_LABEL_LOCAL_OFFSET_RATIO = 1.5

/*
 * 节点标签描述符稳定 ID 前缀。
 * 基于实体身份（节点 ID）构造，不依赖数组下标；与边标签 ID 命名空间隔离，保证全集合唯一。
 */
const NODE_LABEL_ID_PREFIX = 'node-label:'

/*
 * 几何层逻辑路径前缀：节点标签错误发生在已转换的 SceneNode 上，不对应原始 JSON path。
 * 用稳定逻辑路径标识失败位置，使测试与诊断可定位，同时不伪造原始响应路径。
 */
const NODE_LABEL_LOGICAL_PATH = 'sceneMap.nodes#label'

/*
 * 构造节点标签错误（SPEC 14.1）。
 * 未知类型用 MAP_ENTITY_INVALID；非有限坐标 / 半径 / 偏移用 MAP_GEOMETRY_INVALID。
 * 整体拒绝，不返回部分描述符；message 含可读中文，便于 overlay 与测试匹配。
 */
function nodeLabelError(
  code: MapErrorCode,
  message: string,
  context?: Readonly<Record<string, unknown>>,
  entityId?: string | null,
): MapDataError {
  return new MapDataError({
    code,
    message,
    jsonPath: NODE_LABEL_LOGICAL_PATH,
    entityId: entityId ?? null,
    context,
  })
}

/*
 * 运行时校验节点类型属于允许的闭合四类集合（SPEC 2.2 / 5.1 / 任务异常路径）。
 *
 * NodeType 在 TypeScript 层是闭合联合，但运行时仍可能被 `as unknown as SceneNode`
 * 绕过边界注入未知字面量（如旧系统残留的 warehouse / shelf）。本函数以类型表自身的
 * key 集合做成员判定，未知类型立即以 MAP_ENTITY_INVALID 整体失败，
 * 禁止给默认半径、默认类别或默认样式（任务“无效半径”异常路径）。
 *
 * 通过本断言后，node.type 在运行时已收敛为已知四类之一，
 * 后续 NODE_RADIUS_BY_TYPE 查找与 nodeLabelKind 派生不会得到意外结果。
 */
function assertKnownNodeType(type: string, nodeId: string): void {
  if (!(type in NODE_RADIUS_BY_TYPE)) {
    throw nodeLabelError(
      MapErrorCode.MAP_ENTITY_INVALID,
      `节点类型 ${type} 不在允许集合 (node|work|park|charge) 中，无法选择半径与标签类别。`,
      { type },
      nodeId,
    )
  }
}

/*
 * 按节点类型派生标签优先级类别（SPEC 11.2 / 任务约束）。
 * 普通节点 'node' → 'node'；work/park/charge → 'operational-node'。
 * 派生只依赖类型字面量，不读取不存在字段。
 */
function nodeLabelKind(type: NodeType): LabelKind {
  return type === 'node' ? 'node' : 'operational-node'
}

/*
 * 节点标签定位纯函数（SPEC 11.2）。
 *
 * 调用方契约：
 *   - 输入是 TASK-005 交付的不可变 SceneNode（坐标已一次性转换、实体语义已校验）。
 *   - 成功返回 LabelDescriptor；失败抛出 MapDataError（整体拒绝，不返回部分描述符）。
 *   - 未知类型 → MAP_ENTITY_INVALID；非有限坐标 / 半径 / 偏移 → MAP_GEOMETRY_INVALID。
 *
 * 定位流水：
 *   1. 运行时类型校验 → 查表得到 radius，派生 kind。
 *   2. 坐标有限性校验（拦截绕过边界的非有限注入）。
 *   3. 世界锚点 = (node.x, 0.250, node.z)（直接读取场景坐标，不做第二次转换）。
 *   4. 局部屏幕偏移 = (radius × 1.5, -radius × 1.5)（屏幕右下方语义）。
 *   5. 半径 / 偏移有限性兜底（捕获未来编辑破坏的非法常量）。
 */
export function buildNodeLabelDescriptor(node: SceneNode): LabelDescriptor {
  // 1. 运行时类型校验：捕获绕过类型边界注入的未知节点类型（SPEC 2.2 / 5.1 / 任务“无效半径”）。
  assertKnownNodeType(node.type, node.id)
  const radius = NODE_RADIUS_BY_TYPE[node.type]
  const kind = nodeLabelKind(node.type)

  // 2. 坐标有限性校验：SceneNode 来自已校验适配层，仍拦截绕过边界的非有限注入
  //    （SPEC 16 / 任务“非有限来源点”异常路径）。任一非有限立即整体失败。
  const sceneX = node.position.x
  const sceneZ = node.position.z
  if (!Number.isFinite(sceneX) || !Number.isFinite(sceneZ)) {
    throw nodeLabelError(
      MapErrorCode.MAP_GEOMETRY_INVALID,
      `节点 ${node.id} 场景坐标含非有限数，无法生成节点标签。`,
      { x: sceneX, z: sceneZ },
      node.id,
    )
  }

  // 3. 局部屏幕偏移 = radius × 1.5（X 正向 / Y 负向，屏幕右下方，SPEC 11.2）。
  //    偏移是屏幕语义（配合 anchorX=left、anchorY=top），不预先写成世界坐标偏移。
  const localOffsetX = radius * NODE_LABEL_LOCAL_OFFSET_RATIO
  const localOffsetY = -radius * NODE_LABEL_LOCAL_OFFSET_RATIO

  // 4. 半径 / 偏移有限性兜底（SPEC 16）：若类型表常量被未来编辑破坏为非有限，
  //    写入的 radius / 偏移会在此被捕获，杜绝非有限数据泄漏到描述符。
  if (
    !Number.isFinite(radius) ||
    !Number.isFinite(localOffsetX) ||
    !Number.isFinite(localOffsetY)
  ) {
    throw nodeLabelError(
      MapErrorCode.MAP_GEOMETRY_INVALID,
      `节点 ${node.id} 标签半径或局部偏移含非有限数。`,
      { radius, localOffsetX, localOffsetY },
      node.id,
    )
  }

  return {
    id: NODE_LABEL_ID_PREFIX + node.id,
    ownerId: node.id,
    kind,
    text: node.name,
    anchorX: sceneX,
    anchorY: LABEL_ANCHOR_Y,
    anchorZ: sceneZ,
    localOffsetX,
    localOffsetY,
  }
}
