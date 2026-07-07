// ============================================================================
// 纯函数 loader：把「已获取的顶层 JSON 对象」解析为可信的 MapData
// ----------------------------------------------------------------------------
// 设计原则（见 docs/SPEC_agv-map-phase1.md §2、§9 与 docs/PLAN §3、§6）：
// 1. 纯函数——不依赖 fetch / fs / DOM，可被 node 环境直接单测；
// 2. 不做坐标映射——保持地图原始 xy，翻转与轴映射交给渲染层；
// 3. 退化优先——零长度/自环/null 控制点/未知 type 等异常一律自动归一化，
//    永不抛出中断渲染，所有问题以 MapWarning 形式上报；
// 4. 信任边坐标——几何定位完全采用边自带 (sx,sy)/(ex,ey)，不反查节点。
// ============================================================================

import type {
  Box2XY,
  Edge,
  EdgeType,
  MapData,
  MapWarning,
  Node,
  NodeType,
} from './types.ts'

// 5 种合法节点类型集合：用于把未知 type 归一化到 'node' 并产出告警
const KNOWN_NODE_TYPES: ReadonlySet<string> = new Set([
  'node',
  'warehouse',
  'park',
  'charge',
  'work',
])

// 退化包围盒：当地图既无节点也无边时返回该值，
// 避免渲染层拿到 ±Infinity 之类的无效包围盒导致 fit 计算崩溃
const EMPTY_BBOX: Box2XY = { minX: 0, maxX: 0, minY: 0, maxY: 0 }

// ----------------------------------------------------------------------------
// 字段读取小工具：对未知值做防御性归一化，确保下游永远拿到合法类型
// ----------------------------------------------------------------------------

