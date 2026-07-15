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

/**
 * 端点与节点坐标视为数值相等的阈值（米）。
 *
 * 低于 1 微米的差异属于浮点噪声而非真实几何偏差；该阈值远小于 V76 数据中
 * 最小的真实端点偏差（约 1 毫米），因此不会把真实偏差误判为相等。
 */
const ENDPOINT_EQUAL_EPSILON_M = 1e-6

/**
 * 原始载荷数据完整性基线（SPEC §4.2 真实数据审计表末两行）。
 *
 * 与 `MapAudit` 互补：`auditRawMap` 统计“数据是什么”（分布），
 * 本结构把“校验通过”这一结论拆解为可逐项核对的不变量计数（缺什么缺陷）。
 * 两者用途不同，也不与 `validation` 共享判定逻辑——validation 决定能否进入
 * 规范化，本审计只如实计数缺陷，把数据基线固定为可断言的事实。
 */
export interface DataIntegrityAudit {
  /** id 重复的节点记录数（同一 id 第二次及之后出现各计一次）。 */
  duplicateNodeIdCount: number
  /** id 重复的边记录数。 */
  duplicateEdgeIdCount: number
  /** x 或 y 非有限的节点记录数。 */
  invalidNodeCoordinateCount: number
  /** sx/sy/ex/ey 任一非有限，或 BEZIER 的 cx/cy/dx/dy 任一非有限的边记录数。 */
  invalidEdgeCoordinateCount: number
  /** snodeId 或 enodeId 未引用已存在节点 id 的边记录数。 */
  missingNodeReferenceCount: number
  /** 起或终端点与所引用节点坐标欧氏距离超过阈值的边记录数。 */
  endpointNodeMismatchCount: number
  /** 端点与节点坐标的最大欧氏距离（米）；无任何差异时为 0。 */
  maxEndpointNodeDistanceM: number
}

/**
 * 审计原始载荷的数据完整性基线（SPEC §4.2）。
 *
 * 不变量：
 * - 只读输入，不修改、不抛异常；遇到非有限坐标或缺失引用如实计数。
 * - 边端点与节点坐标的差异是审计事实而非错误：只统计数量与最大欧氏距离，
 *   不做任何吸附（SPEC §4.2、§4.4）。
 * - 距离比较要求边端点与节点坐标均为有限值，避免把“非法坐标/缺失引用”
 *   重复归因到端点偏差。
 */
export function auditDataIntegrity(payload: RawMapPayload): DataIntegrityAudit {
  const nodeIdSet = new Set<string>()
  // 端点距离比较按首个出现的节点解析引用，与引用语义一致；当前基线无重复 id，
  // 故不存在歧义。
  const nodeById = new Map<string, RawMapNode>()
  let duplicateNodeIdCount = 0
  let invalidNodeCoordinateCount = 0

  for (const node of payload.nodes) {
    if (nodeIdSet.has(node.id)) {
      duplicateNodeIdCount += 1
    } else {
      nodeIdSet.add(node.id)
    }
    if (!nodeById.has(node.id)) {
      nodeById.set(node.id, node)
    }
    if (!Number.isFinite(node.x) || !Number.isFinite(node.y)) {
      invalidNodeCoordinateCount += 1
    }
  }

  const edgeIdSet = new Set<string>()
  let duplicateEdgeIdCount = 0
  let invalidEdgeCoordinateCount = 0
  let missingNodeReferenceCount = 0
  let endpointNodeMismatchCount = 0
  let maxEndpointNodeDistanceM = 0

  for (const edge of payload.edges) {
    if (edgeIdSet.has(edge.id)) {
      duplicateEdgeIdCount += 1
    } else {
      edgeIdSet.add(edge.id)
    }

    // 坐标合法性：直线四端点必须有限；贝塞尔额外要求两个控制点有限。
    let coordInvalid =
      !Number.isFinite(edge.sx) ||
      !Number.isFinite(edge.sy) ||
      !Number.isFinite(edge.ex) ||
      !Number.isFinite(edge.ey)
    if (edge.edgeType === 'BEZIER') {
      coordInvalid =
        coordInvalid ||
        !Number.isFinite(edge.cx) ||
        !Number.isFinite(edge.cy) ||
        !Number.isFinite(edge.dx) ||
        !Number.isFinite(edge.dy)
    }
    if (coordInvalid) {
      invalidEdgeCoordinateCount += 1
    }

    const source = nodeById.get(edge.snodeId)
    const target = nodeById.get(edge.enodeId)
    if (source === undefined || target === undefined) {
      missingNodeReferenceCount += 1
    }

    // 仅当端点与节点坐标均有限时才比较距离，否则 NaN 会污染最大值统计。
    let edgeMax = 0
    if (
      source !== undefined &&
      Number.isFinite(edge.sx) &&
      Number.isFinite(edge.sy) &&
      Number.isFinite(source.x) &&
      Number.isFinite(source.y)
    ) {
      edgeMax = Math.max(edgeMax, Math.hypot(edge.sx - source.x, edge.sy - source.y))
    }
    if (
      target !== undefined &&
      Number.isFinite(edge.ex) &&
      Number.isFinite(edge.ey) &&
      Number.isFinite(target.x) &&
      Number.isFinite(target.y)
    ) {
      edgeMax = Math.max(edgeMax, Math.hypot(edge.ex - target.x, edge.ey - target.y))
    }
    if (edgeMax > ENDPOINT_EQUAL_EPSILON_M) {
      endpointNodeMismatchCount += 1
    }
    if (edgeMax > maxEndpointNodeDistanceM) {
      maxEndpointNodeDistanceM = edgeMax
    }
  }

  return {
    duplicateNodeIdCount,
    duplicateEdgeIdCount,
    invalidNodeCoordinateCount,
    invalidEdgeCoordinateCount,
    missingNodeReferenceCount,
    endpointNodeMismatchCount,
    maxEndpointNodeDistanceM,
  }
}
