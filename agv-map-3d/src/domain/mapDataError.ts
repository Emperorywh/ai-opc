/*
 * 结构化地图数据错误与稳定错误码（domain 层，SPEC 5.3 / 14.1）。
 *
 * 信任边界定位：
 *   - 本层是整个依赖图的根，MapDataError 是所有上层（adapters / application /
 *     workers / rendering / scene / ui）共享的唯一结构化失败载体。
 *   - 错误码以 `as const` 对象形式给出，避免 TypeScript enum（受 tsconfig 的
 *     erasableSyntaxOnly 约束），同时保证字面量类型与运行时值一致。
 *
 * 错误码语义（SPEC 14.1）：
 *   - SAMPLE_FETCH_FAILED / SAMPLE_HASH_MISMATCH：构建期供应链产出，字符串值
 *     与 scripts/sample-supply-chain.mjs 的 SAMPLE_ERRORS 保持一致。
 *   - MAP_ENVELOPE_INVALID：响应包或提取路径错误（根值、code/message、
 *     data.currentMapInfoVersion.mapJson、集合字段非数组、地图元数据字段）。
 *   - MAP_ENTITY_INVALID：实体字段、ID、类型、判别联合或引用错误。
 *   - MAP_GEOMETRY_INVALID：零长度、无切线、非有限几何或轨迹组异常（后续 TASK）。
 *   - FONT_* / WEBGL_*：字体与 WebGL 生命周期错误（后续 TASK）。
 *
 * 关键不变量：
 *   - 每个错误必须携带稳定 code、jsonPath 与可读中文消息；entityId 在能确定时给出。
 *   - code 由失败种类决定，不随调用位置漂移；同一类失败在任何调用点都得到同一 code。
 *   - 本类型不持有可变运行状态，只描述一次失败的不可变快照。
 */

/*
 * 稳定错误码枚举（SPEC 14.1）。
 * 字符串值即为对外契约，不得变更；新增码只能追加，不得改写已有码的含义。
 */
export const MapErrorCode = {
  SAMPLE_FETCH_FAILED: 'SAMPLE_FETCH_FAILED',
  SAMPLE_HASH_MISMATCH: 'SAMPLE_HASH_MISMATCH',
  SAMPLE_JSON_INVALID: 'SAMPLE_JSON_INVALID',
  MAP_ENVELOPE_INVALID: 'MAP_ENVELOPE_INVALID',
  MAP_ENTITY_INVALID: 'MAP_ENTITY_INVALID',
  MAP_GEOMETRY_INVALID: 'MAP_GEOMETRY_INVALID',
  FONT_ASSET_FAILED: 'FONT_ASSET_FAILED',
  FONT_GLYPH_MISSING: 'FONT_GLYPH_MISSING',
  WEBGL_UNAVAILABLE: 'WEBGL_UNAVAILABLE',
  WEBGL_CONTEXT_LOST: 'WEBGL_CONTEXT_LOST',
} as const

export type MapErrorCode = (typeof MapErrorCode)[keyof typeof MapErrorCode]

/*
 * MapDataError 构造参数。
 *   - code：稳定错误码，决定 overlay 文案分支与自动化断言匹配。
 *   - message：简体中文可读消息，直接面向用户与日志。
 *   - jsonPath：失败位置在原始响应中的 JSON 路径，如
 *     `$.data.currentMapInfoVersion.mapJson.nodes[5].x`。
 *   - entityId：可用时的实体 ID（节点或边）；响应包级失败为 null。
 *   - context：可选的附加诊断字段（期望值 / 实际值 / 字段名等），不参与稳定契约。
 */
export interface MapDataErrorInit {
  readonly code: MapErrorCode
  readonly message: string
  readonly jsonPath: string
  readonly entityId?: string | null
  readonly context?: Readonly<Record<string, unknown>>
}

/*
 * 唯一的结构化地图数据错误。
 *
 * 失败语义：
 *   - 一旦抛出，调用方不得返回部分地图、跳过坏实体或补默认值；必须把整个加载转入 error。
 *   - 错误对象是不可变快照：code / jsonPath / entityId 在构造后只读。
 *   - name 固定为 'MapDataError'，便于上层按构造名而非 message 做分支。
 */
export class MapDataError extends Error {
  readonly code: MapErrorCode
  readonly jsonPath: string
  readonly entityId: string | null
  readonly context: Readonly<Record<string, unknown>> | null

  constructor(init: MapDataErrorInit) {
    super(init.message)
    this.name = 'MapDataError'
    this.code = init.code
    this.jsonPath = init.jsonPath
    this.entityId = init.entityId ?? null
    this.context = init.context ? { ...init.context } : null
  }

  /*
 * 把错误序列化为面向日志的可读字符串。
 * 包含稳定 code、JSON path、实体 ID（若有）与中文消息，
 * 便于 overlay / 开发者控制台一次性定位失败种类与位置。
 */
  toLogString(): string {
    const entity = this.entityId ? ` entity=${this.entityId}` : ''
    return `[${this.code}] path=${this.jsonPath}${entity} :: ${this.message}`
  }
}

/*
 * 类型守卫：把任意未知值收敛为 MapDataError。
 * 上层 catch 只通过本守卫识别地图数据错误，其它异常按未知错误处理。
 */
export function isMapDataError(value: unknown): value is MapDataError {
  return value instanceof MapDataError
}
