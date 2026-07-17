/*
 * 浏览器运行时端口装配（app-root 层，SPEC 3.1 / 3.3 / 4.1 / 4.2 / 4.3 / 11.1 / 任务约束）。
 *
 * 定位（TASK-018）：
 *   - application 层禁止依赖 rendering / three / worker / troika / 浏览器 API（SPEC 3.3 分层），
 *     故 worker 创建 / 终止、Three 资源创建、Troika 字体预加载与 glyphs.json 清单加载等浏览器能力，
 *     一律由本 app-root 模块装配为端口，注入 LoadOrchestrator。
 *   - 本模块是端口实现侧；application 面向端口契约编程，二者对能力形状的认知只来自 loadPorts。
 *
 * 端口实现不变量（SPEC 4.1 / 4.3 / 11.1 / 任务约束）：
 *   - BrowserSceneBuildWorkerPort：按 Vite worker 约定 new Worker(new URL(...), {type:'module'})，
 *     postMessage 一条 build 请求；terminate 终止并置空 worker，幂等。worker 消息原样路由给 onMessage。
 *   - 资源工厂：把 createMapResources 包装为 Promise；同步抛错经 Promise executor 转为 reject，
 *     使资源创建失败成为 preparing 门禁的拒绝（SPEC 4.2），不向 orchestrator 暴露同步异常。
 *   - TroikaFontPreloadPort：包装 troika preloadFont；成功回调 → onDone(null)，
 *     超时未回调 → onDone(error)（收敛 Troika 加载失败时可能仅 console.error 不回调的行为）。
 *
 * 字体清单加载（SPEC 11.1 / 任务约束）：
 *   - 同源请求 /fonts/glyphs.json，经 parseGlyphManifest 派生只读码点集合；失败映射 FONT_ASSET_FAILED。
 *   - 不远端请求、不内嵌、不降级；清单与本地字体同源，是字体资产的清单而非地图数据来源。
 *
 * 依赖方向（SPEC 3.3）：app-root 允许依赖任意内部层与 react / three / r3f / troika / vite。
 */
import { preloadFont } from 'troika-three-text'
import { MapDataError, MapErrorCode } from './domain/mapDataError'
import { createMapResources } from './rendering/mapResources'
import type { MapResources } from './rendering/mapResources'
import { parseGlyphManifest } from './labels/glyphManifest'
import type { LabelFontPreloadPort } from './labels/fontPreload'
import { LABEL_FONT_SDF_GLYPH_SIZE, LABEL_FONT_URL } from './config/fontConfig'
import type {
  LoadFontConfig,
  LoadOrchestratorConfig,
  MapResourceFactoryPort,
  SceneBuildWorkerPort,
} from './application/loadPorts'
import type {
  SceneBuildMessage,
  SceneBuildRequestId,
} from './workers/sceneBuildProtocol'

/*
 * 浏览器 scene-build worker 端口（SPEC 3.1 / 4.3）。
 *
 * 生命周期：start 创建一个全新 module worker、投递 build 请求并路由消息；
 *   terminate 终止当前 worker 并置空（幂等）。旧 worker 的 in-flight 消息携带旧 requestId，
 *   由 orchestrator + reducer 统一丢弃，端口不做请求归属判定。
 */
class BrowserSceneBuildWorkerPort implements SceneBuildWorkerPort {
  private worker: Worker | null = null

  start(
    requestId: SceneBuildRequestId,
    onMessage: (message: SceneBuildMessage) => void,
  ): void {
    // Vite worker 约定：相对 URL + type:'module'，构建时独立打包为 worker chunk（SPEC 3.1）。
    this.worker = new Worker(
      new URL('./workers/sceneBuildWorker.ts', import.meta.url),
      { type: 'module' },
    )
    // worker → 主线程消息（progress / success / failure）原样路由给 onMessage；
    // success 消息的 ArrayBuffer 已通过 transfer list 转移，event.data.model 直接可用。
    this.worker.onmessage = (event: MessageEvent) => {
      onMessage(event.data as SceneBuildMessage)
    }
    // 主线程 → worker：投递 build 请求，requestId 由 orchestrator 单调分配。
    this.worker.postMessage({ type: 'build', requestId })
  }

  terminate(): void {
    if (this.worker === null) return
    this.worker.terminate()
    this.worker = null
  }

  get isRunning(): boolean {
    return this.worker !== null
  }
}

/*
 * Three 资源创建端口（SPEC 4.2 / TASK-014）。
 * createMapResources 同步执行；用 Promise executor 把同步抛错收敛为 reject，
 * 使资源创建失败成为 preparing 门禁的异步拒绝，符合 orchestrator 的 Promise 契约。
 */
