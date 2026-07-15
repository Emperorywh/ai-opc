/// <reference lib="webworker" />
import {
  DEFAULT_LANE_GROUPING_CONFIG,
  DEFAULT_NODE_DIMENSIONS_CONFIG,
  DEFAULT_PATH_RIBBON_CONFIG,
  DEFAULT_SAMPLING_CONFIG,
} from '../config/geometryConfig'
import { verifyAssetIntegrity } from '../infrastructure/assetIntegrity'
import { runMapCompilation, type CompilationDeps } from './mapCompilerCore'
import { collectPacketTransferables } from './packetTransfer'
import type {
  CompileRequest,
  CompilationEvent,
  FromWorkerMessage,
  ToWorkerMessage,
} from '../domain/compilerProtocol'

/**
 * 后台地图编译 Worker 入口（SPEC §5.2、§5.4、TASK-007）。
 *
 * 职责：接收主线程编译请求，调用 runMapCompilation 完成下载、校验、规范化与几何编译，
 * 把每个事件原样转发回主线程。成功时把 RenderPacket 的全部 ArrayBuffer 转移所有权，
 * 不复制大块缓冲（SPEC §5.4）。
 *
 * 不变量：
 * - 每条回复携带请求的 requestId，主线程据此隔离过期会话（SPEC §5.4）。
 * - 下载使用 fetch 的 ReadableStream 分块读取，按已读字节数上报真实下载进度。
 * - Worker 不持有 React 状态、不读写全局可变对象；一次请求处理完即等待下一条。
 */

/** Worker 自引用（module Worker 中 self 即 DedicatedWorkerGlobalScope）。 */
const ctx = self as unknown as DedicatedWorkerGlobalScope

/**
 * 用 fetch 流式下载资产字节，按已读字节经 onProgress 上报。
 *
 * 进度分母不由下载层决定：核心把已读字节绑定到固定契约字节数（ASSET_SIZE_BYTES），
 * 因此此处只上报 received，不读取也不依赖 Content-Length——缺失或错误的 Content-Length
 * 不会影响进度单调，实际字节总数最终由完整性校验裁决（SPEC §10.1、TASK-007）。
 * signal 中止时 fetch 自然 reject 为 AbortError。
 */
const fetchBytes: CompilationDeps['fetchBytes'] = async (url, signal, onProgress) => {
  const response = await fetch(url, { signal })
  if (!response.ok) {
    throw new Error(`资产下载失败：HTTP ${response.status} ${response.statusText}`)
  }

  if (response.body === null) {
    // 无流 body（如 data: URL 或被 polyfill）：一次性读取，按已读总字节报告进度。
    const buffer = await response.arrayBuffer()
    const bytes = new Uint8Array(buffer)
    onProgress(bytes.byteLength)
    return bytes
  }

  const reader = response.body.getReader()
  const chunks: Uint8Array<ArrayBuffer>[] = []
  let received = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    if (value) {
      chunks.push(value as Uint8Array<ArrayBuffer>)
      received += value.byteLength
      onProgress(received)
    }
  }

  // 合并分块为单一连续 Uint8Array，供完整性校验与 JSON 解码消费。
  const merged = new Uint8Array(received)
  let offset = 0
  for (const chunk of chunks) {
    merged.set(chunk, offset)
    offset += chunk.byteLength
  }
  return merged
}

/** 把编译事件包装为 Worker 消息并回传；成功事件附带全部数据包缓冲的转移列表（SPEC §5.4）。 */
function postEvent(requestId: number, event: CompilationEvent): void {
  const message: FromWorkerMessage = { type: 'event', requestId, event }
  if (event.kind === 'success') {
    ctx.postMessage(message, collectPacketTransferables(event.packet))
  } else {
    ctx.postMessage(message)
  }
}

/** 处理单条编译请求：运行核心编排并把事件流回传主线程。 */
async function handleCompile(request: CompileRequest): Promise<void> {
  const controller = new AbortController()
  // Worker 收到的消息没有内建取消指令；主线程通过 terminate() 终止整个 Worker 来中止。
  // 此处 controller 仅用于在内部链路传递取消语义（保留扩展点）。
  const deps: CompilationDeps = { fetchBytes, verifyIntegrity: verifyAssetIntegrity }
  await runMapCompilation(
    request.assetUrl,
    controller.signal,
    (event) => postEvent(request.requestId, event),
    deps,
    {
      sampling: DEFAULT_SAMPLING_CONFIG,
      laneGrouping: DEFAULT_LANE_GROUPING_CONFIG,
      ribbon: DEFAULT_PATH_RIBBON_CONFIG,
      nodeDimensions: DEFAULT_NODE_DIMENSIONS_CONFIG,
    },
  )
}

ctx.addEventListener('message', (event: MessageEvent<ToWorkerMessage>) => {
  const message = event.data
  if (message?.type !== 'compile') return
  // 不 await：Worker 的事件处理不应阻塞下一条消息接收；错误已在核心内部消化。
  // 附加兜底 catch：runMapCompilation 设计上永不 reject（全部错误经 emit 上报），
  // 此处仅防御性地吞掉极端情况下 postMessage 抛出导致的泄漏，保证无未处理异步拒绝
  // （SPEC §5.4、TASK-007）。
  void handleCompile(message).catch(() => {
    /* 无法上报的极端错误：忽略，避免未处理拒绝 */
  })
})
