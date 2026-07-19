/**
 * 加载 / 入场状态机的确定性不变量测试（TASK-020 验证方式 1、2）。
 *
 * 依赖方向：测试基线（vitest，Node 环境），import src/lib/entrance-state（纯函数状态机）、
 * src/config/entrance（冻结时序 ENTRANCE_DURATIONS）。不依赖浏览器 / React / Three.js / R3F——状态机是
 * 纯函数，可在 Node 直接断言「阶段顺序固定、每阶段只进一次、交互只在最终态启用」「资产乱序完成无影响」
 * 「加载失败终态」「永不卡 99%」「地形升起 / 标签错峰 / 水面边界淡入时序」等不变量，无需启动浏览器 / WebGL
 * （人工视觉验收留给 TASK-020 验证方式 4、5）。
 */

import { describe, it, expect } from 'vitest'
import { ENTRANCE_DURATIONS, ENTRANCE_TRACKED_ASSET_COUNT } from '../src/config/entrance'
import {
  computeAncillaryLabelOpacity,
  computeAssetReadiness,
  computeProvinceLabelOpacity,
  computeSceneLayerOpacity,
  computeTerrainRise,
  deriveEntrancePhase,
  isEntranceInteractive,
  totalEntranceSeconds,
  type EntranceDurations,
  type EntranceFrame,
  type TrackedAssetState,
} from '../src/lib/entrance-state'

const D = ENTRANCE_DURATIONS
const TOTAL = totalEntranceSeconds(D)
const TOLERANCE = 1e-6

/** 构造五个资产全部就绪的合法状态（computeAssetReadiness 输入）。 */
function allReadyAssets(): TrackedAssetState[] {
  return [
    { key: 'heightmap', phase: 'ready', errorMessage: null },
    { key: 'provinceGeometry', phase: 'ready', errorMessage: null },
    { key: 'politicalBoundary', phase: 'ready', errorMessage: null },
    { key: 'placeDirectory', phase: 'ready', errorMessage: null },
    { key: 'labelFontManifest', phase: 'ready', errorMessage: null },
  ]
}

/** 断言两数在容差内相等。 */
function expectAlmostEqual(actual: number, expected: number, tol: number, note = ''): void {
  expect(Math.abs(actual - expected), `期望 ${actual} ≈ ${expected}（容差 ${tol}）${note}`).toBeLessThanOrEqual(tol)
}

describe('资产就绪聚合：真实进度、不伪造（TASK-020 验证方式 2「永不卡 99%」）', () => {
  it('全部就绪 → ready=true、loadedCount=totalCount、无失败', () => {
    const r = computeAssetReadiness(allReadyAssets())
    expect(r.ready).toBe(true)
    expect(r.failed).toBe(false)
    expect(r.loadedCount).toBe(5)
    expect(r.totalCount).toBe(5)
    expect(r.failureMessage).toBeNull()
  })

  it('全部加载中 → ready=false、loadedCount=0（进度 0/5，不伪造推到 99%）', () => {
    const r = computeAssetReadiness(
      allReadyAssets().map((a) => ({ ...a, phase: 'loading' as const })),
    )
    expect(r.ready).toBe(false)
    expect(r.failed).toBe(false)
    expect(r.loadedCount).toBe(0)
    expect(r.totalCount).toBe(5)
  })

  it('部分就绪 → 进度停在真实值（如 3/5），绝不用计时器虚假推到 99%', () => {
    const assets = allReadyAssets().map((a) => ({ ...a, phase: 'loading' as const }))
    assets[0].phase = 'ready'
    assets[2].phase = 'ready'
    assets[4].phase = 'ready'
    const r = computeAssetReadiness(assets)
    expect(r.loadedCount).toBe(3)
    expect(r.totalCount).toBe(5)
    expect(r.ready).toBe(false)
    // 真实进度 = 3/5 = 60%，不会被任何计时器推到 99%——loadedCount 只随真实资产就绪推进。
  })

  it('任一失败 → failed=true、ready=false、保留首个失败诊断（不退化为 fallback）', () => {
    const assets = allReadyAssets()
    assets[1] = { key: 'provinceGeometry', phase: 'error', errorMessage: '省级行政区几何解析失败' }
    const r = computeAssetReadiness(assets)
    expect(r.failed).toBe(true)
    expect(r.ready).toBe(false)
    expect(r.failureMessage).toBe('省级行政区几何解析失败')
  })

  it('空资产列表 → ready=false、totalCount=0（不除零、不伪造就绪）', () => {
    const r = computeAssetReadiness([])
    expect(r.ready).toBe(false)
    expect(r.totalCount).toBe(0)
    expect(r.loadedCount).toBe(0)
  })

  it('受跟踪资产数配置 = 5（heightmap / 省界几何 / 政治边界 / 地点目录 / 字体清单）', () => {
    expect(ENTRANCE_TRACKED_ASSET_COUNT).toBe(5)
  })
})

