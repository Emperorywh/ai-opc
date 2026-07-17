/*
 * 跨实体语义完整性校验（adapters 层，SPEC 5.3 第 3/4/9/10/12 项）。
 *
 * 信任边界定位（TASK-004）：
 *   - 本模块消费 parseSampleEnvelope 产出的 RawMap，校验字段级之外的跨实体语义不变量。
 *   - 字段级校验（类型、判别联合、数值有限性、ID 非空、ID 唯一性、angle 规则）
 *     已由 parseSampleEnvelope 完成；本模块绝不重复这些校验，只补充跨集合、跨实体
 *     的一致性与几何前置语义。
 *   - 任何失败都整体拒绝地图：不跳过坏实体、不补坐标、不修正 ID、不输出部分合法集合。
 *   - 本模块不实现坐标转换、轨迹 canonical 分组、双车道、三角化或 GPU 数据；
 *     这些属于 normalizeSceneMap / buildSceneModel（后续 TASK）。本模块通过校验后，
 *     仅表示数据“实体级语义可信”，尚未伪称渲染 ready。
 *
 * 校验项（SPEC 5.3）：
 *   - 第 3 项：zones 与 nodeEdgeGroups 必须为空（v1 不渲染二者，非空整体拒绝）。
 *   - 第 4 项：mapId 全链路一致——响应元 data.mapId、版本元 version.mapId、
 *             每个节点 mapId 与每条边 mapId 必须完全相同。
 *   - 第 9 项：每条边的 snodeId/enodeId 必须引用已存在的节点，且二者不同（无自环）。
 *   - 第 10 项：边弦长大于 1e-9m（端点直线距离，LINE 与 BEZIER 一视同仁）。
 *   - 第 12 项：边端点到引用节点的距离分别不超过 0.05m；通过校验后仍使用边自身端点绘图。
 *
 * 边坐标所有权（SPEC 2.3 / 6.1）：
 *   - 边自身的 sx/sy/ex/ey/cx/cy/dx/dy 是显示几何唯一事实来源。
 *   - snodeId/enodeId 只表示拓扑关系；端点偏差校验仅用于发现数据不一致，
 *     通过校验后绝不以节点坐标覆盖边端点（本模块不修改 RawMap，也不输出新坐标）。
 *
 * 错误码归属（SPEC 14.1）：
 *   - 范围门禁、mapId 不一致、悬空引用、自环、端点偏差 → MAP_ENTITY_INVALID
 *     （跨实体语义/引用/字段一致性问题）。
 *   - 弦长过短（零长度边）→ MAP_GEOMETRY_INVALID（SPEC 14.1 明确把“零长度”归入几何错误）。
 */
import { MapDataError, MapErrorCode } from '../domain/mapDataError'
import type { RawEdge, RawMap, RawNode } from './rawMap'
import {
  DATA_MAP_ID_PATH,
  EDGES_COLLECTION_PATH,
  NODES_COLLECTION_PATH,
  NODE_EDGE_GROUPS_PATH,
  ZONES_PATH,
} from './parseSampleEnvelope'

/*
 * SPEC 5.3 第 10 项：边弦长下界（米）。
 * 弦长 = start 到 end 的直线距离，必须严格大于该值；等于或小于视为零长度边。
 */
const EDGE_CHORD_EPSILON = 1e-9

/*
 * SPEC 5.3 第 12 项：边端点到引用节点的最大允许距离（米）。
 * 端点偏差超过该门限属于数据不一致，整体拒绝；通过后仍使用边自身端点绘图。
 */
const ENDPOINT_DEVIATION_LIMIT = 0.05

/*
 * 唯一的跨实体语义校验入口。
 *
 * 调用方契约：
 *   - 输入是 parseSampleEnvelope 成功返回的 RawMap（字段级已校验）。
 *   - 成功返回 void：表示实体级语义不变量全部成立，数据可交给坐标归一化（后续 TASK）。
 *   - 失败抛出 MapDataError：调用方必须整体转入 error，不得返回部分地图。
 *   - 本函数是纯校验：不修改输入，不产生新几何，不接触 Three / React / 浏览器 API。
 */
