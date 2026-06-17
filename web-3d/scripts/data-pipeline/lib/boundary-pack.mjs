/**
 * Task 19 · 国家边界二进制打包 / 解码（核心格式契约，M6）。
 *
 * SPEC §6.3「国家边界系统」+ §12.2.4：紧凑二进制 = `Float32[lon,lat]` 顶点 +
 * `UInt32` 偏移索引 + 属性表（ISO_A3、大洲）。
 *
 * 本模块是 Task 19 与 Task 20（渲染）/ Task 22（拾取）之间的**单一格式契约**：
 *   pipeline（pack）  →  boundaries.bin / disputed.bin  →  前端（decode，Task 20 在
 *   `src/data/boundaries.ts` 以 TS 复刻同一布局常量）。
 *
 * 投影对齐决策（关键，R2）：二进制存**地理 lon,lat**（非投影坐标）。MVP equirect 是线性投影，
 *   Task 20 加载时用 `src/config/projection.ts` 的 `project()` 投影——与地形顶点 / 标签锚点同源对齐。
 *   故 pipeline **不投影**（保持 lon,lat）；proj4 重投影推迟到 M9 Robinson（重跑 pipeline 重三角化）。
 *   三角化在 lon,lat 2D 空间进行：equirect 线性投影保持直线，三角化有效（无翻转/自交）。
 *
 * ─── boundaries.bin 布局（Little-Endian）─────────────────────────────────────
 *   HEADER (28B):
 *     0   magic            4B   "BDRT"
 *     4   version          u32  =1
 *     8   vertexCount      u32  全局顶点数
 *     12  countryCount     u32
 *     16  fillIndexCount   u32  填充三角形索引总数（= 三角形 ×3）
 *     20  borderIndexCount u32  描边线段索引总数（= 线段 ×2）
 *     24  continentCount   u32  大洲名表条目数
 *   CONTINENT_NAMES: continentCount × 16B（UTF-8，零填充，≤15 字符）
 *   VERTICES:      vertexCount × 2 × f32   (lon, lat 交错)   lon∈[-180,180] lat∈[-90,90]
 *   FILL_INDICES:  fillIndexCount × u32     (三角形顶点全局索引)
 *   BORDER_INDICES:borderIndexCount × u32   (线段顶点全局索引，成对)
 *   COUNTRIES:     countryCount × 36B:
 *     0  id               u32   拾取稳定 id（= 记录序号 0..count-1）
 *     4  isoA3            4B    ASCII（3 大写字母，零填充）
 *     8  continentIndex   u8    → CONTINENT_NAMES
 *     9  (pad)            3B    零
 *     12 vertexOffset     u32   该国家顶点在 VERTICES 起始
 *     16 vertexCount      u32
 *     20 fillIndexOffset  u32   该国家三角形索引在 FILL_INDICES 起始
 *     24 fillIndexCount   u32
 *     28 borderIndexOffset u32  该国家描边索引在 BORDER_INDICES 起始
 *     32 borderIndexCount u32
 *
 * ─── disputed.bin 布局（Little-Endian）──────────────────────────────────────
 *   HEADER (16B):
 *     0  magic       4B  "DSPT"
 *     4  version     u32 =1
 *     8  vertexCount u32
 *     12 lineCount   u32
 *   VERTICES: vertexCount × 2 × f32 (lon, lat)
 *   LINES:    lineCount × 24B:
 *     0  vertexOffset u32
 *     4  vertexCount  u32   该折线顶点数（line strip）
 *     8  id           16B   UTF-8 名（零填充）
 *
 * 所有 pack/decode 为纯函数（DataView 读写），不依赖 DOM / three，可在 Node 单测验证 round-trip。
 */

import earcut from 'earcut'

/** 文件魔数 / 版本（前后端 decoder 同步；src/data/boundaries.ts 复刻）。 */
export const BOUNDARIES_MAGIC = 'BDRT'
export const BOUNDARIES_VERSION = 1
export const DISPUTED_MAGIC = 'DSPT'
export const DISPUTED_VERSION = 1

/** 布局常量（字节）。 */
export const LAYOUT = {
  HEADER: 28,
  CONTINENT_NAME: 16,
  ISO_A3: 4,
  COUNTRY_RECORD: 36,
  DISPUTED_HEADER: 16,
  DISPUTED_LINE_RECORD: 24,
}

