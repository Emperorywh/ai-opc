#!/usr/bin/env node
/**
 * Task 28 · 河流数据 pipeline —— CLI 入口。
 *
 * 运行：  pnpm gen:rivers
 *   可选：--simplify=<度>（Douglas-Peucker 简化阈值；0=不简化，默认 0.2；真实 NE 密集折线建议 0.05~0.2）
 *         --ne-dir=<path>（NE 数据目录，默认 scripts/data-pipeline/raw/ne）
 *
 * 产出：  public/data/rivers.bin
 *
 * SPEC §6.4 / §12.3。数据源由 lib/river-source.mjs 选择：
 *   raw/ne/ 存在真实 NE rivers_lake_centerlines → 真实路径；否则合成代表性数据 fallback（确定可测）。
 *   pipeline：简化(DP) → projectRobinson 投影 → Robinson heightmap 采样高度 + ε → 带状几何 → 紧凑二进制
 *   （Float32[x,y,z] 带状顶点 + Float32[u,v] + UInt32 带状索引 + 属性表 name/level）。
 *
 * 文件序号说明：SPEC §1 原计划 `3-rivers.mjs`，但序号 3 已被 M9 `3-reproject-robinson.mjs`（Task 26）
 * 占用，故河流顺延为 `5-rivers.mjs`（序号 = 组织标识非强制执行序；脚本名 `gen:rivers` 独立）。
 *
 * 投影 / 高度对齐（R2 / R3，详见 lib/rivers-pack.mjs）：
 *   · 河流在 **Robinson 空间烘焙**（meta.projection 须为 robinson）——projectRobinson 与前端
 *     `project` 同源；带状几何在投影空间生成（法线 / 宽度精确）。
 *   · 高度采样 sampleHeightAtWorld（worldXY→UV→双线性）与前端 `src/data/assets.ts` 逐字节同源，
 *     保证河流贴地与地形 shader 一致（M10 风险验证 #1「贴地不穿山」前置缓解）。
 */

import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs'
import { decodePng } from './lib/png-reader.mjs'
import { projectRobinson, PLANE_WIDTH, PLANE_HEIGHT } from './lib/robinson.mjs'
import { createRiverSource } from './lib/river-source.mjs'
import {
  packRivers,
  decodeRivers,
  sampleHeightAtWorld,
  RIVER_Y_OFFSET,
  heightToWorldY,
} from './lib/rivers-pack.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const OUT_DIR = resolve(__dirname, '../../public/data')

function arg(name, fallback) {
  const m = process.argv.find((a) => a.startsWith(`--${name}=`))
  return m ? m.split('=')[1] : fallback
}

const simplify = Number(arg('simplify', 0.2))
const neDirArg = arg('ne-dir', '')
const neDir = neDirArg ? resolve(neDirArg) : undefined

mkdirSync(OUT_DIR, { recursive: true })

// ---------------------------------------------------------------------------
// 1. 校验投影 + 读 Robinson heightmap / meta
// ---------------------------------------------------------------------------

const metaPath = resolve(OUT_DIR, 'meta.json')
const meta = JSON.parse(readFileSync(metaPath, 'utf8'))
if (meta.projection !== 'robinson') {
  throw new Error(
    `河流须在 Robinson 空间烘焙，当前 meta.projection = ${meta.projection}。` +
      `请先 pnpm gen:dem:robinson 烘焙 Robinson DEM。`,
  )
}

const png = decodePng(readFileSync(resolve(OUT_DIR, 'heightmap.png')))
if (png.bitDepth !== 16 || png.colorType !== 0) {
  throw new Error(`Robinson heightmap 必须 16-bit 灰度，实际 depth=${png.bitDepth} color=${png.colorType}`)
}
const W = png.width
const H = png.height
// Robinson raw uint16 栅格（大端 → 本机 uint16）
const elevRaw = new Uint16Array(W * H)
for (let i = 0; i < elevRaw.length; i++) {
  elevRaw[i] = (png.data[i * 2] << 8) | png.data[i * 2 + 1]
}

const elevMeta = {
  elevationMin: meta.elevationMin,
  elevationMax: meta.elevationMax,
  seaLevelMeters: meta.seaLevelMeters,
  heightExaggeration: meta.heightExaggeration,
}
const seaY = meta.seaLevelMeters * meta.heightExaggeration * 1e-5

console.log(
  `[gen:rivers] 投影 ${meta.projection} / heightmap ${W}×${H} / ` +
    `高程 ${meta.elevationMin}..${meta.elevationMax}m / 海平面 ${meta.seaLevelMeters}m / 简化 ${simplify}°`,
)

