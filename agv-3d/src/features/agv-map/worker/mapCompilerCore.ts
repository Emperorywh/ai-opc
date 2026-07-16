import { ASSET_SIZE_BYTES, type AssetIntegrityResult } from '../domain/assetContract'
import type { CompileProgressReport, RenderPacket } from '../domain/renderPacket'
import { normalizeMap } from '../domain/normalize'
import { validateRawMapAsset } from '../domain/validation'
import { GeometryCompileError } from '../geometry/pathSampling'
import { compileRenderPacket, type SceneCompileConfigs } from '../geometry/sceneCompile'
import type { CompilationEvent, CompilationErrorCode } from '../domain/compilerProtocol'

/**
 * 后台地图编译核心编排（SPEC §5.2、§10.1、TASK-007）。
 *
 * 该函数把"下载 → 完整性校验 → 解析 → 严格校验 → 规范化 → 几何编译"串成单一编排，
 * 并通过 emit 回调向上报告真实阶段与已处理记录数。它是环境无关的纯逻辑：
 * - 下载字节经 deps.fetchBytes 注入，使纯 Node 环境可用伪造 fetch 验证全流程；
 * - 完整性校验经 deps.verifyIntegrity 注入，Worker 注入基于 Web Crypto 的真实实现，
 *   测试可注入直通实现以单独验证解析/校验错误路径；
 * - 解析、校验、规范化、几何编译全部复用 domain/geometry 的纯函数。
 *
 * 不变量：
 * - 永不向调用方抛出：所有错误（含中止）都在内部捕获并经 emit('error') 上报，
 *   返回的 Promise 恒为已决，避免未处理的异步拒绝（SPEC §5.4、TASK-007）。
 * - 中止静默：AbortSignal 触发时立即停止并不再 emit 任何事件，
 *   因为调用方取消意味着会话已失效，后续结果不应再写入状态。
 * - 进度单调：emit 顺序固定为下载 → 解析(离散) → 校验 → 节点编译 → 路径编译，
 *   各阶段 fraction 始终在 [0,1] 且单调不下降，交由应用层状态机保证全局单调。
 *
 * 依赖方向（SPEC §5.1）：位于 worker 层，仅依赖 domain 与 geometry；
 * 完整性校验结果类型（AssetIntegrityResult）归属 domain，运行时实现由 Worker 注入，
 * 核心不依赖 infrastructure 模块。
 */

/** 事件发射器：把编译事件交给调用方（Worker 转发主线程，或测试直接收集）。 */
export type CompilationEmitter = (event: CompilationEvent) => void

/**
 * 编译所需的可注入依赖。
 *
 * fetchBytes 与 verifyIntegrity 均由 Worker 注入为基于浏览器 API 的真实实现；
 * 测试中注入伪造/直通实现，使全流程（含解析、校验错误路径）可在 Node 验证。
 */
export interface CompilationDeps {
  /**
   * 下载资产字节，按已读字节数经 onProgress 上报。
   * 进度分母不由此处决定：核心把已读字节绑定到固定契约字节数 ASSET_SIZE_BYTES，
   * 因此 onProgress 只需报告 received，无需也不应依赖 Content-Length（SPEC §10.1、TASK-007）。
   * 必须在 signal 中止时 reject（AbortError），使核心进入静默中止路径。
   */
  readonly fetchBytes: (
    url: string,
    signal: AbortSignal,
    onProgress: (received: number) => void,
  ) => Promise<Uint8Array<ArrayBuffer>>

  /**
   * 校验资产字节数与 SHA-256 是否匹配契约指纹（SPEC §10.1）。
   * Worker 注入基于 Web Crypto 的真实实现；测试可注入直通实现绕过指纹，
   * 以便单独驱动 PARSE_FAILED / VALIDATION_FAILED 等后续错误路径。
   */
  readonly verifyIntegrity: (bytes: Uint8Array<ArrayBuffer>) => Promise<AssetIntegrityResult>
}

/**
 * 运行完整后台地图编译。
 *
 * 成功路径以 emit({ kind: 'success', packet }) 结束；失败路径以 emit({ kind: 'error', ... }) 结束。
 * 任一情况下返回的 Promise 都已决议，调用方无需再附加 catch。
 */
