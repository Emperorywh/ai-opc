/*
 * 场景构建管线（workers 层，SPEC 3.1 / 4.1 / 5 / 14.1 / 任务约束）。
 *
 * 信任边界定位（TASK-013）：
 *   - 本模块是 worker 内"请求 → JSON.parse → 严格校验 → 领域归一化 → 场景模型构建"的
 *     单向管线编排，是跨线程可测试的核心。
 *   - I/O 边界（fetch 与 postMessage）通过依赖注入提供：浏览器 worker 入口注入全局
 *     fetch 与 self.postMessage；node 测试注入模拟实现，从而在不启动浏览器或 Web Worker
 *     的前提下验证消息顺序、请求关联、缓冲区转移与失败原子性。
 *   - 管线只依赖 domain / adapters / geometry / labels / workers 纯能力（SPEC 3.3），
 *     不创建 Three / React / DOM / GPU 资源，不回读原始 JSON 做第二套几何推导。
 *
 * 阶段编排（SPEC 4.1 数据流 / 4.2 状态机 / 任务约束）：
 *   1. 报告 loading；fetch 唯一运行时样本 URL（SAMPLE_RUNTIME_URL，SPEC 3.1）。
 *   2. 进入 preparing：JSON.parse（parsing）→ parseSampleEnvelope + validateMapSemantics
 *      + normalizeSceneMap（validating）→ buildSceneModel（building）。
 *   3. 成功：发送 success 消息，transfer list 覆盖且仅覆盖 SceneModel 的每个 ArrayBuffer。
 *
 * 原子性不变量（SPEC 16 / 任务约束）：
 *   - 任一阶段失败都整体终止：发送一条失败消息后立即返回，不继续后续阶段、
 *     不发送部分 SceneModel、不发送成功消息。
 *   - 失败消息携带稳定 code、阶段、中文消息、JSON path、实体 ID（可用时）与上下文，
 *     全部可结构化克隆；不抛出不可克隆对象、不吞掉错误。
 *
 * 转移所有权不变量（SPEC 4.1 / 4.3 / 任务约束）：
 *   - 成功消息的 transfer list 由 collectTransferableBuffers 给出，覆盖且仅覆盖
 *     SceneModel 的每个 ArrayBuffer，每个恰好一次。
 *   - send 成功转移后，runSceneBuild 立即返回，不再访问已转移的 typed array 或
 *     ArrayBuffer（SPEC 4.3 postMessage 转移后 worker 侧缓冲区已分离）。
 *
 * 哈希不重复不变量（任务约束）：
 *   - 样本 SHA-256 由构建前供应链（TASK-002）负责；本管线不建立第二套哈希或数据来源逻辑，
 *     只请求唯一运行时 URL 并信任供应链已校验身份。
 */
import { MapErrorCode, isMapDataError } from '../domain/mapDataError'
import { parseSampleEnvelope } from '../adapters/parseSampleEnvelope'
import { validateMapSemantics } from '../adapters/validateMapSemantics'
import { normalizeSceneMap } from '../adapters/normalizeSceneMap'
import type { SceneMap } from '../domain/sceneMap'
import { buildSceneModel, collectTransferableBuffers } from './buildSceneModel'
import type { SceneModel } from './buildSceneModel'
import { SCENE_BUILD_PHASE, SCENE_BUILD_STAGE } from './sceneBuildProtocol'
import type {
  SceneBuildFailure,
  SceneBuildFailureStage,
  SceneBuildMessage,
  SceneBuildPhase,
  SceneBuildProgress,
  SceneBuildRequestId,
  SceneBuildStage,
  SceneBuildSuccess,
} from './sceneBuildProtocol'

/*
 * fetch 返回的最小视图（任务约束：I/O 边界依赖注入）。
 * 不依赖 DOM 的 Response 类型：管线只消费 ok / status / text()，worker 入口把全局
 * Response 适配为该结构。这样管线可在 node 测试中以纯数据模拟，不引入浏览器类型耦合。
 */
export interface SceneBuildFetchResponse {
  readonly ok: boolean
  readonly status: number
  text(): Promise<string>
}

/*
 * 管线依赖注入接口（I/O 边界，任务约束）。
 *
 * 设计意图：把 fetch / postMessage / 时钟从管线剥离，使核心逻辑可在 node 直接驱动。
 *   - fetch：仅请求调用方传入的 URL；worker 入口注入 SAMPLE_RUNTIME_URL 与全局 fetch。
 *   - send：发送一条 worker → 主线程消息，可选 transfer list（仅 success 消息提供）。
 *     入口注入 self.postMessage；测试注入捕获实现或真实转移实现（structuredClone）。
 *   - now：单调时钟（毫秒），用于阶段耗时。入口注入 performance.now；测试可注入固定值。
 */
export interface SceneBuildDeps {
  fetch(url: string): Promise<SceneBuildFetchResponse>
  send(message: SceneBuildMessage, transfer?: readonly ArrayBuffer[]): void
  now(): number
}

