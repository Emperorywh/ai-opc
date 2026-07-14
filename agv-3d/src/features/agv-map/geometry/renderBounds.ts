import type { MapNode } from '../domain/domainModel'
import type { Bounds3Data } from '../domain/renderPacket'
import type { NodeDimensionsConfig } from '../config/geometryConfig'
import type { MapSpace } from './worldCoords'
import { GeometryCompileError } from './pathSampling'
import { computeNodePlacement } from './nodeInstances'

// 渲染边界契约 Bounds3Data 已上移至 domain 层（SPEC §5.1 依赖方向），此处重新导出
// 以保持 geometry 公共 API 稳定。
export type { Bounds3Data }

/**
 * 最终渲染边界计算（SPEC §5.2 Bounds3Data、§6.3）。
 *
 * 不变量：
 * - 纯函数：相同节点、地图空间、尺寸配置与路径顶点产生字节级稳定的边界，
 *   不读取系统时间、随机源或展示状态（SPEC §7.1）。
 * - 边界完整：必须包含全部节点尺寸、扁带宽度和双车道偏移，不只依据节点坐标
 *   （SPEC §6.3、TASK-005）。节点贡献为中心 ± 旋转后 XZ 半 extents、Y ∈ [0, sizeYM]；
 *   路径顶点已含扁带展开与车道偏移，直接并入 AABB。
 * - 世界空间：输出为世界 XZ 地面 + Y 高度的 3D AABB，供相机 framing、雾效、阴影与
 *   反射地面范围统一推导（SPEC §6.3、§9.1、§8.4）。
 */

/**
 * 在几何编译完成后重新计算渲染边界（SPEC §6.3）。
 *
 * 节点与路径顶点同时为空属于上游契约错误（V76 基线 1768 节点），此时抛出几何错误，
 * 不返回半成品边界；任一非空即按联合包围盒计算。
 *
 * @param nodes 全部规范化节点（用于中心与尺寸贡献）。
 * @param space 地图空间基准（节点坐标映射到世界）。
 * @param nodeConfig 节点尺寸配置（各类包围盒尺寸）。
 * @param pathPositions 已编译路径扁带的全部世界空间顶点，每 3 个分量为一组 (x,y,z)。
 */
export function computeRenderBounds(
  nodes: readonly MapNode[],
  space: MapSpace,
  nodeConfig: NodeDimensionsConfig,
  pathPositions: Float32Array,
): Bounds3Data {
  let minX = Number.POSITIVE_INFINITY
  let minY = Number.POSITIVE_INFINITY
  let minZ = Number.POSITIVE_INFINITY
  let maxX = Number.NEGATIVE_INFINITY
  let maxY = Number.NEGATIVE_INFINITY
  let maxZ = Number.NEGATIVE_INFINITY
  let hasAny = false

  // 节点贡献：中心 ± 旋转后 XZ 半 extents；Y 底部贴地、顶部为 sizeYM。
  for (const node of nodes) {
    const p = computeNodePlacement(node, space, nodeConfig)
    // 绕 Y 旋转的 XZ 包围盒半 extents：|cos|、|sin| 交叉相加。
    const hxBase = p.dimensions.sizeXM / 2
    const hzBase = p.dimensions.sizeZM / 2
    const cos = Math.abs(Math.cos(p.rotationY))
    const sin = Math.abs(Math.sin(p.rotationY))
    const halfX = hxBase * cos + hzBase * sin
    const halfZ = hxBase * sin + hzBase * cos
    // 中心 Y = sizeYM/2，故底部 = 0、顶部 = sizeYM。
    const bottomY = p.worldY - p.dimensions.sizeYM / 2
    const topY = p.worldY + p.dimensions.sizeYM / 2

    hasAny = true
    if (p.worldX - halfX < minX) minX = p.worldX - halfX
    if (p.worldX + halfX > maxX) maxX = p.worldX + halfX
    if (p.worldZ - halfZ < minZ) minZ = p.worldZ - halfZ
    if (p.worldZ + halfZ > maxZ) maxZ = p.worldZ + halfZ
    if (bottomY < minY) minY = bottomY
    if (topY > maxY) maxY = topY
  }

  // 路径贡献：顶点已含扁带宽度和车道偏移，直接取 AABB，无需额外展开。
  for (let i = 0; i < pathPositions.length; i += 3) {
    const x = pathPositions[i]
    const y = pathPositions[i + 1]
    const z = pathPositions[i + 2]
    hasAny = true
    if (x < minX) minX = x
    if (x > maxX) maxX = x
    if (y < minY) minY = y
    if (y > maxY) maxY = y
    if (z < minZ) minZ = z
    if (z > maxZ) maxZ = z
  }

  if (!hasAny) {
    throw new GeometryCompileError(
      'EMPTY_COMPUTE_BOUNDS',
      '渲染边界计算缺少任何节点或路径顶点',
    )
  }

  return {
    min: [minX, minY, minZ],
    max: [maxX, maxY, maxZ],
  }
}
