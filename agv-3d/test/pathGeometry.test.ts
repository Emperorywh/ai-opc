import { describe, expect, it } from 'vitest'
import { buildPathGeometry } from '../src/features/agv-map/presentation/scene/pathGeometry'
import type { PathGeometryPacket } from '../src/features/agv-map/domain/renderPacket'

/**
 * 路径扁带几何挂接单元测试（SPEC §7.5、§8.3，TASK-010）。
 * 验证 PathGeometryPacket → BufferGeometry 的属性命名、分量数、零拷贝与索引设置，
 * 这是着色器能否读到 aPathU/aFlowDirection 的关键接线点。
 */

/** 构造最小合法扁带数据包：4 顶点构成一个 Quad（2 三角形），一条车道。 */
function minimalPacket(): PathGeometryPacket {
  return {
    positions: new Float32Array([
      0, 0.015, 0, // near @ u=0
      0, 0.015, 1, // far  @ u=0
      4, 0.015, 0, // near @ u=4
      4, 0.015, 1, // far  @ u=4
    ]),
    normals: new Float32Array([0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0]),
    pathU: new Float32Array([0, 0, 4, 4]),
    flowDirections: new Float32Array([1, 1, 1, 1]),
    indices: new Uint32Array([0, 1, 2, 1, 3, 2]),
    edgeVertexRanges: new Uint32Array([0, 4]),
  }
}

describe('buildPathGeometry — 属性命名与分量数（§7.5）', () => {
  const geometry = buildPathGeometry(minimalPacket())

  it('包含 position/normal 内建属性与 aPathU/aFlowDirection 自定义属性', () => {
    expect(geometry.getAttribute('position')).toBeDefined()
    expect(geometry.getAttribute('normal')).toBeDefined()
    expect(geometry.getAttribute('aPathU')).toBeDefined()
    expect(geometry.getAttribute('aFlowDirection')).toBeDefined()
  })

  it('position/normal 分量数为 3，aPathU/aFlowDirection 分量数为 1', () => {
    expect(geometry.getAttribute('position').itemSize).toBe(3)
    expect(geometry.getAttribute('normal').itemSize).toBe(3)
    expect(geometry.getAttribute('aPathU').itemSize).toBe(1)
    expect(geometry.getAttribute('aFlowDirection').itemSize).toBe(1)
  })

  it('顶点数为 4（与 positions/3 一致）', () => {
    expect(geometry.getAttribute('position').count).toBe(4)
    expect(geometry.getAttribute('aPathU').count).toBe(4)
  })
})

describe('buildPathGeometry — 零拷贝与索引（§5.4 转移后直接消费）', () => {
  const packet = minimalPacket()
  const geometry = buildPathGeometry(packet)

  it('属性数组与 packet 的 TypedArray 同引用（零拷贝挂接）', () => {
    expect(geometry.getAttribute('position').array).toBe(packet.positions)
    expect(geometry.getAttribute('normal').array).toBe(packet.normals)
    expect(geometry.getAttribute('aPathU').array).toBe(packet.pathU)
    expect(geometry.getAttribute('aFlowDirection').array).toBe(packet.flowDirections)
  })

  it('索引为 32 位（Uint32Array），支持大地图顶点数', () => {
    expect(geometry.index).not.toBeNull()
    expect(geometry.index!.array).toBe(packet.indices)
    expect(geometry.index!.array).toBeInstanceOf(Uint32Array)
  })
})

describe('buildPathGeometry — 包围球（§11.1 避免视锥误剔除）', () => {
  it('计算非空包围球，半径有限且覆盖全部顶点', () => {
    const geometry = buildPathGeometry(minimalPacket())
    const sphere = geometry.boundingSphere
    expect(sphere).not.toBeNull()
    expect(Number.isFinite(sphere!.radius)).toBe(true)
    expect(sphere!.radius).toBeGreaterThan(0)
    // 包围球中心为 4 顶点的几何中心 (2, 0.015, 0.5)。
    expect(sphere!.center.x).toBeCloseTo(2, 6)
    expect(sphere!.center.y).toBeCloseTo(0.015, 6)
    expect(sphere!.center.z).toBeCloseTo(0.5, 6)
  })
})

describe('buildPathGeometry — 属性值正确透传', () => {
  it('aPathU 与 aFlowDirection 逐顶点值与 packet 一致', () => {
    const packet = minimalPacket()
    const geometry = buildPathGeometry(packet)
    const pathU = geometry.getAttribute('aPathU')
    const flowDir = geometry.getAttribute('aFlowDirection')
    for (let i = 0; i < 4; i += 1) {
      expect(pathU.getX(i)).toBe(packet.pathU[i])
      expect(flowDir.getX(i)).toBe(packet.flowDirections[i])
    }
  })

  it('支持反方向车道：flowDirections 含 -1 时正确透传', () => {
    const packet = minimalPacket()
    packet.flowDirections[2] = -1
    packet.flowDirections[3] = -1
    const geometry = buildPathGeometry(packet)
    const flowDir = geometry.getAttribute('aFlowDirection')
    expect(flowDir.getX(0)).toBe(1)
    expect(flowDir.getX(2)).toBe(-1)
  })
})
