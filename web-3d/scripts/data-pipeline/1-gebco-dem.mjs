#!/usr/bin/env node
/**
 * Task 02b · 真实 DEM Pipeline（GEBCO 2026）—— CLI 入口。
 *
 * 运行：  pnpm gen:dem:real
 *   可选参数：--width=4096 --height=2048 --tiles-dir=<path>（默认 scripts/data-pipeline/raw/gebco）
 *
 * 产出：  public/data/{heightmap.png(16-bit 灰度), normal.png(8-bit RGB), meta.json}
 *
 * 与 0-synthetic-dem.mjs 对称：仅数据源不同（真实 GEBCO vs 合成噪声），
 * 烘焙流程 lib/heightmap.mjs 数据源无关、零改动复用。保留 gen:dem（合成）作离线 fallback
 * （无数据 / CI 仍可跑、确定可复现）。
 *
 * 前置：需先下载 GEBCO_2026 的 GeoTIFF（8 tiles 或单个全球文件均可）到 raw/gebco/（见 docs/SPEC §12.1）。
 */

import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { mkdirSync } from 'node:fs'
import { createRealDemSource } from './lib/real-dem-source.mjs'
import { generateDem, printReport } from './lib/heightmap.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const OUT_DIR = resolve(__dirname, '../../public/data')

// 解析 --width / --height / --tiles-dir
function arg(name, fallback) {
  const m = process.argv.find((a) => a.startsWith(`--${name}=`))
  return m ? m.split('=')[1] : fallback
}

const width = Number(arg('width', 4096))
const height = Number(arg('height', 2048))
const tilesDirArg = arg('tiles-dir', '')
const tilesDir = tilesDirArg ? resolve(tilesDirArg) : undefined

mkdirSync(OUT_DIR, { recursive: true })

const source = await createRealDemSource({ width, height, tilesDir })

const [rMin, rMax] = source._rasterRange
console.log(
  `[real-dem] GEBCO 实际高程范围：${rMin.toFixed(0)} .. ${rMax.toFixed(0)} m` +
    `（映射 raw 用固定 ${source.elevationMin} .. ${source.elevationMax}）`,
)

const report = generateDem(source, OUT_DIR)
printReport(report)