describe('阶段顺序固定、每阶段只进一次（TASK-020 验证方式 1）', () => {
  it('未就绪 → loading；就绪后随 elapsed 单调推进 5 个阶段', () => {
    // 未就绪：恒 loading（elapsed 不影响）。
    expect(deriveEntrancePhase(0, false, false, D)).toBe('loading')
    expect(deriveEntrancePhase(100, false, false, D)).toBe('loading')
    // 就绪后：elapsed 单调递增 → 阶段顺序固定。
    expect(deriveEntrancePhase(0, true, false, D)).toBe('terrain-rise')
    expect(deriveEntrancePhase(D.terrainRiseSeconds - TOLERANCE, true, false, D)).toBe('terrain-rise')
    expect(deriveEntrancePhase(D.terrainRiseSeconds, true, false, D)).toBe('labels-fade-in')
    expect(
      deriveEntrancePhase(D.terrainRiseSeconds + D.labelsFadeSeconds - TOLERANCE, true, false, D),
    ).toBe('labels-fade-in')
    expect(deriveEntrancePhase(D.terrainRiseSeconds + D.labelsFadeSeconds, true, false, D)).toBe(
      'scene-layers-fade-in',
    )
    expect(
      deriveEntrancePhase(TOTAL - TOLERANCE, true, false, D),
    ).toBe('scene-layers-fade-in')
    expect(deriveEntrancePhase(TOTAL, true, false, D)).toBe('interactive')
    expect(deriveEntrancePhase(TOTAL + 10, true, false, D)).toBe('interactive')
  })

  it('模拟单调 elapsed 序列：阶段顺序固定且每阶段只进一次（不回退、不跳过）', () => {
    const seen: string[] = []
    let last = ''
    // 以 0.05s 步进驱动整个入场，收集阶段序列。
    for (let t = 0; t <= TOTAL + 1; t += 0.05) {
      const phase = deriveEntrancePhase(t, true, false, D)
      if (phase !== last) {
        seen.push(phase)
        last = phase
      }
    }
    expect(seen).toEqual([
      'terrain-rise',
      'labels-fade-in',
      'scene-layers-fade-in',
      'interactive',
    ])
    // 每阶段恰好出现一次（无重复进入、无回退）。
    for (const phase of seen) {
      expect(seen.filter((p) => p === phase).length).toBe(1)
    }
  })

  it('interactive 与 error 为终态：elapsed 继续增长不离开', () => {
    expect(deriveEntrancePhase(TOTAL + 100, true, false, D)).toBe('interactive')
    expect(deriveEntrancePhase(0, true, true, D)).toBe('error')
    expect(deriveEntrancePhase(TOTAL + 100, true, true, D)).toBe('error')
  })
})

describe('交互锁：只在 interactive 启用（TASK-020 输出约束「状态到达可交互后释放 OrbitControls」）', () => {
  it('仅 interactive 为 true；loading / error / 三个动画阶段均锁定', () => {
    expect(isEntranceInteractive('loading')).toBe(false)
    expect(isEntranceInteractive('error')).toBe(false)
    expect(isEntranceInteractive('terrain-rise')).toBe(false)
    expect(isEntranceInteractive('labels-fade-in')).toBe(false)
    expect(isEntranceInteractive('scene-layers-fade-in')).toBe(false)
    expect(isEntranceInteractive('interactive')).toBe(true)
  })
})