export function validateMapSemantics(rawMap: RawMap): void {
  // SPEC 5.3 第 3 项：v1 渲染范围门禁，zones / nodeEdgeGroups 必须为空。
  assertCollectionsEmpty(rawMap)

  // SPEC 5.3 第 4 项：mapId 全链路一致（响应元 ↔ 版本元 ↔ 节点 ↔ 边）。
  assertMapIdConsistency(rawMap)

  // 后续引用存在性与端点偏差校验需要按节点 ID 查找坐标。
  // ID 唯一性已由 parseSampleEnvelope 保证，此处直接建立索引，不重复唯一性校验。
  const nodeById = indexNodesById(rawMap.nodes)

  // SPEC 5.3 第 9/10/12 项：逐边校验引用、自环、弦长与端点偏差。
  for (let i = 0; i < rawMap.edges.length; i++) {
    assertEdgeSemantics(rawMap.edges[i], i, nodeById)
  }
}

/*
 * SPEC 5.3 第 3 项 / SPEC 1.3：zones 与 nodeEdgeGroups 必须为空。
 * 二者属于 v1 明确排除的渲染对象；非空时整体拒绝，不解析其元素结构。
 */
function assertCollectionsEmpty(rawMap: RawMap): void {
  if (rawMap.zones.length !== 0) {
    throw new MapDataError({
      code: MapErrorCode.MAP_ENTITY_INVALID,
      message: 'zones 必须为空：v1 不渲染 zones，非空时整体拒绝加载。',
      jsonPath: ZONES_PATH,
      context: { actualLength: rawMap.zones.length },
    })
  }
  if (rawMap.nodeEdgeGroups.length !== 0) {
    throw new MapDataError({
      code: MapErrorCode.MAP_ENTITY_INVALID,
      message: 'nodeEdgeGroups 必须为空：v1 不渲染 nodeEdgeGroups，非空时整体拒绝加载。',
      jsonPath: NODE_EDGE_GROUPS_PATH,
      context: { actualLength: rawMap.nodeEdgeGroups.length },
    })
  }
}

/*
 * SPEC 5.3 第 4 项：mapId 全链路一致性。
 * 规范 mapId 取版本元 mapId（metadata.mapId）；响应元、每个节点与每条边的 mapId
 * 必须与其完全相同。任一不一致都以 MAP_ENTITY_INVALID 拒绝，并定位到具体实体。
 */
function assertMapIdConsistency(rawMap: RawMap): void {
  const canonical = rawMap.metadata.mapId

  // 响应元 data.mapId 与版本元 mapId 必须一致。
  if (rawMap.metadata.envelopeMapId !== canonical) {
    throw new MapDataError({
      code: MapErrorCode.MAP_ENTITY_INVALID,
      message: 'mapId 全链路不一致：响应元 data.mapId 与版本元 mapId 不同。',
      jsonPath: DATA_MAP_ID_PATH,
      context: {
        envelopeMapId: rawMap.metadata.envelopeMapId,
        versionMapId: canonical,
      },
    })
  }

  // 每个节点的 mapId 必须与规范 mapId 一致。
  for (let i = 0; i < rawMap.nodes.length; i++) {
    const node = rawMap.nodes[i]
    if (node.mapId !== canonical) {
      throw new MapDataError({
        code: MapErrorCode.MAP_ENTITY_INVALID,
        message: `节点 mapId 与地图 mapId 不一致：期望 ${canonical}，实际 ${node.mapId}。`,
        jsonPath: `${NODES_COLLECTION_PATH}[${i}].mapId`,
        entityId: node.id,
        context: { expected: canonical, actual: node.mapId },
      })
    }
  }

  // 每条边的 mapId 必须与规范 mapId 一致。
  for (let i = 0; i < rawMap.edges.length; i++) {
    const edge = rawMap.edges[i]
    if (edge.mapId !== canonical) {
      throw new MapDataError({
        code: MapErrorCode.MAP_ENTITY_INVALID,
        message: `边 mapId 与地图 mapId 不一致：期望 ${canonical}，实际 ${edge.mapId}。`,
        jsonPath: `${EDGES_COLLECTION_PATH}[${i}].mapId`,
        entityId: edge.id,
        context: { expected: canonical, actual: edge.mapId },
      })
    }
  }
}

/*
 * 按节点 ID 建立查找索引。
 * 节点 ID 唯一性已由 parseSampleEnvelope.assertUniqueIds 校验，此处不再重复；
 * 若上游不变量被破坏，后出现者覆盖先出现者，引用校验仍会以“存在”通过——
 * 因此上游唯一性校验是本函数正确性的前置条件，不得绕过。
 */
function indexNodesById(
  nodes: readonly RawNode[],
): ReadonlyMap<string, RawNode> {
  const map = new Map<string, RawNode>()
  for (const node of nodes) {
    map.set(node.id, node)
  }
  return map
}

