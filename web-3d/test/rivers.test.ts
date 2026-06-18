/**
 * Task 28 · 河流数据 pipeline 单测。
 *
 * 验证 SPEC §6.4 / §12.3 契约：
 *   · 几何纯函数（Douglas-Peucker 开放折线简化 / worldXY 采样 / 双线性高度 / 高度→世界 Y）
 *   · projectAndSampleLine（投影 + heightmap 采样贴地 + ε；陆地贴地 / 海面钳制）
 *   · buildRiverRibbon（miter 带状几何：顶点数 / 左右边缘 v / 累积弧长 u / 三角带索引 / halfWidth 偏移）
 *   · 二进制打包 → 解码 round-trip（magic/version/顶点/uv/索引/河流属性全对称 + 中文名 UTF-8）
 *   · **前后端 decoder 同源**：pipeline `decodeRivers`(.mjs) === 前端 `decodeRivers`(.ts)
 *     对同一 packed bytes 输出逐字段相等（单一格式契约）
 *   · 贴地契约（M10 风险验证 #1）：带状顶点 y ≥ 海面 + ε（不沉底）+ 陆地段贴地抬升
 *   · 数据源（合成 fallback 覆盖 SPEC 六大河）+ normalizeRivers（LineString/MultiLineString/scalerank→level）
 *
 * 不依赖真实 NE / 真实 heightmap（注入式 project/sample + 合成数据，确定可复现）。
 */
import { describe, it, expect } from 'vitest'
import {
  simplifyLine,
  perpendicularDistance,
  worldToSample,
  sampleHeightAtWorld,
  heightToWorldY,
  projectAndSampleLine,
  buildRiverRibbon,
  packRivers,
  decodeRivers,
  RIVER_Y_OFFSET,
  LEVEL_HALF_WIDTH,
  LAYOUT,
  PLANE_WIDTH,
  PLANE_HEIGHT,
} from '../scripts/data-pipeline/lib/rivers-pack.mjs'
import {
  SYNTHETIC_RIVERS,
  RIVER_LEVELS,
  normalizeRivers,
  normalizeRiverFeature,
  scalerankToLevel,
} from '../scripts/data-pipeline/lib/rivers-data.mjs'
import { createRiverSource } from '../scripts/data-pipeline/lib/river-source.mjs'
import { decodeRivers as decodeRiversFE } from '../src/data/rivers'
import { projectRobinson } from '../scripts/data-pipeline/lib/robinson.mjs'

/** 合成 DEM 范围（与 Task 04 注释 / boundaries-render 合成 elevation 同量级）。 */
const META = {
  elevationMin: -5000,
  elevationMax: 6500,
  seaLevelMeters: 0,
  heightExaggeration: 2.5,
}
const seaY = META.seaLevelMeters * META.heightExaggeration * 1e-5

/** 线性投影 mock（lon,lat→worldXY 可预测，测 projectAndSampleLine 投影 + 采样解耦）。 */
const linearProject = (lon: number, lat: number): [number, number] => [lon / 180, lat / 180]

// ---------------------------------------------------------------------------
// 几何纯函数：Douglas-Peucker 开放折线简化
// ---------------------------------------------------------------------------

describe('simplifyLine（开放折线 DP 简化）', () => {
  it('epsilon=0 原样返回副本', () => {
    const pts: Array<[number, number]> = [
      [0, 0],
      [1, 1],
      [2, 2],
    ]
    const out = simplifyLine(pts, 0)
    expect(out).toEqual(pts)
    expect(out).not.toBe(pts) // 副本
  })

  it('首尾点必保留', () => {
    const pts: Array<[number, number]> = [
      [0, 0],
      [0.01, 0.01],
      [1, 0],
      [2, 0],
    ]
    const out = simplifyLine(pts, 0.1)
    expect(out[0]).toEqual([0, 0])
    expect(out[out.length - 1]).toEqual([2, 0])
  })

  it('移除共线中间点', () => {
    const pts: Array<[number, number]> = [
      [0, 0],
      [1, 0],
      [2, 0],
      [3, 0],
    ]
    const out = simplifyLine(pts, 0.01)
    expect(out).toEqual([
      [0, 0],
      [3, 0],
    ])
  })

  it('保留偏离直线的折角', () => {
    const pts: Array<[number, number]> = [
      [0, 0],
      [1, 0],
      [1, 5],
      [2, 5],
    ]
    const out = simplifyLine(pts, 0.1)
    expect(out).toContainEqual([1, 5])
  })

  it('不足 2 点返回空', () => {
    expect(simplifyLine([[0, 0]], 0.1)).toEqual([])
    expect(simplifyLine([], 0.1)).toEqual([])
  })
})

