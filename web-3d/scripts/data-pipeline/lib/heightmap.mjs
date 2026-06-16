/**
 * DEM 烘焙编排：数据源 → 16-bit heightmap.png + 8-bit normal.png + meta.json，
 * 并内置完整校验（IHDR 格式断言、整图 16-bit 往返解码、已知陆地/海洋点、陆地占比、ASCII 预览）。
 *
 * 输出接口固定（与 src/data/assets.ts Task 03 加载器、Task 04 shader 解码对齐）：
 *   raw16 = round((elevMeters - elevationMin) / (elevationMax - elevationMin) * 65535)
 *   解码：elevMeters = raw16 / 65535 * (elevationMax - elevationMin) + elevationMin
 */

import { writeFileSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { writeGray16, writeRGB8 } from './png-writer.mjs'
import { decodePng } from './png-reader.mjs'

/** 像素中心 → 经纬度（equirect，顶行=+90° 北）。 */
function pixelToLonLat(x, y, width, height) {
  const lon = -180 + ((x + 0.5) / width) * 360
  const lat = 90 - ((y + 0.5) / height) * 180
  return [lon, lat]
}

/** 经纬度 → 最近像素索引（用于已知点采样）。 */
function lonLatToPixel(lon, lat, width, height) {
  const x = Math.min(width - 1, Math.max(0, Math.floor(((lon + 180) / 360) * width)))
  const y = Math.min(height - 1, Math.max(0, Math.floor(((90 - lat) / 180) * height)))
  return [x, y]
}

/** 高程米 → raw uint16（用数据源声明的 bounds）。 */
function elevToRaw(e, source) {
  const { elevationMin: min, elevationMax: max } = source
  return Math.max(0, Math.min(65535, Math.round(((e - min) / (max - min)) * 65535)))
}

/** 光栅化数据源 → 高程 Float32（米）+ 实际 min/max。 */
function rasterize(source) {
  const { width: W, height: H, getElevation } = source
  const elev = new Float32Array(W * H)
  let min = Infinity
  let max = -Infinity
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const [lon, lat] = pixelToLonLat(x, y, W, H)
      const e = getElevation(lon, lat)
      elev[y * W + x] = e
      if (e < min) min = e
      if (e > max) max = e
    }
  }
  return { elev, min, max }
}

/** 由高程（米）计算 8-bit RGB 法线贴图（OpenGL 切线空间，+G 朝上）。 */
function computeNormals(elev, source, strength = 6) {
  const { width: W, height: H } = source
  const out = new Uint8Array(W * H * 3)
  const mPerDeg = 111320 // 米/度（近似）
  for (let y = 0; y < H; y++) {
    const lat = 90 - ((y + 0.5) / H) * 180
    const cosLat = Math.cos((lat * Math.PI) / 180)
    const dxm = mPerDeg * cosLat * (360 / W) // 每像素经度方向米数
    const dym = mPerDeg * (180 / H) // 每像素纬度方向米数
    const yu = Math.max(0, y - 1)
    const yd = Math.min(H - 1, y + 1)
    for (let x = 0; x < W; x++) {
      const xl = (x - 1 + W) % W // 经度方向环绕
      const xr = (x + 1) % W
      const eL = elev[y * W + xl]
      const eR = elev[y * W + xr]
      const eU = elev[yu * W + x]
      const eD = elev[yd * W + x]
      const dzdx = (eR - eL) / (2 * dxm)
      const dzdy = (eD - eU) / (2 * dym)
      let nx = -dzdx * strength
      let ny = -dzdy * strength
      let nz = 1
      const len = Math.hypot(nx, ny, nz) || 1
      const i = (y * W + x) * 3
      out[i] = Math.round((nx / len) * 127.5 + 127.5)
      out[i + 1] = Math.round((ny / len) * 127.5 + 127.5)
      out[i + 2] = Math.round((nz / len) * 127.5 + 127.5)
    }
  }
  return out
}

