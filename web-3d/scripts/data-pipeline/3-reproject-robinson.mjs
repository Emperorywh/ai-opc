#!/usr/bin/env node
/**
 * Task 26 · Robinson 重投影 pipeline —— CLI 入口。
 *
 * 运行：  pnpm gen:dem:robinson
 *   可选：--width=4096 --height=2048（Robinson 输出尺寸，默认沿用现有 heightmap 尺寸）
 *
 * 产出：  覆盖 public/data/{heightmap.png, normal.png, meta.json}（projection: 'robinson'）
 *
 * 原理（SPEC §5.2 / ROADMAP M9 风险验证 #1「DEM 重投影可行性」）：
 *   Robinson 非线性，DEM 不能 1:1 采样。本脚本对**现有 equirect heightmap.png**（Task 02b GEBCO 产物）
 *   做一次性反投影重采样 —— 每个 Robinson 网格像素 (px,py) → worldXY（与 PlaneGeometry 顶点同源）
 *   → unprojectRobinson → (lon,lat) → 双线性采样原 equirect DEM → 写入 Robinson 网格。
 *
 *   不依赖 raw GEBCO GeoTIFF（raw/ 在 .gitignore，CI/无数据环境不可用）—— 从已烘焙的 equirect
 *   heightmap 重采样，多一次双线性插值（精度损失 ≪ 16-bit 量化级 ~0.29m，可接受），
 *   换取零外部数据依赖、确定可复现。
 *
 *   Robinson 像素均匀对应 worldXY（投影矩形），故：
 *     · shader 的 `worldXY→UV`（Task 04）零改动即可采样 Robinson heightmap（渲染层 diff 为空）；
 *     · 矢量（边界/标签存 lon/lat）经前端 `project()` 自动重投影，与本 heightmap 同源对齐。
 *
 * 投影同源：lib/robinson.mjs 与 src/config/projection.ts 共用 ROBINSON_DEF + 常数表达式。
 */

import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readFileSync, writeFileSync } from 'node:fs'
import { decodePng } from './lib/png-reader.mjs'
import { writeGray16, writeRGB8 } from './lib/png-writer.mjs'
import { bilinearSampleElev } from './lib/real-dem-source.mjs'
import {
  PLANE_WIDTH,
  PLANE_HEIGHT,
  projectRobinson,
  unprojectRobinson,
} from './lib/robinson.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const OUT_DIR = resolve(__dirname, '../../public/data')

function arg(name, fallback) {
  const m = process.argv.find((a) => a.startsWith(`--${name}=`))
  return m ? m.split('=')[1] : fallback
}

// ---------------------------------------------------------------------------
// 1. 读现有 equirect heightmap + meta
// ---------------------------------------------------------------------------

const metaPath = resolve(OUT_DIR, 'meta.json')
const meta = JSON.parse(readFileSync(metaPath, 'utf8'))
if (meta.projection !== 'equirectangular') {
  throw new Error(
    `重投影源必须是 equirectangular，当前 meta.projection = ${meta.projection}。` +
      `请先 pnpm gen:dem:real 烘焙 equirect DEM。`,
  )
}

const eqPng = decodePng(readFileSync(resolve(OUT_DIR, 'heightmap.png')))
if (eqPng.bitDepth !== 16 || eqPng.colorType !== 0) {
  throw new Error(`源 heightmap 必须 16-bit 灰度，实际 depth=${eqPng.bitDepth} color=${eqPng.colorType}`)
}
const eqW = eqPng.width
const eqH = eqPng.height
// 原 equirect raw uint16 栅格（大端 → 本机 uint16）
const eqRaw = new Uint16Array(eqW * eqH)
for (let i = 0; i < eqRaw.length; i++) {
  eqRaw[i] = (eqPng.data[i * 2] << 8) | eqPng.data[i * 2 + 1]
}

// Robinson 输出尺寸（默认沿用源尺寸）
const W = Number(arg('width', eqW))
const H = Number(arg('height', eqH))

const { elevationMin: MIN, elevationMax: MAX, seaLevelMeters, heightExaggeration } = meta
const rawToMeters = (raw) => MIN + (raw / 65535) * (MAX - MIN)
const metersToRaw = (m) => Math.max(0, Math.min(65535, Math.round(((m - MIN) / (MAX - MIN)) * 65535)))

console.log(`[robinson] 源 equirect ${eqW}×${eqH} → Robinson ${W}×${H}（${MIN}..${MAX}m）`)

// ---------------------------------------------------------------------------
// 2. 预计算 Robinson 每像素 (lon,lat)（rasterize + normal 共用，避免重复反投影）
// ---------------------------------------------------------------------------

