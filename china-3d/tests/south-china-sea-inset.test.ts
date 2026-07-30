/**
 * 南海诸岛 2D 标准附图测试（TASK-012，SPEC §3.8 / §5.4 / §6）。
 *
 * 依赖方向：测试基线（vitest，Node 环境），import src/lib/south-china-sea-inset（领域准备层，含标注
 * 摆放裁决）、src/lib/projection（projectToInset / projectToMercator / projectToWorld /
 * MAIN_MAP_CENTER——复算与跨投影一致性断言）、src/lib/political-red-line（共享红线扫描）、
 * src/geo-contracts（validatePoliticalBoundary 契约校验 + political-catalog SPEC §6 红线点名真值）、
 * src/config/south-china-sea-inset（生产四至 / viewBox / 样式不变量）、src/config/political-features
 * （主图政治要素基线色——同源性断言）。不启动浏览器 / WebGL——准备层是纯函数、组件装配与总装接线走
 * 源码扫描，人工视觉验收见 TASK-012 verificationHints（pnpm dev 目视核对）。
 *
 * 覆盖（对应 TASK-012 验收条件）：
 * - 验收 1「右下角矩形 2D 附图：九段线（十段）、南海岛礁点、标注齐全」：
 *   生产资产 10 段全被消费（segmentIndex 1..10，含台湾东侧第 10 段）、5 个岛礁点全在（含点名岛礁
 *   钓鱼岛 / 赤尾屿 / 曾母暗沙）、全部 (u,v) 落在 [0,1]²；规范名称标注经确定性贪心摆放后完整落在
 *   矩形边框内且两两不互叠（钓鱼岛 / 赤尾屿这类同纬度相邻贴东缘点位不裁剪不互叠）；CSS 锁定右下角
 *   定位与 DOM overlay 形态。
 * - 验收 2「同一 projection 模块的 2D 子范围，与主图投影一致」：附图 (u,v) 严格等于 projectToInset
 *   （忠实复用，无第二套投影）；跨投影交叉验证——由 (u,v) 重建的墨卡托与由主图 projectToWorld 重建的
 *   墨卡托一致（二者都等于 projectToMercator(lon,lat)）；源码扫描锁定领域层唯一投影入口。
 * - 验收 3「DOM overlay，不进入 3D 渲染循环，深色科技风样式与页面一致」：组件源码扫描——无
 *   R3F / Three.js / useFrame / fetch / 硬编码坐标；App 总装扫描——附图挂在 </Canvas> 之外、
 *   准备失败进入整页错误通道；CSS 扫描——半透明深色面板 + 发光描边 + pointer-events: none。
 * - 红线失败路径（SPEC §6）：删台湾东侧段 / 删任一点名岛礁 / 空契约 / 越界四至 → 各自稳定 code
 *   抛错，绝不产出残缺附图（不静默显示残缺图）。
 * - 配置不变量：四至自洽、含全部十段线与岛礁；viewBox 高度按墨卡托比例派生；样式参数有限非空、
 *   全部冻结；附图线 / 点基线色与主图政治要素同一事实源。
 */

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  prepareSouthChinaSeaInset,
  SouthChinaSeaInsetPrepError,
  type SouthChinaSeaInsetPrepConfig,
} from '../src/lib/south-china-sea-inset'
import { collectPoliticalRedLineGaps } from '../src/lib/political-red-line'
import {
  MAIN_MAP_CENTER,
  projectToInset,
  projectToMercator,
  projectToWorld,
} from '../src/lib/projection'
import {
  SOUTH_CHINA_SEA_INSET_CONFIG,
  SOUTH_CHINA_SEA_INSET_EXTENT,
} from '../src/config/south-china-sea-inset'
import { POLITICAL_FEATURES_CONFIG } from '../src/config/political-features'
import {
  EXPECTED_NINE_DASH_SEGMENT_COUNT,
  REQUIRED_ISLAND_NAMES,
  REQUIRED_NINE_DASH_SEGMENT_INDICES,
  TAIWAN_EAST_SEGMENT_INDEX,
  validatePoliticalBoundary,
  type IslandOrReefPointFeature,
  type PoliticalBoundaryContract,
} from '../src/geo-contracts'

const projectRoot = resolve(fileURLToPath(import.meta.url), '..', '..')

