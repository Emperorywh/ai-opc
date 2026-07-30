/**
 * 加载 / 入场状态机与入场编排接线的确定性不变量测试（TASK-013，SPEC §4.3 / §12.8）。
 *
 * 依赖方向：测试基线（vitest，Node 环境），import src/lib/entrance-state（纯函数状态机）、
 * src/config/entrance（冻结时序 ENTRANCE_DURATIONS）。不依赖浏览器 / React / Three.js / R3F——
 * 状态机是纯函数，可在 Node 直接断言「阶段顺序固定、每阶段只进一次、交互只在最终态启用」
 * 「资产乱序完成无影响」「加载失败终态」「进度只反映真实资产（永不卡 99%）」「地形升起 /
 * 标签错峰 / 水面边界淡入时序」等不变量，无需启动浏览器 / WebGL（人工视觉验收：pnpm dev 目视 +
 * 无头 Chrome 截图）。
 *
 * 覆盖 CURRENT_TASK 验收条件：
 * - 验收 1「DOM 进度条反映真实加载进度」：computeAssetReadiness 真实计数 + App 把四个资产 hook
 *   映射为受跟踪资产 + Loader 只消费 readiness（源码扫描）。
 * - 验收 2「地形 ≈1.2s 升起、省名自西向东错峰淡入、水面与边界随后淡入」：computeTerrainRise /
 *   computeProvinceLabelOpacity / computeSceneLayerOpacity 时序 + 各渲染层接线（源码扫描）。
 * - 验收 3「动画期间 OrbitControls 锁定，结束后释放」：isEntranceInteractive 只认 interactive +
 *   App 以单一布尔驱动 MapOrbitControls enabled（源码扫描）。
 * - 验收 4「pnpm build && pnpm test 通过」：本文件即入场状态机测试。
 */

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  ENTRANCE_DURATIONS,
  ENTRANCE_TRACKED_ASSET_COUNT,
} from '../src/config/entrance'
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

const srcRoot = resolve(fileURLToPath(import.meta.url), '..', '..', 'src')

/** 读取 src 下某个源文件的 UTF-8 文本（装配不变量源码扫描用）。 */
function readSource(relativePath: string): string {
  return readFileSync(resolve(srcRoot, relativePath), 'utf-8')
}

/** 去除块注释与行注释（负向断言基于去注释文本，避免文件头文档注释里的反面模式描述误伤）。 */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1')
}

/** 构造四个资产全部就绪的合法状态（computeAssetReadiness 输入）。 */
function allReadyAssets(): TrackedAssetState[] {
  return [
    { key: 'heightmap', phase: 'ready', errorMessage: null },
    { key: 'provinceGeometry', phase: 'ready', errorMessage: null },
    { key: 'politicalBoundary', phase: 'ready', errorMessage: null },
    { key: 'placeLabelAssets', phase: 'ready', errorMessage: null },
  ]
}

/** 断言两数在容差内相等。 */
function expectAlmostEqual(actual: number, expected: number, tol: number, note = ''): void {
  expect(Math.abs(actual - expected), `期望 ${actual} ≈ ${expected}（容差 ${tol}）${note}`).toBeLessThanOrEqual(tol)
}