/** 已知地理样点（用于「大陆轮廓可辨认」可编程校验）。 */
const KNOWN_POINTS = [
  { name: '北京', lon: 116.4, lat: 39.9, expect: 'land' },
  { name: '上海', lon: 121.4, lat: 31.2, expect: 'land' },
  { name: '撒哈拉', lon: 10, lat: 23, expect: 'land' },
  { name: '喜马拉雅', lon: 86.9, lat: 27.9, expect: 'high' },
  { name: '安第斯', lon: -70, lat: -15, expect: 'high' },
  { name: '格陵兰内陆', lon: -40, lat: 72, expect: 'land' },
  { name: '南极内陆', lon: 0, lat: -80, expect: 'land' },
  { name: '澳大利亚中部', lon: 134, lat: -25, expect: 'land' },
  { name: '大西洋中部', lon: -30, lat: 0, expect: 'ocean' },
  { name: '太平洋中部', lon: -150, lat: 0, expect: 'ocean' },
  { name: '印度洋', lon: 75, lat: -10, expect: 'ocean' },
  { name: '西伯利亚', lon: 100, lat: 65, expect: 'land' },
]

/** ASCII 预览（陆地/海洋 + 山脉），用于肉眼核对大陆形状。 */
function asciiPreview(source, pw = 96, ph = 48) {
  const { width: W, height: H, getElevation } = source
  const lines = []
  for (let py = 0; py < ph; py++) {
    let line = ''
    for (let px = 0; px < pw; px++) {
      // 预览格中心 → 数据像素
      const fx = ((px + 0.5) / pw) * W
      const fy = ((py + 0.5) / ph) * H
      const x = Math.min(W - 1, Math.floor(fx))
      const y = Math.min(H - 1, Math.floor(fy))
      const [lon, lat] = pixelToLonLat(x, y, W, H)
      const e = getElevation(lon, lat)
      if (e < 0) line += ' '
      else if (e < 2000) line += '.'
      else if (e < 4000) line += 'o'
      else line += '#'
    }
    lines.push(line)
  }
  return lines.join('\n')
}

/**
 * 主烘焙流程。
 * @param {ReturnType<typeof import('./dem-source.mjs').createSyntheticSource>} source
 * @param {string} outDir 输出目录（public/data）
 * @returns {{files:string[], known:Array, landFraction:number, ascii:string, rasterMin:number, rasterMax:number}}
 */