// ===========================================================================
// 几何纯函数：环归一化 / Douglas-Peucker 简化 / 边界线段
// ===========================================================================

/**
 * 归一化环：丢弃与首点重复的闭合尾点（GeoJSON 闭合环约定），确保 ≥3 顶点。
 * @param {Array<[number,number]>} ring
 * @returns {Array<[number,number]>}
 */
export function normalizeRing(ring) {
  if (!Array.isArray(ring) || ring.length < 3) return []
  const cleaned = ring.filter((p) => Array.isArray(p) && p.length >= 2)
  if (cleaned.length >= 2) {
    const a = cleaned[0]
    const b = cleaned[cleaned.length - 1]
    if (a[0] === b[0] && a[1] === b[1]) cleaned.pop()
  }
  return cleaned.length >= 3 ? cleaned.map((p) => [p[0], p[1]]) : []
}

/**
 * 点到线段（p0→p1）的垂直距离（Douglas-Peucker 用）。lon,lat 平面近似（小范围误差可忽略）。
 * @param {[number,number]} p
 * @param {[number,number]} a
 * @param {[number,number]} b
 * @returns {number}
 */
export function perpendicularDistance(p, a, b) {
  const dx = b[0] - a[0]
  const dy = b[1] - a[1]
  const len2 = dx * dx + dy * dy
  if (len2 === 0) return Math.hypot(p[0] - a[0], p[1] - a[1])
  const t = ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / len2
  const tClamped = Math.min(1, Math.max(0, t))
  const px = a[0] + tClamped * dx
  const py = a[1] + tClamped * dy
  return Math.hypot(p[0] - px, p[1] - py)
}

/**
 * Douglas-Peucker 简化折线（epsilon 单位 = 度；0 = 不简化，原样返回副本）。
 * 对闭合环先在首点展开（首尾相同）再简化，避免环特征丢失。
 * @param {Array<[number,number]>} points
 * @param {number} epsilon 简化阈值（度）
 * @returns {Array<[number,number]>}
 */
export function simplifyRing(points, epsilon) {
  if (!Array.isArray(points) || points.length < 3) return []
  const safe = points.map((p) => [p[0], p[1]])
  if (!epsilon || epsilon <= 0) return safe
  // 闭合环：在最长相邻段处断开展开为开放折线（DP 对开放折线更稳），简化后视作环
  const closed = safe.concat([safe[0]])
  /** @param {number[]} keep 标记数组 */
  function dp(start, end, keep) {
    let maxD = -1
    let idx = -1
    for (let i = start + 1; i < end; i++) {
      const d = perpendicularDistance(closed[i], closed[start], closed[end])
      if (d > maxD) {
        maxD = d
        idx = i
      }
    }
    if (maxD > epsilon && idx > 0) {
      keep[idx] = 1
      dp(start, idx, keep)
      dp(idx, end, keep)
    }
  }
  const keep = new Array(closed.length).fill(0)
  keep[0] = 1
  keep[closed.length - 1] = 1
  dp(0, closed.length - 1, keep)
  // 保留的顶点（去重末尾闭合点）
  const out = closed.filter((_, i) => keep[i] === 1)
  out.pop() // 去掉末尾 = 首的闭合点
  return out.length >= 3 ? out : safe
}

/**
 * 计算球面多边形有符号面积（lon,lat 平面梯形法，逆时针为正）——供三角化自交/朝向诊断用。
 * @param {Array<[number,number]>} ring
 * @returns {number}
 */
export function ringSignedArea(ring) {
  let sum = 0
  const n = ring.length
  for (let i = 0; i < n; i++) {
    const [x1, y1] = ring[i]
    const [x2, y2] = ring[(i + 1) % n]
    sum += x1 * y2 - x2 * y1
  }
  return sum / 2
}

/**
 * 闭合环 → 边界线段索引对（v_i → v_{(i+1)%n}）。环顶点不得含闭合尾点（先 normalizeRing）。
 * 返回相对环起始的局部索引对数组。
 * @param {number} n 环顶点数
 * @returns {Array<[number,number]>}
 */
export function ringBorderSegments(n) {
  const segs = []
  for (let i = 0; i < n; i++) segs.push([i, (i + 1) % n])
  return segs
}

