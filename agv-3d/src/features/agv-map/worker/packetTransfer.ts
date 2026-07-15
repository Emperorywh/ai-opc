import type { RenderPacket } from '../domain/renderPacket'

/**
 * 渲染数据包的可转移 ArrayBuffer 收集（SPEC §5.4、TASK-007）。
 *
 * Worker 在 postMessage 成功事件时，把数据包内全部大块 TypedArray 的底层 ArrayBuffer
 * 所有权一次性转移给主线程，避免结构化克隆复制约 6.5 MB 地图编译产物，实现零拷贝交接。
 *
 * 不变量：
 * - 完整覆盖：数据包内每个参与渲染的 TypedArray 的底层 ArrayBuffer 都被收录。
 *   遗漏任一字段会使该缓冲被结构化克隆（仍可用但不满足零拷贝契约），因此以显式枚举方式
 *   收集而非遍历对象键——新增字段时此处为唯一必须同步修改的位置，编译期即可发现。
 * - 互不重叠：几何编译为每个 TypedArray 独立分配 ArrayBuffer，彼此不共享底层缓冲，
 *   故转移列表不含重复引用（重复转移同一 ArrayBuffer 会触发 DataCloneError）。
 * - 只转缓冲：renderBounds / report 等纯值字段由结构化克隆携带，开销可忽略，不进入转移列表。
 *
 * 依赖方向（SPEC §5.1）：位于 worker 层，仅依赖 domain 的 RenderPacket 类型；
 * 返回 ArrayBuffer[] 而非 Transferable[]，使该纯函数不绑定浏览器专用类型，可在 Node 直接单测。
 * Worker 入口调用 postMessage 时把结果作为 Transferable[] 传入（ArrayBuffer 是 Transferable）。
 */

/**
 * 收集渲染数据包内全部应零拷贝转移的 ArrayBuffer。
 * 顺序无业务含义，仅保持稳定以便测试断言。
 */
export function collectPacketTransferables(packet: RenderPacket): ArrayBuffer[] {
  return [
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
}
