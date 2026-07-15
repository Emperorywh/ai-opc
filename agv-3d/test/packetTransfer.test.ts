import { describe, expect, it } from 'vitest'
import { collectPacketTransferables } from '../src/features/agv-map/worker/packetTransfer'
import type { RenderPacket } from '../src/features/agv-map/domain/renderPacket'

/**
 * 渲染数据包可转移缓冲收集验证（SPEC §5.4、TASK-007）。
 *
 * Worker 成功事件必须把数据包内全部大块 TypedArray 的底层 ArrayBuffer 所有权一次性转移
 * 给主线程，零拷贝交接约 6.5 MB 编译产物。此处验证收集函数完整覆盖每个渲染相关字段，
 * 且各缓冲互不重叠（重复转移同一 ArrayBuffer 会触发 DataCloneError）。
 */

/** 构造结构合法的空渲染数据包（每个 TypedArray 独立分配底层 ArrayBuffer）。 */
function emptyPacket(): RenderPacket {
  return {
    nodeInstances: {
      node: { count: 0, matrices: new Float32Array(0) },
      work: { count: 0, matrices: new Float32Array(0) },
      charge: { count: 0, matrices: new Float32Array(0) },
      park: { count: 0, matrices: new Float32Array(0) },
    },
    pathGeometry: {
      positions: new Float32Array(0),
      normals: new Float32Array(0),
      pathU: new Float32Array(0),
      flowDirections: new Float32Array(0),
      indices: new Uint32Array(0),
      edgeVertexRanges: new Uint32Array(0),
    },
    renderBounds: { min: [0, 0, 0], max: [1, 1, 1] },
    report: { nodeCount: 0, edgeLaneCount: 0, bidirectionalGroupCount: 0, unpairedEdgeCount: 0 },
  }
}

describe('collectPacketTransferables 完整覆盖数据包全部渲染缓冲（SPEC §5.4、TASK-007）', () => {
  it('收集 4 个节点矩阵 + 6 个路径缓冲 = 10 个 ArrayBuffer', () => {
    const packet = emptyPacket()
    const buffers = collectPacketTransferables(packet)
    expect(buffers).toHaveLength(10)
    for (const buf of buffers) {
      expect(buf).toBeInstanceOf(ArrayBuffer)
    }
  })

  it('收集的缓冲与数据包各字段的 .buffer 为同一引用', () => {
    const packet = emptyPacket()
    const buffers = collectPacketTransferables(packet)
    const expected: ArrayBuffer[] = [
      packet.nodeInstances.node.matrices.buffer,
      packet.nodeInstances.work.matrices.buffer,
      packet.nodeInstances.charge.matrices.buffer,
      packet.nodeInstances.park.matrices.buffer,
      packet.pathGeometry.positions.buffer,
      packet.pathGeometry.normals.buffer,
      packet.pathGeometry.pathU.buffer,
      packet.pathGeometry.flowDirections.buffer,
      packet.pathGeometry.indices.buffer,
      packet.pathGeometry.edgeVertexRanges.buffer,
    ]
    // 逐引用相等：任一字段被遗漏都会使 expected 中存在未被 buffers 包含的缓冲。
    for (const buf of expected) {
      expect(buffers).toContain(buf)
    }
  })

  it('各缓冲互不重叠（无重复引用，避免 postMessage DataCloneError）', () => {
    const packet = emptyPacket()
    const buffers = collectPacketTransferables(packet)
    // 用 Set 去重后数量不变，说明无重复引用。
    expect(new Set(buffers).size).toBe(buffers.length)
  })

  it('非空数据包同样完整收集其底层缓冲', () => {
    // 构造带真实数据的非空缓冲，验证非 0 字节 ArrayBuffer 也被正确收录。
    const packet: RenderPacket = {
      nodeInstances: {
        node: { count: 1, matrices: new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]) },
        work: { count: 0, matrices: new Float32Array(0) },
        charge: { count: 0, matrices: new Float32Array(0) },
        park: { count: 0, matrices: new Float32Array(0) },
      },
      pathGeometry: {
        positions: new Float32Array([0, 0, 0, 1, 0, 0]),
        normals: new Float32Array([0, 1, 0, 0, 1, 0]),
        pathU: new Float32Array([0, 1]),
        flowDirections: new Float32Array([1, 1]),
        indices: new Uint32Array([0, 1, 2]),
        edgeVertexRanges: new Uint32Array([0, 2]),
      },
      renderBounds: { min: [0, 0, 0], max: [1, 0, 0] },
      report: { nodeCount: 1, edgeLaneCount: 1, bidirectionalGroupCount: 0, unpairedEdgeCount: 1 },
    }
    const buffers = collectPacketTransferables(packet)
    expect(buffers).toContain(packet.nodeInstances.node.matrices.buffer)
    expect(buffers).toContain(packet.pathGeometry.positions.buffer)
    expect(buffers).toContain(packet.pathGeometry.indices.buffer)
    expect(new Set(buffers).size).toBe(buffers.length)
  })
})