// ===========================================================================
// 三角化：earcut（MultiPolygon 逐多边形 + 洞）
// ===========================================================================

/**
 * 单多边形（外环 + 洞）三角化。
 *
 * @param {Array<[number,number]>} outer 外环（≥3 顶点，不含闭合尾点）
 * @param {Array<Array<[number,number]>>} holes 洞环数组
 * @returns {number[]} 三角形顶点索引（指向 [outer..., holes[0]..., holes[1]...] 的拼接序列）
 */
export function triangulatePolygon(outer, holes = []) {
  const allRings = [outer, ...holes]
  const flat = []
  const holeIndices = []
  let cursor = 0
  for (let k = 0; k < allRings.length; k++) {
    const ring = allRings[k]
    for (const p of ring) {
      flat.push(p[0], p[1])
    }
    if (k > 0) holeIndices.push(cursor)
    cursor += ring.length
  }
  const tris = earcut(flat, holeIndices.length > 0 ? holeIndices : undefined, 2)
  return Array.from(tris)
}

// ===========================================================================
// 打包：boundaries.bin
// ===========================================================================

/**
 * 把一个环的顶点追加进全局顶点缓冲，记录 [全局偏移, 顶点数]。
 * @param {number[]} verts 扁平 [lon0,lat0,...]（原地追加）
 * @param {Array<[number,number]>} ring
 * @returns {{ offset:number, count:number }} 全局偏移（顶点单位）与顶点数
 */
function appendRing(verts, ring) {
  const offset = verts.length / 2
  for (const [lon, lat] of ring) verts.push(lon, lat)
  return { offset, count: ring.length }
}

/**
 * 把三角化局部索引（指向 polygon 外环+洞拼接序列）映射为全局顶点索引。
 * @param {number[]} localTris 局部三角形索引
 * @param {{ offset:number, count:number }[]} rings [outer, ...holes] 的全局范围
 * @returns {number[]} 全局三角形索引
 */
function mapTrisToGlobal(localTris, rings) {
  // 拼接序列内每个局部索引 → (ring k, local within ring)
  const ringStarts = []
  let acc = 0
  for (const r of rings) {
    ringStarts.push(acc)
    acc += r.count
  }
  const global = []
  for (const li of localTris) {
    // 二分/线性定位所在环
    let k = 0
    for (let j = ringStarts.length - 1; j >= 0; j--) {
      if (li >= ringStarts[j]) {
        k = j
        break
      }
    }
    const within = li - ringStarts[k]
    global.push(rings[k].offset + within)
  }
  return global
}

/**
 * 打包 boundaries.bin。
 *
 * @param {import('./boundaries-data.mjs').CountryFeature[]} countries
 * @param {string[]} continentNames 大洲名表（CONTINENT_NAMES）
 * @param {{ simplify?: number }} [opts] simplify=0 不简化
 * @returns {{ bytes: Uint8Array, stats: object }}
 */
