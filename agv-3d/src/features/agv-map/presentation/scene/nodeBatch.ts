import type { RawNodeType } from '../../domain/rawDto'
import type { NodeInstancePacket } from '../../domain/renderPacket'

/**
 * 节点批次契约（SPEC §7.2、§11.1，TASK-009）。
 *
 * 把 NodeLayer 组件所需的两项"非组件"契约——固定四类批次顺序与渲染数据包自洽校验——
 * 抽离到独立模块，使 NodeLayer.tsx 仅导出组件，满足 React Fast Refresh 对组件文件的
 * only-export-components 约束；同时使批次数量与数据自洽校验可作为纯函数单独验证。
 */

/** 每个 4×4 实例矩阵的浮点分量数（与 geometry 层 NODE_MATRIX_FLOATS 对齐，Three.js Matrix4 列主序）。 */
const MATRIX_FLOATS = 16

/**
 * 固定四类节点遍历顺序：恰好对应 SPEC §11.1 的"节点 DrawCall 4"批次数量，
 * 顺序确定使实例下标与渲染顺序可复现。导出供批次数量自动化验证（TASK-009）。
 */
export const NODE_BATCH_TYPES: readonly RawNodeType[] = ['node', 'work', 'charge', 'park']

/**
 * 校验单类型节点实例包的数据自洽性（TASK-009 异常路径）。
 *
 * 编译层（nodeInstances）天然保证 matrices.length === count × 16；此处的防御性校验覆盖
 * RenderPacket 跨 Worker 转移或反序列化损坏的极端情形。出现不一致时抛 RangeError，
 * 由展示层 SceneErrorBoundary 捕获并接入既有错误链（notifySceneCreateFailed），而非继续
 * 上传越界 NaN 矩阵静默展示半批节点（SPEC §10.2 "不跳过坏记录"）。
 *
 * @param packet 单类型实例包。
 * @param type   节点类型，仅用于错误定位信息。
 */
export function assertNodeInstancePacket(packet: NodeInstancePacket, type: RawNodeType): void {
  if (!Number.isInteger(packet.count) || packet.count < 0) {
    throw new RangeError(`节点实例包 ${type} count 非法: ${packet.count}`)
  }
  const expected = packet.count * MATRIX_FLOATS
  if (packet.matrices.length !== expected) {
    throw new RangeError(
      `节点实例包 ${type} 矩阵长度 ${packet.matrices.length} 与 count×16=${expected} 不一致`,
    )
  }
}