console.log(`[robinson] 预计算 ${W}×${H} 像素 Robinson 反投影…`)
const lonLat = new Float64Array(W * H * 2)
for (let py = 0; py < H; py++) {
  const v = (py + 0.5) / H
  const worldZ = (v - 0.5) * PLANE_HEIGHT
  for (let px = 0; px < W; px++) {
    const u = (px + 0.5) / W
    const worldX = (u - 0.5) * PLANE_WIDTH
    const [lon, lat] = unprojectRobinson(worldX, worldZ)
    const o = (py * W + px) * 2
    lonLat[o] = lon
    lonLat[o + 1] = lat
  }
  if (py % 256 === 0) process.stdout.write(`\r  反投影 ${((py / H) * 100).toFixed(0)}%`)
}
process.stdout.write('\r  反投影 100%  \n')

// ---------------------------------------------------------------------------
// 3. Robinson 网格光栅化（每像素 lon,lat → 双线性采样源 equirect DEM）
// ---------------------------------------------------------------------------

console.log(`[robinson] 光栅化 Robinson 网格（双线性重采样源 DEM）…`)
const raw = new Uint16Array(W * H)
const meters = new Float32Array(W * H)
for (let i = 0; i < W * H; i++) {
  const lon = lonLat[i * 2]
  const lat = lonLat[i * 2 + 1]
  const sampledRaw = bilinearSampleElev(eqRaw, eqW, eqH, lon, lat) // raw 浮点（线性插值）
  const m = rawToMeters(sampledRaw)
  meters[i] = m
  raw[i] = metersToRaw(m)
}

// ---------------------------------------------------------------------------
// 4. Robinson 法线（米空间梯度，与 equirect computeNormals 同框架 / 同符号 / strength=6）
// ---------------------------------------------------------------------------

console.log(`[robinson] 计算 Robinson 法线贴图…`)
const normals = new Uint8Array(W * H * 3)
const STRENGTH = 6
const M_PER_DEG = 111320
for (let y = 0; y < H; y++) {
  const yu = Math.max(0, y - 1)
  const yd = Math.min(H - 1, y + 1)
  for (let x = 0; x < W; x++) {
    const xl = (x - 1 + W) % W // 经度环绕（日界线 ±180 同经线）
    const xr = (x + 1) % W
    const o = (y * W + x) * 2
    const lon = lonLat[o]
    const lat = lonLat[o + 1]
    const cosLat = Math.cos((lat * Math.PI) / 180)
    // 相邻像素经纬度差 → 米距离（ Robinson 非线性，逐像素真实跨度）
    const lonR = lonLat[(y * W + xr) * 2]
    const latD = lonLat[(yd * W + x) * 2 + 1]
    const latU = lonLat[(yu * W + x) * 2 + 1]
    const dxm = Math.abs((lonR - lon) * M_PER_DEG * cosLat) || 1e-6
    const dym = Math.abs((latD - latU) * 0.5 * M_PER_DEG) || 1e-6
    const eL = meters[y * W + xl]
    const eR = meters[y * W + xr]
    const eU = meters[yu * W + x]
    const eD = meters[yd * W + x]
    const dzdx = (eR - eL) / (2 * dxm)
    const dzdy = (eD - eU) / (2 * dym) // 与 equirect 同符号：eD=y+1(南) - eU=y-1(北)
    let nx = -dzdx * STRENGTH
    let ny = -dzdy * STRENGTH
    const nz = 1
    const len = Math.hypot(nx, ny, nz) || 1
    const i = (y * W + x) * 3
    normals[i] = Math.round((nx / len) * 127.5 + 127.5)
    normals[i + 1] = Math.round((ny / len) * 127.5 + 127.5)
    normals[i + 2] = Math.round((nz / len) * 127.5 + 127.5)
  }
}

// ---------------------------------------------------------------------------
// 5. 写 heightmap.png + normal.png + meta.json
// ---------------------------------------------------------------------------

const heightmapPath = resolve(OUT_DIR, 'heightmap.png')
const normalPath = resolve(OUT_DIR, 'normal.png')
writeGray16(heightmapPath, W, H, raw)
writeRGB8(normalPath, W, H, normals)

const newMeta = {
  ...meta,
  projection: 'robinson',
  width: W,
  height: H,
}
writeFileSync(metaPath, JSON.stringify(newMeta, null, 2) + '\n', 'utf8')
console.log(`[robinson] 写入 heightmap.png / normal.png / meta.json（projection: robinson）`)

// ---------------------------------------------------------------------------
// 6. 校验
// ---------------------------------------------------------------------------