export async function runMapCompilation(
  assetUrl: string,
  signal: AbortSignal,
  emit: CompilationEmitter,
  deps: CompilationDeps,
  configs: SceneCompileConfigs,
): Promise<void> {
  try {
    // —— 下载（downloading 阶段：0%～30%，按 已读字节 / 契约字节数 映射）——
    // 进度分母固定为资产契约字节数 ASSET_SIZE_BYTES（SPEC §10.1、TASK-007），不依赖运行时
    // Content-Length：缺失或错误的 Content-Length 不会把首块误报为 100%，实际字节总数最终
    // 由完整性校验裁决。fetchBytes 只上报已读字节，total 在此绑定为固定基线。
    // 下载错误单独捕获并归为 DOWNLOAD_FAILED，不与后续阶段错误混淆。
    let bytes: Uint8Array<ArrayBuffer>
    try {
      bytes = await deps.fetchBytes(assetUrl, signal, (received) => {
        emit({ kind: 'download-progress', received, total: ASSET_SIZE_BYTES })
      })
    } catch (downloadError) {
      if (signal.aborted || isAbortError(downloadError)) return
      emit({
        kind: 'error',
        code: 'DOWNLOAD_FAILED',
        message: '地图资产下载失败',
        details: [describeError(downloadError)],
      })
      return
    }
    if (signal.aborted) return

    // —— 完整性校验（解析前核对字节数与 SHA-256，SPEC §10.1）——
    const integrity = await deps.verifyIntegrity(bytes)
    if (signal.aborted) return
    if (!integrity.ok) {
      emit({
        kind: 'error',
        code: 'INTEGRITY_FAILED',
        message: '地图资产字节数或 SHA-256 与契约指纹不符',
        details: [
          `期望 size=${integrity.expectedSize}，实际 size=${integrity.actualSize}`,
          `期望 sha256=${integrity.expectedSha256}`,
          `实际 sha256=${integrity.actualSha256}`,
        ],
      })
      return
    }

    // —— 解析（parsing 阶段：离散开始/完成，不伪造连续进度）——
    emit({ kind: 'parse', stage: 'parse-start' })
    const text = decodeUtf8(bytes)
    let parsed: unknown
    try {
      parsed = JSON.parse(text)
    } catch (error) {
      emit({
        kind: 'error',
        code: 'PARSE_FAILED',
        message: '地图资产 JSON 解析失败',
        details: [describeError(error)],
      })
      return
    }
    if (signal.aborted) return
    emit({ kind: 'parse', stage: 'parse-done' })

    // —— 严格校验与规范化（validating 阶段：30%～40%，按节点+边记录数映射）——
    const problems = validateRawMapAsset(parsed, (processed, total) => {
      emit({ kind: 'validate-progress', processed, total })
    })
    if (signal.aborted) return
    if (problems.length > 0) {
      emit({
        kind: 'error',
        code: 'VALIDATION_FAILED',
        message: '地图数据结构校验未通过',
        details: problems.map((p) => `${p.path || '<root>'}:${p.code} ${p.message}`),
      })
      return
    }
    // 校验通过后规范化为领域模型；契约外字段在此被显式丢弃（SPEC §4.3）。
    const model = normalizeMap(extractPayloadAssumingValid(parsed))

    // —— 几何编译（compiling-nodes 40%～55%、compiling-paths 55%～90%）——
    // 节点进度先于路径进度上报，匹配状态机阶段顺序；采样与分组为共享前置不计入进度百分比。
    // 进入编译段先发一条 processed=0 的节点进度：使应用层状态机从 validating 跃迁到
    // compiling-nodes。采样/分组虽不计入进度，但已属于几何编译阶段——若前置在此抛出
    // （如贝塞尔细分上限耗尽），error.stage 应归属编译阶段而非 validating，保持
    // error.code（GEOMETRY_COMPILE_FAILED）与诊断阶段一致（SPEC §10.1、§10.2、TASK-007）。
    emit({
      kind: 'compile-progress',
      report: { phase: 'nodes', processed: 0, total: model.nodes.length },
    })
    let packet: RenderPacket
    try {
      packet = compileRenderPacket(model, configs, (report: CompileProgressReport) => {
        emit({ kind: 'compile-progress', report })
      })
    } catch (error) {
      // 几何编译错误（零长度段、非法扁带等）携带可定位上下文，映射为 COMPILE_FAILED。
      const details =
        error instanceof GeometryCompileError
          ? [`code=${error.code}`, error.message, error.edgeId ? `edge=${error.edgeId}` : ''].filter(
              Boolean,
            )
          : [describeError(error)]
      emit({
        kind: 'error',
        code: 'COMPILE_FAILED',
        message: '地图几何编译失败',
        details,
      })
      return
    }
    if (signal.aborted) return

    emit({ kind: 'success', packet })
  } catch (error) {
    // 中止：静默返回，不 emit；调用方已使会话失效。
    if (signal.aborted || isAbortError(error)) return
    // 到达此处说明下载之后的某一步抛出了未被局部捕获的异常（完整性计算、规范化等），
    // 属于不可预期错误，归为 UNEXPECTED_ERROR；应用层将其映射为 GEOMETRY_COMPILE_FAILED。
    const code: CompilationErrorCode = 'UNEXPECTED_ERROR'
    emit({
      kind: 'error',
      code,
      message: '地图编译过程发生不可预期错误',
      details: [describeError(error)],
    })
  }
}

/**
 * 把校验通过的 rawAsset 还原为 RawMapPayload 形状以供规范化。
 *
 * 校验已保证 data.currentMapInfoVersion.mapJson 路径存在且形状合法，
 * 此处沿用与 validation 一致的取数路径，不引入第二次校验或容忍逻辑。
 */
function extractPayloadAssumingValid(rawAsset: unknown): Parameters<typeof normalizeMap>[0] {
  const cursor = rawAsset as {
    data: { currentMapInfoVersion: { mapJson: Parameters<typeof normalizeMap>[0] } }
  }
  return cursor.data.currentMapInfoVersion.mapJson
}

/** 把字节序列按 UTF-8 解码为字符串；TextDecoder 在浏览器与 Node 均原生可用。 */
function decodeUtf8(bytes: Uint8Array<ArrayBuffer>): string {
  return new TextDecoder('utf-8').decode(bytes)
}

/** 提取错误的可读描述，避免把非字符串 message 透传到结构化 details。 */
function describeError(error: unknown): string {
  if (error instanceof Error) return error.message || error.name
  if (typeof error === 'string') return error
  try {
    return JSON.stringify(error)
  } catch {
    return String(error)
  }
}

/** 判定错误是否为 AbortSignal 中止引起的 AbortError（各运行时名称不一）。 */
function isAbortError(error: unknown): boolean {
  if (error instanceof DOMException && error.name === 'AbortError') return true
  if (error instanceof Error && error.name === 'AbortError') return true
  return false
}