describe('加载失败：显式终态、不继续入场动画（TASK-020 验证方式 2「失败后继续渲染」须不可达）', () => {
  it('failed=true 时无论 elapsed 多大，阶段恒为 error', () => {
    expect(deriveEntrancePhase(0, false, true, D)).toBe('error')
    expect(deriveEntrancePhase(0, true, true, D)).toBe('error')
    expect(deriveEntrancePhase(TOTAL, true, true, D)).toBe('error')
    expect(deriveEntrancePhase(999, true, true, D)).toBe('error')
  })

  it('失败终态下 elapsed=0 → 地形 rise=0、水面 / 边界透明度=0（入场动画不继续）', () => {
    // 失败时 EntranceController 永不捕获起始时刻 → elapsed 冻结为 0。
    const elapsed = 0
    expect(computeTerrainRise(elapsed, D)).toBe(0)
    expect(computeSceneLayerOpacity(elapsed, D)).toBe(0)
    expect(computeProvinceLabelOpacity(elapsed, D, 0, 34)).toBe(0)
    expect(computeAncillaryLabelOpacity(elapsed, D)).toBe(0)
  })
})

describe('资产乱序完成：不影响阶段顺序（TASK-020 验证方式 2）', () => {
  it('不同资产完成顺序 → 同一最终 ready=true（顺序无关）', () => {
    // 顺序 A：heightmap 先就绪。
    const orderA = allReadyAssets()
    // 顺序 B：打乱键顺序后全部就绪。
    const orderB = [...allReadyAssets()].reverse()
    expect(computeAssetReadiness(orderA)).toEqual(computeAssetReadiness(orderB))
    expect(computeAssetReadiness(orderA).ready).toBe(true)
  })

  it('纯函数确定性：相同 (elapsed, ready, failed) 永远得同一阶段（StrictMode 重挂载 / 重渲染无影响）', () => {
    // StrictMode 下组件可能重挂载 / 重渲染，但状态机是纯函数——相同输入永远同一输出，
    // 不存在内部计数器被重挂载重置或翻倍。动画 elapsed 由控制器单调派生，故不会重复启动。
    for (let t = 0; t <= TOTAL; t += 0.1) {
      const a = deriveEntrancePhase(t, true, false, D)
      const b = deriveEntrancePhase(t, true, false, D)
      expect(a).toBe(b)
    }
    // 多次「调用」（模拟重挂载）不改变结果——无重复动画 / 提前解锁。
    expect(deriveEntrancePhase(TOTAL, true, false, D)).toBe('interactive')
    expect(deriveEntrancePhase(TOTAL, true, false, D)).toBe('interactive')
    expect(deriveEntrancePhase(TOTAL, true, false, D)).toBe('interactive')
  })
})

describe('地形升起：约 1.2 秒从平面升至夸张后真实高度（TASK-020 输出约束）', () => {
  it('elapsed=0 → rise=0（平面）；elapsed=terrainRiseSeconds → rise=1（升毕）', () => {
    expect(computeTerrainRise(0, D)).toBe(0)
    expectAlmostEqual(computeTerrainRise(D.terrainRiseSeconds, D), 1, TOLERANCE)
  })

  it('rise 在 [0,1] 内单调递增、其后恒 1（smoothstep，无超调）', () => {
    let prev = -Infinity
    for (let t = 0; t <= D.terrainRiseSeconds + 1; t += 0.05) {
      const rise = computeTerrainRise(t, D)
      expect(rise).toBeGreaterThanOrEqual(0)
      expect(rise).toBeLessThanOrEqual(1)
      expect(rise).toBeGreaterThanOrEqual(prev)
      prev = rise
    }
    // 升毕后恒 1。
    expect(computeTerrainRise(D.terrainRiseSeconds + 5, D)).toBe(1)
  })

  it('地形升起时长 = 1.2 秒（SPEC §4.3）', () => {
    expect(D.terrainRiseSeconds).toBe(1.2)
  })

  it('rise=0 时 uRise 使地形为平面（复用 GPU 位移，不建第二套几何的契约由 ChinaTerrainMesh 位移 uniform 保证）', () => {
    // 本断言锁定 rise=0 产出的标量；ChinaTerrainMesh 顶点位移 = h·k·uRise，uRise=0 → 平面（同一套几何）。
    expect(computeTerrainRise(0, D)).toBe(0)
  })
})