// 安全取字符串：非字符串一律退化为空串
function asString(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

// 安全取数值：非有限数值退化为 0，避免 NaN 污染包围盒与几何计算
function asNumber(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

// 安全取可空数值：非有限数值视为 null（用于 cx/cy/dx/dy、angle 等可选字段）
function asNullableNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

// 从「可能是对象」的值中按 key 取字段，非对象一律返回 undefined
function getField(obj: unknown, key: string): unknown {
  if (obj !== null && typeof obj === 'object') {
    return (obj as Record<string, unknown>)[key]
  }
  return undefined
}

// ----------------------------------------------------------------------------
// 包围盒计算：遍历所有节点坐标 + 边端点取 min/max（SPEC §2.2）
// 贝塞尔控制点不参与包围盒（仅取骨架端点 P0/P3）。
// ----------------------------------------------------------------------------
function computeBBox(nodes: Node[], edges: Edge[]): Box2XY {
  // 以 ±Infinity 作初值，便于统一 min/max 归并
  let minX = Infinity
  let maxX = -Infinity
  let minY = Infinity
  let maxY = -Infinity

  // 把单个坐标纳入包围盒的局部闭包
  const extend = (x: number, y: number): void => {
    if (x < minX) minX = x
    if (x > maxX) maxX = x
    if (y < minY) minY = y
    if (y > maxY) maxY = y
  }

  // 节点坐标
  for (const node of nodes) {
    extend(node.x, node.y)
  }

  // 边端点：起点 (sx,sy) 与终点 (ex,ey)
  for (const edge of edges) {
    extend(edge.sx, edge.sy)
    extend(edge.ex, edge.ey)
  }

  // 若没有任何坐标（空地图），返回退化包围盒
  if (minX === Infinity || maxX === -Infinity) {
    return { ...EMPTY_BBOX }
  }

  return { minX, maxX, minY, maxY }
}

// ----------------------------------------------------------------------------
// 解析单个节点：归一化字段，未知 type 归 'node' 并告警
// 节点不做「丢弃」，字段异常一律退化为安全默认值，保证不丢节点。
// ----------------------------------------------------------------------------
function parseNode(raw: unknown, warnings: MapWarning[]): Node {
  const id = asString(getField(raw, 'id'))
  const name = asString(getField(raw, 'name'))
  const mapId = asString(getField(raw, 'mapId'))
  const rawType = asString(getField(raw, 'type'))

  // 未知 type 归一化为 'node'，并产出告警（SPEC §9）
  let type: NodeType
  if (KNOWN_NODE_TYPES.has(rawType)) {
    type = rawType as NodeType
  } else {
    type = 'node'
    warnings.push({
      kind: 'NODE_TYPE_UNKNOWN',
      id,
      detail: `unknown node type: ${JSON.stringify(getField(raw, 'type'))}`,
    })
  }

  return {
    id,
    name,
    mapId,
    type,
    x: asNumber(getField(raw, 'x')),
    y: asNumber(getField(raw, 'y')),
    angle: asNullableNumber(getField(raw, 'angle')),
  }
}

// ----------------------------------------------------------------------------
// 解析单个边：归一化字段 + 退化判定（SPEC §9）
// 退化顺序遵循任务定义：零长度 → 自环 → BEZIER 控制点 → LINE 控制点。
// 零长度/自环边返回 null（从结果中剔除）；控制点异常边保留但降级为 LINE。
// ----------------------------------------------------------------------------
function parseEdge(raw: unknown, warnings: MapWarning[]): Edge | null {
  const id = asString(getField(raw, 'id'))
  const name = asString(getField(raw, 'name'))
  const mapId = asString(getField(raw, 'mapId'))

  // edgeType 仅 LINE/BEZIER 两种合法；未知值退化为 LINE（安全默认）
  const edgeType: EdgeType = asString(getField(raw, 'edgeType')) === 'BEZIER' ? 'BEZIER' : 'LINE'

  const sx = asNumber(getField(raw, 'sx'))
  const sy = asNumber(getField(raw, 'sy'))
  const ex = asNumber(getField(raw, 'ex'))
  const ey = asNumber(getField(raw, 'ey'))
  let cx = asNullableNumber(getField(raw, 'cx'))
  let cy = asNullableNumber(getField(raw, 'cy'))
  let dx = asNullableNumber(getField(raw, 'dx'))
  let dy = asNullableNumber(getField(raw, 'dy'))
  const isBackEdge = getField(raw, 'isBackEdge') === true
  const snodeId = asString(getField(raw, 'snodeId'))
  const enodeId = asString(getField(raw, 'enodeId'))

  // 退化 1：零长度边（起点与终点完全重合）→ 丢弃 + 告警
  if (sx === ex && sy === ey) {
    warnings.push({ kind: 'ZERO_LENGTH', id, detail: 'zero-length edge dropped' })
    return null
  }

  // 退化 2：自环边（起止节点为同一个）→ 丢弃 + 告警
  // 仅当两端 id 非空时判定，避免缺数据的边被误判为自环
  if (snodeId !== '' && snodeId === enodeId) {
    warnings.push({ kind: 'SELF_LOOP', id, detail: 'self-loop edge dropped' })
    return null
  }

  // 退化 3：BEZIER 任一控制点为 null → 退化为 LINE + 告警
  // 退化 4：LINE 携带控制点 → 忽略控制点 + 告警
  if (edgeType === 'BEZIER') {
    if (cx === null || cy === null || dx === null || dy === null) {
      warnings.push({
        kind: 'BEZIER_MISSING_CTRL',
        id,
        detail: 'bezier missing control point, degraded to LINE',
      })
      // 控制点清空，几何降级为直线
      cx = null
      cy = null
      dx = null
      dy = null
      return {
        id,
        name,
        mapId,
        edgeType: 'LINE',
        sx,
        sy,
        ex,
        ey,
        cx,
        cy,
        dx,
        dy,
        isBackEdge,
        snodeId,
        enodeId,
      }
    }
  } else {
    // LINE 边：若携带了控制点则忽略并告警
    if (cx !== null || cy !== null || dx !== null || dy !== null) {
      warnings.push({
        kind: 'LINE_IGNORE_CTRL',
        id,
        detail: 'LINE edge has control point, ignored',
      })
      cx = null
      cy = null
      dx = null
      dy = null
    }
  }

  return {
    id,
    name,
    mapId,
    edgeType,
    sx,
    sy,
    ex,
    ey,
    cx,
    cy,
    dx,
    dy,
    isBackEdge,
    snodeId,
    enodeId,
  }
}

// ----------------------------------------------------------------------------
// 主入口：loadMapData
// 输入：后端 HTTP 响应的顶层 JSON 对象（已由调用方获取，本函数不做 fetch）
// 输出：清洗后的 MapData（含节点、边、包围盒、告警）
// 顶层结构缺失时返回带 PARSE_ERROR 告警的空 MapData，绝不抛异常。
// ----------------------------------------------------------------------------
export function loadMapData(raw: unknown): MapData {
  const warnings: MapWarning[] = []

  // 按嵌套路径逐层解包：data → currentMapInfoVersion → mapJson（SPEC §2.1）
  const data = getField(raw, 'data')
  const version = getField(data, 'currentMapInfoVersion')
  const mapJson = getField(version, 'mapJson')

  // 顶层结构缺失：返回带 PARSE_ERROR 的空 MapData（SPEC §9 显示空场景）
  if (mapJson === null || typeof mapJson !== 'object') {
    warnings.push({
      kind: 'PARSE_ERROR',
      detail: 'missing data.currentMapInfoVersion.mapJson',
    })
    return {
      mapId: asString(getField(data, 'mapId')),
      mapName: asString(getField(data, 'mapName')),
      nodes: [],
      edges: [],
      bbox: { ...EMPTY_BBOX },
      warnings,
    }
  }

  // mapState 非 ENABLED：告警但仍继续渲染（SPEC §2.1）
  if (asString(getField(data, 'mapState')) !== 'ENABLED') {
    warnings.push({
      kind: 'MAP_STATE_DISABLED',
      detail: `mapState is not ENABLED: ${JSON.stringify(getField(data, 'mapState'))}`,
    })
  }

  // 解析节点数组：缺失或非数组按空数组处理（容错）
  const rawNodes = getField(mapJson, 'nodes')
  const nodes: Node[] = []
  if (Array.isArray(rawNodes)) {
    for (const rn of rawNodes) {
      nodes.push(parseNode(rn, warnings))
    }
  }

  // 解析边数组：含退化过滤与降级（parseEdge 返回 null 即被剔除）
  const rawEdges = getField(mapJson, 'edges')
  const edges: Edge[] = []
  if (Array.isArray(rawEdges)) {
    for (const re of rawEdges) {
      const edge = parseEdge(re, warnings)
      if (edge !== null) edges.push(edge)
    }
  }

  // 计算包围盒
  const bbox = computeBBox(nodes, edges)

  return {
    mapId: asString(getField(data, 'mapId')),
    mapName: asString(getField(data, 'mapName')),
    nodes,
    edges,
    bbox,
    warnings,
  }
}