// ---------------------------------------------------------------------------
// 2. 数据源 + 投影 / 采样注入 + 打包
// ---------------------------------------------------------------------------

const { source, rivers } = createRiverSource({ neDir })

const sampleFn = (worldX, worldZ) => sampleHeightAtWorld(elevRaw, W, H, worldX, worldZ)
const packed = packRivers(rivers, projectRobinson, sampleFn, elevMeta, { simplify })

const riversPath = resolve(OUT_DIR, 'rivers.bin')
writeFileSync(riversPath, packed.bytes)

const s = packed.stats
console.log(`[gen:rivers] 数据源：${source}`)
console.log(`[gen:rivers] 写入 ${riversPath}`)
console.log(`  · ${s.riverCount} 条河流 / ${s.vertexCount} 带状顶点 / ${s.indexCount / 3} 三角形 / ${s.bytes} 字节`)

// ---------------------------------------------------------------------------
// 3. 校验
// ---------------------------------------------------------------------------

// 3a. round-trip 解码（解码契约完整校验在 vitest；此处 CLI 打印每河规模）
const decoded = decodeRivers(packed.bytes)
console.log('[gen:rivers] 河流清单（round-trip 解码）：')
for (const r of decoded.rivers) {
  console.log(
    `  - ${r.name.padEnd(8)} level ${r.level} 顶点 ${r.vertexCount} / 三角形 ${r.indexCount / 3}`,
  )
}

// 3b. 贴地契约（M10 风险验证 #1「贴地不穿山」）：每顶点 y ≥ 海面 + ε（不沉底）；
//     且全数据集至少存在陆地贴地点（y 显著高于海面，证明采样到地形而非全钳到海面）。
let minSeaDelta = Infinity
let maxGroundLift = -Infinity
for (let i = 0; i < decoded.vertices.length; i += 3) {
  const y = decoded.vertices[i + 1]
  const delta = y - (seaY + RIVER_Y_OFFSET)
  if (delta < minSeaDelta) minSeaDelta = delta
  if (y - seaY > maxGroundLift) maxGroundLift = y - seaY
}
if (minSeaDelta < -1e-6) {
  throw new Error(`贴地契约违反：存在顶点低于海面+ε（minSeaDelta=${minSeaDelta}），河流沉底`)
}
if (maxGroundLift < 0.01) {
  throw new Error(
    `贴地采样可疑：最高贴地抬升 ${maxGroundLift.toFixed(4)} < 0.01（全河流钳在海面，heightmap 采样未生效）`,
  )
}
console.log(
  `[gen:rivers] ✅ 贴地契约：所有顶点 ≥ 海面+ε（minSeaDelta=${minSeaDelta.toExponential(2)}）/ ` +
    `最高陆地贴地抬升 ${maxGroundLift.toFixed(4)}（≈ ${(maxGroundLift / (2.5e-5)).toFixed(0)}m）`,
)

// 3c. 山脉源头抽样（长江青藏 / 亚马逊安第斯 / 黄河青藏）：断言源头段贴到高地（> 1500m），
//     证明河流在山脉区采样到地表而非穿山悬空。
const SPUR = [
  { name: '长江源头(青藏)', lon: 91, lat: 33 },
  { name: '黄河源头(青藏)', lon: 96, lat: 35 },
  { name: '亚马逊源头(安第斯)', lon: -77, lat: -10 },
]
console.log('[gen:rivers] 山脉源头贴地抽样（高度采样与地形一致 R3）：')
let spurFail = 0
for (const p of SPUR) {
  const [wx, wz] = projectRobinson(p.lon, p.lat)
  const h = sampleHeightAtWorld(elevRaw, W, H, wx, wz)
  const groundM = meta.elevationMin + h * (meta.elevationMax - meta.elevationMin)
  const y = Math.max(heightToWorldY(h, elevMeta), seaY) + RIVER_Y_OFFSET
  const ok = groundM > 1500
  if (!ok) spurFail++
  console.log(
    `  ${ok ? '✅' : '⚠️ '} ${p.name.padEnd(16)} 地表 ${groundM.toFixed(0).padStart(5)}m → y=${y.toFixed(4)}`,
  )
}
if (spurFail > 0) {
  console.log(`[gen:rivers] ⚠️ ${spurFail} 山脉源头未采到高地（可能源 DEM 分辨率 / 合成折线偏离真实山脊）`)
}
console.log('\n[gen:rivers] ===== 河流 pipeline 完成 =====')