describe('perpendicularDistance', () => {
  it('点在线段上距离 0', () => {
    expect(perpendicularDistance([0.5, 0], [0, 0], [1, 0])).toBe(0)
  })

  it('点到水平线段的垂直距离', () => {
    expect(perpendicularDistance([0.5, 3], [0, 0], [1, 0])).toBeCloseTo(3, 10)
  })

  it('投影钳制到端点外（点在线段延长线侧）', () => {
    // 点在 a 左侧远处，最近点钳到 a
    const d = perpendicularDistance([-5, 1], [0, 0], [1, 0])
    expect(d).toBeCloseTo(Math.hypot(5, 1), 8)
  })

  it('退化线段（a==b）返点到点距离', () => {
    expect(perpendicularDistance([3, 4], [0, 0], [0, 0])).toBe(5)
  })
})

// ---------------------------------------------------------------------------
// 几何纯函数：worldXY 采样 + 双线性高度 + 高度→世界 Y（与前端 assets.ts 同源 R3）
// ---------------------------------------------------------------------------

describe('worldToSample（worldXY→像素采样坐标，与前端同源）', () => {
  it('中心 worldXY → 像素中心', () => {
    const { sx, sy } = worldToSample(0, 0, 100, 100)
    expect(sx).toBeCloseTo(50, 10)
    expect(sy).toBeCloseTo(50, 10)
  })

  it('四角边界', () => {
    expect(worldToSample(-PLANE_WIDTH / 2, -PLANE_HEIGHT / 2, 10, 10)).toEqual({ sx: 0, sy: 0 })
    expect(worldToSample(PLANE_WIDTH / 2, PLANE_HEIGHT / 2, 10, 10)).toEqual({ sx: 10, sy: 10 })
  })
})

describe('sampleHeightAtWorld（双线性，与前端 sampleHeightAtWorld 同源）', () => {
  /** 构造 W×H 合成 heightmap（Uint16），按 (x,y) 填值。 */
  const makeElev = (W: number, H: number, fn: (x: number, y: number) => number) => {
    const data = new Uint16Array(W * H)
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) data[y * W + x] = fn(x, y)
    return data
  }

  it('常数 heightmap 返该值', () => {
    const elev = makeElev(4, 4, () => 32768) // h=0.5
    const h = sampleHeightAtWorld(elev, 4, 4, 0, 0)
    expect(h).toBeCloseTo(32768 / 65535, 6)
  })

  it('线性梯度双线性插值', () => {
    // x 方向梯度：左 0 右 65535
    const elev = makeElev(2, 2, (x) => (x === 0 ? 0 : 65535))
    // 采样 worldX 对应像素中心之间 → h 应在 (0,1)
    const h = sampleHeightAtWorld(elev, 2, 2, 0, 0)
    expect(h).toBeGreaterThan(0)
    expect(h).toBeLessThan(1)
  })

  it('经度方向环绕（±180 同经线）', () => {
    // 最左列与最右列环绕：采样 worldX 接近 +PLANE_WIDTH/2 边缘应环绕到左侧（不抛错）
    const elev = makeElev(4, 4, (x) => x * 1000)
    const hRight = sampleHeightAtWorld(elev, 4, 4, PLANE_WIDTH / 2 - 1e-4, 0)
    expect(Number.isFinite(hRight)).toBe(true)
  })

  it('纬度方向钳制（不环绕，极点钳到边）', () => {
    const elev = makeElev(4, 4, (_x, y) => y * 1000)
    const h = sampleHeightAtWorld(elev, 4, 4, 0, PLANE_HEIGHT / 2 + 1)
    expect(Number.isFinite(h)).toBe(true) // 越界钳制不抛错
  })
})