describe('资产就绪聚合：真实进度、不伪造（验收 1「永不卡 99%」）', () => {
  it('全部就绪 → ready=true、loadedCount=totalCount、无失败', () => {
    const r = computeAssetReadiness(allReadyAssets())
    expect(r.ready).toBe(true)
    expect(r.failed).toBe(false)
    expect(r.loadedCount).toBe(4)
    expect(r.totalCount).toBe(4)
    expect(r.failureMessage).toBeNull()
  })

  it('全部加载中 → ready=false、loadedCount=0（进度 0/4，不伪造推到 99%）', () => {
    const r = computeAssetReadiness(
      allReadyAssets().map((a) => ({ ...a, phase: 'loading' as const })),
    )
    expect(r.ready).toBe(false)
    expect(r.failed).toBe(false)
    expect(r.loadedCount).toBe(0)
    expect(r.totalCount).toBe(4)
  })

  it('部分就绪 → 进度停在真实值（如 2/4），绝不用计时器虚假推到 99%', () => {
    const assets = allReadyAssets().map((a) => ({ ...a, phase: 'loading' as const }))
    assets[0].phase = 'ready'
    assets[2].phase = 'ready'
    const r = computeAssetReadiness(assets)
    expect(r.loadedCount).toBe(2)
    expect(r.totalCount).toBe(4)
    expect(r.ready).toBe(false)
    // 真实进度 = 2/4 = 50%，不会被任何计时器推到 99%——loadedCount 只随真实资产就绪推进。
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

  it('受跟踪资产数配置 = 4（heightmap / 省界几何 / 政治边界 / 标签资产）', () => {
    expect(ENTRANCE_TRACKED_ASSET_COUNT).toBe(4)
  })
})

describe('阶段顺序固定、每阶段只进一次（SPEC §4.3）', () => {
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
    expect(deriveEntrancePhase(TOTAL - TOLERANCE, true, false, D)).toBe('scene-layers-fade-in')
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

describe('交互锁：只在 interactive 启用（验收 3「动画期间锁定，结束后释放」）', () => {
  it('仅 interactive 为 true；loading / error / 三个动画阶段均锁定', () => {
    expect(isEntranceInteractive('loading')).toBe(false)
    expect(isEntranceInteractive('error')).toBe(false)
    expect(isEntranceInteractive('terrain-rise')).toBe(false)
    expect(isEntranceInteractive('labels-fade-in')).toBe(false)
    expect(isEntranceInteractive('scene-layers-fade-in')).toBe(false)
    expect(isEntranceInteractive('interactive')).toBe(true)
  })
})

describe('加载失败：显式终态、不继续入场动画', () => {
  it('failed=true 时无论 elapsed 多大，阶段恒为 error', () => {
    expect(deriveEntrancePhase(0, false, true, D)).toBe('error')
    expect(deriveEntrancePhase(0, true, true, D)).toBe('error')
    expect(deriveEntrancePhase(TOTAL, true, true, D)).toBe('error')
    expect(deriveEntrancePhase(999, true, true, D)).toBe('error')
  })

  it('失败终态下 elapsed=0 → 地形 rise=0、水面 / 边界 / 标签透明度=0（入场动画不继续）', () => {
    // 失败时 EntranceController 永不捕获起始时刻 → elapsed 冻结为 0。
    const elapsed = 0
    expect(computeTerrainRise(elapsed, D)).toBe(0)
    expect(computeSceneLayerOpacity(elapsed, D)).toBe(0)
    expect(computeProvinceLabelOpacity(elapsed, D, 0, 34)).toBe(0)
    expect(computeAncillaryLabelOpacity(elapsed, D)).toBe(0)
  })
})

describe('资产乱序完成：不影响阶段顺序', () => {
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

describe('地形升起：约 1.2 秒从平面升至夸张后真实高度（验收 2，SPEC §4.3）', () => {
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

  it('地形升起时长 = 1.2 秒（SPEC §4.3「≈1.2s」）', () => {
    expect(D.terrainRiseSeconds).toBe(1.2)
  })

  it('rise=0 时 uRise 使地形为平面（复用 GPU 位移，不建第二套几何的契约由 ChinaTerrainMesh 位移 uniform 保证）', () => {
    // 本断言锁定 rise=0 产出的标量；ChinaTerrainMesh 顶点位移 = h·k·uRise，uRise=0 → 平面（同一套几何）。
    expect(computeTerrainRise(0, D)).toBe(0)
  })
})

describe('省名标签错峰淡入：自西向东、确定顺序（验收 2，SPEC §4.3）', () => {
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
    expect(east).toBe(0)
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

  it('省会光点 / 省会名小字（ancillary）随省名阶段整体淡入：阶段前 0、阶段后 1', () => {
    expect(computeAncillaryLabelOpacity(0, D)).toBe(0)
    expect(computeAncillaryLabelOpacity(D.terrainRiseSeconds, D)).toBe(0)
    expectAlmostEqual(computeAncillaryLabelOpacity(D.terrainRiseSeconds + D.labelsFadeSeconds, D), 1, TOLERANCE)
  })

  it('staggerCount ≤ 1 时不错峰（单标签直接整体淡入，无除零）', () => {
    expect(() => computeProvinceLabelOpacity(D.terrainRiseSeconds + 0.5, D, 0, 1)).not.toThrow()
    expect(computeProvinceLabelOpacity(D.terrainRiseSeconds + D.labelsFadeSeconds, D, 0, 1)).toBe(1)
  })
})

describe('水面 / 边界淡入：在省名标签淡入后开始（验收 2，SPEC §4.3「随后淡入」）', () => {
  it('省名淡入完成前 → 场景层透明度 0（海面 / 边界不可见）', () => {
    expect(computeSceneLayerOpacity(0, D)).toBe(0)
    expect(computeSceneLayerOpacity(D.terrainRiseSeconds, D)).toBe(0)
    // 省名淡入进行中（terrainRise + labelsFade 之间）仍为 0。
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

describe('EntranceFrame 零分配契约：原地改写而非整对象替换（SPEC §7.4「无运行时分配循环」）', () => {
  it('字段可原地改写且对象引用跨多帧稳定（模拟 EntranceController 每帧写共享帧，无新对象）', () => {
    // App 的 useRef 一次性创建的共享入场帧对象（同 fiber 跨重渲染保持同一引用）。
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

describe('统一时间源：入场模块无独立时钟 / 计时器（SPEC §7.4）', () => {
  const ENTRANCE_FILES = [
    'config/entrance.ts',
    'lib/entrance-state.ts',
    'three/EntranceController.tsx',
    'components/ui/Loader.tsx',
  ]

  for (const file of ENTRANCE_FILES) {
    it(`${file} 无 new Clock / setInterval / setTimeout / Date.now（唯一时钟是 R3F 共享 clock）`, () => {
      const code = stripComments(readSource(file))
      expect(code).not.toContain('new THREE.Clock')
      expect(code).not.toContain('new Clock(')
      expect(code).not.toContain('setInterval(')
      expect(code).not.toContain('setTimeout(')
      expect(code).not.toContain('Date.now(')
      expect(code).not.toContain('performance.now(')
    })
  }

  it('EntranceController 的 elapsed 只从 R3F 共享 clock 派生（state.clock.getElapsedTime）', () => {
    const source = readSource('three/EntranceController.tsx')
    expect(source).toContain('state.clock.getElapsedTime()')
    expect(source).toContain('useFrame')
  })
})

describe('App 总装接线（验收 1、3：进度来自真实资产、相机锁由入场阶段显式驱动）', () => {
  const source = readSource('App.tsx')
  const code = stripComments(source)

  it('四个资产 hook 映射为受跟踪资产（与 ENTRANCE_TRACKED_ASSET_COUNT=4 一致），经 computeAssetReadiness 聚合', () => {
    expect(source).toContain("key: 'heightmap'")
    expect(source).toContain("key: 'provinceGeometry'")
    expect(source).toContain("key: 'politicalBoundary'")
    expect(source).toContain("key: 'placeLabelAssets'")
    expect(source).toContain('computeAssetReadiness(trackedAssets)')
    // 恰好四个受跟踪资产键（不多不少——进度分母真实）。
    const keyCount = (source.match(/key: '(heightmap|provinceGeometry|politicalBoundary|placeLabelAssets)'/g) ?? []).length
    expect(keyCount).toBe(ENTRANCE_TRACKED_ASSET_COUNT)
  })

  it('共享入场帧 ref + 入场阶段 state：EntranceController 挂载于 Canvas 内并先于 MapOrbitControls', () => {
    expect(source).toContain("useRef<EntranceFrame>({ phase: 'loading', elapsedSeconds: 0 })")
    expect(source).toContain("from './three/EntranceController'")
    const controllerIndex = source.indexOf('<EntranceController')
    const controlsIndex = source.indexOf('<MapOrbitControls')
    const canvasCloseIndex = source.indexOf('</Canvas>')
    expect(controllerIndex).toBeGreaterThan(-1)
    expect(controlsIndex).toBeGreaterThan(controllerIndex)
    expect(canvasCloseIndex).toBeGreaterThan(controlsIndex)
    // 阶段切换回调 = 入场阶段 state setter（单一显式状态流）。
    expect(source).toContain('onPhaseChange={setEntrancePhase}')
    expect(source).toContain('entranceFrame={entranceFrameRef}')
  })

  it('相机交互锁：enabled={interactionEnabled}，单一布尔 = isEntranceInteractive(entrancePhase) 且运行时 running（TASK-015）', () => {
    expect(source).toContain('isEntranceInteractive(entrancePhase)')
    // TASK-015 起交互锁为「入场 interactive && 运行时 running」单一合取布尔。
    expect(code).toContain(
      "const interactionEnabled = isEntranceInteractive(entrancePhase) && runtimePhase === 'running'",
    )
    expect(source).toContain('<MapOrbitControls enabled={interactionEnabled} />')
    // 无第二套交互开关：App 内不再出现恒启用的 enabled 写法。
    expect(code).not.toContain('<MapOrbitControls enabled />')
  })

  it('共享入场帧透传到地形 / 海面 / 场景内容层（升起 + 淡入同一时间源）', () => {
    // 地形（uRise 升起）与海面（随后淡入）直接注入。
    const terrainIndex = source.indexOf('<ChinaTerrainMesh')
    expect(terrainIndex).toBeGreaterThan(-1)
    expect(source.indexOf('entranceFrame={entranceFrameRef}', terrainIndex)).toBeGreaterThan(terrainIndex)
    expect(source).toContain('<SeaSurface entranceFrame={entranceFrameRef} runtimeFrame={runtimeFrameRef} />')
    // 场景内容层（省界 / 标签 / 政治要素）经 TerrainSceneLayers 透传。
    expect(source).toContain('entranceFrame={entranceFrame}')
  })

  it('Loader 以 readiness + phase 渲染（进度只反映真实资产），失败时红线整页错误通道优先', () => {
    expect(source).toContain("from './components/ui/Loader'")
    expect(source).toContain('<Loader readiness={readiness} phase={entrancePhase} />')
    // 资产错误 → 整页错误通道（Loader 不重复挂载，避免双错误界面）。
    expect(source).toContain("heightmap.phase !== 'error' && assetErrorMessage === null")
    // 旧「地形数据加载中…」静态文本已由真实进度条取代。
    expect(code).not.toContain('地形数据加载中')
  })
})

describe('渲染层入场接线（验收 2：升起 + 错峰淡入 + 随后淡入的实际写入路径）', () => {
  it('ChinaTerrainMesh：computeTerrainRise 经 materialRef 写材质 uniforms 的 uRise（R3F v9 合并陷阱的正确路径）', () => {
    const source = readSource('three/ChinaTerrainMesh.tsx')
    const code = stripComments(source)
    expect(source).toContain('computeTerrainRise')
    expect(source).toContain('ENTRANCE_DURATIONS')
    expect(code).toContain('material.uniforms.uRise.value = computeTerrainRise(')
    expect(code).toContain('const material = materialRef.current')
    // 错误路径负向断言：不得改写 useMemo 持有的初始 uniforms 对象（R3F v9 浅拷贝合并不到达 GPU）。
    // 剥离正确路径（material.uniforms…）后，不得残留任何对 memo 对象 uniforms 的直接写入。
    const withoutCorrectPath = code.split('material.uniforms.uRise.value').join('')
    expect(withoutCorrectPath).not.toContain('uniforms.uRise.value =')
    // 入场接管时初始 uRise = 0（首个绘制帧即平面）。
    expect(code).toContain('uRise: { value: entranceActive ? 0 : rise }')
  })

  it('SeaSurface：uOpacity = 配置基线 × computeSceneLayerOpacity，经 materialRef 写入', () => {
    const source = readSource('three/SeaSurface.tsx')
    const code = stripComments(source)
    expect(source).toContain('computeSceneLayerOpacity')
    expect(code).toContain(
      'material.uniforms.uOpacity.value =\n        opacity * computeSceneLayerOpacity(entranceFrame.current.elapsedSeconds, ENTRANCE_DURATIONS)',
    )
    // 入场接管时初始 uOpacity = 0（首个绘制帧即不可见）。
    expect(code).toContain('uOpacity: { value: entranceActive ? 0 : opacity }')
  })

  it('ProvinceBorders：单一 useFrame 把 computeSceneLayerOpacity 写入全部省界材质（材质经登记数组寻址）', () => {
    const source = readSource('three/ProvinceBorders.tsx')
    const code = stripComments(source)
    expect(source).toContain('computeSceneLayerOpacity')
    expect(code).toContain('const opacity = computeSceneLayerOpacity(entranceFrame.current.elapsedSeconds, ENTRANCE_DURATIONS)')
    expect(code).toContain('material.opacity = opacity')
    expect(code).toContain('materials[materialSlot] = line.material')
    // 入场接管时初始 opacity = 0。
    expect(code).toContain('initialOpacity={entranceActive ? 0 : 1}')
  })

  it('PoliticalFeatures：单一 useFrame 把 computeSceneLayerOpacity 写入全部十段线 / 岛礁光点材质', () => {
    const source = readSource('three/PoliticalFeatures.tsx')
    const code = stripComments(source)
    expect(source).toContain('computeSceneLayerOpacity')
    expect(code).toContain('const opacity = computeSceneLayerOpacity(entranceFrame.current.elapsedSeconds, ENTRANCE_DURATIONS)')
    expect(code).toContain('material.opacity = opacity')
    // 线段与光点共享同一登记数组（光点槽位偏移 lines.length，确定性对齐）。
    expect(code).toContain('materialSlot={features.lines.length + index}')
    expect(code).toContain('initialOpacity={entranceActive ? 0 : 1}')
  })

  it('PlaceLabels：省名按世界 x 升序错峰（自西向东）+ 入场透明度与遮挡 / 焦点目标乘法合成', () => {
    const source = readSource('three/PlaceLabels.tsx')
    const code = stripComments(source)
    // 错峰排序：按 position[0]（世界 x，+X = 东）升序。
    expect(code).toContain('entries.sort((a, b) => a.x - b.x)')
    expect(code).toContain('x: desc.position[0]')
    // 省名错峰淡入 + 省会光点 / 小字整体淡入。
    expect(code).toContain('computeProvinceLabelOpacity(')
    expect(code).toContain('computeAncillaryLabelOpacity(entranceElapsed, ENTRANCE_DURATIONS)')
    // 乘法合成（入场透明度 × 遮挡 / 焦点目标）。
    expect(code).toContain('const composedTarget = entranceOpacity * styleTarget')
    // 入场接管时初始透明度 = 0（troika fillOpacity 与 currentOpacities 同源）。
    expect(code).toContain('const initialOpacity = entranceActive ? 0 : LABEL_OCCLUSION_CONFIG.visibleOpacity')
    expect(code).toContain('fillOpacity={initialOpacity}')
  })

  it('Loader：进度只来自 readiness（loadedCount / totalCount），无计时器伪造', () => {
    const source = readSource('components/ui/Loader.tsx')
    const code = stripComments(source)
    expect(code).toContain('readiness.loadedCount / total')
    expect(code).toContain('{readiness.loadedCount} / {readiness.totalCount}')
    // interactive 无输出（不遮挡已可交互场景）。
    expect(code).toContain('if (isEntranceInteractive(phase)) return null')
  })
})