/** 生产准备配置（与组件装配同源：布局参数取配置层冻结值，无第二份）。 */
const PREP_CONFIG: SouthChinaSeaInsetPrepConfig = {
  viewboxWidth: SOUTH_CHINA_SEA_INSET_CONFIG.viewboxWidth,
  viewboxHeight: SOUTH_CHINA_SEA_INSET_CONFIG.viewboxHeight,
  labelFontSize: SOUTH_CHINA_SEA_INSET_CONFIG.labelFontSize,
  pointRadius: SOUTH_CHINA_SEA_INSET_CONFIG.pointRadius,
  labelOffsetX: SOUTH_CHINA_SEA_INSET_CONFIG.labelOffsetX,
  frameMargin: SOUTH_CHINA_SEA_INSET_CONFIG.frameStrokeWidth,
}

/** 加载生产政治边界资产并经契约校验，返回 PoliticalBoundaryContract（与政治要素测试同构）。 */
function loadProductionContract(): PoliticalBoundaryContract {
  const assetPath = resolve(projectRoot, 'public', 'geo', 'china-political-boundary.json')
  const payload: unknown = JSON.parse(readFileSync(assetPath, 'utf-8'))
  const outcome = validatePoliticalBoundary(payload)
  expect(outcome.ok, '生产政治边界资产应通过契约校验').toBe(true)
  return payload as PoliticalBoundaryContract
}

/** 深拷贝生产契约，避免篡改污染（与政治要素测试同构）。 */
function cloneContract(contract: PoliticalBoundaryContract): PoliticalBoundaryContract {
  return JSON.parse(JSON.stringify(contract)) as PoliticalBoundaryContract
}

/** 断言两个数值在给定绝对容差内相等。 */
function expectAlmostEqual(actual: number, expected: number, tolerance: number, note = ''): void {
  expect(
    Math.abs(actual - expected),
    `期望 ${actual} ≈ ${expected}（容差 ${tolerance}）${note}`,
  ).toBeLessThanOrEqual(tolerance)
}

/** 在契约中按名查找岛礁点位要素（断言存在）。 */
function findIsland(contract: PoliticalBoundaryContract, name: string): IslandOrReefPointFeature {
  const feature = contract.features.find(
    (f): f is IslandOrReefPointFeature => f.type === 'islandOrReefPoint' && f.name === name,
  )
  expect(feature, `契约应含岛礁点位「${name}」`).toBeDefined()
  return feature as IslandOrReefPointFeature
}

/** 读取 src 下某源码文件的文本（源码结构不变量扫描用，与政治要素测试同构）。 */
function readSource(relativePath: string): string {
  return readFileSync(resolve(projectRoot, 'src', relativePath), 'utf-8')
}