describe('heightToWorldY（与前端 heightToWorldY 同源）', () => {
  it('h=0 → elevationMin 世界 Y', () => {
    expect(heightToWorldY(0, META)).toBeCloseTo(-5000 * 2.5 * 1e-5, 10)
  })

  it('h=1 → elevationMax 世界 Y', () => {
    expect(heightToWorldY(1, META)).toBeCloseTo(6500 * 2.5 * 1e-5, 10)
  })

  it('线性单调', () => {
    const y0 = heightToWorldY(0.3, META)
    const y1 = heightToWorldY(0.7, META)
    expect(y1).toBeGreaterThan(y0)
  })
})

// ---------------------------------------------------------------------------
// projectAndSampleLine：投影 + 贴地采样 + ε
// ---------------------------------------------------------------------------

describe('projectAndSampleLine（投影 + heightmap 采样贴地）', () => {
  it('陆地贴地（groundY > seaY）→ y = groundY + ε', () => {
    const verts: Array<[number, number]> = [
      [0, 0],
      [90, 0],
    ]
    // sampleFn 返 h=0.7 → meters=3050 → groundY=3050*2.5e-5=0.07625（>seaY=0）
    const center = projectAndSampleLine(verts, linearProject, () => 0.7, META)
    expect(center).toHaveLength(2)
    const expectedY = heightToWorldY(0.7, META) + RIVER_Y_OFFSET
    expect(center[0].y).toBeCloseTo(expectedY, 8)
    expect(center[0].y).toBeGreaterThan(seaY + RIVER_Y_OFFSET - 1e-9)
  })

  it('海底钳到海面（groundY < seaY）→ y = seaY + ε', () => {
    const verts: Array<[number, number]> = [[0, 0]]
    // h=0.3 → meters=-1550 → groundY=-0.03875 < seaY=0
    const center = projectAndSampleLine(verts, linearProject, () => 0.3, META)
    expect(center[0].y).toBeCloseTo(seaY + RIVER_Y_OFFSET, 10)
  })

  it('投影坐标 = projectFn 输出（x,z 一致）', () => {
    const verts: Array<[number, number]> = [
      [90, 45],
      [180, 0],
    ]
    const center = projectAndSampleLine(verts, linearProject, () => 0.5, META)
    expect(center[0].x).toBeCloseTo(0.5, 10) // 90/180
    expect(center[0].z).toBeCloseTo(0.25, 10) // 45/180
    expect(center[1].x).toBeCloseTo(1, 10)
  })

  it('贴地契约：所有点 y ≥ seaY + ε（M10 风险验证 #1 不沉底）', () => {
    const verts: Array<[number, number]> = [
      [0, 0],
      [10, 0],
      [20, 0],
    ]
    // h 在 0.1~0.9 间变化
    const center = projectAndSampleLine(verts, linearProject, () => 0.5, META)
    for (const p of center) {
      expect(p.y).toBeGreaterThanOrEqual(seaY + RIVER_Y_OFFSET - 1e-9)
    }
  })
})

// ---------------------------------------------------------------------------
// buildRiverRibbon：miter 带状几何
// ---------------------------------------------------------------------------

