/**
 * Task 27 · 全矢量对齐验证（M9 风险验证 #2「所有矢量对齐」+ #3「渲染层零改动」，落地 ROADMAP
 * Task 27「对齐验证报告」的编程断言依据）。
 *
 * Task 26 已证「地基对齐」：project===pipeline projectRobinson 逐点（robinson.test）、
 * sampleHeight 走 project→worldXY→UV（assets.test）、Robinson heightmap 已知点正确（robinson.test）。
 * 本 Task 把地基接到「矢量消费者」（边界/争议/标签/卡片）做**端到端闭环**，并用**真实 Robinson
 * 重烘焙产物**校验（区别于 boundaries-render.test / labels.test 的合成 fixture / buildLabels）。
 *
 * 四组验证：
 *   A. 全矢量锚点落工作平面（真实 boundaries.bin / disputed.bin / labels.json 17 条）
 *   B. 矢量贴地高度语义（陆地贴地 / 大洋贴海面 / 边界顶点 ≥ 海面 —— 不被山埋、不沉海底）
 *   C. 极区压缩量化（南极洲 lat=-82 / 北冰洋 lat=85 锚点，M9 核心验收 #1 的客观度量）
 *   D. 切换投影验收（全域网格落 PLANE + round-trip 无空洞 + src/three 无硬编码 equirect 映射守护）
 *
 * 不渲染真实 WebGL（agent 无浏览器）；几何 / 采样对齐编程可验证，dev 视觉留 Review。
 */
import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { resolve, relative } from 'node:path'

import { decodeBoundaries, decodeDisputed } from '../src/data/boundaries'
import {
  parseLabels,
  parseMeta,
  sampleHeightAtWorld,
  sampleWorldY,
} from '../src/data/assets'
import { decodePng } from '../scripts/data-pipeline/lib/png-reader.mjs'
import {
  project,
  unproject,
  heightToMeters,
  metersToWorldY,
  PLANE_WIDTH,
} from '../src/config/projection'
import {
  buildBoundaryPositions,
  buildDisputedSegments,
  BOUNDARY_Y_OFFSET,
} from '../src/three/borders/boundaryGeometry'
import { labelWorldPosition } from '../src/three/labels/labelLayout'
import { countryAnchorLonLat } from '../src/three/labels/countryInfo'
import type {
  BoundaryData,
  DisputedData,
  ElevationData,
} from '../src/data/types'

// ---------------------------------------------------------------------------
// 真实产物（Task 26 Robinson 重烘焙）：public/data/**
// ---------------------------------------------------------------------------

const PUBLIC_DATA = resolve('public/data')

const png = decodePng(readFileSync(resolve(PUBLIC_DATA, 'heightmap.png')))
const elevRaw = new Uint16Array(png.width * png.height)
for (let i = 0; i < elevRaw.length; i++) {
  elevRaw[i] = (png.data[i * 2] << 8) | png.data[i * 2 + 1]
}
const elevation: ElevationData = { width: png.width, height: png.height, data: elevRaw }

const meta = parseMeta(JSON.parse(readFileSync(resolve(PUBLIC_DATA, 'meta.json'), 'utf8')))
const seaY = metersToWorldY(meta.seaLevelMeters)

const boundaries: BoundaryData = decodeBoundaries(
  new Uint8Array(readFileSync(resolve(PUBLIC_DATA, 'boundaries.bin'))),
)
const disputed: DisputedData = decodeDisputed(
  new Uint8Array(readFileSync(resolve(PUBLIC_DATA, 'disputed.bin'))),
)
const labels = parseLabels(JSON.parse(readFileSync(resolve(PUBLIC_DATA, 'labels.json'), 'utf8')))

/** equirect 参照投影（切换前的 before 基线，量化 Robinson 极区压缩用）。 */
const equirectX = (lon: number): number => (lon / 180) * (PLANE_WIDTH / 2)

// ---------------------------------------------------------------------------
// 辅助：src/three 源码扫描（切换投影守护 —— 渲染层不得绕过 project 做硬编码 equirect 映射）
// ---------------------------------------------------------------------------

/** 递归列出目录下所有 .ts/.tsx 源码文件（相对项目根）。 */
function listSourceFiles(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = resolve(dir, entry.name)
    if (entry.isDirectory()) {
      out.push(...listSourceFiles(full))
    } else if (/\.(ts|tsx)$/.test(entry.name)) {
      out.push(full)
    }
  }
  return out
}