describe('红线完整性：十段含台湾东侧段、岛礁点与标注齐全（验收 1）', () => {
  it('生产政治资产经附图准备后恰好产出 10 段十段线，段序号 1..10 全在', () => {
    const contract = loadProductionContract()
    const result = prepareSouthChinaSeaInset(contract, SOUTH_CHINA_SEA_INSET_EXTENT, PREP_CONFIG)
    expect(result.lines.length).toBe(EXPECTED_NINE_DASH_SEGMENT_COUNT)
    const indices = new Set(result.lines.map((line) => line.segmentIndex))
    for (const index of REQUIRED_NINE_DASH_SEGMENT_INDICES) {
      expect(indices.has(index), `段序号 ${index} 应在附图准备产物中`).toBe(true)
    }
  })

  it('台湾东侧段（segmentIndex=10）被独立消费（SPEC §6 红线「含台湾东侧那段」）', () => {
    const contract = loadProductionContract()
    const result = prepareSouthChinaSeaInset(contract, SOUTH_CHINA_SEA_INSET_EXTENT, PREP_CONFIG)
    const taiwanEast = result.lines.find((line) => line.segmentIndex === TAIWAN_EAST_SEGMENT_INDEX)
    expect(taiwanEast, '台湾东侧段必须被附图消费').toBeDefined()
    expect(
      (taiwanEast as (typeof result.lines)[number]).uvPolyline.length,
      '台湾东侧段应含至少 2 个顶点',
    ).toBeGreaterThanOrEqual(2)
  })

  it('十段线按段独立组织（10 段各自一个折线），不合并为单条连续折线', () => {
    const contract = loadProductionContract()
    const result = prepareSouthChinaSeaInset(contract, SOUTH_CHINA_SEA_INSET_EXTENT, PREP_CONFIG)
    expect(result.lines.length).toBe(10)
    for (const line of result.lines) {
      expect(line.uvPolyline.length, `段 ${line.segmentIndex} 应含至少 2 个顶点`).toBeGreaterThanOrEqual(2)
    }
    // 按段序号升序输出（台湾东侧段位置确定、可审计）。
    const indices = result.lines.map((line) => line.segmentIndex)
    expect([...indices].sort((a, b) => a - b)).toEqual(indices)
  })

  it('生产资产全部岛礁点（5 个）连同规范名称均被消费，点名岛礁均在', () => {
    const contract = loadProductionContract()
    const result = prepareSouthChinaSeaInset(contract, SOUTH_CHINA_SEA_INSET_EXTENT, PREP_CONFIG)
    const contractIslandCount = contract.features.filter((f) => f.type === 'islandOrReefPoint').length
    expect(result.points.length).toBe(contractIslandCount)
    expect(result.points.length).toBe(5)
    const names = new Set(result.points.map((point) => point.name))
    for (const name of REQUIRED_ISLAND_NAMES) {
      expect(names.has(name), `点名岛礁「${name}」应在附图点位中`).toBe(true)
    }
    // 每个点位都携带非空规范名称（标注齐全的载体）。
    for (const point of result.points) {
      expect(point.name.length).toBeGreaterThan(0)
    }
  })

  it('全部十段线顶点与岛礁点位的 (u,v) 落在 [0,1]²（附图四至含全部红线要素）', () => {
    const contract = loadProductionContract()
    const result = prepareSouthChinaSeaInset(contract, SOUTH_CHINA_SEA_INSET_EXTENT, PREP_CONFIG)
    for (const line of result.lines) {
      for (const vertex of line.uvPolyline) {
        expect(vertex.u).toBeGreaterThanOrEqual(0)
        expect(vertex.u).toBeLessThanOrEqual(1)
        expect(vertex.v).toBeGreaterThanOrEqual(0)
        expect(vertex.v).toBeLessThanOrEqual(1)
      }
    }
    for (const point of result.points) {
      expect(point.u).toBeGreaterThanOrEqual(0)
      expect(point.u).toBeLessThanOrEqual(1)
      expect(point.v).toBeGreaterThanOrEqual(0)
      expect(point.v).toBeLessThanOrEqual(1)
    }
  })
})