export function packBoundaries(countries, continentNames, opts = {}) {
  const epsilon = opts.simplify ?? 0
  const continentIndex = new Map(continentNames.map((name, i) => [name, i]))

  // 1. 简化环 + 布局全局顶点 / 三角形索引 / 边界索引
  /** @type {number[]} 扁平顶点 [lon,lat,...] */
  const verts = []
  /** @type {number[]} 三角形全局索引 */
  const fillIdx = []
  /** @type {number[]} 边界线段全局索引 */
  const borderIdx = []
  /** @type {object[]} 每国家记录 */
  const records = []

  let nextId = 0
  for (const c of countries) {
    const ci = continentIndex.get(c.continent)
    if (ci === undefined) {
      throw new Error(`未知大洲「${c.continent}」（isoA3=${c.isoA3}），不在 continentNames 表`)
    }
    const countryVertexOffset = verts.length / 2
    const countryFillOffset = fillIdx.length
    const countryBorderOffset = borderIdx.length

    // 1a. 逐多边形：简化环 → 追加顶点 → 三角化 → 映射全局；同时记录环范围供边界线段
    for (const poly of c.polygons) {
      const outerSimp = simplifyRing(normalizeRing(poly.outer), epsilon)
      if (outerSimp.length < 3) continue
      const outerRange = appendRing(verts, outerSimp)
      /** @type {{ offset:number, count:number }[]} */
      const polyRings = [outerRange]
      for (const h of poly.holes) {
        const holeSimp = simplifyRing(normalizeRing(h), epsilon)
        if (holeSimp.length < 3) continue
        polyRings.push(appendRing(verts, holeSimp))
      }
      // 三角化（外环 + 洞）
      const localTris = triangulatePolygon(outerSimp, polyRings.slice(1).map((r) => extractRing(verts, r)))
      const globalTris = mapTrisToGlobal(localTris, polyRings)
      for (const gi of globalTris) fillIdx.push(gi)
      // 边界线段：每个环（外 + 洞）闭合折线
      for (const r of polyRings) {
        for (const [a, b] of ringBorderSegments(r.count)) {
          borderIdx.push(r.offset + a, r.offset + b)
        }
      }
    }

    const countryVertexCount = verts.length / 2 - countryVertexOffset
    records.push({
      id: nextId++,
      isoA3: c.isoA3,
      continentIndex: ci,
      vertexOffset: countryVertexOffset,
      vertexCount: countryVertexCount,
      fillIndexOffset: countryFillOffset,
      fillIndexCount: fillIdx.length - countryFillOffset,
      borderIndexOffset: countryBorderOffset,
      borderIndexCount: borderIdx.length - countryBorderOffset,
    })
  }

  // 2. 计算字节尺寸并写入 DataView
  const vertexCount = verts.length / 2
  const fillIndexCount = fillIdx.length
  const borderIndexCount = borderIdx.length
  const countryCount = records.length
  const continentCount = continentNames.length

  const size =
    LAYOUT.HEADER +
    continentCount * LAYOUT.CONTINENT_NAME +
    vertexCount * 2 * 4 +
    fillIndexCount * 4 +
    borderIndexCount * 4 +
    countryCount * LAYOUT.COUNTRY_RECORD

  const buf = new ArrayBuffer(size)
  const dv = new DataView(buf)
  let p = 0

  writeAscii(dv, p, BOUNDARIES_MAGIC)
  p += 4
  dv.setUint32(p, BOUNDARIES_VERSION, true)
  p += 4
  dv.setUint32(p, vertexCount, true)
  p += 4
  dv.setUint32(p, countryCount, true)
  p += 4
  dv.setUint32(p, fillIndexCount, true)
  p += 4
  dv.setUint32(p, borderIndexCount, true)
  p += 4
  dv.setUint32(p, continentCount, true)
  p += 4

  // CONTINENT_NAMES
  for (const name of continentNames) {
    writeUtf8Fixed(dv, p, name, LAYOUT.CONTINENT_NAME)
    p += LAYOUT.CONTINENT_NAME
  }
  // VERTICES
  for (let i = 0; i < verts.length; i += 2) {
    dv.setFloat32(p, verts[i], true)
    p += 4
    dv.setFloat32(p, verts[i + 1], true)
    p += 4
  }
  // FILL_INDICES
  for (const idx of fillIdx) {
    dv.setUint32(p, idx, true)
    p += 4
  }
  // BORDER_INDICES
  for (const idx of borderIdx) {
    dv.setUint32(p, idx, true)
    p += 4
  }
  // COUNTRIES
  for (const r of records) {
    dv.setUint32(p, r.id, true)
    p += 4
    writeAscii(dv, p, r.isoA3.toUpperCase(), LAYOUT.ISO_A3)
    p += LAYOUT.ISO_A3
    dv.setUint8(p, r.continentIndex)
    p += 1
    p += 3 // pad
    dv.setUint32(p, r.vertexOffset, true)
    p += 4
    dv.setUint32(p, r.vertexCount, true)
    p += 4
    dv.setUint32(p, r.fillIndexOffset, true)
    p += 4
    dv.setUint32(p, r.fillIndexCount, true)
    p += 4
    dv.setUint32(p, r.borderIndexOffset, true)
    p += 4
    dv.setUint32(p, r.borderIndexCount, true)
    p += 4
  }

  return {
    bytes: new Uint8Array(buf),
    stats: {
      vertexCount,
      countryCount,
      fillIndexCount,
      borderIndexCount,
      continentCount,
      bytes: size,
    },
  }
}

/** 从全局顶点缓冲按范围取回环顶点（供三角化的洞参数；与 appendRing 对称）。 */
function extractRing(verts, range) {
  const ring = []
  const base = range.offset * 2
  for (let i = 0; i < range.count; i++) {
    ring.push([verts[base + i * 2], verts[base + i * 2 + 1]])
  }
  return ring
}