function createBrowserResourceFactory(): MapResourceFactoryPort<MapResources> {
  return {
    create(model) {
      return new Promise<MapResources>((resolve, reject) => {
        try {
          resolve(createMapResources(model))
        } catch (err) {
          reject(err)
        }
      })
    },
  }
}

/*
 * Troika 字体预加载超时（毫秒）。
 * Troika 在本地字体加载失败时可能仅 console.error 且永不回调；超时兜底把这种情况收敛为 onDone(err)。
 * 本地 .woff 正常加载远小于该窗口；超时仅作为不可达失败路径的防御。
 */
const TROIKA_PRELOAD_TIMEOUT_MS = 15000

/*
 * Troika 字体预加载端口（SPEC 11.1 / 任务约束）。
 * 成功回调 → onDone(null)；超时未回调 → onDone(error)。
 * 字形覆盖门禁已由 preloadLabelFont 先于本端口执行，此处只负责资产加载信号。
 */
function createTroikaFontPort(): LabelFontPreloadPort {
  return {
    preloadFont({ font, characters, sdfGlyphSize }, onDone) {
      let settled = false
      const timer = setTimeout(() => {
        if (settled) return
        settled = true
        onDone(new Error('Troika 字体预加载超时未回调。'))
      }, TROIKA_PRELOAD_TIMEOUT_MS)
      try {
        preloadFont({ font, characters, sdfGlyphSize }, () => {
          if (settled) return
          settled = true
          clearTimeout(timer)
          onDone(null)
        })
      } catch (err) {
        if (settled) return
        settled = true
        clearTimeout(timer)
        onDone(err)
      }
    },
  }
}

/*
 * glyphs.json 浏览器运行时 URL（与 config LABEL_FONT_URL 同源策略）。
 */
const GLYPH_MANIFEST_URL = '/fonts/glyphs.json'

/*
 * 加载本地字形清单并派生只读码点集合（SPEC 11.1）。
 * 失败（网络 / 解析 / 清单损坏）统一映射为 FONT_ASSET_FAILED；不降级、不远端。
 */
async function loadManifestCodePoints(): Promise<ReadonlySet<number>> {
  let response: Response
  try {
    response = await fetch(GLYPH_MANIFEST_URL)
  } catch (err) {
    throw new MapDataError({
      code: MapErrorCode.FONT_ASSET_FAILED,
      message: `字形清单请求失败：${err instanceof Error ? err.message : String(err)}`,
      jsonPath: GLYPH_MANIFEST_URL,
      context: { stage: 'manifest-fetch' },
    })
  }
  if (!response.ok) {
    throw new MapDataError({
      code: MapErrorCode.FONT_ASSET_FAILED,
      message: `字形清单请求失败：HTTP 状态码 ${response.status}。`,
      jsonPath: GLYPH_MANIFEST_URL,
      context: { stage: 'manifest-fetch', status: response.status },
    })
  }
  let json: unknown
  try {
    json = await response.json()
  } catch (err) {
    throw new MapDataError({
      code: MapErrorCode.FONT_ASSET_FAILED,
      message: `字形清单不是合法 JSON：${err instanceof Error ? err.message : String(err)}`,
      jsonPath: GLYPH_MANIFEST_URL,
      context: { stage: 'manifest-parse' },
    })
  }
  // parseGlyphManifest 对损坏清单抛 FONT_ASSET_FAILED，原样透传。
  return parseGlyphManifest(json)
}

/*
 * 装配 LoadOrchestrator 完整依赖（任务“以可控 worker、资源和字体端口启动请求”）。
 *
 * 调用方契约：
 *   - 先异步加载字形清单（fontConfig 的 manifestCodePoints 来源），再构造端口集合。
 *   - 返回 LoadOrchestratorConfig，由 app-root hook 据此 new LoadOrchestrator 并 start。
 *   - 清单加载失败直接 reject（FONT_ASSET_FAILED），由 hook 映射为 error 状态，不启动 worker。
 */
export async function createMapLoadConfig(): Promise<
  LoadOrchestratorConfig<MapResources>
> {
  const manifestCodePoints = await loadManifestCodePoints()
  const fontConfig: LoadFontConfig = {
    manifestCodePoints,
    fontUrl: LABEL_FONT_URL,
    sdfGlyphSize: LABEL_FONT_SDF_GLYPH_SIZE,
  }
  return {
    workerPort: new BrowserSceneBuildWorkerPort(),
    resourceFactory: createBrowserResourceFactory(),
    fontPort: createTroikaFontPort(),
    fontConfig,
  }
}
