/**
 * 工程基线示例测试：验证 d3-geo 已正确接入，且投影方向符合 SPEC §3.3 约定。
 *
 * 真正的投影封装（lib/projection.ts）由后续任务实现；此处仅锁定
 * 「墨卡托投影在本工程可用、主图范围内坐标有限、东西/南北方向单调」
 * 这一最低契约，防止依赖声明或测试环境配置回归。
 */
import { describe, expect, it } from 'vitest'
import { geoMercator } from 'd3-geo'

/** SPEC §3.3 主图地理范围（含南海诸岛真实位置） */
const EXTENT = {
  lonMin: 72,
  lonMax: 136,
  latMin: 3,
  latMax: 54,
} as const

const project = geoMercator()

function mustProject(lonLat: [number, number]): [number, number] {
  const point = project(lonLat)
  if (!point) {
    throw new Error(`geoMercator 对中国范围坐标 ${lonLat} 返回 null，不符合预期`)
  }
  return point
}

describe('geoMercator 投影基线（SPEC §3.3）', () => {
  it('主图四角均可投影为有限平面坐标', () => {
    const corners: Array<[number, number]> = [
      [EXTENT.lonMin, EXTENT.latMin],
      [EXTENT.lonMin, EXTENT.latMax],
      [EXTENT.lonMax, EXTENT.latMin],
      [EXTENT.lonMax, EXTENT.latMax],
    ]
    for (const corner of corners) {
      const [x, y] = mustProject(corner)
      expect(Number.isFinite(x)).toBe(true)
      expect(Number.isFinite(y)).toBe(true)
    }
  })

  it('东经在屏幕 x 上大于西经，北纬在屏幕 y 上小于南纬', () => {
    const west = mustProject([EXTENT.lonMin, 30])
    const east = mustProject([EXTENT.lonMax, 30])
    const north = mustProject([104, EXTENT.latMax])
    const south = mustProject([104, EXTENT.latMin])
    expect(east[0]).toBeGreaterThan(west[0])
    expect(north[1]).toBeLessThan(south[1])
  })
})