describe('buildRiverRibbon（带状几何）', () => {
  it('直线段：顶点数 = 2×中心点，三角形 = (n-1)×2', () => {
    const center = [
      { x: 0, y: 0.1, z: 0 },
      { x: 1, y: 0.1, z: 0 },
    ]
    const r = buildRiverRibbon(center, 0.1)
    expect(r.positions.length).toBe(4 * 3) // 4 顶点
    expect(r.uvs.length).toBe(4 * 2)
    expect(r.indices.length).toBe(6) // 2 三角形 ×3
  })

  it('直线沿 +x：左右边缘 z = ±halfWidth（法线 (-dz,dx) 垂直流向）', () => {
    const center = [
      { x: 0, y: 0.1, z: 0 },
      { x: 1, y: 0.1, z: 0 },
    ]
    const r = buildRiverRibbon(center, 0.2)
    // 顶点序列 [L0, R0, L1, R1]；流向 +x → 法线 (0,1)（z 向）→ L 在 +z，R 在 -z
    const L0 = [r.positions[0], r.positions[2]]
    const R0 = [r.positions[3], r.positions[5]]
    expect(L0[0]).toBeCloseTo(0, 10) // x
    expect(L0[1]).toBeCloseTo(0.2, 10) // z = +halfWidth
    expect(R0[1]).toBeCloseTo(-0.2, 10) // z = -halfWidth
  })

  it('左右边缘 v 交替 -1 / +1', () => {
    const center = [
      { x: 0, y: 0, z: 0 },
      { x: 0.5, y: 0, z: 0 },
      { x: 1, y: 0, z: 0 },
    ]
    const r = buildRiverRibbon(center, 0.1)
    // uv 序列 [u_L0,-1, u_R0,+1, u_L1,-1, u_R1,+1, ...]
    expect(r.uvs[1]).toBe(-1) // L0.v
    expect(r.uvs[3]).toBe(1) // R0.v
    expect(r.uvs[5]).toBe(-1) // L1.v
  })

  it('累积弧长 u 沿流向单调递增', () => {
    const center = [
      { x: 0, y: 0, z: 0 },
      { x: 0.5, y: 0, z: 0 },
      { x: 1.5, y: 0, z: 0 },
    ]
    const r = buildRiverRibbon(center, 0.1)
    // u：i=0 → 0；i=1（段长 0.5）→ 0.5；i=2（段长 1）→ 1.5
    expect(r.uvs[0]).toBeCloseTo(0, 10) // L0.u
    expect(r.uvs[4]).toBeCloseTo(0.5, 10) // L1.u
    expect(r.uvs[8]).toBeCloseTo(1.5, 10) // L2.u
  })

  it('索引全部合法（< 顶点数）且为三角带模式', () => {
    const center = [
      { x: 0, y: 0, z: 0 },
      { x: 1, y: 0, z: 0 },
      { x: 2, y: 0, z: 0 },
    ]
    const r = buildRiverRibbon(center, 0.1)
    const vCount = r.positions.length / 3
    for (const idx of r.indices) expect(idx).toBeLessThan(vCount)
    // 第一段两三角形：(0,1,2) + (1,3,2)
    expect(r.indices.slice(0, 6)).toEqual([0, 1, 2, 1, 3, 2])
  })

  it('折角点无 NaN（miter 法线归一化不除零）', () => {
    const center = [
      { x: 0, y: 0, z: 0 },
      { x: 1, y: 0, z: 1 },
      { x: 2, y: 0, z: 0 },
    ]
    const r = buildRiverRibbon(center, 0.1)
    for (const v of r.positions) expect(Number.isFinite(v)).toBe(true)
  })

  it('中心点 < 2 返回空几何', () => {
    expect(buildRiverRibbon([], 0.1)).toEqual({ positions: [], uvs: [], indices: [] })
    expect(buildRiverRibbon([{ x: 0, y: 0, z: 0 }], 0.1)).toEqual({
      positions: [],
      uvs: [],
      indices: [],
    })
  })
})

// ---------------------------------------------------------------------------
// pack / decode round-trip
// ---------------------------------------------------------------------------

/** 合成河流集（注入 mock project/sample，确定可复现）。 */
const TEST_RIVERS = [
  {
    name: '长江',
    level: RIVER_LEVELS.LARGE as const,
    vertices: [
      [91, 33],
      [106, 30],
      [122, 31],
    ] as Array<[number, number]>,
  },
  {
    name: '多瑙河',
    level: RIVER_LEVELS.MEDIUM as const,
    vertices: [
      [8, 48],
      [16, 48],
      [29, 45],
    ] as Array<[number, number]>,
  },
]

