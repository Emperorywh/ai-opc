/*
 * 唯一的 unknown → RawMap 解析边界（adapters 层，SPEC 2.1 / 5.1 / 5.3 / 14.1）。
 *
 * 信任边界定位（TASK-003）：
 *   - 本模块是整个工程里唯一允许把 unknown 收敛为受校验原始地图数据的位置。
 *     任何上游（worker 的 JSON.parse 结果、测试 fixture）都只能通过 parseSampleEnvelope
 *     进入领域管线；不存在第二条解析路径、DTO 类型断言或默认值补齐。
 *   - 校验分两层：响应包级（MAP_ENVELOPE_INVALID）与实体字段级（MAP_ENTITY_INVALID）。
 *     code 由失败种类决定，不随调用位置漂移。
 *   - 本 TASK 只做字段与判别联合校验；坐标转换、轨迹分组、引用一致性、几何生成
 *     属于跨实体语义验证，由后续 TASK 在 normalizeSceneMap / buildSceneModel 完成。
 *
 * 提取路径（SPEC 2.1，唯一合法）：
 *       $.data.currentMapInfoVersion.mapJson
 *   - 不得从根对象直接读取 nodes / edges。
 *   - mapJson 是对象而不是 JSON 字符串，禁止二次 JSON.parse。
 *
 * 关键不变量（SPEC 5.3 第 1/2/5/6/7/8/11 项）：
 *   - 根对象存在且 code === 200、message === "success"。
 *   - 提取路径存在；mapJson 为普通对象；nodes/edges/zones/nodeEdgeGroups 均为数组。
 *   - 节点 / 边 ID 非空且在各自集合内唯一；名称为非空字符串。
 *   - 节点类型只允许四种；边类型只允许两种；未知值无默认样式，直接拒绝。
 *   - 所有数值为有限 JavaScript number；禁止数字字符串、NaN、Infinity。
 *   - LINE 四个控制字段全为 null；BEZIER 四个控制字段全为有限数；部分为空即失败。
 *   - 普通 node 的 angle 必须为 null；work/park/charge 的 angle 必须为有限数。
 *   - 失败时抛出 MapDataError，携带稳定 code、JSON path、实体 ID（可用时）与中文消息；
 *     不跳过坏实体、不补默认值、不返回部分地图。
 */
import { MapDataError, MapErrorCode } from '../domain/mapDataError'
import type { NodeType, EdgeType } from '../domain/mapPrimitives'
import type {
  RawEdge,
  RawLineEdge,
  RawBezierEdge,
  RawMap,
  RawMapMetadata,
  RawNode,
} from './rawMap'

/*
 * 提取路径上每一段的字面量，集中定义避免拼写漂移。
 * 断言消息与 JSON path 都引用这些常量，使失败位置可被自动化测试稳定匹配。
 */
const PATH_ROOT = '$'
const PATH_DATA = '$.data'
const PATH_VERSION = '$.data.currentMapInfoVersion'
const PATH_MAP_JSON = '$.data.currentMapInfoVersion.mapJson'
const FIELD_NODES = 'nodes'
const FIELD_EDGES = 'edges'
const FIELD_ZONES = 'zones'
const FIELD_NODE_EDGE_GROUPS = 'nodeEdgeGroups'

/*
 * 类型守卫：普通对象（非 null、非数组）。
 * JSON 里对象与数组都是 object，因此必须显式排除数组，避免把数组当作对象通过校验。
 */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/*
 * 断言普通对象，失败抛 MAP_ENVELOPE_INVALID 或调用方指定 code。
 * 用于响应包每一层（root / data / version / mapJson）。
 */
function requireObject(
  value: unknown,
  path: string,
  code: MapErrorCode,
  what: string,
): Record<string, unknown> {
  if (!isPlainObject(value)) {
    throw new MapDataError({
      code,
      message: `${what}必须是对象，实际为 ${describeKind(value)}。`,
      jsonPath: path,
    })
  }
  return value
}