// ===========================================================================
// 解码：boundaries.bin（round-trip；Task 20 在 src/data/boundaries.ts 以 TS 复刻）
// ===========================================================================

/**
 * 解码 boundaries.bin → 结构化数据。
 * @param {ArrayBuffer | Uint8Array} input
 * @returns {{ vertices: Float32Array, fillIndices: Uint32Array, borderIndices: Uint32Array, continents: string[], countries: object[] }}
 */
export function decodeBoundaries(input) {
  const buf = input instanceof Uint8Array ? input.buffer.slice(input.byteOffset, input.byteOffset + input.byteLength) : input
  const dv = new DataView(buf)
  let p = 0
  const magic = readAscii(dv, p, 4)
  if (magic !== BOUNDARIES_MAGIC) throw new Error(`boundaries.bin 魔数不匹配：${magic}`)
  p += 4
  const version = dv.getUint32(p, true)
  if (version !== BOUNDARIES_VERSION) throw new Error(`boundaries.bin 版本不支持：${version}`)
  p += 4
  const vertexCount = dv.getUint32(p, true)
  p += 4
  const countryCount = dv.getUint32(p, true)
  p += 4
  const fillIndexCount = dv.getUint32(p, true)
  p += 4
  const borderIndexCount = dv.getUint32(p, true)
  p += 4
  const continentCount = dv.getUint32(p, true)
  p += 4

  const continents = []
  for (let i = 0; i < continentCount; i++) {
    continents.push(readUtf8Fixed(dv, p, LAYOUT.CONTINENT_NAME))
    p += LAYOUT.CONTINENT_NAME
  }
  const vertices = new Float32Array(vertexCount * 2)
  for (let i = 0; i < vertices.length; i++) {
    vertices[i] = dv.getFloat32(p, true)
    p += 4
  }
  const fillIndices = new Uint32Array(fillIndexCount)
  for (let i = 0; i < fillIndexCount; i++) {
    fillIndices[i] = dv.getUint32(p, true)
    p += 4
  }
  const borderIndices = new Uint32Array(borderIndexCount)
  for (let i = 0; i < borderIndexCount; i++) {
    borderIndices[i] = dv.getUint32(p, true)
    p += 4
  }
  const countries = []
  for (let i = 0; i < countryCount; i++) {
    const id = dv.getUint32(p, true)
    const isoA3 = readAscii(dv, p + 4, 3)
    const continentIndex = dv.getUint8(p + 8)
    const vertexOffset = dv.getUint32(p + 12, true)
    const vertexCountC = dv.getUint32(p + 16, true)
    const fillIndexOffset = dv.getUint32(p + 20, true)
    const fillIndexCountC = dv.getUint32(p + 24, true)
    const borderIndexOffset = dv.getUint32(p + 28, true)
    const borderIndexCountC = dv.getUint32(p + 32, true)
    p += LAYOUT.COUNTRY_RECORD
    countries.push({
      id,
      isoA3,
      continentIndex,
      continent: continents[continentIndex] ?? '',
      vertexOffset,
      vertexCount: vertexCountC,
      fillIndexOffset,
      fillIndexCount: fillIndexCountC,
      borderIndexOffset,
      borderIndexCount: borderIndexCountC,
    })
  }
  return { vertices, fillIndices, borderIndices, continents, countries }
}

// ===========================================================================
// 打包 / 解码：disputed.bin
// ===========================================================================

/**
 * 打包 disputed.bin。
 * @param {Array<{ id:string, vertices:Array<[number,number]> }>} lines
 * @param {{ simplify?: number }} [opts]
 * @returns {{ bytes: Uint8Array, stats: object }}
 */