/*
 * 把任意错误收敛为简体中文可读字符串，避免把原始 Error 对象放进消息导致不可克隆。
 * 管线只把 describeError 的结果作为失败消息的 message 字段（字符串，可克隆）。
 */
function describeError(err: unknown): string {
  if (err instanceof Error) return err.message
  return String(err)
}

/*
 * 构造进度消息。
 * loading 阶段 stage = null；preparing 阶段报告当前子阶段（parsing / validating / building）。
 */
function progress(
  requestId: SceneBuildRequestId,
  phase: SceneBuildPhase,
  stage: SceneBuildStage | null,
): SceneBuildProgress {
  return { type: 'progress', requestId, phase, stage }
}

/*
 * fetch 阶段失败消息（SAMPLE_FETCH_FAILED，SPEC 14.1）。
 * 非 2xx 响应、网络错误（fetch reject）或响应体读取失败都归入本类；
 * 阶段为 loading，失败位置为 fetch，整体终止。
 */
function buildFetchFailure(
  requestId: SceneBuildRequestId,
  message: string,
  context?: Readonly<Record<string, unknown>>,
): SceneBuildFailure {
  return {
    type: 'failure',
    requestId,
    code: MapErrorCode.SAMPLE_FETCH_FAILED,
    phase: SCENE_BUILD_PHASE.LOADING,
    failureStage: 'fetch',
    message,
    jsonPath: '$',
    entityId: null,
    context: context ?? null,
  }
}

/*
 * parse 阶段失败消息（SAMPLE_JSON_INVALID，SPEC 14.1）。
 * JSON.parse 抛出的任何错误都归入本类；阶段为 preparing，失败位置为 parse，整体终止。
 */
function buildParseFailure(
  requestId: SceneBuildRequestId,
  message: string,
): SceneBuildFailure {
  return {
    type: 'failure',
    requestId,
    code: MapErrorCode.SAMPLE_JSON_INVALID,
    phase: SCENE_BUILD_PHASE.PREPARING,
    failureStage: 'parse',
    message,
    jsonPath: '$',
    entityId: null,
    context: null,
  }
}

/*
 * validate / build 阶段失败消息（SPEC 14.1 / 任务约束）。
 *
 * 从 MapDataError 透传稳定 code / jsonPath / entityId / context；失败阶段由调用方指定。
 * 这样 TASK-003～TASK-012 在各层抛出的稳定错误码、JSON path 与实体 ID 原样穿透到主线程，
 * 管线不重写、不吞掉、不降级。
 *
 * 防御性降级：管线各阶段应只抛 MapDataError；若出现未知异常（理论不应出现），按当前阶段
 * 降级为对应 Map 错误码，仍发送可克隆失败消息，避免抛出不可克隆对象导致 postMessage 静默失败。
 */
function buildMapDataFailure(
  requestId: SceneBuildRequestId,
  err: unknown,
  failureStage: SceneBuildFailureStage,
): SceneBuildFailure {
  if (isMapDataError(err)) {
    return {
      type: 'failure',
      requestId,
      code: err.code,
      phase: SCENE_BUILD_PHASE.PREPARING,
      failureStage,
      message: err.message,
      jsonPath: err.jsonPath,
      entityId: err.entityId,
      context: err.context,
    }
  }
  const code =
    failureStage === 'build'
      ? MapErrorCode.MAP_GEOMETRY_INVALID
      : MapErrorCode.MAP_ENTITY_INVALID
  return {
    type: 'failure',
    requestId,
    code,
    phase: SCENE_BUILD_PHASE.PREPARING,
    failureStage,
    message: describeError(err),
    jsonPath: '$',
    entityId: null,
    context: null,
  }
}

/*
 * 场景构建管线主入口（SPEC 4.1 / 4.2 / 任务约束）。
 *
 * 调用方契约：
 *   - request：主线程的 build 请求上下文，requestId 由调用方保证单调递增；管线只回传，
 *     不判断结果是否过期（任务约束：当前请求归属由 application 层统一决定）。
 *   - sampleUrl：唯一运行时样本 URL（入口固定传入 SAMPLE_RUNTIME_URL，SPEC 3.1）。
 *   - deps：fetch / send / now 的依赖注入（见 SceneBuildDeps）。
 *   - 返回 Promise<void>：所有结果通过 deps.send 异步报告；主线程按消息驱动状态机。
 *
 * 消息顺序（正常路径）：
 *   progress(loading, null)
 *   → progress(preparing, parsing)
 *   → progress(preparing, validating)
 *   → progress(preparing, building)
 *   → success（附带 transfer list）。
 *
 * 失败原子性：任一阶段失败发送对应 failure 消息后立即返回，不再发送后续消息、
 *   不发送 success、不发送部分 SceneModel。
 */