/**
 * 去掉 JS/TS 注释（块注释 `/* *\/` + 整行 `//` 行注释）。
 * 行内尾注释（`code // note`）保留代码部分——守护只关心代码，尾注释不影响。
 */
function stripComments(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, '') // 块注释（含 JSDoc）
    .replace(/^[ \t]*\/\/.*$/gm, '') // 整行行注释
}

/** 断言 (x,z) 落工作平面 [-1,1]×[-0.5,0.5]（容许 1e-9 浮点误差）。 */
function expectInPlane(x: number, z: number): void {
  expect(x).toBeGreaterThanOrEqual(-1 - 1e-9)
  expect(x).toBeLessThanOrEqual(1 + 1e-9)
  expect(z).toBeGreaterThanOrEqual(-0.5 - 1e-9)
  expect(z).toBeLessThanOrEqual(0.5 + 1e-9)
}

// ===========================================================================
// A. 全矢量锚点落工作平面（真实产物端到端）
// ===========================================================================

describe('A. 全矢量锚点落工作平面（Robinson · 真实产物端到端）', () => {
  it('边界全部顶点 project 落 PLANE（真实 boundaries.bin · 6 国轮廓）', () => {
    const n = boundaries.vertices.length / 2
    expect(n).toBeGreaterThan(0)
    for (let i = 0; i < n; i++) {
      const lon = boundaries.vertices[i * 2]
      const lat = boundaries.vertices[i * 2 + 1]
      const [x, z] = project(lon, lat)
      expectInPlane(x, z)
    }
  })

  it('争议线全部顶点 project 落 PLANE（真实 disputed.bin · 3 条争议线）', () => {
    const n = disputed.vertices.length / 2
    expect(n).toBeGreaterThan(0)
    expect(disputed.lines.length).toBeGreaterThan(0)
    for (let i = 0; i < n; i++) {
      const [x, z] = project(disputed.vertices[i * 2], disputed.vertices[i * 2 + 1])
      expectInPlane(x, z)
    }
  })

  it('标签全部锚点 project 落 PLANE（真实 labels.json · 7 大洲+4 大洋+6 国家 = 17）', () => {
    expect(labels.length).toBe(17)
    for (const label of labels) {
      const [x, z] = project(label.lon, label.lat)
      expectInPlane(x, z)
    }
  })
})

// ===========================================================================
// B. 矢量贴地高度语义（真实 Robinson heightmap · 矢量不被山埋 / 不沉海底）
// ===========================================================================

