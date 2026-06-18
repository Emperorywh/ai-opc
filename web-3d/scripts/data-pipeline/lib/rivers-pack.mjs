/**
 * Task 28 · 河流二进制打包 / 解码 + 几何纯函数（核心格式契约，M10）。
 *
 * SPEC §6.4「河流系统」+ §12.3：紧凑二进制 = 带状几何顶点 `Float32[x,y,z]`（已投影 worldXY +
 * heightmap 采样高度 + ε）+ `Float32[u,v]`（累积弧长 / 跨宽度）+ `UInt32` 带状三角形索引 +
 * 属性表（name、level）。
 *
 * 本模块是 Task 28（pipeline pack）与 Task 29（渲染层 decode 消费）之间的**单一格式契约**：
 *   pipeline（pack）  →  rivers.bin  →  前端（decode，`src/data/rivers.ts` TS 复刻同一布局常量）。
 *
 * ─── 投影 / 高度对齐决策（关键，R2 / R3）─────────────────────────────────────────
 *   河流与边界**不同**：边界存地理 lon,lat（点状，前端轻量 `project()`）；河流存**已投影 worldXY**
 *   （带状面）。原因：
 *     1. SPEC §6.4 第 1 点要求「pipeline 中按 DEM 重采样高度 +ε」——高度采样在 pipeline；
 *     2. 带状几何的法线 / 宽度必须在**投影空间**生成（XZ 平面法线垂直于投影后流向），lon,lat
 *        空间法线在高纬失真（Robinson 非线性）；
 *     3. ROADMAP Task 28 步骤「简化→投影→heightmap 采样高度+ε→带状几何→二进制」全部在 pipeline。
 *   pipeline 内部用 `projectRobinson`（与前端 `project` 同源），仍守 R2 单一投影契约。河流「直接
 *   用 Robinson 烘焙无需重投影」（Task 27 备注——M9 已定型）。
 *
 *   高度采样 `sampleHeightAtWorld`（worldXY→UV→双线性）与前端 `src/data/assets.ts` 逐字节同源（R3），
 *   保证河流贴地与地形 shader 一致。前端 decodeRivers 读出带状顶点直接喂 BufferGeometry——**前端
 *   不再 project() / 不再采样高度**（已在 pipeline 烘焙）。
 *
 * ─── rivers.bin 布局（Little-Endian）──────────────────────────────────────────────
 *   HEADER (20B):
 *     0  magic        4B   "RIVR"
 *     4  version      u32  =1
 *     8  vertexCount  u32  带状几何总顶点数（所有河流左右边缘合计）
 *     12 indexCount   u32  带状三角形索引总数（= 三角形 ×3）
 *     16 riverCount   u32  河流数
 *   VERTICES: vertexCount × 3 × f32   (x, y, z；worldXY + 高度 + ε)
 *   UVS:      vertexCount × 2 × f32   (u=累积弧长 XZ 平面世界单位, v∈{-1,+1} 左/右边缘)
 *   INDICES:  indexCount × u32        (带状三角形顶点全局索引)
 *   RIVERS:   riverCount × 48B:
 *     0  id            u32   河流 id（= 记录序号 0..count-1）
 *     4  level         u8    流量级别 1/2/3（决定渲染粗细 / 亮度）
 *     5  (pad)         3B    零
 *     8  name          24B   UTF-8 河流名（零填充；中文 UTF-8 ~3B/字 ≈ 8 字）
 *     32 vertexOffset  u32   该河流顶点在 VERTICES 起始
 *     36 vertexCount   u32
 *     40 indexOffset   u32   该河流三角形索引在 INDICES 起始
 *     44 indexCount    u32
 *
 * 所有 pack/decode 为纯函数（DataView 读写 / 注入式投影与采样），不依赖 DOM / three / 真实
 * heightmap，可在 Node 单测验证 round-trip + 贴地契约。
 */

/** 文件魔数 / 版本（前后端 decoder 同步；src/data/rivers.ts 复刻）。 */
export const RIVER_MAGIC = 'RIVR'
export const RIVER_VERSION = 1

/** 布局常量（字节）。 */
export const LAYOUT = {
  HEADER: 20,
  RIVER_NAME: 24,
  RIVER_RECORD: 48,
}

/** 工作平面尺寸（与 src/config/projection.ts / lib/robinson.mjs 同）。 */
export const PLANE_WIDTH = 2.0
export const PLANE_HEIGHT = 1.0

