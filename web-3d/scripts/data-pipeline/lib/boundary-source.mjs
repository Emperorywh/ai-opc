/**
 * Task 19 · 国家边界数据源（real NE / synthetic fallback）。
 *
 * 与 Task 02b GEBCO 同模式：真实 Natural Earth 数据需人工下载（放 `scripts/data-pipeline/raw/ne/`，
 * .gitignore 不进 git/构建）；agent 阶段用 `boundaries-data.mjs` 合成代表性数据保证 pipeline
 * 确定 + 可测。本模块按 `raw/ne/` 是否存在自动选择数据源，返回统一结构供 CLI 消费。
 *
 * 统一结构：
 *   {
 *     source: 'natural-earth' | 'synthetic',
 *     countries: CountryFeature[],
 *     disputed: Array<{ id:string, vertices:Array<[lon,lat]> }>,
 *   }
 *
 * 真实数据源（SPEC §12.2，公共域/CC0，naturalearthdata.com）：
 *   · 国家：`ne_10m_admin_0_countries`（GeoJSON 或 TopoJSON；本模块免 Shapefile 依赖——
 *     纯 JS 无 shapefile reader，故读 NE 的 GeoJSON/TopoJSON 分发）。
 *   · 争议：`ne_10m_admin_0_boundary_lines_disputed_areas`（LineString/MultiLineString）。
 *   下载 NE 的 .geojson（如 github.com/nvkelso/natural-earth-vector 的 geojson 分发）放入 raw/ne/。
 *
 * 大洲名表由本模块从数据中收集（unique + 排序），写入 boundaries.bin 的 CONTINENT_NAMES。
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { feature as topoFeature } from 'topojson-client'
import {
  CONTINENTS,
  SYNTHETIC_COUNTRIES,
  SYNTHETIC_DISPUTED,
  normalizeCountries,
} from './boundaries-data.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const DEFAULT_NE_DIR = resolve(__dirname, '../raw/ne')

/**
 * 读取 raw/ne/ 下指定基名的 NE 数据文件（.geojson / .json），返回解析后的 JS 对象。
 * 优先 .geojson，次 .json。.json 若为 TopoJSON（含 objects）则用 topojson-client 转为 GeoJSON。
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
  // TopoJSON：含 objects → 转 GeoJSON FeatureCollection
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
 * NE disputed Feature → 折线数组（LineString/MultiLineString 展平为多条 line strip）。
 * @param {any} feature
 * @returns {Array<{ id:string, vertices:Array<[number,number]> }>}
 */
function disputedFeatureToLines(feature) {
  const props = feature.properties ?? {}
  const id = props.name || props.brk_name || props.scalerank || ''
  const geom = feature.geometry
  if (!geom) return []
  /** @param {number[][]} coords */
  const toVerts = (coords) => coords.filter((c) => c.length >= 2).map((c) => [c[0], c[1]])
  if (geom.type === 'LineString') {
    const v = toVerts(geom.coordinates)
    return v.length >= 2 ? [{ id: String(id), vertices: v }] : []
  }
  if (geom.type === 'MultiLineString') {
    return geom.coordinates
      .map(toVerts)
      .filter((v) => v.length >= 2)
      .map((v) => ({ id: String(id), vertices: v }))
  }
  return []
}

/**
 * 创建边界数据源：raw/ne/ 存在 → 真实 NE；否则合成 fallback。
 * @param {{ neDir?: string }} [opts]
 * @returns {{ source:'natural-earth'|'synthetic', countries:any[], disputed:any[], continents:string[] }}
 */
export function createBoundarySource(opts = {}) {
  const neDir = opts.neDir ?? DEFAULT_NE_DIR
  if (existsSync(neDir)) {
    const countriesRaw = readNeFile(neDir, 'ne_10m_admin_0_countries')
    if (countriesRaw) {
      const countries = normalizeCountries(countriesRaw)
      if (countries.length > 0) {
        const disputedRaw = readNeFile(neDir, 'ne_10m_admin_0_boundary_lines_disputed_areas')
        const disputed = disputedRaw
          ? /** @type {any} */ (disputedRaw).features.flatMap(disputedFeatureToLines)
          : []
        const continents = uniqueContinents(countries)
        console.log(
          `[boundaries] 自然地球真实数据：${countries.length} 国 / ${disputed.length} 条争议线 / ${continents.length} 大洲`,
        )
        return { source: 'natural-earth', countries, disputed, continents }
      }
    }
    console.warn(`[boundaries] raw/ne/ 存在但未找到 ne_10m_admin_0_countries.{geojson,json}，回退合成数据`)
  }

  const continents = uniqueContinents(SYNTHETIC_COUNTRIES)
  console.log(
    `[boundaries] 合成代表性数据：${SYNTHETIC_COUNTRIES.length} 国 / ${SYNTHETIC_DISPUTED.length} 条争议线 / ${continents.length} 大洲` +
      `（真实 NE 由人工下载至 raw/ne/ 后重跑 pnpm gen:boundaries）`,
  )
  return {
    source: 'synthetic',
    countries: SYNTHETIC_COUNTRIES,
    disputed: SYNTHETIC_DISPUTED,
    continents,
  }
}

/**
 * 收集数据中出现的唯一大洲名（排序）。合成数据子集；真实 NE 全集。补齐七大洲标准项保证稳定顺序。
 * @param {Array<{ continent:string }>} countries
 * @returns {string[]}
 */
export function uniqueContinents(countries) {
  const set = new Set(countries.map((c) => c.continent))
  // 按 CONTINENTS 标准序优先，其余字母序追加（保证七大洲顺序稳定 + 兼容 NE 变体名）
  const ordered = CONTINENTS.filter((name) => set.has(name))
  const rest = [...set].filter((name) => !CONTINENTS.includes(name)).sort()
  return [...ordered, ...rest]
}