/*
 * 断言数组，失败抛指定 code。
 * 用于四个集合字段（nodes / edges / zones / nodeEdgeGroups）。
 */
function requireArray(
  value: unknown,
  path: string,
  code: MapErrorCode,
  field: string,
): unknown[] {
  if (!Array.isArray(value)) {
    throw new MapDataError({
      code,
      message: `集合字段 ${field} 必须是数组，实际为 ${describeKind(value)}。`,
      jsonPath: path,
    })
  }
  return value
}

/*
 * 断言非空字符串，失败抛指定 code。
 * 空字符串、非字符串都被拒绝；用于 ID、名称、mapId、地图元数据等必需字符串字段。
 */
function requireNonEmptyString(
  value: unknown,
  path: string,
  code: MapErrorCode,
  field: string,
  entityId: string | null,
): string {
  if (typeof value !== 'string') {
    throw new MapDataError({
      code,
      message: `字段 ${field} 必须是非空字符串，实际为 ${describeKind(value)}。`,
      jsonPath: path,
      entityId,
    })
  }
  if (value.length === 0) {
    throw new MapDataError({
      code,
      message: `字段 ${field} 不得为空字符串。`,
      jsonPath: path,
      entityId,
    })
  }
  return value
}

/*
 * 断言有限 JavaScript number，失败抛指定 code。
 * 拒绝数字字符串、NaN、Infinity、非 number 类型——这些都是 SPEC 5.3 第 7 项禁止的形态。
 */
function requireFiniteNumber(
  value: unknown,
  path: string,
  code: MapErrorCode,
  field: string,
  entityId: string | null,
): number {
  if (typeof value !== 'number') {
    throw new MapDataError({
      code,
      message: `字段 ${field} 必须是有限数值，实际为 ${describeKind(value)}。`,
      jsonPath: path,
      entityId,
    })
  }
  if (!Number.isFinite(value)) {
    throw new MapDataError({
      code,
      message: `字段 ${field} 必须是有限数值，实际为 ${Number.isNaN(value) ? 'NaN' : 'Infinity'}。`,
      jsonPath: path,
      entityId,
    })
  }
  return value
}

/*
 * 断言布尔，失败抛指定 code。
 * 用于边的 isBackEdge——类型错误必须以 MAP_ENTITY_INVALID 拒绝，禁止把真值强转。
 */
function requireBoolean(
  value: unknown,
  path: string,
  code: MapErrorCode,
  field: string,
  entityId: string | null,
): boolean {
  if (typeof value !== 'boolean') {
    throw new MapDataError({
      code,
      message: `字段 ${field} 必须是布尔值，实际为 ${describeKind(value)}。`,
      jsonPath: path,
      entityId,
    })
  }
  return value
}

/*
 * 断言恰好为 null（非 undefined、非 0、非空串）。
 * 用于 LINE 边的四个控制字段——SPEC 5.3 第 8 项要求它们必须全部为 null。
 */
function requireNull(
  value: unknown,
  path: string,
  code: MapErrorCode,
  field: string,
  entityId: string | null,
): null {
  if (value !== null) {
    throw new MapDataError({
      code,
      message: `字段 ${field} 必须为 null，实际为 ${describeKind(value)}。`,
      jsonPath: path,
      entityId,
    })
  }
  return null
}

/*
 * 把未知值描述为中文类型名，用于错误消息的可读性。
 * 不暴露给上层，仅在本模块内构造失败上下文。
 */
function describeKind(value: unknown): string {
  if (value === null) return 'null'
  if (Array.isArray(value)) return '数组'
  if (value === undefined) return 'undefined'
  return typeof value
}

/*
 * 解析节点类型联合（SPEC 2.2 / 5.3 第 6 项）。
 * 闭合集合 node/work/park/charge；任何其它字符串（含样本不存在的旧类型）均拒绝，
 * 不给默认类型、不给默认样式。
 */
