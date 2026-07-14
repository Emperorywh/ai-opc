/**
 * 原始载荷严格校验（SPEC §4.4）。
 *
 * 校验以 `unknown` 为输入，按 SPEC §4.4 的封闭规则一次性收集全部问题。
 * 空问题数组代表数据满足契约，可进入规范化阶段；非空代表数据不可展示，
 * 调用方不得再产出可供渲染的数据结果。
 *
 * 不变量：
 * - 不在首个错误处短路；同一记录的多类问题与不同记录的问题都被完整收集。
 * - 结构性错误（例如 nodes 不是数组）只跳过依赖该结构的更深层检查，仍继续
 *   校验其余独立字段。
 * - 边端点与节点坐标的差异不属于校验错误；`isBackEdge` 不参与任何校验结论。
 */

/** 校验问题错误码封闭联合（用字符串字面量联合替代枚举，满足 erasableSyntaxOnly）。 */
export type ValidationCode =
  | 'INVALID_PAYLOAD_SHAPE'
  | 'INVALID_NODE_SHAPE'
  | 'INVALID_EDGE_SHAPE'
  | 'EMPTY_NODE_ID'
  | 'EMPTY_EDGE_ID'
  | 'DUPLICATE_NODE_ID'
  | 'DUPLICATE_EDGE_ID'
  | 'DUPLICATE_DIRECTED_PAIR'
  | 'INVALID_NODE_TYPE'
  | 'INVALID_EDGE_TYPE'
  | 'NON_FINITE_NODE_COORDINATE'
  | 'NON_FINITE_EDGE_COORDINATE'
  | 'INVALID_NODE_ANGLE'
  | 'MISSING_NODE_REFERENCE'
  | 'ZERO_LENGTH_LINE'
  | 'INCOMPLETE_BEZIER_CONTROL'
  | 'NON_EMPTY_ZONES'
  | 'NON_EMPTY_NODE_EDGE_GROUPS'

/** 单条校验问题，携带可定位的字段路径与简短说明。 */
export interface ValidationProblem {
  code: ValidationCode
  /** 载荷内点分路径，如 "nodes[3].x" 或 "edges[5].cx"；根级问题为空串。 */
  path: string
  message: string
}

/** 声明的封闭节点类型集合，用于运行时拒绝非法类型值。 */
const NODE_TYPES: ReadonlySet<string> = new Set(['node', 'work', 'charge', 'park'])

/** 声明的封闭边类型集合，用于运行时拒绝非法类型值。 */
const EDGE_TYPES: ReadonlySet<string> = new Set(['LINE', 'BEZIER'])

/** 方向性节点类型，其 angle 必须为有限数值（普通节点除外）。 */
const DIRECTIONAL_NODE_TYPES: ReadonlySet<string> = new Set(['work', 'charge', 'park'])

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0
}

function stringify(value: unknown): string {
  if (value === undefined) return 'undefined'
  if (value === null) return 'null'
  if (typeof value === 'string') return value
  return JSON.stringify(value)
}

interface ValidationContext {
  problems: ValidationProblem[]
  /** 已见的合法节点 id，用于重复检测与边引用校验。 */
  nodeIds: Set<string>
  /** 已见的合法边 id，用于重复检测。 */
  edgeIds: Set<string>
  /** 已见的有向节点对键，用于保证反向候选唯一。 */
  directedPairs: Set<string>
}

/**
 * 严格校验 mapJson 载荷，返回全部问题。
 *
 * 可选的 onProgress 在每处理完一条节点或边记录后回调，参数为
 * (已处理记录数, 节点数+边数)。该回调只反映遍历进度，不影响校验结果
 * 或短路行为（SPEC §4.4：不在首个错误处短路）。
 * 供后台编译流程把真实处理记录数映射到状态机 validating 区间（SPEC §10.1）。
 */
export function validateRawMap(
  payload: unknown,
  onProgress?: (processed: number, total: number) => void,
): ValidationProblem[] {
  const ctx: ValidationContext = {
    problems: [],
    nodeIds: new Set(),
    edgeIds: new Set(),
    directedPairs: new Set(),
  }

  collectPayloadProblems(payload, ctx)
  // 仅当 nodes/edges 均为数组时才可知总数，进度才具有意义；否则跳过回调。
  const nodeCount = isRecord(payload) && Array.isArray(payload.nodes) ? payload.nodes.length : 0
  const edgeCount = isRecord(payload) && Array.isArray(payload.edges) ? payload.edges.length : 0
  const total = nodeCount + edgeCount
  let processed = 0

  if (isRecord(payload)) {
    if (Array.isArray(payload.nodes)) {
      payload.nodes.forEach((node, index) => {
        collectNodeProblems(node, index, ctx)
        processed += 1
        onProgress?.(processed, total)
      })
    }
    if (Array.isArray(payload.edges)) {
      payload.edges.forEach((edge, index) => {
        collectEdgeProblems(edge, index, ctx)
        processed += 1
        onProgress?.(processed, total)
      })
    }
  }
  return ctx.problems
}

