#!/usr/bin/env node
/**
 * Task 02 · 合成 DEM Pipeline（免 GDAL）—— CLI 入口。
 *
 * 运行：  pnpm gen:dem
 *   可选参数：--width=2048 --height=1024  （默认 1024×512）
 *
 * 产出：  public/data/{heightmap.png(16-bit 灰度), normal.png(8-bit RGB), meta.json}
 *
 * 设计为「数据源可插拔」（R1）：本脚本绑定合成源；未来真实 DEM（Copernicus，免 GDAL 路径）
 * 实现同一 DemSource 接口，烘焙流程（lib/heightmap.mjs）零改动即可替换。
 */

import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { mkdirSync } from 'node:fs'
import { createSyntheticSource } from './lib/dem-source.mjs'
import { generateDem, printReport } from './lib/heightmap.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const OUT_DIR = resolve(__dirname, '../../public/data')

// 解析 --width / --height
function arg(name, fallback) {
  const m = process.argv.find((a) => a.startsWith(`--${name}=`))
  return m ? Number(m.split('=')[1]) : fallback
}

const width = arg('width', 1024)
const height = arg('height', 512)

const source = createSyntheticSource({ width, height })

mkdirSync(OUT_DIR, { recursive: true })

const report = generateDem(source, OUT_DIR)
printReport(report)
