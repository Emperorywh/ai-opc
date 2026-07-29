/**
 * 省级悬停焦点配置与装配测试（TASK-009 验收 2、3；SPEC §4.2）。
 *
 * 依赖方向：测试基线（vitest，Node 环境），import src/config/province-hover（悬停视觉参数唯一事实源）、
 * src/config/province-borders（基线参数，用于断言焦点 / 压暗态相对基线的关系）、
 * src/three/province-hover + ProvinceHoverProvider（共享焦点状态的 React context 载体，经
 * react-dom/server 在 Node 内做真实渲染行为断言，无需 DOM / WebGL）、以及对渲染层源码的结构扫描
 * （ProvinceBorders / ProvinceHoverPicker / App 装配不变量）。
 *
 * 覆盖：
 * - 配置不变量：焦点色逐通道 ≥ 基线（加亮）、压暗色逐通道 ≤ 基线（轻微压暗）、焦点线宽 > 基线
 *   （加粗）、标签放大倍率 > 1、置顶透明度 = 1.0、全部冻结。
 * - 共享焦点状态行为：Provider 内初始焦点为 null；缺 Provider 时两个 hook 确定性抛错（装配错误
 *   显式暴露，不静默无焦点）。
 * - 渲染层装配（源码扫描）：ProvinceBorders 经 useHoveredProvince 消费唯一焦点源、三态样式全部
 *   取自配置、additive 发光 + 不写深度 + renderOrder 后置、按省分组渲染；ProvinceHoverPicker 只
 *   注册 move/out/leave（无 click）、经 invertWorld + findProvinceAtLonLat + dispatch 反查、卸载
 *   复位 null、拾取面与地形同包围盒且不用 visible={false}；App 总装 Provider + 边界层 + 拾取点。
 */

import { describe, it, expect } from 'vitest'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { PROVINCE_HOVER_CONFIG } from '../src/config/province-hover'
import { PROVINCE_BORDERS_CONFIG } from '../src/config/province-borders'
import { ProvinceHoverProvider } from '../src/three/ProvinceHoverProvider'
import { useHoveredProvince, useProvinceHoverDispatch } from '../src/three/province-hover'

const projectRoot = resolve(fileURLToPath(import.meta.url), '..', '..')

/** 读取 src 下某源码文件的文本（装配结构不变量扫描用）。 */
function readSource(relativePath: string): string {
  return readFileSync(resolve(projectRoot, 'src', relativePath), 'utf-8')
}

/**
 * 去掉块注释 / JSX 注释 / 行注释后的源码。
 * 「不存在某模式」类断言必须基于去注释文本——组件文件头的文档注释会提到反面模式
 * （如「不注册 onClick」「不得用 visible={false}」），不去注释会误命中。
 */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '')
}

describe('省级悬停焦点配置不变量（验收 3：加亮加粗 / 轻微压暗）', () => {
  it('焦点省界色比基线省界色更亮（加亮，逐通道 ≥ 基线）', () => {
    const { focusedBorderColorRgb, dimmedBorderColorRgb } = PROVINCE_HOVER_CONFIG
    const baseline = PROVINCE_BORDERS_CONFIG.colorRgb
    // 焦点色逐通道 ≥ 基线色（加亮）。
    expect(focusedBorderColorRgb.r).toBeGreaterThanOrEqual(baseline.r)
    expect(focusedBorderColorRgb.g).toBeGreaterThanOrEqual(baseline.g)
    expect(focusedBorderColorRgb.b).toBeGreaterThanOrEqual(baseline.b)
    // 压暗色逐通道 ≤ 基线色（弱化非焦点）。
    expect(dimmedBorderColorRgb.r).toBeLessThanOrEqual(baseline.r)
    expect(dimmedBorderColorRgb.g).toBeLessThanOrEqual(baseline.g)
    expect(dimmedBorderColorRgb.b).toBeLessThanOrEqual(baseline.b)
  })

  it('压暗是「轻微」压暗：压暗色各通道 > 0（不抹没非焦点省界）', () => {
    const { dimmedBorderColorRgb } = PROVINCE_HOVER_CONFIG
    expect(dimmedBorderColorRgb.r).toBeGreaterThan(0)
    expect(dimmedBorderColorRgb.g).toBeGreaterThan(0)
    expect(dimmedBorderColorRgb.b).toBeGreaterThan(0)
  })

  it('焦点省界线宽 > 基线线宽（加粗）', () => {
    expect(PROVINCE_HOVER_CONFIG.focusedBorderLineWidthPx).toBeGreaterThan(
      PROVINCE_BORDERS_CONFIG.lineWidthPx,
    )
  })

  it('焦点省名标签放大倍率 > 1、置顶透明度 = 1.0（SPEC §4.2「标签放大并置顶」，TASK-010 消费）', () => {
    expect(PROVINCE_HOVER_CONFIG.focusedLabelScale).toBeGreaterThan(1)
    expect(PROVINCE_HOVER_CONFIG.focusedLabelOpacity).toBe(1.0)
  })

  it('配置全部冻结（运行时不可被偷偷改）', () => {
    expect(Object.isFrozen(PROVINCE_HOVER_CONFIG)).toBe(true)
    expect(Object.isFrozen(PROVINCE_HOVER_CONFIG.focusedBorderColorRgb)).toBe(true)
    expect(Object.isFrozen(PROVINCE_HOVER_CONFIG.dimmedBorderColorRgb)).toBe(true)
    expect(Object.isFrozen(PROVINCE_HOVER_CONFIG.focusedLabelColorRgb)).toBe(true)
  })
})

