import type { CompilationEvent, CompileRequest } from '../domain/compilerProtocol'

/**
 * 后台地图编译端口：应用层拥有的协作契约（SPEC §5.1、TASK-006）。
 *
 * 这是面向基础设施的窄应用边界：应用层加载用例只依赖该端口，不反向依赖基础设施具体实现。
 * infrastructure 层的 MapCompilerClient 实现该端口（SPEC §5.1 允许 infrastructure→application），
 * 由展示层在组合根处把具体适配器注入应用层协调器。
 *
 * 不变量：
 * - 端口只暴露"发起编译 + 终止"两项能力；事件回调把编译进度与结果交还应用层，
 *   由加载用例配合会话控制器隔离过期结果（SPEC §5.4）。
 * - terminate 幂等：多次调用安全，终止后该实例不再可用，新会话由调用方创建新适配器。
 */
export interface MapCompilerPort {
  /**
   * 发起一次编译并注册事件回调。每条事件携带请求时的 requestId，便于上层做会话隔离。
   * 同一适配器同一时间只承载一个有效监听；再次 start 会覆盖前一次回调与 requestId。
   */
  start(
    request: CompileRequest,
    onEvent: (requestId: number, event: CompilationEvent) => void,
  ): void

  /**
   * 终止后台编译并释放底层执行单元（Worker）。终止是中止在途下载与后台微任务的唯一可靠手段；
   * 幂等，多次调用安全。终止后该实例不可再用，新会话须由调用方创建新适配器。
   */
  terminate(): void
}