// 6a. heightmap 16-bit 往返
const hmDecoded = decodePng(readFileSync(heightmapPath))
if (hmDecoded.bitDepth !== 16) throw new Error(`heightmap bitDepth 应 16，实际 ${hmDecoded.bitDepth}`)
if (hmDecoded.colorType !== 0) throw new Error(`heightmap colorType 应 0，实际 ${hmDecoded.colorType}`)
let mism = 0
for (let i = 0; i < W * H; i++) {
  const v = (hmDecoded.data[i * 2] << 8) | hmDecoded.data[i * 2 + 1]
  if (v !== raw[i]) mism++
}
if (mism > 0) throw new Error(`heightmap 16-bit 往返不一致：${mism} 像素`)
console.log(`[robinson] ✅ heightmap 16-bit 往返零误差`)

// 6b. normal 格式
const nDecoded = decodePng(readFileSync(normalPath))
if (nDecoded.bitDepth !== 8 || nDecoded.colorType !== 2) {
  throw new Error(`normal 应 8-bit RGB，实际 depth=${nDecoded.bitDepth} color=${nDecoded.colorType}`)
}

// 6c. 已知点（经 projectRobinson → Robinson 像素采样，验证 Robinson 网格在该经纬度的值正确）
const KNOWN = [
  { name: '北京', lon: 116.4, lat: 39.9, expect: 'land' },
  { name: '喜马拉雅', lon: 86.9, lat: 27.9, expect: 'high' },
  { name: '安第斯', lon: -70, lat: -15, expect: 'high' },
  { name: '格陵兰内陆', lon: -40, lat: 72, expect: 'land' },
  { name: '南极内陆', lon: 0, lat: -80, expect: 'land' },
  { name: '澳洲中部', lon: 134, lat: -25, expect: 'land' },
  { name: '大西洋中部', lon: -30, lat: 0, expect: 'ocean' },
  { name: '太平洋中部', lon: -150, lat: 0, expect: 'ocean' },
  { name: '印度洋', lon: 75, lat: -10, expect: 'ocean' },
]
const sampleRobinsonMeters = (lon, lat) => {
  const [wx, wz] = projectRobinson(lon, lat)
  const px = Math.min(W - 1, Math.max(0, Math.round((wx / PLANE_WIDTH + 0.5) * W)))
  const py = Math.min(H - 1, Math.max(0, Math.round((0.5 + wz / PLANE_HEIGHT) * H)))
  return meters[py * W + px]
}
console.log('\n[robinson] 已知点校验（Robinson 像素采样）：')
let knownFail = 0
for (const p of KNOWN) {
  const e = sampleRobinsonMeters(p.lon, p.lat)
  let actual
  if (e < seaLevelMeters) actual = 'ocean'
  else if (e > 3000) actual = 'high'
  else actual = 'land'
  const ok = actual === p.expect || (p.expect === 'land' && actual === 'high')
  if (!ok) knownFail++
  console.log(`  ${ok ? '✅' : '⚠️ '} ${p.name.padEnd(8)} 期望 ${p.expect.padEnd(6)} 实际 ${actual.padEnd(6)} ${e.toFixed(0)}m`)
}

// 6d. 陆地占比（Robinson 重投影应与源接近 ~29%）
let landCount = 0
for (let i = 0; i < meters.length; i++) if (meters[i] > seaLevelMeters) landCount++
const landFraction = landCount / meters.length

// 6e. ASCII 预览（Robinson 网格大陆形状，肉眼核对极区压缩）
const PW = 96
const PH = 48
let ascii = ''
for (let py = 0; py < PH; py++) {
  for (let px = 0; px < PW; px++) {
    const sx = Math.min(W - 1, Math.floor(((px + 0.5) / PW) * W))
    const sy = Math.min(H - 1, Math.floor(((py + 0.5) / PH) * H))
    const e = meters[sy * W + sx]
    ascii += e < 0 ? ' ' : e < 2000 ? '.' : e < 4000 ? 'o' : '#'
  }
  ascii += '\n'
}

console.log(`\n[robinson] 陆地占比: ${(landFraction * 100).toFixed(1)}%  (源 equirect ~29%)`)
console.log('[robinson] Robinson 网格大陆形状预览（空格=海 .=低陆 o=山 #=高峰；上=北）：')
for (const line of ascii.trimEnd().split('\n')) console.log('    ' + line)
console.log('\n[robinson] ===== 重投影完成 =====')
if (knownFail > 0) console.log(`[robinson] ⚠️ ${knownFail} 已知点不符（可能源 DEM 分辨率/Robinson 边缘采样）`)
