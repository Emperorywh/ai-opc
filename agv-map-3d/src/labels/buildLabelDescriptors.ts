/*
 * 标签描述符编排（labels 层，SPEC 4.1 / 5.2 / 11.2 / 16）。
 *
 * 信任边界定位（TASK-011）：
 *   - 本模块是 (nodes + edges + edgeLaneOffsets) → LabelDescriptorCollection 的唯一编排入口。
 *   - 节点标签与边标签分别调用各自纯函数（buildNodeLabelDescriptor / buildEdgeLabelDescriptor），
 *     两套定位公式互不合并，无隐式类型分支（SPEC 11.2 / 任务约束）。
 *   - 输出顺序固定为“节点标签（输入 nodes 顺序）+ 边标签（输入 edges 顺序）”，
 *     重复构建完全稳定，可供后续空间索引与可见集确定性消费。
 *
 * 车道偏移复用不变量（SPEC 9.3 / 11.2 / 任务约束）：
 *   - edgeLaneOffsets 提供“边 ID → laneOffset 标量”映射，由上层从 TASK-006 的 TrackModel 提取；
 *     本模块不重新判断轨迹是否重合，也不导入 geometry（分层约束禁止 labels → geometry）。
 *   - 每条边必须在映射中有对应 laneOffset；缺失视为车道数据不一致，整体失败（任务“无法对应所有者”异常）。
 *
 * 内容 bounds 隔离不变量（SPEC 11.2 / 12.1）：
 *   - 本模块不输出任何 bounds；标签锚点不进入内容 bounds 或地面尺寸计算。
 *
 * 异常不变量（SPEC 16 / 任务约束）：
 *   - 任一节点 / 边标签构建失败时整体拒绝，不返回部分描述符、不跳过实体、不补默认值。
 *
 * 依赖方向（SPEC 3.3）：仅依赖 domain（MapDataError / SceneNode / SceneEdge）与本层
 * （labelDescriptor / nodeLabel / edgeLabel）。
 */
import { MapDataError, MapErrorCode } from '../domain/mapDataError'
import type { SceneEdge, SceneNode } from '../domain/sceneMap'
import { buildEdgeLabelDescriptor } from './edgeLabel'
import { buildNodeLabelDescriptor } from './nodeLabel'
import type { LabelDescriptor, LabelDescriptorCollection } from './labelDescriptor'

/*
 * 标签层逻辑路径前缀：编排错误发生在实体集合上，不对应原始 JSON path。
 * 用稳定逻辑路径标识失败集合，使测试与诊断可定位，同时不伪造原始响应路径。
 */
const LABEL_ORCHESTRATOR_LOGICAL_PATH = 'sceneMap#label'

/*
 * 标签描述符编排主入口（SPEC 4.1 / 11.2）。
 *
 * 调用方契约：
 *   - nodes / edges 来自 TASK-005 交付的不可变 SceneMap（坐标已一次性转换、实体语义已校验）。
 *   - edgeLaneOffsets 由上层从 TASK-006 的 TrackModel 提取（edgeId → laneOffset 标量），
 *     必须覆盖 edges 中的每一条边。
 *   - 成功返回 LabelDescriptorCollection；失败抛出 MapDataError（整体拒绝）。
 *
 * 编排顺序（顺序稳定，重复构建完全一致）：
 *   1. 节点标签：按 nodes 顺序逐个调用 buildNodeLabelDescriptor（每个节点一个标签）。
 *   2. 边标签：按 edges 顺序逐个查 laneOffset 后调用 buildEdgeLabelDescriptor（每条边一个标签）。
 *   3. 组装只读数组与诊断计数（labelCandidateCount = nodes.length + edges.length）。
 */
export function buildLabelDescriptors(
  nodes: readonly SceneNode[],
  edges: readonly SceneEdge[],
  edgeLaneOffsets: ReadonlyMap<string, number>,
): LabelDescriptorCollection {
  const total = nodes.length + edges.length
  const descriptors: LabelDescriptor[] = new Array<LabelDescriptor>(total)

  let out = 0

  // 1. 节点标签（nodes 顺序）：纯函数定位，与边标签定位逻辑相互独立。
  for (let i = 0; i < nodes.length; i++) {
    descriptors[out++] = buildNodeLabelDescriptor(nodes[i])
  }

  // 2. 边标签（edges 顺序）：复用 TASK-006 车道偏移标量，与节点标签定位逻辑相互独立。
  for (let i = 0; i < edges.length; i++) {
    const edge = edges[i]
    const laneOffset = edgeLaneOffsets.get(edge.id)
    // 边在车道偏移映射中缺失 → 车道数据不一致，整体失败
    // （SPEC 16 / 任务“无法对应所有者的标签输入”异常路径）。不留下部分描述符。
    if (laneOffset === undefined) {
      throw new MapDataError({
        code: MapErrorCode.MAP_GEOMETRY_INVALID,
        message: `边 ${edge.id} 在车道偏移映射中缺失，无法生成边标签（edgeLaneOffsets 未覆盖全部边）。`,
        jsonPath: LABEL_ORCHESTRATOR_LOGICAL_PATH,
        entityId: edge.id,
        context: { edgeId: edge.id },
      })
    }
    descriptors[out++] = buildEdgeLabelDescriptor(edge, laneOffset)
  }

  // 写入游标必须等于预算（保证无越界、无遗漏）。
  if (out !== total) {
    throw new MapDataError({
      code: MapErrorCode.MAP_GEOMETRY_INVALID,
      message: '标签描述符写入数与预算不符，编排逻辑错误。',
      jsonPath: LABEL_ORCHESTRATOR_LOGICAL_PATH,
      context: { written: out, budget: total },
    })
  }

  return {
    descriptors,
    labelCandidateCount: total,
  }
}