export async function runSceneBuild(
  request: { readonly requestId: SceneBuildRequestId },
  sampleUrl: string,
  deps: SceneBuildDeps,
): Promise<void> {
  const requestId = request.requestId
  // 阶段耗时累加器（内部可变）；最终随 success 消息以只读 SceneBuildTimings 视图交付。
  // 不显式标注为 SceneBuildTimings（其字段 readonly 会阻止累加赋值），
  // 结构兼容即可：可变对象可赋给 readonly 字段（readonly 只约束消费方）。
  const timings = {
    fetch: 0,
    parse: 0,
    validate: 0,
    build: 0,
  }

  // —— 阶段 1：loading。报告加载阶段，请求唯一运行时样本 URL（SPEC 3.1 / 4.2 / 任务约束）。——
  deps.send(progress(requestId, SCENE_BUILD_PHASE.LOADING, null))

  let responseText: string
  try {
    const fetchStart = deps.now()
    const response = await deps.fetch(sampleUrl)
    timings.fetch = deps.now() - fetchStart
    // 非 2xx 响应：SAMPLE_FETCH_FAILED，整体终止，不读取响应体、不进入解析。
    if (!response.ok) {
      deps.send(
        buildFetchFailure(requestId, `样本请求失败：HTTP 状态码 ${response.status}。`, {
          status: response.status,
        }),
      )
      return
    }
    // 响应体读取失败（连接中断等）：仍归 SAMPLE_FETCH_FAILED，整体终止。
    try {
      responseText = await response.text()
    } catch (readErr) {
      deps.send(
        buildFetchFailure(requestId, `样本响应体不可读：${describeError(readErr)}。`),
      )
      return
    }
  } catch (fetchErr) {
    // 网络错误（fetch reject）：SAMPLE_FETCH_FAILED，整体终止（SPEC 14.1）。
    deps.send(buildFetchFailure(requestId, `样本请求失败：${describeError(fetchErr)}。`))
    return
  }

  // —— 阶段 2a：preparing / parsing。JSON.parse 字符串 → JS 对象。 ——
  deps.send(progress(requestId, SCENE_BUILD_PHASE.PREPARING, SCENE_BUILD_STAGE.PARSING))

  let parsed: unknown
  try {
    const parseStart = deps.now()
    parsed = JSON.parse(responseText)
    timings.parse = deps.now() - parseStart
  } catch (parseErr) {
    // JSON 无法解析：SAMPLE_JSON_INVALID，整体终止，不进入校验与构建。
    deps.send(buildParseFailure(requestId, `样本不是合法 JSON：${describeError(parseErr)}。`))
    return
  }

  // —— 阶段 2b：preparing / validating。响应包校验 + 实体语义校验 + 一次性坐标归一化。 ——
  // parseSampleEnvelope（TASK-003）/ validateMapSemantics（TASK-004）/ normalizeSceneMap（TASK-005）
  // 任一失败都透传其稳定错误码；normalizeSceneMap 的 source bounds 退化也在此阶段以
  // MAP_GEOMETRY_INVALID 终止。
  deps.send(progress(requestId, SCENE_BUILD_PHASE.PREPARING, SCENE_BUILD_STAGE.VALIDATING))

  let sceneMap: SceneMap
  try {
    const validateStart = deps.now()
    const rawMap = parseSampleEnvelope(parsed)
    validateMapSemantics(rawMap)
    sceneMap = normalizeSceneMap(rawMap)
    timings.validate = deps.now() - validateStart
  } catch (validateErr) {
    // 响应包 / 实体 / 几何前置校验失败：透传 TASK-003～TASK-005 稳定错误码与定位，整体终止。
    deps.send(buildMapDataFailure(requestId, validateErr, 'validate'))
    return
  }

  // —— 阶段 2c：preparing / building。轨迹 / ribbon / 实例 / 标签 / bounds 构建与交付前自校验。 ——
  // buildSceneModel（TASK-012）任一子系统构建或汇总自校验不一致都整体拒绝，不返回部分模型。
  deps.send(progress(requestId, SCENE_BUILD_PHASE.PREPARING, SCENE_BUILD_STAGE.BUILDING))

  let model: SceneModel
  try {
    const buildStart = deps.now()
    model = buildSceneModel(sceneMap)
    timings.build = deps.now() - buildStart
  } catch (buildErr) {
    // 场景模型构建或自校验失败：MAP_GEOMETRY_INVALID，整体终止，不返回部分模型。
    deps.send(buildMapDataFailure(requestId, buildErr, 'build'))
    return
  }

  // —— 阶段 3：成功。transfer list 覆盖且仅覆盖 SceneModel 每个 ArrayBuffer，每个恰好一次。 ——
  // collectTransferableBuffers 已校验无重复 ArrayBuffer 与全部为 ArrayBuffer；此处只搬运，
  // 不再访问 model 内部。send 成功转移后本函数立即返回，不再访问已转移的 typed array
  // 或 ArrayBuffer（SPEC 4.3 postMessage 转移后 worker 侧缓冲区已分离）。
  const transfer = collectTransferableBuffers(model)
  const success: SceneBuildSuccess = {
    type: 'success',
    requestId,
    model,
    timings,
  }
  deps.send(success, transfer)
}