export function packDisputed(lines, opts = {}) {
  const epsilon = opts.simplify ?? 0
  /** @type {number[]} */
  const verts = []
  /** @type {object[]} */
  const records = []
  for (const line of lines) {
    const simp = simplifyRing(normalizeRing(line.vertices), epsilon)
    if (simp.length < 2) continue
    const offset = verts.length / 2
    for (const [lon, lat] of simp) verts.push(lon, lat)
    records.push({ id: line.id ?? '', vertexOffset: offset, vertexCount: simp.length })
  }
  const vertexCount = verts.length / 2
  const lineCount = records.length
  const size = LAYOUT.DISPUTED_HEADER + vertexCount * 2 * 4 + lineCount * LAYOUT.DISPUTED_LINE_RECORD
  const buf = new ArrayBuffer(size)
  const dv = new DataView(buf)
  let p = 0
  writeAscii(dv, p, DISPUTED_MAGIC)
  p += 4
  dv.setUint32(p, DISPUTED_VERSION, true)
  p += 4
  dv.setUint32(p, vertexCount, true)
  p += 4
  dv.setUint32(p, lineCount, true)
  p += 4
  for (let i = 0; i < verts.length; i += 2) {
    dv.setFloat32(p, verts[i], true)
    p += 4
    dv.setFloat32(p, verts[i + 1], true)
    p += 4
  }
  for (const r of records) {
    dv.setUint32(p, r.vertexOffset, true)
    p += 4
    dv.setUint32(p, r.vertexCount, true)
    p += 4
    writeUtf8Fixed(dv, p, r.id, 16)
    p += 16
  }
  return {
    bytes: new Uint8Array(buf),
    stats: { vertexCount, lineCount, bytes: size },
  }
}

/**
 * 解码 disputed.bin。
 * @param {ArrayBuffer | Uint8Array} input
 * @returns {{ vertices: Float32Array, lines: Array<{ vertexOffset:number, vertexCount:number, id:string }> }}
 */
export function decodeDisputed(input) {
  const buf = input instanceof Uint8Array ? input.buffer.slice(input.byteOffset, input.byteOffset + input.byteLength) : input
  const dv = new DataView(buf)
  let p = 0
  const magic = readAscii(dv, p, 4)
  if (magic !== DISPUTED_MAGIC) throw new Error(`disputed.bin 魔数不匹配：${magic}`)
  p += 4
  const version = dv.getUint32(p, true)
  if (version !== DISPUTED_VERSION) throw new Error(`disputed.bin 版本不支持：${version}`)
  p += 4
  const vertexCount = dv.getUint32(p, true)
  p += 4
  const lineCount = dv.getUint32(p, true)
  p += 4
  const vertices = new Float32Array(vertexCount * 2)
  for (let i = 0; i < vertices.length; i++) {
    vertices[i] = dv.getFloat32(p, true)
    p += 4
  }
  const lines = []
  for (let i = 0; i < lineCount; i++) {
    const vertexOffset = dv.getUint32(p, true)
    const vCount = dv.getUint32(p + 4, true)
    const id = readUtf8Fixed(dv, p + 8, 16)
    p += LAYOUT.DISPUTED_LINE_RECORD
    lines.push({ vertexOffset, vertexCount: vCount, id })
  }
  return { vertices, lines }
}

// ===========================================================================
// DataView 读写助手（ASCII / 定长 UTF-8）
// ===========================================================================

/** 写 ASCII（不足补 0，超出截断）。 */
function writeAscii(dv, offset, str, maxLen = str.length) {
  const enc = new TextEncoder()
  const bytes = enc.encode(str).subarray(0, maxLen)
  for (let i = 0; i < bytes.length; i++) dv.setUint8(offset + i, bytes[i])
}

/** 读 ASCII（到首个 0 或 maxLen）。 */
function readAscii(dv, offset, maxLen) {
  const bytes = []
  for (let i = 0; i < maxLen; i++) {
    const b = dv.getUint8(offset + i)
    if (b === 0) break
    bytes.push(b)
  }
  return new TextDecoder().decode(new Uint8Array(bytes))
}

/** 写定长 UTF-8（不足补 0，超出截断到 maxLen 字节）。 */
function writeUtf8Fixed(dv, offset, str, maxLen) {
  const enc = new TextEncoder()
  const bytes = enc.encode(str).subarray(0, maxLen)
  for (let i = 0; i < bytes.length; i++) dv.setUint8(offset + i, bytes[i])
}

/** 读定长 UTF-8（到首个 0 或 maxLen）。 */
function readUtf8Fixed(dv, offset, maxLen) {
  const bytes = []
  for (let i = 0; i < maxLen; i++) {
    const b = dv.getUint8(offset + i)
    if (b === 0) break
    bytes.push(b)
  }
  return new TextDecoder().decode(new Uint8Array(bytes))
}
