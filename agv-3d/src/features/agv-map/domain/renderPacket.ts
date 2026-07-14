import type { RawNodeType } from './rawDto'

/**
 * 渲染数据包契约（SPEC §5.2）。
 *
 * 该模块定义 Worker 几何编译产物与主线程渲染消费方之间的纯数据契约。全部字段为可转移的
 * TypedArray 或不可变元数据，不包含 Three.js 类实例，因此可安全跨 Worker 边界转移，
 * 也可被应用层加载状态机直接持有而不引入对 Three.js 的依赖。
 *
 * 依赖方向（SPEC §5.1）：该模块位于 domain 层，geometry / application / worker /
 * presentation 均单向依赖此处。此前 RenderPacket 及其子结构散落于 geometry 各模块，
 * TASK-006 将其收敛到 domain，使应用层状态机能引用渲染数据包而无需反向依赖 geometry，
 * 消除跨层耦合。geometry 各模块改为从此处导入同一契约。
 */

/**
 * 单类型节点实例包（SPEC §5.2 NodeInstancePacket）。
 *
 * matrices 为可转移的 Float32Array，每实例连续 16 个分量构成一个列主序 4×4 矩阵，
 * 供主线程 InstancedMesh.setMatrixAt 直接消费。显式声明为 ArrayBuffer 支撑：
 * 编译产物恒由 `new Float32Array(n)` 构造，底层是普通 ArrayBuffer（非 SharedArrayBuffer），
 * 因此其 buffer 可直接进入 postMessage 的 transfer 列表（SPEC §5.4 零拷贝转移）。
 */
export interface NodeInstancePacket {
  readonly count: number
  readonly matrices: Float32Array<ArrayBuffer>
}

/** 四类节点的实例包集合，键为节点类型（SPEC §5.2 RenderPacket.nodeInstances 字段）。 */
export type CompiledNodeInstances = Record<RawNodeType, NodeInstancePacket>

/**
 * 路径几何包（SPEC §5.2 PathGeometryPacket）。
 *
 * positions / normals 每顶点 3 个分量，pathU / flowDirections 每顶点 1 个分量，
 * indices 为三角形顶点索引，edgeVertexRanges 按车道顺序成对存储 [startVertex, endVertex)。
 * 全部为可转移 TypedArray（ArrayBuffer 支撑），不包含 Three.js 类实例。
 */
export interface PathGeometryPacket {
  readonly positions: Float32Array<ArrayBuffer>
  readonly normals: Float32Array<ArrayBuffer>
  readonly pathU: Float32Array<ArrayBuffer>
  readonly flowDirections: Float32Array<ArrayBuffer>
  readonly indices: Uint32Array<ArrayBuffer>
  readonly edgeVertexRanges: Uint32Array<ArrayBuffer>
}

/**
 * 编译统计报告（SPEC §5.2 CompilationReport）。
 * 数值来自一次编译的模型与车道分组，稳定且与 RenderPacket 其余部分同源。
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
 * 三维渲染边界（SPEC §5.2 Bounds3Data）。世界空间轴对齐包围盒，单位米。
 * min / max 为 [x, y, z] 三元组；min 分量不大于对应 max 分量。
 */
export interface Bounds3Data {
  readonly min: readonly [number, number, number]
  readonly max: readonly [number, number, number]
}

/**
 * 完整渲染数据包（SPEC §5.2 RenderPacket）。
 *
 * 全部 TypedArray 可转移；不包含 Three.js 类实例。nodeInstances 按类型索引，
 * pathGeometry 为合并后的单一扁带，renderBounds 为世界空间 3D AABB，
 * report 为编译统计。应用层加载状态机在 preparing 与 ready 状态中持有该数据包。
 */
export interface RenderPacket {
  readonly nodeInstances: CompiledNodeInstances
  readonly pathGeometry: PathGeometryPacket
  readonly renderBounds: Bounds3Data
  readonly report: CompilationReport
}

/**
 * 几何编译进度报告（SPEC §10.1 节点/路径编译进度映射）。
 *
 * 纯几何函数在处理节点与边时可选择通过该结构向上报告已处理记录数，
 * 供后台编译流程把真实处理进度映射到状态机的 compiling-nodes（40%～55%）
 * 与 compiling-paths（55%～90%）区间。该结构为纯数据，不携带回调或副作用，
 * 保持在 domain 层以避免 geometry/application 反向依赖。
 *
 * phase 顺序固定为 nodes 在前、paths 在后，与状态机阶段顺序一致；
 * 调用方据此决定何时从 compiling-nodes 跃迁到 compiling-paths。
 */
export interface CompileProgressReport {
  readonly phase: 'nodes' | 'paths'
  readonly processed: number
  readonly total: number
}