/**
 * 顶层校验：先提取载荷，再执行载荷契约校验，返回合并后的问题列表。
 * 可选 onProgress 透传给 validateRawMap（SPEC §10.1）。
 */
export function validateRawMapAsset(
  rawAsset: unknown,
  onProgress?: (processed: number, total: number) => void,
): ValidationProblem[] {
  const extraction = extractMapPayload(rawAsset)
  if (!extraction.ok) return extraction.problems
  return validateRawMap(extraction.payload, onProgress)
}

function collectPayloadProblems(payload: unknown, ctx: ValidationContext): void {
  if (!isRecord(payload)) {
    ctx.problems.push({ code: 'INVALID_PAYLOAD_SHAPE', path: '', message: 'mapJson 载荷不是对象' })
    return
  }
  if (!Array.isArray(payload.nodes)) {
    ctx.problems.push({ code: 'INVALID_PAYLOAD_SHAPE', path: 'nodes', message: 'nodes 不是数组' })
  }
  if (!Array.isArray(payload.edges)) {
    ctx.problems.push({ code: 'INVALID_PAYLOAD_SHAPE', path: 'edges', message: 'edges 不是数组' })
  }
  if (!Array.isArray(payload.zones)) {
    ctx.problems.push({ code: 'INVALID_PAYLOAD_SHAPE', path: 'zones', message: 'zones 不是数组' })
  } else if (payload.zones.length > 0) {
    ctx.problems.push({
      code: 'NON_EMPTY_ZONES',
      path: 'zones',
      message: `当前契约要求 zones 为空，实际 ${payload.zones.length} 项`,
    })
  }
  if (!Array.isArray(payload.nodeEdgeGroups)) {
    ctx.problems.push({
      code: 'INVALID_PAYLOAD_SHAPE',
      path: 'nodeEdgeGroups',
      message: 'nodeEdgeGroups 不是数组',
    })
  } else if (payload.nodeEdgeGroups.length > 0) {
    ctx.problems.push({
      code: 'NON_EMPTY_NODE_EDGE_GROUPS',
      path: 'nodeEdgeGroups',
      message: `当前契约要求 nodeEdgeGroups 为空，实际 ${payload.nodeEdgeGroups.length} 项`,
    })
  }
}

function collectNodeProblems(node: unknown, index: number, ctx: ValidationContext): void {
  const basePath = `nodes[${index}]`
  if (!isRecord(node)) {
    ctx.problems.push({ code: 'INVALID_NODE_SHAPE', path: basePath, message: '节点记录不是对象' })
    return
  }

  const id = node.id
  if (!isNonEmptyString(id)) {
    ctx.problems.push({ code: 'EMPTY_NODE_ID', path: `${basePath}.id`, message: '节点 id 为空或非字符串' })
  } else if (ctx.nodeIds.has(id)) {
    ctx.problems.push({ code: 'DUPLICATE_NODE_ID', path: `${basePath}.id`, message: `节点 id 重复：${id}` })
  } else {
    ctx.nodeIds.add(id)
  }

  const type = node.type
  if (typeof type !== 'string' || !NODE_TYPES.has(type)) {
    ctx.problems.push({
      code: 'INVALID_NODE_TYPE',
      path: `${basePath}.type`,
      message: `非法节点类型：${stringify(type)}`,
    })
  }

  if (!isFiniteNumber(node.x)) {
    ctx.problems.push({ code: 'NON_FINITE_NODE_COORDINATE', path: `${basePath}.x`, message: '节点 x 非有限数值' })
  }
  if (!isFiniteNumber(node.y)) {
    ctx.problems.push({ code: 'NON_FINITE_NODE_COORDINATE', path: `${basePath}.y`, message: '节点 y 非有限数值' })
  }

  // 角度约束依赖类型：普通节点必须为 null，方向性节点必须为有限值；
  // 类型非法时不重复报角度问题，避免噪声。
  const angle = node.angle
  if (type === 'node' && angle !== null) {
    ctx.problems.push({ code: 'INVALID_NODE_ANGLE', path: `${basePath}.angle`, message: '普通节点 angle 必须为 null' })
  } else if (typeof type === 'string' && DIRECTIONAL_NODE_TYPES.has(type) && !isFiniteNumber(angle)) {
    ctx.problems.push({
      code: 'INVALID_NODE_ANGLE',
      path: `${basePath}.angle`,
      message: '该类型节点 angle 必须为有限数值',
    })
  }
}