describe('共享悬停焦点状态（React context）行为（验收 3：hoveredProvince 跨组件共享）', () => {
  /** 只读消费者：渲染当前焦点（null → 'none'）。 */
  function HoverStateConsumer() {
    const value = useHoveredProvince()
    return createElement('span', null, value === null ? 'none' : value)
  }

  /** dispatch 消费者：把 dispatch 是否存在渲染出来。 */
  function HoverDispatchConsumer() {
    const dispatch = useProvinceHoverDispatch()
    return createElement('span', null, typeof dispatch === 'function' ? 'ready' : 'missing')
  }

  it('Provider 内初始焦点为 null（无焦点基线态），dispatch 可用', () => {
    const html = renderToStaticMarkup(
      createElement(
        ProvinceHoverProvider,
        null,
        createElement(HoverStateConsumer),
        createElement(HoverDispatchConsumer),
      ),
    )
    expect(html).toBe('<span>none</span><span>ready</span>')
  })

  it('缺 Provider 时 useHoveredProvince 确定性抛错（装配错误显式暴露）', () => {
    expect(() => renderToStaticMarkup(createElement(HoverStateConsumer))).toThrowError(
      /ProvinceHoverProvider/,
    )
  })

  it('缺 Provider 时 useProvinceHoverDispatch 确定性抛错（装配错误显式暴露）', () => {
    expect(() => renderToStaticMarkup(createElement(HoverDispatchConsumer))).toThrowError(
      /ProvinceHoverProvider/,
    )
  })

  it('context 模块结构：状态 / dispatch 双 context 拆分（picker 不随 hover 重渲染）', () => {
    const source = readSource('three/province-hover.ts')
    expect(source).toContain('HoveredProvinceContext')
    expect(source).toContain('ProvinceHoverDispatchContext')
    // 缺 Provider 哨兵：状态用 undefined（与合法 null 区分），dispatch 用 null。
    expect(source).toContain('createContext<HoveredProvinceId | undefined>(undefined)')
    expect(source).toContain('createContext<ProvinceHoverDispatch | null>(null)')
  })
})

describe('ProvinceBorders 渲染装配不变量（验收 2、3）', () => {
  const source = readSource('three/ProvinceBorders.tsx')

  it('按行政区分组渲染（每省一个 drei Line = 一个 draw call，34 省共 34 个，保留 hover 按省寻址）', () => {
    // 每省一个 <Line>（borders.borders.map），以稳定 adminId 为 key。
    expect(source).toContain('borders.borders.map')
    expect(source).toContain('key={border.adminId}')
    // segments 模式：领域层平铺端点按 [a,b] 对解释为独立线段（一条多段折线合并为一个 draw call）。
    expect(source).toContain('segments')
  })

  it('浅青白 additive 发光：AdditiveBlending + 基线色 / 线宽全部取自配置层', () => {
    expect(source).toContain('THREE.AdditiveBlending')
    expect(source).toContain('PROVINCE_BORDERS_CONFIG.colorHex')
    expect(source).toContain('PROVINCE_BORDERS_CONFIG.lineWidthPx')
    // 半透明通道 + 不写深度（与海面共存，不竞争深度）。
    expect(source).toContain('transparent')
    expect(source).toContain('depthWrite={false}')
    // 在海面（renderOrder=0）之后绘制，避免海岸线透明顺序错乱。
    expect(source).toContain('renderOrder={2}')
  })

  it('hover 三态样式：焦点加亮加粗、非焦点压暗、无焦点基线，全部取自 PROVINCE_HOVER_CONFIG', () => {
    // 唯一焦点源：共享 context（不经 props、不自拾取）。
    expect(source).toContain('useHoveredProvince()')
    // 焦点态：加亮色 + 加粗线宽。
    expect(source).toContain('PROVINCE_HOVER_CONFIG.focusedBorderColorHex')
    expect(source).toContain('PROVINCE_HOVER_CONFIG.focusedBorderLineWidthPx')
    // 压暗态。
    expect(source).toContain('PROVINCE_HOVER_CONFIG.dimmedBorderColorHex')
    // 三态合成的确定性条件。
    expect(source).toContain('hoveredAdminId === border.adminId')
  })

  it('NDC 深度偏移经 applyLineDepthBias 注入（抗 z-fighting 主防线），偏移值取自配置层', () => {
    expect(source).toContain('applyLineDepthBias')
    expect(source).toContain('PROVINCE_BORDERS_CONFIG.depthBiasNdc')
  })

  it('省界线自身不注册任何指针处理器（拾取唯一入口是 ProvinceHoverPicker）', () => {
    const code = stripComments(source)
    expect(code).not.toContain('onPointerMove')
    expect(code).not.toContain('onPointerOut')
    expect(code).not.toContain('onPointerLeave')
    expect(code).not.toContain('onClick')
    expect(code).not.toContain('onPointerDown')
    expect(code).not.toContain('onPointerUp')
  })
})