/** 河流贴地 Y 浮起量（SPEC §6.4「+ε 如 0.005」；介于边界 0.003 / 标签 0.012 之间）。 */
export const RIVER_Y_OFFSET = 0.005

/** 世界 Y 单位/米（与 src/config/projection.ts WORLD_Y_PER_METER 同源）。 */
export const WORLD_Y_PER_METER = 1e-5

/**
 * 各流量级别对应的带状半宽（世界单位）。PLANE 宽 2.0 = 全球经度 360°；河流真实宽度相对全球
 * 可忽略，此处为艺术化可见宽度（"可辨认即可"，真实观感交 Review）。pipeline 按 level 烘焙固定
 * 带宽；Task 29 视觉可在固定带宽上做边缘软过渡 / 发光宽度（shader 层），宽度随 zoom 联动留增强。
 */
export const LEVEL_HALF_WIDTH = {
  1: 0.004,
  2: 0.006,
  3: 0.009,
}

// ===========================================================================
// 几何纯函数：Douglas-Peucker 简化（开放折线）/ worldXY 采样 / 高度转换
// ===========================================================================

/**
 * 点到线段（a→b）的垂直距离（DP 用）。lon,lat 平面近似（小范围误差可忽略）。
 * 与 boundary-pack.mjs perpendicularDistance 同实现（独立维护避免跨模块耦合）。
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
 * Douglas-Peucker 简化**开放折线**（line strip，首尾都保留；区别于 boundary-pack 的闭合环版）。
 * epsilon 单位 = 度（lon,lat）；0 = 不简化，原样返回副本。
 * @param {Array<[number,number]>} points
 * @param {number} epsilon 简化阈值（度）
 * @returns {Array<[number,number]>}
 */