describe('B. 矢量贴地高度语义（真实 Robinson heightmap · R3 端到端）', () => {
  it('边界顶点 y ≥ 海面 + ε（陆地贴地表 / 海面贴海平面，不沉海底）', () => {
    const positions = buildBoundaryPositions(boundaries, elevation, meta)
    expect(positions.length / 3).toBe(boundaries.vertices.length / 2)
    for (let i = 0; i < positions.length / 3; i++) {
      expect(positions[i * 3 + 1]).toBeGreaterThanOrEqual(seaY + BOUNDARY_Y_OFFSET - 1e-9)
    }
  })

  it('争议线顶点 y ≥ 海面 + ε（贴地，与边界同源 BOUNDARY_Y_OFFSET）', () => {
    const { positions } = buildDisputedSegments(disputed, elevation, meta)
    expect(positions.length).toBeGreaterThan(0)
    for (let i = 0; i < positions.length / 3; i++) {
      expect(positions[i * 3 + 1]).toBeGreaterThanOrEqual(seaY + BOUNDARY_Y_OFFSET - 1e-9)
    }
  })

  it('已知陆地国家标签锚点贴地（y > 海面：中国/巴西/埃及/澳大利亚）', () => {
    const landCountryIds = ['chn', 'bra', 'egy', 'aus']
    for (const id of landCountryIds) {
      const label = labels.find((l) => l.id === id)
      expect(label, `标签 ${id} 应存在`).toBeDefined()
      const [, y] = labelWorldPosition(label!, elevation, meta)
      // 陆地 groundY > 0（seaLevelMeters=0 → seaY=0），max(地面,海面)=地面 > 海面
      expect(y, `${label!.zhName} 应贴地高于海面`).toBeGreaterThan(seaY)
    }
  })

  it('大洋标签锚点贴海面（y = 海面：太平洋/大西洋/印度洋/北冰洋，不沉海底）', () => {
    const oceans = labels.filter((l) => l.kind === 'ocean')
    expect(oceans.length).toBe(4)
    for (const ocean of oceans) {
      const [, y] = labelWorldPosition(ocean, elevation, meta)
      // 海底 groundY < 0，max(海底, 海面)=海面 → y = seaY（大洋标签贴海面，避免被海洋几何遮蔽）
      expect(y, `${ocean.zhName} 应贴海面`).toBeCloseTo(seaY, 6)
    }
  })

  it('CountryCard 锚点（countryAnchorLonLat）project 落 PLANE（质心落海修复后锚点仍合规）', () => {
    for (const country of boundaries.countries) {
      const [lon, lat] = countryAnchorLonLat(boundaries, country)
      const [x, z] = project(lon, lat)
      expectInPlane(x, z)
    }
  })

  it('矢量消费者 y 链路与地形顶点同源（sampleWorldY 经 project→worldXY→UV ≡ shader heightUv）', () => {
    // 标签/边界/卡片的 y 经 sampleWorldY → sampleHeight → project → sampleHeightAtWorld(worldXY→UV)，
    // 与 Task 04 shader 的 heightUv = worldXY→UV 严格同源（assets.test 已证函数级，此处真实产物复证）
    for (const label of labels) {
      const [x, z] = project(label.lon, label.lat)
      const viaChain = sampleWorldY(elevation, meta, label.lon, label.lat)
      // sampleWorldY = heightToWorldY(sampleHeight(lon,lat)) = heightToWorldY(sampleHeightAtWorld(x,z))
      const h = sampleHeightAtWorld(elevation, x, z)
      const groundMeters = heightToMeters(h, meta)
      const expected = metersToWorldY(groundMeters)
      expect(viaChain).toBeCloseTo(expected, 9)
    }
  })
})

// ===========================================================================
// C. 极区压缩量化（M9 核心验收 #1 · Robinson 消除极区拉伸）
// ===========================================================================

describe('C. 极区压缩量化（M9 核心验收 #1 · Robinson 消除极区拉伸）', () => {
  it('南极洲大洲锚点（lat=-82）：Robinson x 跨度显著小于 equirect（极区经线收敛）', () => {
    const antarctica = labels.find((l) => l.id === 'antarctica')
    expect(antarctica, '南极洲标签应存在').toBeDefined()
    expect(antarctica!.lat).toBe(-82)

    // 同纬度 lon=±180 的 x 跨度：equirect 恒 2.0（与纬度无关，极区拉伸根源），Robinson 收敛
    const eqSpan = equirectX(180) - equirectX(-180) // = 2.0
    const robSpan = project(180, antarctica!.lat)[0] - project(-180, antarctica!.lat)[0]
    expect(eqSpan).toBeCloseTo(2.0, 9)
    expect(robSpan).toBeLessThan(1.5) // 压缩 > 25%
    expect(robSpan).toBeGreaterThan(0)
  })

  it('北冰洋锚点（lat=85）：Robinson 高纬经线收敛（lon=180 的 x < equirect 1.0）', () => {
    const arctic = labels.find((l) => l.id === 'arctic')
    expect(arctic, '北冰洋标签应存在').toBeDefined()
    expect(arctic!.lat).toBe(85)

    const eqX = equirectX(180) // = 1.0（equirect 与纬度无关）
    const robX = project(180, arctic!.lat)[0]
    expect(eqX).toBeCloseTo(1.0, 9)
    expect(robX).toBeLessThan(0.6) // 极区经线大幅收敛
  })

  it('极区压缩率随 |lat| 单调增强（赤道 0 → 极区最强，Robinson 伪圆柱特性）', () => {
    // 压缩率 = 1 − robinson跨度 / equirect跨度(=2.0)；|lat| 越大经线越收敛 → 压缩越强
    const compress = (lat: number): number => {
      const rob = project(180, lat)[0] - project(-180, lat)[0]
      return 1 - rob / 2.0
    }
    expect(compress(0)).toBeCloseTo(0, 6) // 赤道无压缩
    expect(compress(45)).toBeGreaterThan(0)
    expect(compress(60)).toBeGreaterThan(compress(45))
    expect(compress(80)).toBeGreaterThan(compress(60))
    expect(compress(85)).toBeGreaterThan(compress(80))
  })

  it('极区锚点 z 接近极（|z| → 0.5）：南极洲/北冰洋锚点落在极区纵向边缘', () => {
    const antarctica = labels.find((l) => l.id === 'antarctica')!
    const arctic = labels.find((l) => l.id === 'arctic')!
    const [, zAnt] = project(antarctica.lon, antarctica.lat)
    const [, zArc] = project(arctic.lon, arctic.lat)
    expect(zAnt).toBeCloseTo(0.5, 1) // lat=-82 → z ≈ +0.488（南极 +z）
    expect(zArc).toBeCloseTo(-0.5, 1) // lat=+85 → z ≈ -0.491（北极 -z）
  })
})