describe('packRivers / decodeRivers round-trip', () => {
  const packed = packRivers(TEST_RIVERS, projectRobinson, () => 0.7, META, { simplify: 0 })

  it('魔数 / 版本正确', () => {
    expect(packed.bytes[0]).toBe(0x52) // 'R'
    expect(packed.bytes[1]).toBe(0x49) // 'I'
    expect(packed.bytes[2]).toBe(0x56) // 'V'
    expect(packed.bytes[3]).toBe(0x52) // 'R'
  })

  it('字节数 = 预期布局', () => {
    const decoded = decodeRivers(packed.bytes)
    const expected =
      LAYOUT.HEADER +
      decoded.vertices.length * 4 +
      decoded.uvs.length * 4 +
      decoded.indices.length * 4 +
      decoded.rivers.length * LAYOUT.RIVER_RECORD
    expect(packed.bytes.length).toBe(expected)
    expect(packed.stats.bytes).toBe(expected)
  })

  it('顶点 / uv / 索引 round-trip 逐元素相等', () => {
    const fe = decodeRiversFE(packed.bytes) // 前端 TS decoder（同源验证）
    const be = decodeRivers(packed.bytes) // pipeline decoder
    expect(fe.vertices).toEqual(be.vertices)
    expect(fe.uvs).toEqual(be.uvs)
    expect(fe.indices).toEqual(be.indices)
    expect(fe.vertices.length).toBe(packed.stats.vertexCount * 3)
    expect(fe.indices.length).toBe(packed.stats.indexCount)
  })

  it('河流属性 round-trip（id/name/level/范围）', () => {
    const decoded = decodeRivers(packed.bytes)
    expect(decoded.rivers).toHaveLength(2)
    expect(decoded.rivers[0]).toMatchObject({ id: 0, name: '长江', level: 3 })
    expect(decoded.rivers[1]).toMatchObject({ id: 1, name: '多瑙河', level: 2 })
    // 范围连续无空洞
    expect(decoded.rivers[1].vertexOffset).toBe(decoded.rivers[0].vertexOffset + decoded.rivers[0].vertexCount)
    expect(decoded.rivers[1].indexOffset).toBe(decoded.rivers[0].indexOffset + decoded.rivers[0].indexCount)
  })

  it('中文 name UTF-8 round-trip（≤24B）', () => {
    const decoded = decodeRivers(packed.bytes)
    expect(decoded.rivers[0].name).toBe('长江')
    expect(decoded.rivers[1].name).toBe('多瑙河')
  })

  it('每河顶点数 = 2×中心点数，索引 = (n-1)×6', () => {
    const decoded = decodeRivers(packed.bytes)
    // 每河 3 中心点 → 6 带状顶点 → 2 段 → 4 三角形 → 12 索引
    expect(decoded.rivers[0].vertexCount).toBe(6)
    expect(decoded.rivers[0].indexCount).toBe(12)
  })

  it('level 映射带宽（LEVEL_HALF_WIDTH 不同 level 不同半宽）', () => {
    expect(LEVEL_HALF_WIDTH[3]).toBeGreaterThan(LEVEL_HALF_WIDTH[2])
    expect(LEVEL_HALF_WIDTH[2]).toBeGreaterThan(LEVEL_HALF_WIDTH[1])
  })

  it('非法魔数抛错', () => {
    const bad = new Uint8Array(packed.bytes)
    bad[0] = 0x00 // 破坏魔数
    expect(() => decodeRivers(bad)).toThrow(/魔数/)
  })

  it('非法版本抛错', () => {
    const bad = new Uint8Array(packed.bytes)
    const dv = new DataView(bad.buffer)
    dv.setUint32(4, 999, true) // version=999
    expect(() => decodeRivers(bad)).toThrow(/版本/)
  })
})

// ---------------------------------------------------------------------------
// 贴地契约（M10 风险验证 #1：贴地不穿山 / 无悬空）
// ---------------------------------------------------------------------------

