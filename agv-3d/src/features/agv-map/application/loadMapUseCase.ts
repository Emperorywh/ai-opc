import type { MapCompilerClient } from '../infrastructure/mapCompilerWorker'
import type { CompilationErrorCode, CompilationEvent } from '../worker/mapCompilerProtocol'
import type { MapLoadErrorCode } from './loadState'
import { LoadSessionController } from './loadSession'

/**
 * 后台地图加载用例（SPEC §5.2、§5.3、§5.4、TASK-007）。
 *
 * 该用例是 application 层的"加载用例与显式状态机驱动"：把 Worker 编译事件流
 * 翻译为状态机命令，驱动 LoadSessionController 从 downloading 推进到 ready 或 error。
 * 它是展示层与（Worker 适配器 + 纯状态机）之间的编排者，本身不持有 React 状态、
 * 不直接接触 Worker API 或原始 JSON。
 *
 * 不变量：
 * - 会话隔离：仅当事件携带的 requestId 等于当前会话且会话仍活跃时才写入状态；
 *   过期、取消或被取代的事件一律丢弃（SPEC §5.4）。
 * - 阶段顺序：按事件顺序驱动状态机——下载进度→解析→校验→节点编译→路径编译→挂载数据包；
 *   进度始终单调，非法跃迁由状态机拒绝。
 * - 资源归一：dispose() 同时取消会话与终止 Worker，保证卸载后后台执行单元归零
 *   （SPEC §5.4、TASK-007）。
 */

/** Worker 错误码到状态机错误码的稳定映射（SPEC §10.2、§5.1 单向依赖）。 */
const ERROR_CODE_MAP: Readonly<Record<CompilationErrorCode, MapLoadErrorCode>> = {
  DOWNLOAD_FAILED: 'ASSET_DOWNLOAD_FAILED',
  INTEGRITY_FAILED: 'ASSET_INTEGRITY_FAILED',
  PARSE_FAILED: 'JSON_PARSE_FAILED',
  VALIDATION_FAILED: 'SCHEMA_VALIDATION_FAILED',
  COMPILE_FAILED: 'GEOMETRY_COMPILE_FAILED',
  // 不可预期错误归属编译失败阶段；状态机会以当前活跃阶段写入 error.stage。
  UNEXPECTED_ERROR: 'GEOMETRY_COMPILE_FAILED',
}

/** 后台加载句柄：dispose 立即中止会话并回收 Worker。 */
export interface BackgroundMapLoadHandle {
  readonly requestId: number
  /** 取消会话、终止 Worker；幂等，多次调用安全。 */
  dispose(): void
}

/**
 * 启动一次后台地图加载，返回可 dispose 的句柄。
 *
 * 调用方负责在组件卸载或显式取消时调用 handle.dispose()，以中止下载、终止 Worker
 * 并隔离后续过期结果。Worker 编译与状态机推进全部在事件回调中异步发生，调用方
 * 通过订阅 LoadSessionController 观察状态变化。
 *
 * @param controller 加载会话控制器（单一有效会话、取消与过期隔离）。
 * @param client 编译 Worker 客户端；用例完成后由 dispose 终止。
 * @param assetUrl 自托管地图资产 URL。
 */
export function startBackgroundMapLoad(
  controller: LoadSessionController,
  client: MapCompilerClient,
  assetUrl: string,
): BackgroundMapLoadHandle {
  // 启动新会话：递增 requestId、重置状态为 downloading 初始态，隔离旧会话结果。
  const requestId = controller.start()
  // 本地阶段镜像：与状态机阶段同步推进，用于判定何时需要 advance 到下一阶段。
  // 仅在命令成功采纳后更新，保证镜像与状态机一致。
  let phase: LoadPhase = 'downloading'

  client.start({ type: 'compile', requestId, assetUrl }, (rid, event) => {
    // 过期或已取消的会话结果一律丢弃，绝不覆盖当前状态（SPEC §5.4）。
    if (rid !== requestId || !controller.isActive(requestId)) return
    applyEvent(controller, requestId, event, (next) => {
      phase = next
    }, phase)
  })

  return {
    requestId,
    dispose() {
      // 先取消会话（冻结状态、拒绝后续写入），再终止 Worker（中止下载与微任务）。
      controller.cancel()
      client.terminate()
    },
  }
}

/** 用例内部跟踪的阶段镜像，仅含活跃阶段（不含 creating-scene/fading 终态准备）。 */
type LoadPhase = 'downloading' | 'parsing' | 'validating' | 'compiling-nodes' | 'compiling-paths'

/**
 * 把单条编译事件翻译为状态机命令序列并应用，推进 phase 镜像。
 *
 * 命令始终以当前会话 requestId 提交；若会话已失效，controller.apply 返回 'stale'，
 * phase 镜像不再更新，后续事件也已被外层 isActive 守卫拦截。
 */
function applyEvent(
  controller: LoadSessionController,
  requestId: number,
  event: CompilationEvent,
  advancePhase: (next: LoadPhase) => void,
  phase: LoadPhase,
): void {
  switch (event.kind) {
    case 'download-progress':
      // 下载进度按已读字节占比映射到 downloading 区间（0%～30%）。
      if (phase === 'downloading' && event.total > 0) {
        controller.apply(
          { type: 'report-progress', fraction: event.received / event.total },
          requestId,
        )
      }
      return

    case 'parse':
      if (event.stage === 'parse-start' && phase === 'downloading') {
        if (controller.apply({ type: 'advance', to: 'parsing' }, requestId) === 'applied') {
          advancePhase('parsing')
        }
      } else if (event.stage === 'parse-done' && phase === 'parsing') {
        if (controller.apply({ type: 'advance', to: 'validating' }, requestId) === 'applied') {
          advancePhase('validating')
        }
      }
      return

    case 'validate-progress':
      // 校验进度按已处理节点+边占比映射到 validating 区间（30%～40%）。
      if (phase === 'validating' && event.total > 0) {
        controller.apply(
          { type: 'report-progress', fraction: event.processed / event.total },
          requestId,
        )
      }
      return

    case 'compile-progress': {
      // 节点/路径编译阶段首次事件先 advance，再按已处理记录数报告进度。
      if (event.report.phase === 'nodes' && phase === 'validating') {
        if (controller.apply({ type: 'advance', to: 'compiling-nodes' }, requestId) === 'applied') {
          advancePhase('compiling-nodes')
        }
      } else if (event.report.phase === 'paths' && phase === 'compiling-nodes') {
        if (controller.apply({ type: 'advance', to: 'compiling-paths' }, requestId) === 'applied') {
          advancePhase('compiling-paths')
        }
      }
      if (event.report.total > 0) {
        controller.apply(
          { type: 'report-progress', fraction: event.report.processed / event.report.total },
          requestId,
        )
      }
      return
    }

    case 'success':
      // 挂载渲染数据包，进入 creating-scene 准备阶段（SPEC §5.3）。
      // 大块 TypedArray 经 Worker transfer 零拷贝到达，此处不再复制。
      controller.apply({ type: 'attach-packet', packet: event.packet }, requestId)
      return

    case 'error':
      controller.apply(
        {
          type: 'fail',
          code: ERROR_CODE_MAP[event.code],
          message: event.message,
          details: event.details,
        },
        requestId,
      )
      return
  }
}