describe('标注齐全：摆放框内不裁剪、互不叠（验收 1「标注齐全」）', () => {
  /**
   * 复算某点位的标注盒（与领域层同一度量：CJK 全宽字形宽 = 字数 × 字号，上沿 0.85em / 下沿 0.15em）。
   * 测试独立复算以交叉验证准备层摆放决策，而非信任其内部几何。
   */
  function labelBoxOf(point: {
    readonly name: string
    readonly u: number
    readonly v: number
    readonly labelAnchor: 'start' | 'end' | 'middle'
    readonly labelDx: number
    readonly labelDy: number
  }): { readonly x0: number; readonly y0: number; readonly x1: number; readonly y1: number } {
    const W = SOUTH_CHINA_SEA_INSET_CONFIG.viewboxWidth
    const H = SOUTH_CHINA_SEA_INSET_CONFIG.viewboxHeight
    const fs = SOUTH_CHINA_SEA_INSET_CONFIG.labelFontSize
    const cx = point.u * W
    const cy = (1 - point.v) * H
    const width = point.name.length * fs
    const x0 =
      point.labelAnchor === 'start'
        ? cx + point.labelDx
        : point.labelAnchor === 'end'
          ? cx + point.labelDx - width
          : cx + point.labelDx - width / 2
    const baseline = cy + point.labelDy
    return { x0, y0: baseline - 0.85 * fs, x1: x0 + width, y1: baseline + 0.15 * fs }
  }

  it('五个岛礁标注的摆放决策确定且符合意图（钓鱼岛左锚、赤尾屿上锚、其余右锚）', () => {
    const contract = loadProductionContract()
    const result = prepareSouthChinaSeaInset(contract, SOUTH_CHINA_SEA_INSET_EXTENT, PREP_CONFIG)
    const anchorOf = (name: string): 'start' | 'end' | 'middle' => {
      const point = result.points.find((p) => p.name === name)
      expect(point, `点位「${name}」应在附图产物中`).toBeDefined()
      return (point as (typeof result.points)[number]).labelAnchor
    }
    // 钓鱼岛 / 赤尾屿同纬度相邻贴东缘：右锚出框、双左锚互叠 → 钓鱼岛左锚、赤尾屿上锚（候选序裁决）。
    expect(anchorOf('钓鱼岛')).toBe('end')
    expect(anchorOf('赤尾屿')).toBe('middle')
    expect(anchorOf('曾母暗沙')).toBe('start')
    expect(anchorOf('黄岩岛')).toBe('start')
    expect(anchorOf('永兴岛')).toBe('start')
    // 摆放确定性：同一契约与配置重跑，决策逐点一致。
    const rerun = prepareSouthChinaSeaInset(contract, SOUTH_CHINA_SEA_INSET_EXTENT, PREP_CONFIG)
    for (let i = 0; i < result.points.length; i++) {
      expect(rerun.points[i].labelAnchor).toBe(result.points[i].labelAnchor)
      expect(rerun.points[i].labelDx).toBe(result.points[i].labelDx)
      expect(rerun.points[i].labelDy).toBe(result.points[i].labelDy)
    }
  })

  it('全部岛礁规范名称完整落在矩形边框内（不被裁剪）', () => {
    const contract = loadProductionContract()
    const result = prepareSouthChinaSeaInset(contract, SOUTH_CHINA_SEA_INSET_EXTENT, PREP_CONFIG)
    const W = SOUTH_CHINA_SEA_INSET_CONFIG.viewboxWidth
    const H = SOUTH_CHINA_SEA_INSET_CONFIG.viewboxHeight
    for (const point of result.points) {
      const box = labelBoxOf(point)
      expect(box.x0, `「${point.name}」标注西缘应不越出左边框`).toBeGreaterThanOrEqual(0)
      expect(box.x1, `「${point.name}」标注东缘应不越出右边框`).toBeLessThanOrEqual(W)
      expect(box.y0, `「${point.name}」标注上缘应不越出上边框`).toBeGreaterThanOrEqual(0)
      expect(box.y1, `「${point.name}」标注下缘应不越出下边框`).toBeLessThanOrEqual(H)
    }
  })

  it('全部岛礁规范名称两两不互叠（标注可读）', () => {
    const contract = loadProductionContract()
    const result = prepareSouthChinaSeaInset(contract, SOUTH_CHINA_SEA_INSET_EXTENT, PREP_CONFIG)
    const boxes = result.points.map((point) => ({ name: point.name, box: labelBoxOf(point) }))
    for (let i = 0; i < boxes.length; i++) {
      for (let j = i + 1; j < boxes.length; j++) {
        const a = boxes[i]
        const b = boxes[j]
        const overlap = a.box.x0 < b.box.x1 && a.box.x1 > b.box.x0 && a.box.y0 < b.box.y1 && a.box.y1 > b.box.y0
        expect(overlap, `「${a.name}」与「${b.name}」标注不应互叠`).toBe(false)
      }
    }
  })

  it('退化情形（四候选均不可放）回退右锚标准惯例，不崩溃不丢标注', () => {
    const contract = cloneContract(loadProductionContract())
    // 东北角角点：右出东框、左出上框、上出上框、下出东框 → 触发回退。
    contract.features = [
      ...contract.features,
      { type: 'islandOrReefPoint', name: '测试角点', coordinate: { lon: 126, lat: 27 } },
    ]
    const result = prepareSouthChinaSeaInset(contract, SOUTH_CHINA_SEA_INSET_EXTENT, PREP_CONFIG)
    const corner = result.points.find((p) => p.name === '测试角点')
    expect(corner, '角点点位应在附图产物中').toBeDefined()
    expect((corner as (typeof result.points)[number]).labelAnchor).toBe('start')
  })
})