// ===========================================================================
// D. 切换投影验收（渲染层零改动守护 · M9 核心验收 #3）
// ===========================================================================

describe('D. 切换投影验收（渲染层零改动守护 · M9 核心验收 #3）', () => {
  it('project 全域密集网格采样落 PLANE（范围恒定 → 渲染层依赖范围，不依赖内部映射）', () => {
    // 无论 PROJECTION 切到哪个，只要 project 输出范围恒定 [-1,1]×[-0.5,0.5]，
    // 渲染层（依赖 project 输出范围）就零改动 —— 这是「切换投影渲染层零改动」的数学保证。
    let outOfRange = 0
    let sampled = 0
    for (let lon = -180; lon <= 180; lon += 10) {
      for (let lat = -90; lat <= 90; lat += 5) {
        const [x, z] = project(lon, lat)
        sampled++
        if (
          x < -1 - 1e-9 ||
          x > 1 + 1e-9 ||
          z < -0.5 - 1e-9 ||
          z > 0.5 + 1e-9
        ) {
          outOfRange++
        }
      }
    }
    expect(sampled).toBeGreaterThan(600) // 37×37 网格足够密集
    expect(outOfRange).toBe(0)
  })

  it('unproject round-trip 全域无空洞（Robinson 矩形内部全覆盖，非线性投影不失真）', () => {
    // ±180 边缘经度在 Robinson 是矩形左右边（同一经线，反投影返回 ±180 之一，环绕歧义非 bug），
    // 故 round-trip 用内部点验证
    let maxErr = 0
    for (let lon = -170; lon <= 170; lon += 10) {
      for (let lat = -89; lat <= 89; lat += 5) {
        const [x, z] = project(lon, lat)
        const [lon2, lat2] = unproject(x, z)
        maxErr = Math.max(maxErr, Math.abs(lon - lon2), Math.abs(lat - lat2))
      }
    }
    expect(maxErr).toBeLessThan(1e-6)
  })

  it('渲染层 src/three 无硬编码 equirect 经纬度坐标映射（只经 project / worldXY→UV）', () => {
    // 守护 R2 单一投影契约：若有人在 src/three 写 lon/180、lat/90 等硬编码 equirect 映射，
    // 切换 Robinson 时该处会错位且难排查。扫描源码（去注释）断言不存在此类绕过 project 的硬编码。
    // 角度→弧度（cameraState 的 * Math.PI / 180，变量名 pitchDeg/yawRangeDeg）不在此列。
    const threeDir = resolve('src/three')
    const files = listSourceFiles(threeDir)
    expect(files.length).toBeGreaterThan(10) // 渲染层子系统应有相当数量的源码文件

    // equirect 坐标硬编码特征：lon/lat 标识符后 40 字符内出现 / 180、/ 90 或 * 90（坐标映射）
    const re = /(?:\blon\b|\blat\b)[^\n]{0,40}(?:\/\s*180\b|\/\s*90\b|\*\s*90\b)/
    const offenders: string[] = []
    for (const f of files) {
      const code = stripComments(readFileSync(f, 'utf8'))
      for (const line of code.split('\n')) {
        if (re.test(line)) {
          offenders.push(`${relative(resolve('.'), f)}: ${line.trim()}`)
        }
      }
    }
    expect(offenders, `渲染层存在绕过 project 的硬编码 equirect 映射：\n${offenders.join('\n')}`).toEqual([])
  })
})