export function simplifyLine(points, epsilon) {
  if (!Array.isArray(points) || points.length < 2) return []
  const safe = points.map((p) => [p[0], p[1]])
  if (!epsilon || epsilon <= 0) return safe
  const n = safe.length
  /** @param {number[]} keep */
  function dp(start, end, keep) {
    let maxD = -1
    let idx = -1
    for (let i = start + 1; i < end; i++) {
      const d = perpendicularDistance(safe[i], safe[start], safe[end])
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
  const keep = new Array(n).fill(0)
  keep[0] = 1
  keep[n - 1] = 1
  dp(0, n - 1, keep)
  return safe.filter((_, i) => keep[i] === 1)
}

/**
 * 世界平面坐标 → 连续像素采样坐标（与前端 `src/data/assets.ts:worldToSample` 严格同源，R3）。
 * heightmap 布局：v=0 顶行=北，u=0 左列=西；Robinson 重烘焙后像素均匀对应 worldXY。
 * @param {number} worldX
 * @param {number} worldZ
 * @param {number} W
 * @param {number} H
 * @returns {{ sx:number, sy:number }}
 */
export function worldToSample(worldX, worldZ, W, H) {
  const sx = (worldX / PLANE_WIDTH + 0.5) * W
  const sy = (0.5 + worldZ / PLANE_HEIGHT) * H
  return { sx, sy }
}

/**
 * 双线性采样 Robinson heightmap 归一化高程 h∈[0,1]（与前端 `sampleHeightAtWorld` 逐字节同源，R3）。
 * 像素中心约定；经度方向环绕（±180 同经线）、纬度方向钳制。
 * @param {Uint16Array} elev 16-bit raw 高程（行主序，与 Task 02 烘焙 / Task 26 Robinson 重烘焙一致）
 * @param {number} W
 * @param {number} H
 * @param {number} worldX
 * @param {number} worldZ
 * @returns {number} h∈[0,1]
 */
export function sampleHeightAtWorld(elev, W, H, worldX, worldZ) {
  const { sx, sy } = worldToSample(worldX, worldZ, W, H)
  const x0 = Math.floor(sx - 0.5)
  const y0 = Math.floor(sy - 0.5)
  const fx = sx - 0.5 - x0
  const fy = sy - 0.5 - y0
  const wrap = (i) => ((i % W) + W) % W
  const clamp = (i) => Math.min(H - 1, Math.max(0, i))
  const xi0 = wrap(x0)
  const xi1 = wrap(x0 + 1)
  const yi0 = clamp(y0)
  const yi1 = clamp(y0 + 1)
  const h00 = elev[yi0 * W + xi0] / 65535
  const h10 = elev[yi0 * W + xi1] / 65535
  const h01 = elev[yi1 * W + xi0] / 65535
  const h11 = elev[yi1 * W + xi1] / 65535
  const a = h00 + (h10 - h00) * fx
  const b = h01 + (h11 - h01) * fx
  return a + (b - a) * fy
}

/**
 * 归一化高程 h∈[0,1] → 世界 Y（与前端 `heightToWorldY` 同源：meters × exaggeration × 1e-5）。
 * @param {number} h
 * @param {{ elevationMin:number, elevationMax:number, heightExaggeration:number }} meta
 * @returns {number}
 */
export function heightToWorldY(h, meta) {
  const meters = meta.elevationMin + h * (meta.elevationMax - meta.elevationMin)
  return meters * meta.heightExaggeration * WORLD_Y_PER_METER
}

// ===========================================================================
// 折线 → 已投影 + 采样高度的中心线
// ===========================================================================

/**
 * 河流折线（lon,lat）→ 已投影中心线（worldXY + 贴地高度 y）。
 *
 *   x,z = projectFn(lon, lat)                        // R2 投影契约（pipeline 注入 projectRobinson）
 *   groundY = heightToWorldY(sampleFn(worldX,worldZ), meta)  // R3：与 shader / 边界 / 标签同源
 *   y = max(groundY, seaY) + RIVER_Y_OFFSET           // 陆地贴地表 / 海面贴海面 + ε 浮起防 z-fighting
 *
 * 注入 projectFn / sampleFn 使本函数可在 Node 单测（mock 投影 / 采样）无需真实 heightmap。
 *
 * @param {Array<[number,number]>} verts lon,lat 折线
 * @param {(lon:number, lat:number) => [number, number]} projectFn
 * @param {(worldX:number, worldZ:number) => number} sampleFn 返回归一化高程 h∈[0,1]
 * @param {{ elevationMin:number, elevationMax:number, seaLevelMeters:number, heightExaggeration:number }} meta
 * @returns {Array<{ x:number, y:number, z:number }>}
 */
export function projectAndSampleLine(verts, projectFn, sampleFn, meta) {
  const seaY = meta.seaLevelMeters * meta.heightExaggeration * WORLD_Y_PER_METER
  const out = []
  for (const [lon, lat] of verts) {
    const [x, z] = projectFn(lon, lat)
    const h = sampleFn(x, z)
    const groundY = heightToWorldY(h, meta)
    out.push({ x, y: Math.max(groundY, seaY) + RIVER_Y_OFFSET, z })
  }
  return out
}

// ===========================================================================
// 带状几何（ribbon）：中心线 + miter 法线 → 左右边缘顶点 + 累积弧长 UV + 三角带索引
// ===========================================================================

/**
 * 中心线（已投影 + 贴地）→ 带状面几何（position / uv / index）。
 *
 * 每个中心点扩展为左 (v=-1) / 右 (v=+1) 两个边缘顶点，沿 miter 法线（相邻两段法线角平分线，
 * 归一化）偏移 halfWidth——折角无缝（非逐段独立法线产生的裂缝）。边缘顶点共用中心点高度 y
 * （halfWidth 极小 ~0.004-0.009 世界单位，横向地形落差可忽略；中心线贴地即整带贴地）。
 *
 *   u = 沿流向累积弧长（XZ 平面水平距离，不含 y）——Task 29 shader 沿 u + uTime 做流动光带
 *   v ∈ {-1, +1} 跨宽度——边缘软过渡 shader 据 |v| 做 alpha / 亮度衰减
 *
 * 三角形（每段 2 个，CCW 朝 +y）：(L_i, R_i, L_{i+1}) + (R_i, R_{i+1}, L_{i+1})。
 *
 * @param {Array<{ x:number, y:number, z:number }>} center 已投影 + 贴地中心线（≥2 点）
 * @param {number} halfWidth 半宽（世界单位，按 level）
 * @returns {{ positions:number[], uvs:number[], indices:number[] }} 扁平数组（顶点单位 ×3/×2 / 三角形索引）
 */
export function buildRiverRibbon(center, halfWidth) {
  const n = center.length
  if (n < 2) return { positions: [], uvs: [], indices: [] }

  // 每段流向单位向量（XZ 平面，忽略 y）
  /** @type {Array<{ x:number, z:number }>} */
  const dirs = []
  for (let i = 0; i < n - 1; i++) {
    const dx = center[i + 1].x - center[i].x
    const dz = center[i + 1].z - center[i].z
    const len = Math.hypot(dx, dz) || 1e-9
    dirs.push({ x: dx / len, z: dz / len })
  }

  // 每点 miter 法线（左法线 = 流向逆时针 90°：(-dz, dx)）
  /** @type {Array<{ x:number, z:number }>} */
  const normals = []
  for (let i = 0; i < n; i++) {
    let dirX, dirZ
    if (i === 0) {
      dirX = dirs[0].x
      dirZ = dirs[0].z
    } else if (i === n - 1) {
      dirX = dirs[n - 2].x
      dirZ = dirs[n - 2].z
    } else {
      // miter：相邻两段方向之和归一化（角平分线）
      dirX = dirs[i - 1].x + dirs[i].x
      dirZ = dirs[i - 1].z + dirs[i].z
      const len = Math.hypot(dirX, dirZ) || 1e-9
      dirX /= len
      dirZ /= len
    }
    normals.push({ x: -dirZ, z: dirX })
  }

  /** @type {number[]} */ const positions = []
  /** @type {number[]} */ const uvs = []
  /** @type {number[]} */ const indices = []

  let u = 0
  for (let i = 0; i < n; i++) {
    const p = center[i]
    const nx = normals[i].x
    const nz = normals[i].z
    // 左边缘（v=-1）
    positions.push(p.x + nx * halfWidth, p.y, p.z + nz * halfWidth)
    uvs.push(u, -1)
    // 右边缘（v=+1）
    positions.push(p.x - nx * halfWidth, p.y, p.z - nz * halfWidth)
    uvs.push(u, 1)
    if (i < n - 1) {
      const segDx = center[i + 1].x - p.x
      const segDz = center[i + 1].z - p.z
      u += Math.hypot(segDx, segDz)
    }
  }

  for (let i = 0; i < n - 1; i++) {
    const li = i * 2
    const ri = i * 2 + 1
    const li1 = (i + 1) * 2
    const ri1 = (i + 1) * 2 + 1
    indices.push(li, ri, li1)
    indices.push(ri, ri1, li1)
  }

  return { positions, uvs, indices }
}

// ===========================================================================
// 打包：rivers.bin
// ===========================================================================

/**
 * 打包 rivers.bin（注入式投影 / 采样，便于 Node 单测）。
 *
 * @param {import('./rivers-data.mjs').RiverFeature[]} rivers
 * @param {(lon:number, lat:number) => [number, number]} projectFn pipeline 传 projectRobinson
 * @param {(worldX:number, worldZ:number) => number} sampleFn 返回归一化高程 h∈[0,1]（CLI 传闭包采样 heightmap）
 * @param {{ elevationMin:number, elevationMax:number, seaLevelMeters:number, heightExaggeration:number }} meta
 * @param {{ simplify?:number }} [opts] simplify=0 不简化（度）
 * @returns {{ bytes:Uint8Array, stats:object }}
 */
export function packRivers(rivers, projectFn, sampleFn, meta, opts = {}) {
  const epsilon = opts.simplify ?? 0
  /** @type {number[]} */ const positions = []
  /** @type {number[]} */ const uvs = []
  /** @type {number[]} */ const indices = []
  /** @type {object[]} */ const records = []

  let nextId = 0
  for (const r of rivers) {
    const simp = simplifyLine(r.vertices, epsilon)
    if (simp.length < 2) continue
    const center = projectAndSampleLine(simp, projectFn, sampleFn, meta)
    if (center.length < 2) continue
    const halfWidth = LEVEL_HALF_WIDTH[/** @type {1|2|3} */ (r.level)] ?? LEVEL_HALF_WIDTH[2]
    const ribbon = buildRiverRibbon(center, halfWidth)

    const vertexOffset = positions.length / 3
    const indexOffset = indices.length
    for (let i = 0; i < ribbon.positions.length; i++) positions.push(ribbon.positions[i])
    for (let i = 0; i < ribbon.uvs.length; i++) uvs.push(ribbon.uvs[i])
    for (const li of ribbon.indices) indices.push(vertexOffset + li)

    records.push({
      id: nextId++,
      level: r.level,
      name: r.name,
      vertexOffset,
      vertexCount: ribbon.positions.length / 3,
      indexOffset,
      indexCount: ribbon.indices.length,
    })
  }

  const vertexCount = positions.length / 3
  const indexCount = indices.length
  const riverCount = records.length

  const size =
    LAYOUT.HEADER +
    vertexCount * 3 * 4 +
    vertexCount * 2 * 4 +
    indexCount * 4 +
    riverCount * LAYOUT.RIVER_RECORD

  const buf = new ArrayBuffer(size)
  const dv = new DataView(buf)
  let p = 0
  writeAscii(dv, p, RIVER_MAGIC)
  p += 4
  dv.setUint32(p, RIVER_VERSION, true)
  p += 4
  dv.setUint32(p, vertexCount, true)
  p += 4
  dv.setUint32(p, indexCount, true)
  p += 4
  dv.setUint32(p, riverCount, true)
  p += 4

  // VERTICES
  for (let i = 0; i < positions.length; i++) {
    dv.setFloat32(p, positions[i], true)
    p += 4
  }
  // UVS
  for (let i = 0; i < uvs.length; i++) {
    dv.setFloat32(p, uvs[i], true)
    p += 4
  }
  // INDICES
  for (let i = 0; i < indices.length; i++) {
    dv.setUint32(p, indices[i], true)
    p += 4
  }
  // RIVERS
  for (const r of records) {
    dv.setUint32(p, r.id, true)
    p += 4
    dv.setUint8(p, r.level)
    p += 1
    p += 3 // pad
    writeUtf8Fixed(dv, p, r.name, LAYOUT.RIVER_NAME)
    p += LAYOUT.RIVER_NAME
    dv.setUint32(p, r.vertexOffset, true)
    p += 4
    dv.setUint32(p, r.vertexCount, true)
    p += 4
    dv.setUint32(p, r.indexOffset, true)
    p += 4
    dv.setUint32(p, r.indexCount, true)
    p += 4
  }

  return {
    bytes: new Uint8Array(buf),
    stats: { vertexCount, indexCount, riverCount, bytes: size },
  }
}

// ===========================================================================
// 解码：rivers.bin（round-trip；Task 29 前端 src/data/rivers.ts 以 TS 复刻）
// ===========================================================================

/**
 * 解码 rivers.bin → 结构化数据。
 * @param {ArrayBuffer | Uint8Array} input
 * @returns {{ vertices:Float32Array, uvs:Float32Array, indices:Uint32Array, rivers:Array<{ id:number, level:number, name:string, vertexOffset:number, vertexCount:number, indexOffset:number, indexCount:number }> }}
 */
export function decodeRivers(input) {
  const buf =
    input instanceof Uint8Array
      ? input.buffer.slice(input.byteOffset, input.byteOffset + input.byteLength)
      : input
  const dv = new DataView(buf)
  let p = 0
  const magic = readAscii(dv, p, 4)
  if (magic !== RIVER_MAGIC) throw new Error(`rivers.bin 魔数不匹配：${magic}`)
  p += 4
  const version = dv.getUint32(p, true)
  if (version !== RIVER_VERSION) throw new Error(`rivers.bin 版本不支持：${version}`)
  p += 4
  const vertexCount = dv.getUint32(p, true)
  p += 4
  const indexCount = dv.getUint32(p, true)
  p += 4
  const riverCount = dv.getUint32(p, true)
  p += 4

  const vertices = new Float32Array(vertexCount * 3)
  for (let i = 0; i < vertices.length; i++) {
    vertices[i] = dv.getFloat32(p, true)
    p += 4
  }
  const uvs = new Float32Array(vertexCount * 2)
  for (let i = 0; i < uvs.length; i++) {
    uvs[i] = dv.getFloat32(p, true)
    p += 4
  }
  const indices = new Uint32Array(indexCount)
  for (let i = 0; i < indexCount; i++) {
    indices[i] = dv.getUint32(p, true)
    p += 4
  }
  const rivers = []
  for (let i = 0; i < riverCount; i++) {
    const id = dv.getUint32(p, true)
    const level = dv.getUint8(p + 4)
    const name = readUtf8Fixed(dv, p + 8, LAYOUT.RIVER_NAME)
    const vertexOffset = dv.getUint32(p + 32, true)
    const vertexCountR = dv.getUint32(p + 36, true)
    const indexOffset = dv.getUint32(p + 40, true)
    const indexCountR = dv.getUint32(p + 44, true)
    p += LAYOUT.RIVER_RECORD
    rivers.push({ id, level, name, vertexOffset, vertexCount: vertexCountR, indexOffset, indexCount: indexCountR })
  }
  return { vertices, uvs, indices, rivers }
}

// ===========================================================================
// DataView 读写助手（ASCII / 定长 UTF-8，与 boundary-pack.mjs 实现对称）
// ===========================================================================

/** 写 ASCII（不足补 0，超出截断）。 */
function writeAscii(dv, offset, str) {
  const bytes = new TextEncoder().encode(str).subarray(0, 4)
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
  const bytes = new TextEncoder().encode(str).subarray(0, maxLen)
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