describe('ProvinceHoverPicker 拾取装配不变量（验收 3：hover 加亮 / 压暗 / 还原、无 click）', () => {
  const source = readSource('three/ProvinceHoverPicker.tsx')

  it('只注册 move / out / leave，不注册 click / down / up（无 click 行为，SPEC §4.2）', () => {
    expect(source).toContain('onPointerMove={handleMove}')
    expect(source).toContain('onPointerOut={handleOut}')
    expect(source).toContain('onPointerLeave={handleOut}')
    // 负向断言基于去注释文本（文件头文档注释会提到「不注册 onClick」等反面模式）。
    const code = stripComments(source)
    expect(code).not.toContain('onClick')
    expect(code).not.toContain('onPointerDown')
    expect(code).not.toContain('onPointerUp')
  })

  it('拾取流程：世界 (x,z) → invertWorld 反查经纬度 → findProvinceAtLonLat 裁决 → dispatch 写入共享焦点', () => {
    expect(source).toContain('invertWorld(worldX, worldZ)')
    expect(source).toContain('findProvinceAtLonLat(')
    expect(source).toContain('useProvinceHoverDispatch()')
    // 反查失败 / 海域 / 无命中 → 写 null（不伪造归属，恢复无焦点）。
    expect(source).toContain('setHoveredProvince(null)')
  })

  it('恢复不变量：卸载时经 effect 清理复位 null（焦点不残留指向已失效几何）', () => {
    // useEffect 的清理函数里复位 null。
    expect(source).toContain('useEffect(() => {')
    expect(source).toContain('return () => {')
  })

  it('拾取面与地形同包围盒（TERRAIN_PLANE_LAYOUT），不可见但可求交（不用 visible={false}）', () => {
    expect(source).toContain('TERRAIN_PLANE_LAYOUT.worldWidthX')
    expect(source).toContain('TERRAIN_PLANE_LAYOUT.worldHeightZ')
    expect(source).toContain('TERRAIN_PLANE_LAYOUT.centerZ')
    // 不可见材质：opacity 0 + 不写深度 + 不写颜色；严禁 visible={false}（会使 three 跳过射线求交）。
    expect(source).toContain('opacity={0}')
    expect(source).toContain('colorWrite={false}')
    expect(stripComments(source)).not.toContain('visible')
  })
})

describe('App 总装不变量（验收 2、3 的装配证据）', () => {
  const source = readSource('App.tsx')

  it('省界数据链路：loadProvinceGeometry 取数 + createElevationProvider 共享高程 + prepareProvinceBorders 准备', () => {
    expect(source).toContain('loadProvinceGeometry')
    expect(source).toContain('createElevationProvider(heightmap.meta, heightmap.pixels)')
    expect(source).toContain('prepareProvinceBorders(geometry.features, provider, exaggeration')
    // densify 间距 / epsilon 取自配置层唯一事实源。
    expect(source).toContain('PROVINCE_BORDERS_CONFIG.densifySpacingMeters')
    expect(source).toContain('PROVINCE_BORDERS_CONFIG.terrainEpsilonMeters')
  })

  it('Canvas 内装配：ProvinceHoverProvider 包裹 ProvinceBordersLayer 与 ProvinceHoverPicker', () => {
    expect(source).toContain('<ProvinceHoverProvider>')
    expect(source).toContain('</ProvinceHoverProvider>')
    expect(source).toContain('<ProvinceBordersLayer')
    expect(source).toContain('<ProvinceHoverPicker features={geometry.contract.features} />')
  })

  it('省界几何加载失败显式暴露（政治红线：不渲染缺省界的地图）', () => {
    expect(source).toContain("geometry.phase === 'error'")
    expect(source).toContain('省界数据加载失败')
  })
})