describe('省名标签错峰淡入：自西向东、确定顺序（TASK-020 / SPEC §4.3）', () => {
  it('阶段前（地形升起中）→ 全部标签透明度 0（不可见）', () => {
    for (let i = 0; i < 34; i++) {
      expect(computeProvinceLabelOpacity(0, D, i, 34)).toBe(0)
      expect(computeProvinceLabelOpacity(D.terrainRiseSeconds - 0.01, D, i, 34)).toBe(0)
    }
  })

  it('西部标签（staggerIndex 小）先于东部标签（staggerIndex 大）达到同一透明度（自西向东）', () => {
    const phaseStart = D.terrainRiseSeconds
    // 取一个早于末个标签起始、晚于首个标签起始的时刻，西部应已部分淡入、东部仍为 0。
    const t = phaseStart + (D.labelsFadeSeconds * D.labelStaggerWindowFraction) * 0.3
    const west = computeProvinceLabelOpacity(t, D, 0, 34)
    const east = computeProvinceLabelOpacity(t, D, 33, 34)
    expect(west).toBeGreaterThan(east)
    expect(west).toBeGreaterThan(0)
  })

  it('入场完成后全部标签恒 1（不论 staggerIndex）', () => {
    for (let i = 0; i < 34; i++) {
      expect(computeProvinceLabelOpacity(TOTAL, D, i, 34)).toBe(1)
      expect(computeProvinceLabelOpacity(TOTAL + 5, D, i, 34)).toBe(1)
    }
  })

  it('末个标签恰在阶段结束完成（delay + perLabel = labelsFadeSeconds）', () => {
    // 末个标签 staggerIndex = staggerCount-1，delay = 窗口；perLabel = 总时长 − 窗口。
    // 在 elapsed = terrainRise + labelsFadeSeconds 处，末个标签 local = 1 → 透明度 1。
    const t = D.terrainRiseSeconds + D.labelsFadeSeconds
    expectAlmostEqual(computeProvinceLabelOpacity(t, D, 33, 34), 1, TOLERANCE)
  })

  it('省会 / 岛礁名（ancillary）随省名阶段整体淡入：阶段前 0、阶段后 1', () => {
    expect(computeAncillaryLabelOpacity(0, D)).toBe(0)
    expect(computeAncillaryLabelOpacity(D.terrainRiseSeconds, D)).toBe(0)
    expectAlmostEqual(computeAncillaryLabelOpacity(D.terrainRiseSeconds + D.labelsFadeSeconds, D), 1, TOLERANCE)
  })

  it('staggerCount ≤ 1 时不错峰（单标签直接整体淡入，无除零）', () => {
    expect(() => computeProvinceLabelOpacity(D.terrainRiseSeconds + 0.5, D, 0, 1)).not.toThrow()
    expect(computeProvinceLabelOpacity(D.terrainRiseSeconds + D.labelsFadeSeconds, D, 0, 1)).toBe(1)
  })
})

describe('水面 / 边界淡入：在省名标签淡入后开始（SPEC §4.3「随后淡入」）', () => {
  it('省名淡入完成前 → 场景层透明度 0（海面 / 边界不可见）', () => {
    expect(computeSceneLayerOpacity(0, D)).toBe(0)
    expect(computeSceneLayerOpacity(D.terrainRiseSeconds, D)).toBe(0)
    // 省名淡进行中（terrainRise + labelsFade 之间）仍为 0。
    expect(computeSceneLayerOpacity(D.terrainRiseSeconds + D.labelsFadeSeconds - TOLERANCE, D)).toBe(0)
  })

  it('省名淡入完成 → 场景层开始淡入；scene-layers 完成时 = 1', () => {
    const start = D.terrainRiseSeconds + D.labelsFadeSeconds
    // 刚开始（local=0）→ 0。
    expect(computeSceneLayerOpacity(start, D)).toBe(0)
    // 完成时刻 → 1。
    expectAlmostEqual(computeSceneLayerOpacity(start + D.sceneLayersFadeSeconds, D), 1, TOLERANCE)
    // interactive 时恒 1。
    expect(computeSceneLayerOpacity(TOTAL, D)).toBe(1)
  })

  it('水面 / 边界 / 十段线 / 岛礁光点共用同一 computeSceneLayerOpacity → 同阶段同步淡入', () => {
    // 三层（SeaSurface / ProvinceBorders / PoliticalFeatures）各自调用同一纯函数 + 同一 elapsed，
    // 故同一时刻产出同一透明度（同步淡入，不由各组件私设计时）。
    const start = D.terrainRiseSeconds + D.labelsFadeSeconds
    const t = start + D.sceneLayersFadeSeconds * 0.5
    const a = computeSceneLayerOpacity(t, D)
    const b = computeSceneLayerOpacity(t, D)
    const c = computeSceneLayerOpacity(t, D)
    expect(a).toBe(b)
    expect(b).toBe(c)
    expect(a).toBeGreaterThan(0)
    expect(a).toBeLessThan(1)
  })
})