describe('同一 projection 模块的 2D 子范围，与主图投影一致（验收 2）', () => {
  it('附图 (u,v) 严格等于 projectToInset（忠实复用同一投影模块，无第二套投影公式）', () => {
    const contract = loadProductionContract()
    const result = prepareSouthChinaSeaInset(contract, SOUTH_CHINA_SEA_INSET_EXTENT, PREP_CONFIG)
    // 岛礁点位：(u,v) 必须等于直接 projectToInset（证明准备层不重写投影）。
    for (const point of result.points) {
      const island = findIsland(contract, point.name)
      const direct = projectToInset(island.coordinate.lon, island.coordinate.lat, SOUTH_CHINA_SEA_INSET_EXTENT)
      expect(direct.ok).toBe(true)
      if (!direct.ok) return
      expect(point.u).toBe(direct.value.u)
      expect(point.v).toBe(direct.value.v)
    }
    // 十段线顶点：逐一对照源契约坐标的 projectToInset。
    for (const line of result.lines) {
      const segment = contract.features.find(
        (f): f is Extract<PoliticalBoundaryContract['features'][number], { type: 'nineDashLineSegment' }> =>
          f.type === 'nineDashLineSegment' && f.segmentIndex === line.segmentIndex,
      )
      expect(segment, `段序号 ${line.segmentIndex} 应在契约中`).toBeDefined()
      const seg = segment as Extract<PoliticalBoundaryContract['features'][number], { type: 'nineDashLineSegment' }>
      expect(seg.coordinates.length).toBe(line.uvPolyline.length)
      for (let i = 0; i < seg.coordinates.length; i++) {
        const direct = projectToInset(seg.coordinates[i].lon, seg.coordinates[i].lat, SOUTH_CHINA_SEA_INSET_EXTENT)
        expect(direct.ok).toBe(true)
        if (!direct.ok) return
        expect(line.uvPolyline[i].u).toBe(direct.value.u)
        expect(line.uvPolyline[i].v).toBe(direct.value.v)
      }
    }
  })

  it('跨投影交叉：附图 (u,v) 与主图 projectToWorld 重建同一墨卡托（同源不同视口映射）', () => {
    const contract = loadProductionContract()
    const result = prepareSouthChinaSeaInset(contract, SOUTH_CHINA_SEA_INSET_EXTENT, PREP_CONFIG)
    // 附图四至西南 / 东北角的墨卡托（用于由 (u,v) 反归一化重建墨卡托）。
    const sw = projectToMercator(SOUTH_CHINA_SEA_INSET_EXTENT.west, SOUTH_CHINA_SEA_INSET_EXTENT.south)
    const ne = projectToMercator(SOUTH_CHINA_SEA_INSET_EXTENT.east, SOUTH_CHINA_SEA_INSET_EXTENT.north)
    const center = projectToMercator(MAIN_MAP_CENTER.lon, MAIN_MAP_CENTER.lat)
    expect(sw.ok && ne.ok && center.ok).toBe(true)
    if (!sw.ok || !ne.ok || !center.ok) return
    // 对每个岛礁点位：由附图 (u,v) 重建墨卡托，由主图 world 重建墨卡托，二者应一致。
    for (const point of result.points) {
      const island = findIsland(contract, point.name)
      // 附图路径：(u,v) → 墨卡托（线性反归一化，projectToInset 的数值逆运算）。
      const mxFromInset = sw.value.x + point.u * (ne.value.x - sw.value.x)
      const myFromInset = sw.value.y + point.v * (ne.value.y - sw.value.y)
      // 主图路径：world (x,z) → 墨卡托（中心化反变换，projectToWorld 的数值逆运算）。
      const world = projectToWorld(island.coordinate.lon, island.coordinate.lat)
      expect(world.ok).toBe(true)
      if (!world.ok) return
      const mxFromWorld = world.value.x + center.value.x
      const myFromWorld = center.value.y - world.value.z
      // 二者都等于 projectToMercator(lon,lat)，容差内一致 → 证明主图与附图共享同一墨卡托结果。
      expectAlmostEqual(mxFromInset, mxFromWorld, 1e-3, `${point.name} 墨卡托 x`)
      expectAlmostEqual(myFromInset, myFromWorld, 1e-3, `${point.name} 墨卡托 y`)
    }
  })
})

