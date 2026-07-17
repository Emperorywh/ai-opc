/*
 * 应用加载状态机的依赖注入端口（application 层，SPEC 3.3 / 4.2 / 4.3 / 13 / 14.1 / 任务约束）。
 *
 * 信任边界定位（TASK-016）：
 *   - application 层禁止依赖 rendering / scene / camera / ui / three（SPEC 3.3 分层策略），
 *     因此 worker 创建 / 终止、Three 资源创建、字体预加载与字形清单等跨层能力，
 *     一律以端口形式由后续 app-root / scene 装配层注入，本层只面向端口契约编程。
 *   - 端口只描述“做什么”，不描述“用什么实现”：浏览器装配层注入真实 Worker / createMapResources /
 *     Troika preloadFont；node 测试注入纯内存模拟，从而在不启动浏览器的前提下驱动状态机。
 *   - 端口不返回 application 层不可识别的对象：资源类型泛型 TResource 约束为 DisposableResource，
 *     application 只通过 dispose() 释放，不访问其 Three 内部结构。
 *
 * 与既有边界的关系：
 *   - LabelFontPreloadPort 已在 labels 层定义（TASK-015）；application 允许依赖 labels 层，
 *     故直接复用其契约，不在本层重复定义第二套字体端口。
 *   - SceneBuildMessage / SceneModel / SceneBuildRequestId 由 workers 层协议（TASK-013）定义，
 *     本层 worker 端口只搬运这些不可变消息，不发明第二套协议。
 */
import type { LabelFontPreloadPort } from '../labels/fontPreload'
import type { SceneModel } from '../workers/buildSceneModel'
import type {
  SceneBuildMessage,
  SceneBuildRequestId,
} from '../workers/sceneBuildProtocol'
import type { DisposableResource } from './loadState'

/*
 * 场景构建 worker 端口（抽象浏览器 Worker 的创建、消息与终止）。
 *
 * 生命周期契约（SPEC 4.3 / 任务约束）：
 *   - start：创建（或复用）一个全新 worker，postMessage 一条 build 请求（携带 requestId），
 *     并把 worker → 主线程消息路由给 onMessage。同一端口实例只在“当前请求”存活。
 *   - terminate：终止当前 worker（若存在），幂等；终止后不再向旧 onMessage 投递任何消息。
 *   - isRunning：是否仍有活跃 worker，供测试与诊断观察“worker 不单调增长”。
 *
 * 竞态配合：旧 worker 在 start / terminate 后其 in-flight 消息仍可能到达；这些消息携带旧
 * requestId，由 orchestrator + reducer 按当前 requestId 统一丢弃，端口不做请求归属判定。
 */
export interface SceneBuildWorkerPort {
  start(
    requestId: SceneBuildRequestId,
    onMessage: (message: SceneBuildMessage) => void,
  ): void
  terminate(): void
  readonly isRunning: boolean
}

/*
 * Three 资源创建端口（抽象 rendering 层 createMapResources）。
 *
 * 契约（TASK-014 / 任务约束）：
 *   - create：输入已自校验的 SceneModel，返回一个可释放的资源集合（MapResources 或等价物）。
 *   - 成功：resolve 为资源；失败：reject 为 MapDataError（整体拒绝，不返回部分集合）。
 *   - 返回 Promise 而非同步值：资源准备与字体预加载同为 preparing 门禁，可按任意顺序完成，
 *     便于测试“最后一道门禁完成前始终保持 preparing”。
 *
 * 资源所有权：create 成功产出的资源所有权移交给 orchestrator；过期请求产出的资源由
 * orchestrator 直接 dispose，不进入状态（任务“过期成功结果不得进入资源适配或状态”）。
 */
export interface MapResourceFactoryPort<TResource extends DisposableResource> {
  create(model: SceneModel): Promise<TResource>
}

/*
 * 本地字体预加载配置（由装配层从 config / 字形清单注入，application 不解析 JSON / 不读 config）。
 *
 * - manifestCodePoints：public/fonts/glyphs.json 派生的只读码点集合（TASK-015 parseGlyphManifest 产出）。
 * - fontUrl：本地字体 URL（config LABEL_FONT_URL，禁止远端）。
 * - sdfGlyphSize：SDF 字形尺寸（config LABEL_FONT_SDF_GLYPH_SIZE = 64）。
 * application 层不依赖 config（SPEC 3.3 分层），故三者均由装配层注入。
 */
export interface LoadFontConfig {
  readonly manifestCodePoints: ReadonlySet<number>
  readonly fontUrl: string
  readonly sdfGlyphSize: number
}

/*
 * 加载编排器完整依赖（任务“以可控 worker、资源和字体端口启动请求”）。
 *
 * - workerPort / resourceFactory：上述端口实现。
 * - fontPort：Troika preloadFont 的端口实现（TASK-015 LabelFontPreloadPort）。
 * - fontConfig：字体预加载配置（码点集合 + 本地 URL + SDF 尺寸）。
 * orchestrator 据此编排 worker 请求、资源准备与字体预加载三道门禁。
 */
export interface LoadOrchestratorConfig<TResource extends DisposableResource> {
  readonly workerPort: SceneBuildWorkerPort
  readonly resourceFactory: MapResourceFactoryPort<TResource>
  readonly fontPort: LabelFontPreloadPort
  readonly fontConfig: LoadFontConfig
}
