import type { MapModel } from '../domain/domainModel'
import type {
  LaneGroupingConfig,
  NodeDimensionsConfig,
  PathRibbonConfig,
  SamplingConfig,
} from '../config/geometryConfig'
import type { PathGeometryPacket } from './pathRibbon'
import { compilePathGeometry } from './pathRibbon'
import { sampleEdges } from './pathSampling'
import { groupLanes } from './laneGrouping'
import { computeMapSpace } from './worldCoords'
import type { CompiledNodeInstances } from './nodeInstances'
import { compileNodeInstances } from './nodeInstances'
import type { Bounds3Data } from './renderBounds'
import { computeRenderBounds } from './renderBounds'

/**
 * 场景编译编排（SPEC §5.2、§7.1）。
 *
 * 不变量：
 * - 纯函数：相同模型与配置产生字节级稳定的 RenderPacket，不读取系统时间、
 *   随机源或展示状态（SPEC §7.1）。内部串联的采样、分组、扁带、节点与边界
 *   编译均为纯函数，本编排只负责按确定顺序组装。
 * - 单次一致性：节点位置、路径顶点、渲染边界与编译统计同源于一次编译过程，
 *   不存在二次派生或外部状态注入；RenderPacket 内 TypedArray 可直接转移
 *   给主线程，大地图交接不复制缓冲（SPEC §5.2、TASK-005）。
 * - 边界后置：renderBounds 在路径与节点几何编译完成后计算，确保完整包含
 *   节点尺寸、扁带宽度和车道偏移（SPEC §6.3）。
 */

/**
 * 编译统计报告（SPEC §5.2 CompilationReport）。
 * 数值来自本次编译的模型与车道分组，稳定且与 RenderPacket 其余部分同源。
 */
export interface CompilationReport {
  /** 节点总数（V76 基线 1768）。 */
  readonly nodeCount: number
  /** 有向车道记录总数（V76 基线 3045）。 */
  readonly edgeLaneCount: number
  /** 双向车道组数（V76 基线 998）。 */
  readonly bidirectionalGroupCount: number
  /** 未配对单向边数（V76 基线 1049）。 */
  readonly unpairedEdgeCount: number
}

/**
 * 完整渲染数据包（SPEC §5.2 RenderPacket）。
 *
 * 全部 TypedArray 可转移；不包含 Three.js 类实例。nodeInstances 按类型索引，
 * pathGeometry 为合并后的单一扁带，renderBounds 为世界空间 3D AABB。
 */
export interface RenderPacket {
  readonly nodeInstances: CompiledNodeInstances
  readonly pathGeometry: PathGeometryPacket
  readonly renderBounds: Bounds3Data
  readonly report: CompilationReport
}

/** 场景编译所需的全部配置，按职责集中传入。 */
export interface SceneCompileConfigs {
  readonly sampling: SamplingConfig
  readonly laneGrouping: LaneGroupingConfig
  readonly ribbon: PathRibbonConfig
  readonly nodeDimensions: NodeDimensionsConfig
}

/**
 * 把规范化地图模型一次性编译为完整渲染数据包。
 *
 * 数据流（SPEC §5.2）：
 * 采样有向边 → 车道分组 → 联合中心 → 路径扁带 + 节点实例 → 渲染边界 → 统计报告。
 * 任一子步骤抛出的几何编译错误向上传播，由加载状态机映射为 GEOMETRY_COMPILE_FAILED。
 */
export function compileRenderPacket(
  model: MapModel,
  configs: SceneCompileConfigs,
): RenderPacket {
  const sampled = sampleEdges(model.edges, configs.sampling)
  const groups = groupLanes(sampled, configs.laneGrouping)
  const space = computeMapSpace(
    model.nodes.map((n) => n.position),
    sampled.map((s) => s.path),
  )

  const compiledPath = compilePathGeometry(
    groups,
    space,
    configs.ribbon,
    configs.laneGrouping,
  )
  const nodeInstances = compileNodeInstances(model.nodes, space, configs.nodeDimensions)
  const renderBounds = computeRenderBounds(
    model.nodes,
    space,
    configs.nodeDimensions,
    compiledPath.geometry.positions,
  )

  let edgeLaneCount = 0
  let bidirectionalGroupCount = 0
  let unpairedEdgeCount = 0
  for (const group of groups) {
    edgeLaneCount += group.lanes.length
    if (group.kind === 'bidirectional') {
      bidirectionalGroupCount += 1
    } else {
      unpairedEdgeCount += 1
    }
  }

  return {
    nodeInstances,
    pathGeometry: compiledPath.geometry,
    renderBounds,
    report: {
      nodeCount: model.nodes.length,
      edgeLaneCount,
      bidirectionalGroupCount,
      unpairedEdgeCount,
    },
  }
}