describe('红线缺项 / 异常路径：阻断附图准备，不静默显示残缺图（SPEC §6）', () => {
  it('删除台湾东侧段（segmentIndex=10）→ 明确失败', () => {
    const contract = cloneContract(loadProductionContract())
    contract.features = contract.features.filter(
      (f) => !(f.type === 'nineDashLineSegment' && f.segmentIndex === TAIWAN_EAST_SEGMENT_INDEX),
    )
    try {
      prepareSouthChinaSeaInset(contract, SOUTH_CHINA_SEA_INSET_EXTENT, PREP_CONFIG)
      expect.unreachable('删除台湾东侧段应阻断附图准备')
    } catch (e) {
      const code = (e as SouthChinaSeaInsetPrepError).code
      // 三条红线锚点至少命中其一（段数 9、段序号 10 缺、台湾东侧段独立锚点）。
      expect([
        'south-china-sea-inset.taiwan-east-segment-missing',
        'south-china-sea-inset.segment-count-mismatch',
        'south-china-sea-inset.segment-missing',
      ]).toContain(code)
    }
  })

  it('删除钓鱼岛 → required-island-missing', () => {
    const contract = cloneContract(loadProductionContract())
    contract.features = contract.features.filter(
      (f) => !(f.type === 'islandOrReefPoint' && f.name === '钓鱼岛'),
    )
    try {
      prepareSouthChinaSeaInset(contract, SOUTH_CHINA_SEA_INSET_EXTENT, PREP_CONFIG)
      expect.unreachable('删除钓鱼岛应阻断附图准备')
    } catch (e) {
      expect((e as SouthChinaSeaInsetPrepError).code).toBe('south-china-sea-inset.required-island-missing')
      expect((e as Error).message).toContain('钓鱼岛')
    }
  })

  it('删除赤尾屿 → required-island-missing', () => {
    const contract = cloneContract(loadProductionContract())
    contract.features = contract.features.filter(
      (f) => !(f.type === 'islandOrReefPoint' && f.name === '赤尾屿'),
    )
    try {
      prepareSouthChinaSeaInset(contract, SOUTH_CHINA_SEA_INSET_EXTENT, PREP_CONFIG)
      expect.unreachable('删除赤尾屿应阻断附图准备')
    } catch (e) {
      expect((e as SouthChinaSeaInsetPrepError).code).toBe('south-china-sea-inset.required-island-missing')
    }
  })

  it('删除曾母暗沙 → required-island-missing', () => {
    const contract = cloneContract(loadProductionContract())
    contract.features = contract.features.filter(
      (f) => !(f.type === 'islandOrReefPoint' && f.name === '曾母暗沙'),
    )
    try {
      prepareSouthChinaSeaInset(contract, SOUTH_CHINA_SEA_INSET_EXTENT, PREP_CONFIG)
      expect.unreachable('删除曾母暗沙应阻断附图准备')
    } catch (e) {
      expect((e as SouthChinaSeaInsetPrepError).code).toBe('south-china-sea-inset.required-island-missing')
    }
  })

  it('features 为空 → empty-features', () => {
    const contract = cloneContract(loadProductionContract())
    contract.features = []
    try {
      prepareSouthChinaSeaInset(contract, SOUTH_CHINA_SEA_INSET_EXTENT, PREP_CONFIG)
      expect.unreachable('空 features 应阻断附图准备')
    } catch (e) {
      expect((e as SouthChinaSeaInsetPrepError).code).toBe('south-china-sea-inset.empty-features')
    }
  })

  it('布局配置非有限 → config-not-finite（畸形配置显式失败）', () => {
    const contract = loadProductionContract()
    try {
      prepareSouthChinaSeaInset(contract, SOUTH_CHINA_SEA_INSET_EXTENT, {
        ...PREP_CONFIG,
        labelFontSize: Number.NaN,
      })
      expect.unreachable('非有限布局配置应阻断附图准备')
    } catch (e) {
      expect((e as SouthChinaSeaInsetPrepError).code).toBe('south-china-sea-inset.config-not-finite')
    }
  })

  it('附图四至越界（不含十段线顶点）→ projection-failed', () => {
    const contract = loadProductionContract()
    // 红线完整（生产契约），但四至过窄不含十段线顶点 → 第一段顶点 projectToInset 失败。
    const narrowExtent = { west: 104, south: 0, east: 110, north: 10 }
    try {
      prepareSouthChinaSeaInset(contract, narrowExtent, PREP_CONFIG)
      expect.unreachable('越界四至应触发 projection-failed')
    } catch (e) {
      expect((e as SouthChinaSeaInsetPrepError).code).toBe('south-china-sea-inset.projection-failed')
    }
  })
})

describe('与主图政治要素准备共用同一红线扫描单源（不复制扫描逻辑）', () => {
  it('附图准备与共享扫描 collectPoliticalRedLineGaps 对生产契约给出一致缺项（全无缺）', () => {
    const contract = loadProductionContract()
    // 附图准备成功即等价于「扫描无缺项」；这里直接断言共享扫描结果齐全。
    const gaps = collectPoliticalRedLineGaps(contract)
    expect(gaps.segmentCount).toBe(EXPECTED_NINE_DASH_SEGMENT_COUNT)
    expect(gaps.missingSegmentIndices).toHaveLength(0)
    expect(gaps.taiwanEastSegmentPresent).toBe(true)
    expect(gaps.missingIslandNames).toHaveLength(0)
    // 附图准备据此成功（不抛）。
    expect(() => prepareSouthChinaSeaInset(contract, SOUTH_CHINA_SEA_INSET_EXTENT, PREP_CONFIG)).not.toThrow()
  })
})

