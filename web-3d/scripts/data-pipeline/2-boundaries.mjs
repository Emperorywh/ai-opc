#!/usr/bin/env node
/**
 * Task 19 · 国家边界数据 pipeline —— CLI 入口。
 *
 * 运行：  pnpm gen:boundaries
 *   可选：--simplify=<度>（Douglas-Peucker 简化阈值；0=不简化，默认 0；真实 NE 建议 0.1）
 *         --ne-dir=<path>（NE 数据目录，默认 scripts/data-pipeline/raw/ne）
 *
 * 产出：  public/data/{boundaries.bin, disputed.bin}
 *
 * SPEC §6.3 / §12.2。数据源由 lib/boundary-source.mjs 选择：
 *   raw/ne/ 存在真实 NE GeoJSON/TopoJSON → 真实路径；否则合成代表性数据 fallback（确定可测）。
 *   pipeline：normalize → 简化(DP) → earcut 三角化(MultiPolygon+洞) + 边界线段 → 紧凑二进制
 *   （Float32[lon,lat] 顶点 + UInt32 索引 + 属性表 ISO_A3/大洲）。
 *
 * 二进制存地理 lon,lat（MVP equirect 线性投影由前端 project() 在加载时完成，与地形/标签同源对齐 R2；
 *   proj4 重投影推迟 M9 Robinson）。前端 TS decoder 见 Task 20 src/data/boundaries.ts。
 */

import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { mkdirSync, writeFileSync } from 'node:fs'
import { createBoundarySource } from './lib/boundary-source.mjs'
import { packBoundaries, packDisputed, decodeBoundaries } from './lib/boundary-pack.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const OUT_DIR = resolve(__dirname, '../../public/data')

function arg(name, fallback) {
  const m = process.argv.find((a) => a.startsWith(`--${name}=`))
  return m ? m.split('=')[1] : fallback
}

const simplify = Number(arg('simplify', 0))
const neDirArg = arg('ne-dir', '')
const neDir = neDirArg ? resolve(neDirArg) : undefined

mkdirSync(OUT_DIR, { recursive: true })

const { source, countries, disputed, continents } = createBoundarySource({ neDir })

const opts = { simplify }
const boundaries = packBoundaries(countries, continents, opts)
const disputedPacked = packDisputed(disputed, opts)

const boundariesPath = resolve(OUT_DIR, 'boundaries.bin')
const disputedPath = resolve(OUT_DIR, 'disputed.bin')
writeFileSync(boundariesPath, boundaries.bytes)
writeFileSync(disputedPath, disputedPacked.bytes)

const s = boundaries.stats
const d = disputedPacked.stats
// 紧凑性：坐标数据 Float32×2(8B/顶点) vs GeoJSON 文本坐标(~20B/顶点)。二进制额外含预烘焙
// earcut 索引（GPU-ready），GeoJSON 把三角化推迟到运行时——故对比坐标数据，非总字节。
const coordRatio = (((s.vertexCount * 8) / (s.vertexCount * 20)) * 100).toFixed(0)
console.log(`[gen:boundaries] 数据源：${source}`)
console.log(`[gen:boundaries] 写入 ${boundariesPath}`)
console.log(
  `  · ${s.countryCount} 国 / ${s.vertexCount} 顶点 / ${s.fillIndexCount / 3} 三角形 / ${s.borderIndexCount / 2} 边界线段`,
)
console.log(
  `  · ${s.bytes} 字节（坐标数据 vs GeoJSON ≈ ${coordRatio}%，预烘焙三角化索引 GPU-ready）`,
)
// round-trip 解码摘要（解码契约完整校验在 vitest；此处仅供 CLI 打印每国轮廓规模）
const summary = decodeBoundaries(boundaries.bytes).countries
for (const c of summary) {
  console.log(
    `  - ${c.isoA3}（${c.continent}）顶点 ${c.vertexCount} / 三角形 ${c.fillIndexCount / 3} / 边界段 ${c.borderIndexCount / 2}`,
  )
}
console.log(`[gen:boundaries] 写入 ${disputedPath}`)
console.log(`  · ${d.lineCount} 条争议线 / ${d.vertexCount} 顶点 / ${d.bytes} 字节`)
