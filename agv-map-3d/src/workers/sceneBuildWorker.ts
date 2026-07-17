/*
 * 场景构建 worker 浏览器入口（workers 层，SPEC 3.1 / 4.1 / 4.3 / 任务约束）。
 *
 * 信任边界定位（TASK-013）：
 *   - 本模块是 scene-build worker 的浏览器入口：监听主线程请求，委托纯函数管线
 *     runSceneBuild 完成 fetch → JSON.parse → 严格校验 → 场景模型构建，再通过
 *     postMessage 转移结果。本文件只做 I/O 装配，不含可测试的领域逻辑。
 *   - 所有解析、校验、几何构建与消息构造都在 sceneBuildPipeline 内（依赖注入使其
 *     在 node 测试中可独立验证）；本入口把它们绑定到 DedicatedWorkerGlobalScope。
 *   - 本入口只运行在 worker 上下文，由 Vite worker 打包器按独立 chunk 生成（SPEC 3.1）；
 *     不被主线程或 node 测试直接 import，避免顶层 self 访问污染测试环境。
 *
 * I/O 装配（任务约束）：
 *   - fetch：全局 fetch，只请求 SAMPLE_RUNTIME_URL（唯一运行时样本 URL，SPEC 3.1）。
 *   - send：self.postMessage，success 消息附带 transfer list（覆盖每个 ArrayBuffer）。
 *   - now：performance.now，用于阶段耗时（SPEC 14.2）。
 */
import { runSceneBuild } from './sceneBuildPipeline'
import { SAMPLE_RUNTIME_URL } from './sampleSource'
import type { SceneBuildRequest } from './sceneBuildProtocol'

/*
 * DedicatedWorkerGlobalScope 的最小运行时视图。
 * 收敛全局 self，避免 TS DOM lib 把 self 推断为 Window（Window.postMessage 的签名
 * 是 (message, targetOrigin, transfer?)，与 worker 的 (message, transfer) 不同）。
 * 运行时 self 实为 DedicatedWorkerGlobalScope，具备 postMessage(message, transfer)、
 * fetch、performance 与 message 事件，本接口只声明管线需要的最小子集。
 */
interface SceneBuildWorkerRuntime {
  postMessage(message: unknown, transfer: ArrayBuffer[]): void
  fetch(input: string): Promise<Response>
  readonly performance: { now(): number }
  addEventListener(type: 'message', listener: (event: MessageEvent) => void): void
}

const runtime = self as unknown as SceneBuildWorkerRuntime

/*
 * 监听主线程 build 请求：校验消息形状后委托管线（SPEC 4.1 / 4.2）。
 *
 * 消息形状校验：只接受 type === 'build' 的请求；非法形状静默忽略（不抛错、不回复），
 * 避免污染协议——application 层（后续 TASK）只发送合规请求，本入口不做协议外兜底。
 * requestId 原样传入管线，由管线在每条回复中回传；当前请求归属由 application 层统一决定。
 */
runtime.addEventListener('message', (event: MessageEvent) => {
  const data = event.data as SceneBuildRequest | null
  if (data === null || typeof data !== 'object' || data.type !== 'build') {
    return
  }
  // 委托管线：fetch / send / now 注入 worker 全局实现。runSceneBuild 内部完成全部阶段
  // 编排、失败原子性与缓冲区转移；本入口在 send（postMessage）成功转移后不再访问 model。
  void runSceneBuild(
    { requestId: data.requestId },
    SAMPLE_RUNTIME_URL,
    {
      fetch: (url) => runtime.fetch(url),
      send: (message, transfer) => {
        // postMessage transfer list 只接受 ArrayBuffer[]；success 消息附带 8 个缓冲区，
        // 其余消息不转移（transfer 为 undefined）。transfer 经 collectTransferableBuffers
        // 给出，无重复、全部为 ArrayBuffer。
        runtime.postMessage(message, transfer ? [...transfer] : [])
      },
      now: () => runtime.performance.now(),
    },
  )
})