function collectEdgeProblems(edge: unknown, index: number, ctx: ValidationContext): void {
  const basePath = `edges[${index}]`
  if (!isRecord(edge)) {
    ctx.problems.push({ code: 'INVALID_EDGE_SHAPE', path: basePath, message: '边记录不是对象' })
    return
  }

  const id = edge.id
  if (!isNonEmptyString(id)) {
    ctx.problems.push({ code: 'EMPTY_EDGE_ID', path: `${basePath}.id`, message: '边 id 为空或非字符串' })
  } else if (ctx.edgeIds.has(id)) {
    ctx.problems.push({ code: 'DUPLICATE_EDGE_ID', path: `${basePath}.id`, message: `边 id 重复：${id}` })
  } else {
    ctx.edgeIds.add(id)
  }

  const edgeType = edge.edgeType
  if (typeof edgeType !== 'string' || !EDGE_TYPES.has(edgeType)) {
    ctx.problems.push({
      code: 'INVALID_EDGE_TYPE',
      path: `${basePath}.edgeType`,
      message: `非法边类型：${stringify(edgeType)}`,
    })
  }

  for (const key of ['sx', 'sy', 'ex', 'ey'] as const) {
    if (!isFiniteNumber(edge[key])) {
      ctx.problems.push({
        code: 'NON_FINITE_EDGE_COORDINATE',
        path: `${basePath}.${key}`,
        message: `边 ${key} 非有限数值`,
      })
    }
  }

  collectEdgeGeometryProblems(edge, edgeType, basePath, ctx)
  collectEdgeReferenceProblems(edge, basePath, ctx)
}

function collectEdgeGeometryProblems(
  edge: Record<string, unknown>,
  edgeType: unknown,
  basePath: string,
  ctx: ValidationContext,
): void {
  if (edgeType === 'LINE') {
    const { sx, sy, ex, ey } = edge
    // 仅当四个端点均为有限值时才判定零长度，避免与非有限坐标问题重复归因。
    if (
      isFiniteNumber(sx) &&
      isFiniteNumber(sy) &&
      isFiniteNumber(ex) &&
      isFiniteNumber(ey) &&
      sx === ex &&
      sy === ey
    ) {
      ctx.problems.push({ code: 'ZERO_LENGTH_LINE', path: basePath, message: '直线起终点重合' })
    }
    return
  }
  if (edgeType === 'BEZIER') {
    for (const key of ['cx', 'cy', 'dx', 'dy'] as const) {
      if (!isFiniteNumber(edge[key])) {
        ctx.problems.push({
          code: 'INCOMPLETE_BEZIER_CONTROL',
          path: `${basePath}.${key}`,
          message: `贝塞尔控制点 ${key} 缺失或非有限数值`,
        })
      }
    }
  }
}

function collectEdgeReferenceProblems(
  edge: Record<string, unknown>,
  basePath: string,
  ctx: ValidationContext,
): void {
  // 将引用收敛为 string|null，使后续成员判断获得明确的类型收窄。
  const snodeId = isNonEmptyString(edge.snodeId) ? edge.snodeId : null
  const enodeId = isNonEmptyString(edge.enodeId) ? edge.enodeId : null

  if (snodeId === null || !ctx.nodeIds.has(snodeId)) {
    ctx.problems.push({
      code: 'MISSING_NODE_REFERENCE',
      path: `${basePath}.snodeId`,
      message: `起始节点引用不存在：${stringify(edge.snodeId)}`,
    })
  }
  if (enodeId === null || !ctx.nodeIds.has(enodeId)) {
    ctx.problems.push({
      code: 'MISSING_NODE_REFERENCE',
      path: `${basePath}.enodeId`,
      message: `目标节点引用不存在：${stringify(edge.enodeId)}`,
    })
  }

  // 每个有向节点对最多一条边，保证反向候选唯一；以非空字符串对为键即可判定，
  // 不依赖节点是否真实存在。
  if (snodeId !== null && enodeId !== null) {
    const pairKey = `${snodeId}>${enodeId}`
    if (ctx.directedPairs.has(pairKey)) {
      ctx.problems.push({
        code: 'DUPLICATE_DIRECTED_PAIR',
        path: basePath,
        message: `重复有向节点对：${snodeId} > ${enodeId}`,
      })
    } else {
      ctx.directedPairs.add(pairKey)
    }
  }
}

/** 从 RawMapAsset 包装结构中提取载荷的结果。 */
export type ExtractionResult =
  | { ok: true; payload: unknown }
  | { ok: false; problems: ValidationProblem[] }

/**
 * 从 RawMapAsset 包装结构中提取 `data.currentMapInfoVersion.mapJson` 载荷。
 * 任何一层缺失或父级非对象都汇总为带路径的问题，不抛异常、不返回半成品数据。
 */
export function extractMapPayload(rawAsset: unknown): ExtractionResult {
  const problems: ValidationProblem[] = []
  let cursor: unknown = rawAsset
  const segments = ['data', 'currentMapInfoVersion', 'mapJson'] as const
  let path = ''
  for (const segment of segments) {
    path = path === '' ? segment : `${path}.${segment}`
    if (!isRecord(cursor)) {
      problems.push({ code: 'INVALID_PAYLOAD_SHAPE', path, message: `${path} 的父级不是对象` })
      return { ok: false, problems }
    }
    if (!(segment in cursor)) {
      problems.push({ code: 'INVALID_PAYLOAD_SHAPE', path, message: `缺少字段 ${path}` })
      return { ok: false, problems }
    }
    cursor = cursor[segment]
  }
  return { ok: true, payload: cursor }
}