describe('配置不变量（四至自洽、含全部红线要素、比例派生、样式同源）', () => {
  it('附图四至自洽（west<east、south<north、有限）', () => {
    const { west, south, east, north } = SOUTH_CHINA_SEA_INSET_EXTENT
    expect(Number.isFinite(west) && Number.isFinite(south) && Number.isFinite(east) && Number.isFinite(north)).toBe(true)
    expect(west).toBeLessThan(east)
    expect(south).toBeLessThan(north)
  })

  it('附图四至完整容纳生产资产的全部十段线段与岛礁点位', () => {
    const contract = loadProductionContract()
    const { west, south, east, north } = SOUTH_CHINA_SEA_INSET_EXTENT
    for (const feature of contract.features) {
      if (feature.type === 'nineDashLineSegment') {
        for (const coord of feature.coordinates) {
          expect(coord.lon).toBeGreaterThanOrEqual(west)
          expect(coord.lon).toBeLessThanOrEqual(east)
          expect(coord.lat).toBeGreaterThanOrEqual(south)
          expect(coord.lat).toBeLessThanOrEqual(north)
        }
      } else if (feature.type === 'islandOrReefPoint') {
        const { lon, lat } = feature.coordinate
        expect(lon).toBeGreaterThanOrEqual(west)
        expect(lon).toBeLessThanOrEqual(east)
        expect(lat).toBeGreaterThanOrEqual(south)
        expect(lat).toBeLessThanOrEqual(north)
      }
    }
  })

  it('viewBox 高度按墨卡托比例派生（高度 = 宽度 / 墨卡托宽高比，附图不被拉伸）', () => {
    const sw = projectToMercator(SOUTH_CHINA_SEA_INSET_EXTENT.west, SOUTH_CHINA_SEA_INSET_EXTENT.south)
    const ne = projectToMercator(SOUTH_CHINA_SEA_INSET_EXTENT.east, SOUTH_CHINA_SEA_INSET_EXTENT.north)
    expect(sw.ok && ne.ok).toBe(true)
    if (!sw.ok || !ne.ok) return
    const aspect = (ne.value.x - sw.value.x) / (ne.value.y - sw.value.y)
    const expectedHeight = SOUTH_CHINA_SEA_INSET_CONFIG.viewboxWidth / aspect
    expectAlmostEqual(SOUTH_CHINA_SEA_INSET_CONFIG.viewboxHeight, expectedHeight, 1e-6, 'viewBox 高度')
    // 高度与宽度同号、有限、为正；纵向矩形构图（标准南海诸岛附图惯例）。
    expect(SOUTH_CHINA_SEA_INSET_CONFIG.viewboxWidth).toBeGreaterThan(0)
    expect(SOUTH_CHINA_SEA_INSET_CONFIG.viewboxHeight).toBeGreaterThan(0)
    expect(SOUTH_CHINA_SEA_INSET_CONFIG.viewboxHeight).toBeGreaterThan(SOUTH_CHINA_SEA_INSET_CONFIG.viewboxWidth)
  })

  it('样式参数有限、为正；配置全部冻结', () => {
    const c = SOUTH_CHINA_SEA_INSET_CONFIG
    expect(c.lineStrokeWidth).toBeGreaterThan(0)
    expect(c.pointRadius).toBeGreaterThan(0)
    expect(c.labelFontSize).toBeGreaterThan(0)
    expect(c.labelOffsetX).toBeGreaterThan(0)
    expect(c.frameStrokeWidth).toBeGreaterThan(0)
    expect(Number.isFinite(c.viewboxWidth)).toBe(true)
    expect(Number.isFinite(c.viewboxHeight)).toBe(true)
    expect(c.lineDash.length).toBeGreaterThan(0)
    expect(Object.isFrozen(SOUTH_CHINA_SEA_INSET_CONFIG)).toBe(true)
    expect(Object.isFrozen(SOUTH_CHINA_SEA_INSET_EXTENT)).toBe(true)
  })

  it('附图线 / 点基线色与主图政治要素同一事实源（同属政治边界补充要素族，无第二份色值）', () => {
    expect(SOUTH_CHINA_SEA_INSET_CONFIG.lineColorHex).toBe(POLITICAL_FEATURES_CONFIG.lineColorHex)
    expect(SOUTH_CHINA_SEA_INSET_CONFIG.pointFillHex).toBe(POLITICAL_FEATURES_CONFIG.pointColorHex)
  })
})

