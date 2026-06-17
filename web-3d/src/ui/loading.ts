/**
 * 加载进度工具（SPEC §加载体验 / §4.2 UI 层，Task 17）。
 *
 * 纯常量 + 纯函数 + 流式 fetch 工具，可脱离 DOM/React 单测（照 atmosphereMaterial /
 * collision / labelLayout 同构「非组件模块承载逻辑、组件只导出组件满足 react-refresh」）。
 *
 * 为何自研而非 drei useProgress：资源加载不走 R3F DefaultLoadingManager —— heightmap/
 * labels 用原生 fetch、troika 字体自加载（仅 normal.png 经 TextureLoader），useProgress
 * 无法完整跟踪。故 Scene 编排加载各阶段上报 store（src/state），Loader（src/ui）订阅渲染。
 *
 * heightmap 是最大文件（11MB+），用流式 fetch 逐块累加报字节级进度（最有感的推进）；
 * 其余阶段（meta/decode）瞬时，给固定权重区间。整体进度单调递进 init→ready。
 */
import type { LoadingStage } from '../state/store'

/** 各阶段的整体进度区间 [start, end]（单调递增；ready 收敛到 1.0）。 */
export const STAGE_PROGRESS: Record<LoadingStage, readonly [number, number]> = {
  init: [0.0, 0.02],
  meta: [0.02, 0.06],
  terrain: [0.06, 0.88],
  decode: [0.88, 0.97],
  ready: [1.0, 1.0],
}

/** 阶段顺序（校验单调 / 单测）。 */
export const STAGE_ORDER: readonly LoadingStage[] = ['init', 'meta', 'terrain', 'decode', 'ready']

/** 阶段中文文案（Loader 展示）。 */
export const STAGE_LABELS: Record<LoadingStage, string> = {
  init: '正在初始化沙盘…',
  meta: '正在读取地图元数据…',
  terrain: '正在生成地形纹理…',
  decode: '正在解算高程数据…',
  ready: '就绪',
}

/** ready 阶段（Loader 据此淡出/卸载）。 */
export function isReady(stage: LoadingStage): boolean {
  return stage === 'ready'
}

/** 钳到 [0,1]；非有限数回 0。 */
export function clamp01(v: number): number {
  if (!Number.isFinite(v)) return 0
  return Math.min(1, Math.max(0, v))
}

/** 字节进度比例 loaded/total（防 total≤0 / 非有限数 → 0）。 */
export function byteFraction(loaded: number, total: number): number {
  if (total <= 0 || !Number.isFinite(loaded) || !Number.isFinite(total)) return 0
  return clamp01(loaded / total)
}

/**
 * 把「阶段内比例 fraction∈[0,1]」映射到整体进度（线性插值该阶段的 [start,end] 区间）。
 * 与 store.setLoading(stage, progress) 配合：Scene 传阶段内比例，得整体进度写 store。
 */
export function stageProgress(stage: LoadingStage, fraction: number): number {
  const [start, end] = STAGE_PROGRESS[stage]
  return clamp01(start + (end - start) * clamp01(fraction))
}

/**
 * 流式 fetch：读取响应体逐块累加字节，回调 onProgress(loaded, total)。
 * 无 content-length / 无 ReadableStream（如不透明响应）时回退整体读取（首尾各回调一次）。
 * 失败（非 2xx）抛错，由 Scene 捕获写 store.loadingError。
 */
export async function fetchWithProgress(
  url: string,
  onProgress?: (loaded: number, total: number) => void,
): Promise<ArrayBuffer> {
  const res = await fetch(url)
  if (!res.ok) throw new Error(`加载失败：${res.status} ${url}`)
  const totalHeader = res.headers.get('content-length')
  const total = totalHeader ? Number(totalHeader) : 0
  const body = res.body
  if (!body || !total || typeof body.getReader !== 'function') {
    // 无流或无总量：无法逐块报进度，首尾各回调一次。
    onProgress?.(0, 0)
    const buf = await res.arrayBuffer()
    onProgress?.(buf.byteLength, buf.byteLength)
    return buf
  }
  const reader = body.getReader()
  const chunks: Uint8Array[] = []
  let loaded = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    if (value) {
      chunks.push(value)
      loaded += value.byteLength
      onProgress?.(loaded, total)
    }
  }
  const merged = new Uint8Array(loaded)
  let offset = 0
  for (const c of chunks) {
    merged.set(c, offset)
    offset += c.byteLength
  }
  return merged.buffer
}