export function generateDem(source, outDir) {
  const { width: W, height: H } = source
  console.log(`[heightmap] 光栅化 ${W}×${H}（${(W * H / 1000).toFixed(0)}k 像素）…`)

  // 1. 光栅化
  const { elev, min: rMin, max: rMax } = rasterize(source)
  console.log(`[heightmap] 实际高程范围: ${rMin.toFixed(0)} .. ${rMax.toFixed(0)} m`)

  // 2. raw uint16 数组
  const raw = new Uint16Array(W * H)
  for (let i = 0; i < elev.length; i++) raw[i] = elevToRaw(elev[i], source)

  // 3. 写 heightmap.png（16-bit 灰度）
  const heightmapPath = join(outDir, 'heightmap.png')
  writeGray16(heightmapPath, W, H, raw)

  // 4. 写 normal.png（8-bit RGB）
  const normals = computeNormals(elev, source, 6)
  const normalPath = join(outDir, 'normal.png')
  writeRGB8(normalPath, W, H, normals)

  // 5. 写 meta.json
  const metaPath = join(outDir, 'meta.json')
  const meta = {
    version: 1,
    source: source.name,
    projection: 'equirectangular',
    width: W,
    height: H,
    elevationMin: source.elevationMin,
    elevationMax: source.elevationMax,
    seaLevelMeters: source.seaLevelMeters,
    heightExaggeration: source.heightExaggeration,
  }
  writeFileSync(metaPath, JSON.stringify(meta, null, 2) + '\n', 'utf8')

  // ===== 校验 =====
  // 6. heightmap 格式断言 + 整图 16-bit 往返
  const hmDecoded = decodePng(readFileSync(heightmapPath))
  if (hmDecoded.bitDepth !== 16) throw new Error(`heightmap bitDepth 应为 16，实际 ${hmDecoded.bitDepth}`)
  if (hmDecoded.colorType !== 0) throw new Error(`heightmap colorType 应为 0(灰度)，实际 ${hmDecoded.colorType}`)
  if (hmDecoded.width !== W || hmDecoded.height !== H) throw new Error('heightmap 尺寸不符')
  let mism = 0
  for (let i = 0; i < W * H; i++) {
    const v = (hmDecoded.data[i * 2] << 8) | hmDecoded.data[i * 2 + 1]
    if (v !== raw[i]) mism++
  }
  if (mism > 0) throw new Error(`heightmap 16-bit 往返不一致：${mism} 个像素不符（编码器有 bug）`)

  // 7. normal 格式断言
  const nDecoded = decodePng(readFileSync(normalPath))
  if (nDecoded.bitDepth !== 8) throw new Error(`normal bitDepth 应为 8，实际 ${nDecoded.bitDepth}`)
  if (nDecoded.colorType !== 2) throw new Error(`normal colorType 应为 2(RGB)，实际 ${nDecoded.colorType}`)

  // 8. 已知点采样
  const known = KNOWN_POINTS.map((p) => {
    const [x, y] = lonLatToPixel(p.lon, p.lat, W, H)
    const e = elev[y * W + x]
    let actual
    if (e < 0) actual = 'ocean'
    else if (e > 3000) actual = 'high'
    else actual = 'land'
    const ok = actual === p.expect || (p.expect === 'land' && actual === 'high') || (p.expect === 'high' && actual === 'land' && e > 1500)
    return { ...p, elev: Math.round(e), actual, ok }
  })
  const knownFail = known.filter((p) => !p.ok)
  if (knownFail.length > 0) {
    console.warn('[heightmap] ⚠️ 已知点判定不符（可能需要调整大陆多边形）：')
    for (const p of knownFail) console.warn(`   ${p.name} (${p.lon},${p.lat}) 期望 ${p.expect}，实际 ${p.actual} (${p.elev}m)`)
  }

  // 9. 陆地占比（地球实际陆地约 29%）
  let landCount = 0
  for (let i = 0; i < elev.length; i++) if (elev[i] > 0) landCount++
  const landFraction = landCount / elev.length

  // 10. ASCII 预览
  const ascii = asciiPreview(source)

  return {
    files: [heightmapPath, normalPath, metaPath],
    known,
    landFraction,
    ascii,
    rasterMin: rMin,
    rasterMax: rMax,
  }
}

/** 打印人类可读报告。 */
export function printReport(report) {
  console.log('\n===== 合成 DEM 烘焙报告 =====')
  for (const f of report.files) {
    const kb = (statSync(f).size / 1024).toFixed(1)
    console.log(`  📄 ${f}  (${kb} KB)`)
  }
  console.log(`\n  陆地占比: ${(report.landFraction * 100).toFixed(1)}%  (地球实际 ~29%)`)
  console.log(`  实际高程: ${report.rasterMin.toFixed(0)} .. ${report.rasterMax.toFixed(0)} m`)
  console.log('\n  已知点校验:')
  for (const p of report.known) {
    console.log(`    ${p.ok ? '✅' : '⚠️ '} ${p.name.padEnd(10)} ${p.expect.padEnd(6)} → ${p.actual.padEnd(6)} ${p.elev} m`)
  }
  console.log('\n  大陆形状预览（空格=海, .=低陆, o=山, #=高峰；上=北）：')
  for (const line of report.ascii.split('\n')) console.log('    ' + line)
  console.log('\n===== 烘焙完成 =====\n')
}