describe('渲染层与总装结构不变量（源码扫描，验收 2 / 3：DOM overlay、单一事实源）', () => {
  it('组件是 DOM overlay：不进入 3D 渲染循环（无 R3F / Three.js / useFrame），不取数、不投影', () => {
    const source = readSource('components/SouthChinaSeaInset.tsx')
    // 不进入 3D 渲染循环：无 R3F / Three.js / 帧循环依赖。
    expect(source).not.toContain('@react-three')
    expect(source).not.toContain("from 'three'")
    expect(source).not.toContain('useFrame')
    // 不取数、不复制投影逻辑（投影唯一入口在领域层；组件仅类型级引用 InsetViewportPoint）。
    expect(source).not.toContain('fetch(')
    expect(source).not.toContain('projectToInset(')
    expect(source).not.toContain('projectToMercator(')
    expect(source).not.toContain('projectToWorld(')
    expect(source).toContain("import type { InsetViewportPoint } from '../lib/projection'")
    // 消费领域准备层与配置层唯一事实源（标注摆放所需布局参数由配置层传入，组件不复制第二份）。
    expect(source).toContain('prepareSouthChinaSeaInset')
    expect(source).toContain("from '../lib/south-china-sea-inset'")
    expect(source).toContain("from '../config/south-china-sea-inset'")
    expect(source).toContain('SOUTH_CHINA_SEA_INSET_CONFIG.labelFontSize')
    expect(source).toContain('SOUTH_CHINA_SEA_INSET_CONFIG.viewboxWidth')
    // 无硬编码经纬度坐标（如 124.55 / 25.92 等岛礁源坐标不得出现在渲染层）。
    expect(source).not.toMatch(/\b1[0-2][0-9]\.[0-9]/)
  })

  it('附图图名唯一来自静态文案事实源（组件不维护第二份图名字面量）', () => {
    const source = readSource('components/SouthChinaSeaInset.tsx')
    expect(source).toContain('SOUTH_CHINA_SEA_INSET_TITLE')
    expect(source).toContain("from '../lib/static-copy'")
    // 不出现第二份图名字面量（引号包裹的字符串字面量形式）。
    expect(source).not.toContain("'南海诸岛'")
    expect(source).not.toContain('"南海诸岛"')
    // 配置层同样不复制图名（唯一事实源在 src/lib/static-copy）。
    const configSource = readSource('config/south-china-sea-inset.ts')
    expect(configSource).not.toContain("'南海诸岛'")
    expect(configSource).not.toContain('"南海诸岛"')
  })

  it('领域准备层忠实复用同一 projection 模块（验收 2），不反向依赖配置层', () => {
    const source = readSource('lib/south-china-sea-inset.ts')
    expect(source).toContain("from './projection'")
    expect(source).toContain('projectToInset')
    // 红线扫描唯一来自共享单源（不复制扫描逻辑）。
    expect(source).toContain("from './political-red-line'")
    expect(source).toContain('collectPoliticalRedLineGaps')
    // 分层约束：不依赖配置层 / 不取数。
    expect(source).not.toContain("from '../config/")
    expect(source).not.toContain('fetch(')
  })

  it('App 总装接线完整（加载 → 准备 → 渲染 → 红线错误暴露），附图挂在 3D Canvas 之外', () => {
    const source = readSource('App.tsx')
    expect(source).toContain('<SouthChinaSeaInset')
    expect(source).toContain('onPrepError={setInsetPrepError}')
    // 附图准备失败进入整页错误通道（不静默显示残缺附图）。
    expect(source).toContain('南海附图准备失败')
    // 附图是 DOM overlay：挂在 </Canvas> 之外（不进入 3D 渲染循环）。
    const canvasClose = source.indexOf('</Canvas>')
    const insetMount = source.indexOf('<SouthChinaSeaInset')
    expect(canvasClose).toBeGreaterThan(-1)
    expect(insetMount).toBeGreaterThan(-1)
    expect(insetMount).toBeGreaterThan(canvasClose)
    // 与主图政治要素复用同一份契约加载单例（不第二次取数）。
    expect(source).toContain('loadPoliticalBoundaryOnce')
  })

  it('附图样式贴合深色科技风页面（右下角半透明深色面板 + 发光描边 + 指针穿透）', () => {
    const css = readSource('index.css')
    expect(css).toContain('.scs-inset')
    // 右下角矩形 overlay 定位。
    expect(css).toContain('right: 24px')
    expect(css).toContain('bottom: 24px')
    expect(css).toContain('position: absolute')
    // 深色科技风：半透明深色面板 + 发光描边（accent-glow 同色系）。
    expect(css).toContain('rgba(14, 20, 36, 0.62)')
    expect(css).toContain('rgba(159, 232, 216')
    // 纯静态展示：指针穿透（不参与 hover、无 click，相机交互不受影响）。
    expect(css).toContain('pointer-events: none')
  })
})
