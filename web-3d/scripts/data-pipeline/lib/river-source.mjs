/**
 * Task 28 · 河流数据源（real NE / synthetic fallback）。
 *
 * 与 Task 19 boundary-source.mjs 同模式：真实 Natural Earth 河流数据需人工下载（放
 * `scripts/data-pipeline/raw/ne/`，.gitignore 不进 git/构建）；agent 阶段用 `rivers-data.mjs`
 * 合成代表性数据保证 pipeline 确定 + 可测。本模块按 `raw/ne/` 是否存在自动选择数据源，
 * 返回统一 RiverFeature[] 结构供 CLI 消费。
 *
 * 真实数据源（SPEC §12.3，公共域，naturalearthdata.com）：
 *   `ne_10m_rivers_lake_centerlines`（GeoJSON / TopoJSON，LineString/MultiLineString）。
 *   下载 NE 的 .geojson（如 github.com/nvkelso/natural-earth-vector 的 geojson 分发）放入 raw/ne/。
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { feature as topoFeature } from 'topojson-client'
import { SYNTHETIC_RIVERS, normalizeRivers } from './rivers-data.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const DEFAULT_NE_DIR = resolve(__dirname, '../raw/ne')

/**
 * 读取 raw/ne/ 下指定基名的 NE 数据文件（.geojson / .json），返回解析后的 JS 对象。
 * 优先 .geojson，次 .json。.json 若为 TopoJSON（含 objects）则用 topojson-client 转为 GeoJSON。
 * （与 boundary-source.mjs readNeFile 同实现，保持数据源读取一致性。）
 * @param {string} dir
 * @param {string} baseName 不含扩展名
 * @returns {unknown | null}
 */
function readNeFile(dir, baseName) {
  const candidates = readdirSync(dir)
    .filter((f) => new RegExp(`^${baseName}\\.(geojson|json)$`, 'i').test(f))
    .sort((a, b) => (/\.geojson$/i.test(a) ? -1 : 1) - (/\.geojson$/i.test(b) ? -1 : 1))
  if (candidates.length === 0) return null
  const path = join(dir, candidates[0])
  const parsed = JSON.parse(readFileSync(path, 'utf8'))
  if (parsed && typeof parsed === 'object' && 'objects' in parsed && 'type' in parsed) {
    const topo = /** @type {any} */ (parsed)
    const layers = Object.values(topo.objects)
    const feats = layers.flatMap((layer) => {
      const fc = topoFeature(topo, layer)
      return /** @type {any} */ (fc).features ?? []
    })
    return { type: 'FeatureCollection', features: feats }
  }
  return parsed
}

/**
 * 创建河流数据源：raw/ne/ 存在且含河流文件 → 真实 NE；否则合成 fallback。
 * @param {{ neDir?: string }} [opts]
 * @returns {{ source:'natural-earth'|'synthetic', rivers: import('./rivers-data.mjs').RiverFeature[] }}
 */
export function createRiverSource(opts = {}) {
  const neDir = opts.neDir ?? DEFAULT_NE_DIR
  if (existsSync(neDir)) {
    const raw = readNeFile(neDir, 'ne_10m_rivers_lake_centerlines')
    if (raw) {
      const rivers = normalizeRivers(raw)
      if (rivers.length > 0) {
        console.log(`[rivers] 自然地球真实数据：${rivers.length} 条河流折线`)
        return { source: 'natural-earth', rivers }
      }
    }
    console.warn(
      `[rivers] raw/ne/ 存在但未找到 ne_10m_rivers_lake_centerlines.{geojson,json}，回退合成数据`,
    )
  }

  console.log(
    `[rivers] 合成代表性数据：${SYNTHETIC_RIVERS.length} 条主要河流` +
      `（真实 NE 由人工下载至 raw/ne/ 后重跑 pnpm gen:rivers）`,
  )
  return { source: 'synthetic', rivers: SYNTHETIC_RIVERS }
}