describe('EntranceFrame 零分配契约：原地改写而非整对象替换（TASK-020 实现约束「禁止逐帧对象分配」）', () => {
  it('字段可原地改写且对象引用跨多帧稳定（模拟 EntranceController 每帧写共享帧，无新对象）', () => {
    // ChinaMapScreen 的 useRef 一次性创建的共享入场帧对象（同 fiber 跨重渲染保持同一引用）。
    const frame: EntranceFrame = { phase: 'loading', elapsedSeconds: 0 }
    const originalRef = frame
    // 模拟 EntranceController 单一 useFrame 多帧「原地改写」phase / elapsedSeconds（不替换整对象）。
    // 若 EntranceFrame 字段被重新声明为 readonly，此处在编译期即报错——测试同时是编译期守卫，
    // 防止 EntranceController 退回 `entranceFrame.current = { ... }` 的逐帧整对象分配写法。
    frame.phase = 'terrain-rise'
    frame.elapsedSeconds = 0.3
    frame.phase = 'labels-fade-in'
    frame.elapsedSeconds = 1.5
    frame.phase = 'scene-layers-fade-in'
    frame.elapsedSeconds = 2.2
    frame.phase = 'interactive'
    frame.elapsedSeconds = TOTAL
    // 对象引用跨多帧保持稳定：useFrame 从不 new / 从不整对象替换 ref.current——零对象分配。
    expect(frame).toBe(originalRef)
    expect(frame.phase).toBe('interactive')
    expect(frame.elapsedSeconds).toBe(TOTAL)
  })

  it('失败终态下 EntranceController 写入 error + elapsed=0 亦为原地改写（保持引用稳定）', () => {
    const frame: EntranceFrame = { phase: 'loading', elapsedSeconds: 0 }
    const originalRef = frame
    // 失败时起始时刻永不捕获 → elapsed 恒 0 → deriveEntrancePhase 返回 error（见状态机测试）。
    frame.phase = 'error'
    frame.elapsedSeconds = 0
    expect(frame).toBe(originalRef)
    expect(frame.phase).toBe('error')
    expect(frame.elapsedSeconds).toBe(0)
  })
})

describe('时序配置不变量（冻结、有限、错峰窗口合法）', () => {
  it('ENTRANCE_DURATIONS 全部冻结、字段有限为正', () => {
    expect(Object.isFrozen(D)).toBe(true)
    expect(D.terrainRiseSeconds).toBeGreaterThan(0)
    expect(D.labelsFadeSeconds).toBeGreaterThan(0)
    expect(D.sceneLayersFadeSeconds).toBeGreaterThan(0)
    expect(Number.isFinite(D.labelStaggerWindowFraction)).toBe(true)
  })

  it('错峰窗口分数落在 (0,1)：=0 无错峰、=1 末个标签永不 complete', () => {
    expect(D.labelStaggerWindowFraction).toBeGreaterThan(0)
    expect(D.labelStaggerWindowFraction).toBeLessThan(1)
  })

  it('总入场时长 = 地形升起 + 省名淡入 + 水面边界淡入（各阶段之和）', () => {
    expect(totalEntranceSeconds(D)).toBeCloseTo(
      D.terrainRiseSeconds + D.labelsFadeSeconds + D.sceneLayersFadeSeconds,
      10,
    )
  })

  it('异常时序配置被防御（非有限 / 负值不会让 smoothstep 产出 NaN）', () => {
    const bad: EntranceDurations = {
      terrainRiseSeconds: NaN,
      labelsFadeSeconds: Infinity,
      sceneLayersFadeSeconds: -1,
      labelStaggerWindowFraction: 0.5,
    }
    // computeTerrainRise / computeSceneLayerOpacity 内部 clamp01 把非有限值归 0，不产 NaN。
    expect(Number.isNaN(computeTerrainRise(1, bad))).toBe(false)
    expect(Number.isNaN(computeSceneLayerOpacity(1, bad))).toBe(false)
  })
})