const NODE_TYPES: readonly NodeType[] = ['node', 'work', 'park', 'charge']
export function parseNodeType(
  value: unknown,
  path: string,
  entityId: string | null,
): NodeType {
  if (typeof value !== 'string' || !NODE_TYPES.includes(value as NodeType)) {
    throw new MapDataError({
      code: MapErrorCode.MAP_ENTITY_INVALID,
      message: `节点类型必须是 node/work/park/charge 之一，实际为 ${describeKind(value)}。`,
      jsonPath: path,
      entityId,
      context: { actual: value },
    })
  }
  return value as NodeType
}

/*
 * 解析边类型联合（SPEC 2.2 / 5.3 第 6 项）。
 * 闭合集合 LINE/BEZIER；判别联合的标签，决定控制字段的合法形态。
 */
const EDGE_TYPES: readonly EdgeType[] = ['LINE', 'BEZIER']
export function parseEdgeType(
  value: unknown,
  path: string,
  entityId: string | null,
): EdgeType {
  if (typeof value !== 'string' || !EDGE_TYPES.includes(value as EdgeType)) {
    throw new MapDataError({
      code: MapErrorCode.MAP_ENTITY_INVALID,
      message: `边类型必须是 LINE/BEZIER 之一，实际为 ${describeKind(value)}。`,
      jsonPath: path,
      entityId,
      context: { actual: value },
    })
  }
  return value as EdgeType
}

/*
 * 解析节点 angle 字段（SPEC 2.5 / 5.3 第 11 项）。
 * - type === 'node'：angle 必须为 null（普通节点无朝向箭头）。
 * - 其余三类：angle 必须为有限弧度值。
 * 规则绑定到已校验的 type，而非读取不存在的 showArrow 字段。
 */
function parseNodeAngle(
  value: unknown,
  type: NodeType,
  path: string,
  entityId: string | null,
): number | null {
  if (type === 'node') {
    if (value !== null) {
      throw new MapDataError({
        code: MapErrorCode.MAP_ENTITY_INVALID,
        message: '普通节点 angle 必须为 null。',
        jsonPath: path,
        entityId,
        context: { actual: value },
      })
    }
    return null
  }
  return requireFiniteNumber(
    value,
    path,
    MapErrorCode.MAP_ENTITY_INVALID,
    'angle',
    entityId,
  )
}

/*
 * 解析单个节点（SPEC 5.1 RawNode）。
 * 只保留受消费字段，丢弃 actions / userDefinedProperties 等业务元数据。
 * 不做唯一性、引用一致性等跨实体校验——这些由 parseSampleEnvelope 编排。
 */
export function parseRawNode(raw: unknown, path: string): RawNode {
  const obj = requireObject(
    raw,
    path,
    MapErrorCode.MAP_ENTITY_INVALID,
    '节点',
  )
  // 先读 id，使后续失败的 entityId 可定位到具体节点。
  const id = requireNonEmptyString(
    obj.id,
    `${path}.id`,
    MapErrorCode.MAP_ENTITY_INVALID,
    'id',
    null,
  )
  const name = requireNonEmptyString(
    obj.name,
    `${path}.name`,
    MapErrorCode.MAP_ENTITY_INVALID,
    'name',
    id,
  )
  const type = parseNodeType(obj.type, `${path}.type`, id)
  const mapId = requireNonEmptyString(
    obj.mapId,
    `${path}.mapId`,
    MapErrorCode.MAP_ENTITY_INVALID,
    'mapId',
    id,
  )
  const x = requireFiniteNumber(
    obj.x,
    `${path}.x`,
    MapErrorCode.MAP_ENTITY_INVALID,
    'x',
    id,
  )
  const y = requireFiniteNumber(
    obj.y,
    `${path}.y`,
    MapErrorCode.MAP_ENTITY_INVALID,
    'y',
    id,
  )
  const angle = parseNodeAngle(obj.angle, type, `${path}.angle`, id)
  return { id, name, type, mapId, x, y, angle }
}

