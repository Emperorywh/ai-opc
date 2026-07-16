import { describe, expect, it } from 'vitest'
import {
  ENVIRONMENT_BACKGROUND_HEX,
  ENVIRONMENT_FOG_HEX,
  ENVIRONMENT_THEME,
} from '../src/features/agv-map/config/visualTheme'

/**
 * 深色沙盘环境视觉主题测试（SPEC §8.2、§8.3、§8.4，TASK-012）。
 *
 * 断言环境视觉参数集中定义、与 SPEC §8.2 背景 #05080F 一致，且光强/材质参数落在合理区间。
 * 空间布局参数（边距、距离因子）的测试见 environmentConfig.test.ts。
 */

describe('environmentTheme — 深色背景与雾色（SPEC §8.2）', () => {
  it('背景固定为 #05080F', () => {
    expect(ENVIRONMENT_BACKGROUND_HEX).toBe('#05080F')
    expect(ENVIRONMENT_THEME.backgroundHex).toBe('#05080F')
  })

  it('雾色与背景一致（远端无缝融入）', () => {
    expect(ENVIRONMENT_FOG_HEX).toBe(ENVIRONMENT_BACKGROUND_HEX)
    expect(ENVIRONMENT_THEME.fogHex).toBe(ENVIRONMENT_THEME.backgroundHex)
  })
})

describe('environmentTheme — 单一灯光配置（SPEC §8.3）', () => {
  it('方向光：光强为正、色相落在蓝青区间（与深色科技底协调）', () => {
    const { directionalLight } = ENVIRONMENT_THEME
    expect(directionalLight.intensity).toBeGreaterThan(0)
    expect(directionalLight.color.h).toBeGreaterThanOrEqual(190)
    expect(directionalLight.color.h).toBeLessThanOrEqual(230)
  })

  it('环境光：低强度补光（明显低于方向光塑形强度）', () => {
    const { ambientLight, directionalLight } = ENVIRONMENT_THEME
    expect(ambientLight.intensity).toBeGreaterThan(0)
    expect(ambientLight.intensity).toBeLessThan(directionalLight.intensity)
  })
})

describe('environmentTheme — 地面材质（SPEC §8.3、§8.4 深色不透明基线）', () => {
  it('地面基础色为深色（明度低，略高于纯背景以接收阴影）', () => {
    expect(ENVIRONMENT_THEME.ground.color.l).toBeLessThan(0.15)
  })

  it('高粗糙度、低金属度（哑光沙盘底，避免镜面高光喧宾夺主）', () => {
    const { ground } = ENVIRONMENT_THEME
    expect(ground.roughness).toBeGreaterThan(0.5)
    expect(ground.metalness).toBeLessThan(0.3)
  })
})

describe('environmentTheme — 网格视觉（SPEC §8.4）', () => {
  it('粗线色明度高于细线色（强调大尺度划分）', () => {
    expect(ENVIRONMENT_THEME.grid.centerColor.l).toBeGreaterThan(
      ENVIRONMENT_THEME.grid.sectionColor.l,
    )
  })

  it('基础透明度为低值（不遮蔽拓扑，SPEC §16.2）', () => {
    expect(ENVIRONMENT_THEME.grid.baseOpacity).toBeGreaterThan(0)
    expect(ENVIRONMENT_THEME.grid.baseOpacity).toBeLessThan(0.5)
  })
})

describe('environmentTheme — 程序化 PMREM 渐变（SPEC §8.3 本地程序化环境）', () => {
  it('顶色明度高于底色（模拟顶光方向的环境光照）', () => {
    const { pmremGradient } = ENVIRONMENT_THEME
    expect(pmremGradient.top.l).toBeGreaterThan(pmremGradient.bottom.l)
  })

  it('底色为深色（近背景，避免环境光照过亮）', () => {
    expect(ENVIRONMENT_THEME.pmremGradient.bottom.l).toBeLessThan(0.1)
  })
})