/*
 * SPEC 5.3 第 9/10/12 项：单条边的跨实体语义与几何前置校验。
 * 校验顺序：引用存在 → 无自环 → 弦长 → 端点偏差。
 * 任一失败立即抛出，定位到具体边与其字段。
 */
function assertEdgeSemantics(
  edge: RawEdge,
  index: number,
  nodeById: ReadonlyMap<string, RawNode>,
): void {
  const edgePath = `${EDGES_COLLECTION_PATH}[${index}]`

  // SPEC 5.3 第 9 项：snodeId / enodeId 必须引用已存在的节点（无悬空引用）。
  const startNode = nodeById.get(edge.snodeId)
  if (startNode === undefined) {
    throw new MapDataError({
      code: MapErrorCode.MAP_ENTITY_INVALID,
      message: `边引用的起点节点不存在：snodeId=${edge.snodeId}。`,
      jsonPath: `${edgePath}.snodeId`,
      entityId: edge.id,
      context: { snodeId: edge.snodeId },
    })
  }
  const endNode = nodeById.get(edge.enodeId)
  if (endNode === undefined) {
    throw new MapDataError({
      code: MapErrorCode.MAP_ENTITY_INVALID,
      message: `边引用的终点节点不存在：enodeId=${edge.enodeId}。`,
      jsonPath: `${edgePath}.enodeId`,
      entityId: edge.id,
      context: { enodeId: edge.enodeId },
    })
  }

  // SPEC 5.3 第 9 项：snodeId !== enodeId（无自环）。
  // 自环判据只比较拓扑 ID，与坐标无关；引用节点存在后再判定，保证消息可定位。
  if (edge.snodeId === edge.enodeId) {
    throw new MapDataError({
      code: MapErrorCode.MAP_ENTITY_INVALID,
      message: '边不允许自环：snodeId 与 enodeId 必须不同。',
      jsonPath: `${edgePath}.enodeId`,
      entityId: edge.id,
      context: { nodeId: edge.snodeId },
    })
  }

  // SPEC 5.3 第 10 项：弦长（start→end 直线距离）必须严格大于 1e-9m。
  // LINE 与 BEZIER 一视同仁——弦长只看端点；曲线中段退化（U 形折返）的切线校验
  // 属于几何层（后续 TASK），不在本语义层提前推导。
  const chord = Math.hypot(edge.ex - edge.sx, edge.ey - edge.sy)
  if (!(chord > EDGE_CHORD_EPSILON)) {
    throw new MapDataError({
      code: MapErrorCode.MAP_GEOMETRY_INVALID,
      message: `边弦长必须大于 ${EDGE_CHORD_EPSILON}m，实际为 ${chord}m。`,
      jsonPath: edgePath,
      entityId: edge.id,
      context: { chord, sx: edge.sx, sy: edge.sy, ex: edge.ex, ey: edge.ey },
    })
  }

  // SPEC 5.3 第 12 项：边端点到引用节点的距离分别不得超过 0.05m。
  // 偏差是地图坐标系下的直线距离；后续重心平移与 y→-z 翻转均为等距变换，不影响判定。
  // 通过校验后仍使用边自身端点绘图：本模块只校验、不覆盖、不输出新端点。
  const startDeviation = Math.hypot(edge.sx - startNode.x, edge.sy - startNode.y)
  if (startDeviation > ENDPOINT_DEVIATION_LIMIT) {
    throw new MapDataError({
      code: MapErrorCode.MAP_ENTITY_INVALID,
      message: `边起点与引用节点距离超过 ${ENDPOINT_DEVIATION_LIMIT}m：偏差 ${startDeviation}m。`,
      jsonPath: `${edgePath}.sx`,
      entityId: edge.id,
      context: {
        deviation: startDeviation,
        edgeX: edge.sx,
        edgeY: edge.sy,
        nodeX: startNode.x,
        nodeY: startNode.y,
        nodeId: startNode.id,
      },
    })
  }
  const endDeviation = Math.hypot(edge.ex - endNode.x, edge.ey - endNode.y)
  if (endDeviation > ENDPOINT_DEVIATION_LIMIT) {
    throw new MapDataError({
      code: MapErrorCode.MAP_ENTITY_INVALID,
      message: `边终点与引用节点距离超过 ${ENDPOINT_DEVIATION_LIMIT}m：偏差 ${endDeviation}m。`,
      jsonPath: `${edgePath}.ex`,
      entityId: edge.id,
      context: {
        deviation: endDeviation,
        edgeX: edge.ex,
        edgeY: edge.ey,
        nodeX: endNode.x,
        nodeY: endNode.y,
        nodeId: endNode.id,
      },
    })
  }
}