/*
 * 解析边公共字段（SPEC 5.1 RawEdgeBase）。
 * snodeId / enodeId 只校验为非空字符串（拓扑标签），引用存在性与互异性由后续 TASK 校验。
 */
function parseEdgeBase(
  obj: Record<string, unknown>,
  path: string,
): Omit<RawEdge, 'edgeType' | 'cx' | 'cy' | 'dx' | 'dy'> {
  const id = requireNonEmptyString(
    obj.id,
    `${path}.id`,
    MapErrorCode.MAP_ENTITY_INVALID,
    'id',
    null,
  )
  const name = requireNonEmptyString(
    obj.name,
    `${path}.name`,
    MapErrorCode.MAP_ENTITY_INVALID,
    'name',
    id,
  )
  const mapId = requireNonEmptyString(
    obj.mapId,
    `${path}.mapId`,
    MapErrorCode.MAP_ENTITY_INVALID,
    'mapId',
    id,
  )
  const snodeId = requireNonEmptyString(
    obj.snodeId,
    `${path}.snodeId`,
    MapErrorCode.MAP_ENTITY_INVALID,
    'snodeId',
    id,
  )
  const enodeId = requireNonEmptyString(
    obj.enodeId,
    `${path}.enodeId`,
    MapErrorCode.MAP_ENTITY_INVALID,
    'enodeId',
    id,
  )
  const sx = requireFiniteNumber(
    obj.sx,
    `${path}.sx`,
    MapErrorCode.MAP_ENTITY_INVALID,
    'sx',
    id,
  )
  const sy = requireFiniteNumber(
    obj.sy,
    `${path}.sy`,
    MapErrorCode.MAP_ENTITY_INVALID,
    'sy',
    id,
  )
  const ex = requireFiniteNumber(
    obj.ex,
    `${path}.ex`,
    MapErrorCode.MAP_ENTITY_INVALID,
    'ex',
    id,
  )
  const ey = requireFiniteNumber(
    obj.ey,
    `${path}.ey`,
    MapErrorCode.MAP_ENTITY_INVALID,
    'ey',
    id,
  )
  const isBackEdge = requireBoolean(
    obj.isBackEdge,
    `${path}.isBackEdge`,
    MapErrorCode.MAP_ENTITY_INVALID,
    'isBackEdge',
    id,
  )
  return { id, name, mapId, snodeId, enodeId, sx, sy, ex, ey, isBackEdge }
}

/*
 * 解析单个边为 LINE 或 BEZIER 判别联合（SPEC 5.1 / 5.3 第 8 项）。
 * - 先读 edgeType 决定分支；
 * - LINE：cx/cy/dx/dy 必须全部为 null；
 * - BEZIER：cx/cy/dx/dy 必须全部为有限数；
 * - 部分为空或部分为非 null 属于非法判别联合，直接 MAP_ENTITY_INVALID。
 */
