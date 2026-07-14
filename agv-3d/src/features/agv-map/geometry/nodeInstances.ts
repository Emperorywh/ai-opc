import type { RawNodeType } from '../domain/rawDto'
import type { MapNode } from '../domain/domainModel'
import type { CompiledNodeInstances, NodeInstancePacket } from '../domain/renderPacket'
import type { NodeDimensions, NodeDimensionsConfig } from '../config/geometryConfig'
import type { MapSpace } from './worldCoords'
import { mapToWorld } from './worldCoords'

// 节点实例包契约（NodeInstancePacket、CompiledNodeInstances）已上移至 domain 层
// （SPEC §5.1 依赖方向），使应用层加载状态机能持有渲染数据包而无需反向依赖 geometry。
// 此处重新导出以保持 geometry 公共 API 稳定，下游仍可从本模块按需引用类型。
export type { CompiledNodeInstances, NodeInstancePacket }

/**
 * 节点实例编译（SPEC §7.2、§6.2）。
 *
 * 不变量：
 * - 纯函数：相同节点、地图空间与配置产生字节级稳定的实例矩阵，不读取系统时间、
 *   随机源、相机或任何展示状态（SPEC §7.1）。
 * - 尺寸不进矩阵：几何模型以原点为中心按配置尺寸构建，矩阵只编码平移与绕 Y 旋转，
 *   不编码缩放（SPEC §7.2）。底部位于地面、中心 Y 等于自身几何半高。
 * - 朝向约定：方向性节点模型 +X 为前向，矩阵使用 rotationY = angle；由于世界映射
 *   z = −y，rotationY 后模型 +X 恰好指向地图角度对应的世界方向（SPEC §6.2）。
 *   普通节点（type === 'node'）无方向性，旋转恒为 0，角度不影响放置。
 * - 类型分组稳定：按固定类型顺序（node、work、charge、park）输出，组内保持输入顺序，
 *   保证实例下标确定、可复现。
 */

/** 每个 4×4 实例矩阵的浮点分量数（Three.js Matrix4 列主序）。 */
export const NODE_MATRIX_FLOATS = 16

/**
 * 节点放置结果：世界空间中心、绕 Y 轴旋转角与该类型尺寸。
 *
 * 作为矩阵编译与渲染边界计算的单一数据源，避免两处重复推导放置逻辑；
 * directional 标记区分方向性节点（参与角度旋转）与普通节点（恒等旋转）。
 */
export interface NodePlacement {
  /** 世界空间 X（地面），单位米。 */
  readonly worldX: number
  /** 世界空间 Y（高度），等于自身几何半高，单位米。 */
  readonly worldY: number
  /** 世界空间 Z（地面），单位米。 */
  readonly worldZ: number
  /** 绕世界 Y 轴的旋转角（弧度），方向性节点为原始 angle，普通节点恒为 0。 */
  readonly rotationY: number
  /** 该类型包围盒尺寸。 */
  readonly dimensions: NodeDimensions
  /** 是否为方向性节点（work/charge/park）。 */
  readonly directional: boolean
}

/** 固定类型遍历顺序，保证输出与实例下标字节级稳定。 */
const NODE_TYPE_ORDER: readonly RawNodeType[] = ['node', 'work', 'charge', 'park']

/**
 * 把全部节点按类型编译为一次性、确定性的实例矩阵集合。
 *
 * 算法步骤：
 * 1. 按类型分桶，桶内保持输入顺序，保证相同输入产生相同实例下标。
 * 2. 每个节点计算世界放置（共享 computeNodePlacement），写入列主序 4×4 TR 矩阵。
 * 3. 每类型产出 { count, matrices }，矩阵数组长度恒为 count × 16。
 */
export function compileNodeInstances(
  nodes: readonly MapNode[],
  space: MapSpace,
  config: NodeDimensionsConfig,
): CompiledNodeInstances {
  const byType: Record<RawNodeType, MapNode[]> = { node: [], work: [], charge: [], park: [] }
  for (const node of nodes) {
    byType[node.type].push(node)
  }

  const result = {} as CompiledNodeInstances
  for (const type of NODE_TYPE_ORDER) {
    const typed = byType[type]
    const matrices = new Float32Array(typed.length * NODE_MATRIX_FLOATS)
    for (let i = 0; i < typed.length; i += 1) {
      const placement = computeNodePlacement(typed[i], space, config)
      writeNodeMatrix(matrices, i * NODE_MATRIX_FLOATS, placement)
    }
    result[type] = { count: typed.length, matrices }
  }
  return result
}

/**
 * 计算单个节点的世界放置（矩阵编译与渲染边界计算的共享逻辑）。
 *
 * 坐标约定（SPEC §6.1、§6.2）：
 * - world = (x − centerX, height, −(y − centerY))；height 取自身几何半高使底部贴地。
 * - 方向性节点 rotationY = angle；普通节点 angle 为 null，rotationY = 0。
 *
 * 边界条件：上游校验保证普通节点 angle === null、方向性节点 angle 为有限弧度
 * （SPEC §4.4），此处对 null 做保守兜底（视作 0），不引入额外校验分支。
 */
export function computeNodePlacement(
  node: MapNode,
  space: MapSpace,
  config: NodeDimensionsConfig,
): NodePlacement {
  const dimensions = config.byType[node.type]
  const directional = node.type !== 'node'
  const world = mapToWorld(node.position, space)
  return {
    worldX: world.x,
    worldY: dimensions.sizeYM / 2,
    worldZ: world.z,
    rotationY: directional && node.angle !== null ? node.angle : 0,
    dimensions,
    directional,
  }
}

/**
 * 把放置结果写入列主序 4×4 TR 矩阵（SPEC §6.2 rotationY = angle）。
 *
 * Three.js Matrix4 列主序：列 0 = (cos,0,−sin,0)、列 1 = (0,1,0,0)、
 * 列 2 = (sin,0,cos,0)、列 3 = (tx,ty,tz,1)。模型 +X 经此矩阵映射到
 * (cosθ,0,−sinθ)，恰好等于地图角度 θ 对应的世界前向（SPEC §6.2）。
 */
function writeNodeMatrix(out: Float32Array, offset: number, p: NodePlacement): void {
  const cos = Math.cos(p.rotationY)
  const sin = Math.sin(p.rotationY)
  out[offset + 0] = cos
  out[offset + 1] = 0
  out[offset + 2] = -sin
  out[offset + 3] = 0
  out[offset + 4] = 0
  out[offset + 5] = 1
  out[offset + 6] = 0
  out[offset + 7] = 0
  out[offset + 8] = sin
  out[offset + 9] = 0
  out[offset + 10] = cos
  out[offset + 11] = 0
  out[offset + 12] = p.worldX
  out[offset + 13] = p.worldY
  out[offset + 14] = p.worldZ
  out[offset + 15] = 1
}