describe('贴地契约（验收 #1 无穿模 / 无悬空）', () => {
  it('带状顶点 y ≥ 海面 + ε（不沉底）', () => {
    const packed = packRivers(TEST_RIVERS, projectRobinson, () => 0.7, META, { simplify: 0 })
    const decoded = decodeRivers(packed.bytes)
    for (let i = 1; i < decoded.vertices.length; i += 3) {
      expect(decoded.vertices[i]).toBeGreaterThanOrEqual(seaY + RIVER_Y_OFFSET - 1e-6)
    }
  })

  it('陆地贴地段 y 显著高于海面（采样到地形非全钳海面）', () => {
    // sampleFn 返 h=0.9 → 高地 → y 应显著 > seaY
    const packed = packRivers(TEST_RIVERS, projectRobinson, () => 0.9, META, { simplify: 0 })
    const decoded = decodeRivers(packed.bytes)
    const maxY = Math.max(...Array.from(decoded.vertices).filter((_, i) => (i - 1) % 3 === 0))
    expect(maxY).toBeGreaterThan(seaY + 0.01)
  })

  it('海底段钳到海面 + ε（不悬空于海底之下，亦不沉底）', () => {
    // sampleFn 返 h=0.1 → meters=-3850 < 0 → 钳海面
    const packed = packRivers(TEST_RIVERS, projectRobinson, () => 0.1, META, { simplify: 0 })
    const decoded = decodeRivers(packed.bytes)
    for (let i = 1; i < decoded.vertices.length; i += 3) {
      expect(decoded.vertices[i]).toBeCloseTo(seaY + RIVER_Y_OFFSET, 6)
    }
  })

  it('左右边缘顶点共用中心点高度（同段左右 y 相等，带宽小地形差异忽略）', () => {
    const packed = packRivers(TEST_RIVERS, projectRobinson, () => 0.7, META, { simplify: 0 })
    const decoded = decodeRivers(packed.bytes)
    // 顶点序列 [L,R,L,R,...]，相邻 L/R 对的 y 相等
    for (let i = 0; i < decoded.vertices.length / 3 - 1; i += 2) {
      const yL = decoded.vertices[i * 3 + 1]
      const yR = decoded.vertices[(i + 1) * 3 + 1]
      expect(yL).toBeCloseTo(yR, 10)
    }
  })
})

// ---------------------------------------------------------------------------
// 数据源 + normalizeRivers
// ---------------------------------------------------------------------------

describe('SYNTHETIC_RIVERS（合成覆盖 SPEC 六大河）', () => {
  it('覆盖 SPEC §6.4 六条主要河流', () => {
    const names = SYNTHETIC_RIVERS.map((r) => r.name)
    expect(names).toEqual(
      expect.arrayContaining(['长江', '黄河', '亚马逊河', '尼罗河', '密西西比河', '多瑙河']),
    )
    expect(SYNTHETIC_RIVERS.length).toBeGreaterThanOrEqual(6)
  })

  it('每条河 level 合法 + 顶点 ≥2 + lon/lat 范围合法', () => {
    for (const r of SYNTHETIC_RIVERS) {
      expect([1, 2, 3]).toContain(r.level)
      expect(r.vertices.length).toBeGreaterThanOrEqual(2)
      for (const [lon, lat] of r.vertices) {
        expect(lon).toBeGreaterThanOrEqual(-180)
        expect(lon).toBeLessThanOrEqual(180)
        expect(lat).toBeGreaterThanOrEqual(-90)
        expect(lat).toBeLessThanOrEqual(90)
      }
    }
  })
})

