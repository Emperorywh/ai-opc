import type { RawMapEdge, RawMapNode, RawMapPayload, RawNodeType } from './rawDto'
import type { DirectedEdge, DirectedPath, MapModel, MapNode } from './domainModel'

/**
 * 将校验通过的原始载荷规范化为领域模型。
 *
 * 前置条件：`validateRawMap(payload)` 必须返回空数组。调用方负责保证该条件，
 * 本函数不再重复校验，而是直接信任 DTO 形状。这是渲染契约的边界约束，
 * 不是旧数据兼容逻辑（SPEC §4.3）：所有契约外字段（name、mapId、cost、
 * actions、userDefinedProperties 等）在此被显式丢弃，绝不进入下游。
 */

/** 把校验通过的原始载荷转换为规范化地图模型。 */
export function normalizeMap(payload: RawMapPayload): MapModel {
  const nodes: MapNode[] = payload.nodes.map(toMapNode)
  const edges: DirectedEdge[] = payload.edges.map(toDirectedEdge)
  return { nodes, edges }
}

function toMapNode(node: RawMapNode): MapNode {
  return {
    id: node.id,
    type: node.type,
    position: { x: node.x, y: node.y },
    angle: node.angle,
  }
}

function toDirectedEdge(edge: RawMapEdge): DirectedEdge {
  return {
    id: edge.id,
    sourceNodeId: edge.snodeId,
    targetNodeId: edge.enodeId,
    path: toDirectedPath(edge),
  }
}

function toDirectedPath(edge: RawMapEdge): DirectedPath {
  if (edge.edgeType === 'LINE') {
    return {
      kind: 'line',
      start: { x: edge.sx, y: edge.sy },
      end: { x: edge.ex, y: edge.ey },
    }
  }
  // 校验已保证 BEZIER 的四个控制点分量为有限数值，故在此安全断言为 number。
  return {
    kind: 'cubic-bezier',
    start: { x: edge.sx, y: edge.sy },
    control1: { x: edge.cx as number, y: edge.cy as number },
    control2: { x: edge.dx as number, y: edge.dy as number },
    end: { x: edge.ex, y: edge.ey },
  }
}

/** 原始载荷审计统计，用于核对数据基线（SPEC §4.2）。 */
export interface MapAudit {
  nodeCount: number
  edgeCount: number
  zoneCount: number
  nodeEdgeGroupCount: number
  nodeTypeCount: Record<RawNodeType, number>
  edgeTypeCount: { LINE: number; BEZIER: number }
  isBackEdgeCount: number
}

/** 统计原始载荷的节点、边、类型分布与审计标记，不修改输入。 */
export function auditRawMap(payload: RawMapPayload): MapAudit {
  const nodeTypeCount: Record<RawNodeType, number> = { node: 0, work: 0, charge: 0, park: 0 }
  for (const node of payload.nodes) {
    nodeTypeCount[node.type] += 1
  }

  let line = 0
  let bezier = 0
  let isBackEdgeCount = 0
  for (const edge of payload.edges) {
    if (edge.edgeType === 'LINE') {
      line += 1
    } else {
      bezier += 1
    }
    if (edge.isBackEdge) {
      isBackEdgeCount += 1
    }
  }

  return {
    nodeCount: payload.nodes.length,
    edgeCount: payload.edges.length,
    zoneCount: payload.zones.length,
    nodeEdgeGroupCount: payload.nodeEdgeGroups.length,
    nodeTypeCount,
    edgeTypeCount: { LINE: line, BEZIER: bezier },
    isBackEdgeCount,
  }
}
