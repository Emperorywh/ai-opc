/**
 * 可插拔 DEM 数据源 + 合成实现（R1：MVP 免 GDAL / 免外部数据）。
 *
 * 【数据源契约（输出接口固定，未来真实 DEM 同格式替换、渲染层零改动）】
 *   DemSource = {
 *     name: string,
 *     width: number,            // heightmap 宽（经度方向，equirect 2:1）
 *     height: number,           // heightmap 高（纬度方向）
 *     elevationMin: number,     // 高程下限（米），映射到 raw 0
 *     elevationMax: number,     // 高程上限（米），映射到 raw 65535
 *     seaLevelMeters: number,   // 海平面（米），=0
 *     heightExaggeration: number, // 高度夸张倍率（shader 用，与 src/config/projection.ts 同步=2.5）
 *     getElevation(lon, lat): number  // 带符号高程（米）；>0 陆地，<0 海洋
 *   }
 *
 * 合成实现 = 大陆轮廓 mask（lib/continents.mjs）裁剪 simplex 噪声：
 *   - 陆地：低频 fbm（平原/丘陵）+ ridged（山脉）+ 极地冰盖高原（格陵兰/南极内陆）。
 *   - 海洋：变化的海底深度，M2 海洋 shader 将采样此水深做深浅渐变。
 *   - 噪声用 3D 圆柱坐标采样（cos/sin(经度)），消除 ±180° 经度接缝。
 *   - 固定种子 → 输出确定、可复现（构建产物稳定）。
 */

import { createNoise3D } from 'simplex-noise'
import { isLand } from './continents.mjs'

/** 固定种子，保证合成 DEM 输出可复现。 */
const SEED = 0x9e3779b1

/** mulberry32 PRNG（供 simplex-noise 确定性初始化）。 */
function mulberry32(a) {
  return function () {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

// 各用途噪声实例（不同子种子 → 通道独立）
const noiseBase = createNoise3D(mulberry32(SEED))
const noiseRidge = createNoise3D(mulberry32(SEED + 1))
const noiseOcean = createNoise3D(mulberry32(SEED + 2))

/** 经纬度 → 圆柱坐标（消除经度接缝）。freq 越大特征越密。 */
function cyl(lon, lat, freq) {
  const t = ((lon + 180) / 360) * Math.PI * 2
  return [Math.cos(t) * freq, Math.sin(t) * freq, (lat / 90) * freq * 1.5]
}

/** 分形布朗运动（fbm）：多层叠加，返回约 [-1,1]。 */
function fbm(noise, lon, lat, freq, octaves) {
  const [x, y, z] = cyl(lon, lat, freq)
  let amp = 1
  let sum = 0
  let norm = 0
  for (let o = 0; o < octaves; o++) {
    const s = 2 ** o
    sum += amp * noise(x * s, y * s, z * s)
    norm += amp
    amp *= 0.5
  }
  return sum / norm
}

/** 山脊噪声（ridged）：噪声过零处形成锐脊，返回约 [0,1]，越接近 1 越山脊化。 */
function ridged(noise, lon, lat, freq, octaves) {
  const [x, y, z] = cyl(lon, lat, freq)
  let amp = 1
  let sum = 0
  let norm = 0
  for (let o = 0; o < octaves; o++) {
    const s = 2 ** o
    const n = noise(x * s, y * s, z * s)
    sum += amp * (1 - Math.abs(n))
    norm += amp
    amp *= 0.5
  }
  return sum / norm
}

/**
 * 创建合成 DEM 数据源。
 * @param {{ width?: number, height?: number }} [opts]
 */
export function createSyntheticSource(opts = {}) {
  const width = opts.width ?? 1024
  const height = opts.height ?? 512

  const elevationMin = -5000
  const elevationMax = 6500

  /**
   * @param {number} lon [-180,180]
   * @param {number} lat [-90,90]
   * @returns {number} 带符号高程（米）
   */
  function getElevation(lon, lat) {
    let elev
    if (isLand(lon, lat)) {
      const base = fbm(noiseBase, lon, lat, 2.2, 6) * 0.5 + 0.5 // 0..1 平原/丘陵
      const mount = Math.pow(Math.min(1, ridged(noiseRidge, lon, lat, 1.7, 6)), 1.8) // 0..1 山脊
      elev = base * 1400 + mount * 5200 // 平原 0..1400，山脉 +0..5200
      const al = Math.abs(lat)
      if (al > 63) elev += ((al - 63) / 13) * 3200 // 极地冰盖高原（格陵兰/南极内陆）
    } else {
      const d = fbm(noiseOcean, lon, lat, 1.6, 5) * 0.5 + 0.5 // 0..1
      elev = -700 - Math.pow(d, 1.3) * 4300 // -700（近岸浅）.. -5000（深渊）
    }
    return Math.max(elevationMin, Math.min(elevationMax, elev))
  }

  return {
    name: 'synthetic',
    width,
    height,
    elevationMin,
    elevationMax,
    seaLevelMeters: 0,
    heightExaggeration: 2.5,
    getElevation,
  }
}

/** 默认合成源（1024×512）。 */
export const SYNTHETIC_SOURCE = createSyntheticSource()