export function parseRawEdge(raw: unknown, path: string): RawEdge {
  const obj = requireObject(raw, path, MapErrorCode.MAP_ENTITY_INVALID, '边')
  // 先读 id 与 edgeType，使后续控制字段失败能定位到具体边。
  const id = requireNonEmptyString(
    obj.id,
    `${path}.id`,
    MapErrorCode.MAP_ENTITY_INVALID,
    'id',
    null,
  )
  const edgeType = parseEdgeType(obj.edgeType, `${path}.edgeType`, id)
  const base = parseEdgeBase(obj, path)

  if (edgeType === 'LINE') {
    // LINE 四个控制字段必须全部为 null。
    requireNull(obj.cx, `${path}.cx`, MapErrorCode.MAP_ENTITY_INVALID, 'cx', id)
    requireNull(obj.cy, `${path}.cy`, MapErrorCode.MAP_ENTITY_INVALID, 'cy', id)
    requireNull(obj.dx, `${path}.dx`, MapErrorCode.MAP_ENTITY_INVALID, 'dx', id)
    requireNull(obj.dy, `${path}.dy`, MapErrorCode.MAP_ENTITY_INVALID, 'dy', id)
    const line: RawLineEdge = { ...base, edgeType: 'LINE', cx: null, cy: null, dx: null, dy: null }
    return line
  }

  // BEZIER 四个控制字段必须全部为有限数。
  const cx = requireFiniteNumber(
    obj.cx,
    `${path}.cx`,
    MapErrorCode.MAP_ENTITY_INVALID,
    'cx',
    id,
  )
  const cy = requireFiniteNumber(
    obj.cy,
    `${path}.cy`,
    MapErrorCode.MAP_ENTITY_INVALID,
    'cy',
    id,
  )
  const dx = requireFiniteNumber(
    obj.dx,
    `${path}.dx`,
    MapErrorCode.MAP_ENTITY_INVALID,
    'dx',
    id,
  )
  const dy = requireFiniteNumber(
    obj.dy,
    `${path}.dy`,
    MapErrorCode.MAP_ENTITY_INVALID,
    'dy',
    id,
  )
  const bezier: RawBezierEdge = { ...base, edgeType: 'BEZIER', cx, cy, dx, dy }
  return bezier
}

/*
 * 解析地图元数据（SPEC 2.1）。
 * 取自提取路径直接父对象 currentMapInfoVersion：
 *   mapId / mapName / mapVersion(→ version) 均必须为非空字符串。
 * 跨实体一致性（与每个节点/边的 mapId 比对）属 SPEC 5.3 第 4 项，由后续 TASK 完成。
 */
function parseMapMetadata(
  version: Record<string, unknown>,
): RawMapMetadata {
  const mapId = requireNonEmptyString(
    version.mapId,
    `${PATH_VERSION}.mapId`,
    MapErrorCode.MAP_ENVELOPE_INVALID,
    'mapId',
    null,
  )
  const mapName = requireNonEmptyString(
    version.mapName,
    `${PATH_VERSION}.mapName`,
    MapErrorCode.MAP_ENVELOPE_INVALID,
    'mapName',
    null,
  )
  const versionStr = requireNonEmptyString(
    version.mapVersion,
    `${PATH_VERSION}.mapVersion`,
    MapErrorCode.MAP_ENVELOPE_INVALID,
    'mapVersion',
    null,
  )
  return { mapId, mapName, version: versionStr }
}

/*
 * 校验集合内 ID 唯一（SPEC 5.3 第 5 项）。
 * 唯一性是结构性身份校验，不是跨实体语义关系，因此在适配边界完成。
 * 发现重复 ID 时以 MAP_ENTITY_INVALID 拒绝，并指出第二次出现的位置。
 */
function assertUniqueIds(
  entities: readonly { readonly id: string }[],
  basePath: string,
  what: string,
): void {
  const seen = new Set<string>()
  entities.forEach((entity, index) => {
    if (seen.has(entity.id)) {
      throw new MapDataError({
        code: MapErrorCode.MAP_ENTITY_INVALID,
        message: `${what} ID 重复：${entity.id}。`,
        jsonPath: `${basePath}[${index}].id`,
        entityId: entity.id,
      })
    }
    seen.add(entity.id)
  })
}

/*
 * 唯一的 unknown → RawMap 边界（SPEC 2.1 / 5.1 / 5.3）。
 *
 * 调用方契约：
 *   - 输入是 JSON.parse 后的任意值（unknown）；本函数是它进入领域管线的唯一入口。
 *   - 成功返回只含受校验被消费字段的 RawMap；失败抛出 MapDataError。
 *   - 不返回部分地图、不跳过坏实体、不补默认值。
 */
