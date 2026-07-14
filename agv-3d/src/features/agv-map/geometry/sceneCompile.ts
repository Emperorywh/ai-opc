import type { MapModel } from '../domain/domainModel'
import type { CompileProgressReport, RenderPacket } from '../domain/renderPacket'
import type {
  LaneGroupingConfig,
  NodeDimensionsConfig,
  PathRibbonConfig,
  SamplingConfig,
} from '../config/geometryConfig'
import { compilePathGeometry } from './pathRibbon'
import { sampleEdges } from './pathSampling'
import { groupLanes } from './laneGrouping'
import { computeMapSpace } from './worldCoords'
import { compileNodeInstances } from './nodeInstances'
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
 *
 * RenderPacket 与 CompilationReport 契约已上移至 domain 层（SPEC §5.1），
 * 应用层加载状态机据此持有渲染数据包而无需反向依赖 geometry。
 *
 * 进度顺序：节点编译在路径扁带编译之前报告，使后台编译流程能按状态机阶段顺序
 * （compiling-nodes → compiling-paths）映射真实处理记录数（SPEC §10.1）。
 * 采样与车道分组是共享前置（决定联合中心，二者都依赖），不计入可报告进度阶段。
 * 节点与扁带编译互不读写共享可变状态，调换顺序不改变输出字节。
 */

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
 * 采样有向边 → 车道分组 → 联合中心 → 节点实例 + 路径扁带 → 渲染边界 → 统计报告。
 * 任一子步骤抛出的几何编译错误向上传播，由加载状态机映射为 GEOMETRY_COMPILE_FAILED。
 *
 * 可选 onProgress 透传给节点与扁带编译，按 nodes → paths 顺序报告已处理记录数，
 * 供后台编译把真实处理进度映射到状态机 compiling-nodes 与 compiling-paths 区间。
 */
export function compileRenderPacket(
  model: MapModel,
  configs: SceneCompileConfigs,
  onProgress?: (report: CompileProgressReport) => void,
): RenderPacket {
  // 共享前置：采样与车道分组决定联合中心，节点与扁带均依赖该中心（SPEC §6.3）。
  const sampled = sampleEdges(model.edges, configs.sampling)
  const groups = groupLanes(sampled, configs.laneGrouping)
  const space = computeMapSpace(
    model.nodes.map((n) => n.position),
    sampled.map((s) => s.path),
  )

  // 节点编译先于路径扁带报告进度，匹配状态机 compiling-nodes → compiling-paths 顺序。
  const nodeInstances = compileNodeInstances(model.nodes, space, configs.nodeDimensions, onProgress)
  const compiledPath = compilePathGeometry(
    groups,
    space,
    configs.ribbon,
    configs.laneGrouping,
    onProgress,
  )
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