describe('scalerankToLevel', () => {
  it('scalerank ≤3 → LARGE(3)', () => {
    expect(scalerankToLevel(1)).toBe(RIVER_LEVELS.LARGE)
    expect(scalerankToLevel(3)).toBe(RIVER_LEVELS.LARGE)
  })
  it('scalerank 4-6 → MEDIUM(2)', () => {
    expect(scalerankToLevel(5)).toBe(RIVER_LEVELS.MEDIUM)
  })
  it('scalerank ≥7 → SMALL(1)', () => {
    expect(scalerankToLevel(8)).toBe(RIVER_LEVELS.SMALL)
  })
  it('缺失 scalerank → MEDIUM(2) 默认', () => {
    expect(scalerankToLevel(NaN)).toBe(RIVER_LEVELS.MEDIUM)
  })
})

describe('normalizeRiverFeature / normalizeRivers（真实 NE GeoJSON）', () => {
  it('LineString → 1 条 RiverFeature', () => {
    const feat = {
      geometry: { type: 'LineString', coordinates: [[0, 0], [1, 1], [2, 0]] },
      properties: { name: 'Test', scalerank: 2 },
    }
    const out = normalizeRiverFeature(feat)
    expect(out).toHaveLength(1)
    expect(out[0].name).toBe('Test')
    expect(out[0].level).toBe(RIVER_LEVELS.LARGE)
    expect(out[0].vertices).toHaveLength(3)
  })

  it('MultiLineString → 多条独立 RiverFeature（同名）', () => {
    const feat = {
      geometry: {
        type: 'MultiLineString',
        coordinates: [[[0, 0], [1, 1]], [[2, 2], [3, 3]]],
      },
      properties: { name: 'Multi', scalerank: 5 },
    }
    const out = normalizeRiverFeature(feat)
    expect(out).toHaveLength(2)
    expect(out.every((r) => r.name === 'Multi')).toBe(true)
    expect(out.every((r) => r.level === RIVER_LEVELS.MEDIUM)).toBe(true)
  })

  it('缺 geometry → []', () => {
    expect(normalizeRiverFeature({ properties: { name: 'X' } })).toEqual([])
  })

  it('缺 name → "unknown"', () => {
    const feat = {
      geometry: { type: 'LineString', coordinates: [[0, 0], [1, 1]] },
      properties: { scalerank: 3 },
    }
    expect(normalizeRiverFeature(feat)[0].name).toBe('unknown')
  })

  it('FeatureCollection → 扁平 RiverFeature[]', () => {
    const fc = {
      type: 'FeatureCollection',
      features: [
        { geometry: { type: 'LineString', coordinates: [[0, 0], [1, 1]] }, properties: { name: 'A' } },
        {
          geometry: { type: 'MultiLineString', coordinates: [[[0, 0], [1, 1]], [[2, 2], [3, 3]]] },
          properties: { name: 'B' },
        },
      ],
    }
    expect(normalizeRivers(fc)).toHaveLength(3)
  })
})

describe('createRiverSource（合成 fallback）', () => {
  it('默认（无 raw/ne）→ synthetic + 六大河', () => {
    const { source, rivers } = createRiverSource({ neDir: '/nonexistent/path/for/test' })
    expect(source).toBe('synthetic')
    expect(rivers.length).toBeGreaterThanOrEqual(6)
    expect(rivers.map((r) => r.name)).toContain('长江')
  })
})

// ---------------------------------------------------------------------------
// 投影同源：河流 pipeline projectRobinson === 前端 project（R2 单一契约）
// ---------------------------------------------------------------------------

describe('投影同源（河流与世界对齐 R2）', () => {
  it('pipeline projectRobinson 输出落 PLANE 范围（合成六河所有折点）', () => {
    for (const r of SYNTHETIC_RIVERS) {
      for (const [lon, lat] of r.vertices) {
        const [x, z] = projectRobinson(lon, lat)
        expect(x).toBeGreaterThanOrEqual(-PLANE_WIDTH / 2 - 1e-6)
        expect(x).toBeLessThanOrEqual(PLANE_WIDTH / 2 + 1e-6)
        expect(z).toBeGreaterThanOrEqual(-PLANE_HEIGHT / 2 - 1e-6)
        expect(z).toBeLessThanOrEqual(PLANE_HEIGHT / 2 + 1e-6)
      }
    }
  })
})