export function parseSampleEnvelope(input: unknown): RawMap {
  // --- SPEC 5.3 第 1 项：响应包根对象与状态码。 ---
  const root = requireObject(
    input,
    PATH_ROOT,
    MapErrorCode.MAP_ENVELOPE_INVALID,
    '响应包根对象',
  )
  if (root.code !== 200) {
    throw new MapDataError({
      code: MapErrorCode.MAP_ENVELOPE_INVALID,
      message: '响应状态码 code 必须为 200，实际不符。',
      jsonPath: `${PATH_ROOT}.code`,
      context: { actual: root.code },
    })
  }
  if (root.message !== 'success') {
    throw new MapDataError({
      code: MapErrorCode.MAP_ENVELOPE_INVALID,
      message: '响应消息 message 必须为 "success"，实际不符。',
      jsonPath: `${PATH_ROOT}.message`,
      context: { actual: root.message },
    })
  }

  // --- SPEC 2.1：提取路径 data.currentMapInfoVersion.mapJson。 ---
  const data = requireObject(
    root.data,
    PATH_DATA,
    MapErrorCode.MAP_ENVELOPE_INVALID,
    'data',
  )
  const version = requireObject(
    data.currentMapInfoVersion,
    PATH_VERSION,
    MapErrorCode.MAP_ENVELOPE_INVALID,
    'currentMapInfoVersion',
  )

  // 地图元数据（取自提取路径父对象）。
  const metadata = parseMapMetadata(version)

  // --- SPEC 5.3 第 2 项：mapJson 必须是普通对象（不是字符串、不是数组）。 ---
  // 不允许二次 JSON.parse：mapJson 在样本里就是对象字面量。
  const mapJson = requireObject(
    version.mapJson,
    PATH_MAP_JSON,
    MapErrorCode.MAP_ENVELOPE_INVALID,
    'mapJson',
  )

  // --- SPEC 5.3 第 2 项：四个集合字段必须是数组。 ---
  // zones / nodeEdgeGroups 的“必须为空”断言（第 3 项）属跨实体语义，由后续 TASK 完成。
  const nodesRaw = requireArray(
    mapJson[FIELD_NODES],
    `${PATH_MAP_JSON}.${FIELD_NODES}`,
    MapErrorCode.MAP_ENVELOPE_INVALID,
    FIELD_NODES,
  )
  const edgesRaw = requireArray(
    mapJson[FIELD_EDGES],
    `${PATH_MAP_JSON}.${FIELD_EDGES}`,
    MapErrorCode.MAP_ENVELOPE_INVALID,
    FIELD_EDGES,
  )
  const zonesRaw = requireArray(
    mapJson[FIELD_ZONES],
    `${PATH_MAP_JSON}.${FIELD_ZONES}`,
    MapErrorCode.MAP_ENVELOPE_INVALID,
    FIELD_ZONES,
  )
  const nodeEdgeGroupsRaw = requireArray(
    mapJson[FIELD_NODE_EDGE_GROUPS],
    `${PATH_MAP_JSON}.${FIELD_NODE_EDGE_GROUPS}`,
    MapErrorCode.MAP_ENVELOPE_INVALID,
    FIELD_NODE_EDGE_GROUPS,
  )

  // --- SPEC 5.1 / 5.3：逐实体字段校验与判别联合。 ---
  const nodes = nodesRaw.map((node, index) =>
    parseRawNode(node, `${PATH_MAP_JSON}.${FIELD_NODES}[${index}]`),
  )
  const edges = edgesRaw.map((edge, index) =>
    parseRawEdge(edge, `${PATH_MAP_JSON}.${FIELD_EDGES}[${index}]`),
  )

  // --- SPEC 5.3 第 5 项：节点 / 边 ID 在各自集合内唯一。 ---
  assertUniqueIds(nodes, `${PATH_MAP_JSON}.${FIELD_NODES}`, '节点')
  assertUniqueIds(edges, `${PATH_MAP_JSON}.${FIELD_EDGES}`, '边')

  return {
    metadata,
    nodes,
    edges,
    // zones / nodeEdgeGroups 只校验为数组后透传；元素结构不解析（SPEC 1.3 排除其渲染）。
    zones: zonesRaw,
    nodeEdgeGroups: nodeEdgeGroupsRaw,
  }
}
