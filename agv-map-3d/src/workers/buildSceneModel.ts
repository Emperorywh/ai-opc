/*
 * 可转移且自校验的场景模型汇总（workers 层，SPEC 4.1 / 5.2 / 6 / 7.1 / 8 / 9 / 10 / 11.2 / 12.1 / 14.2 / 15.3 / 16）。
 *
 * 信任边界定位（TASK-012）：
 *   - 本模块是 SceneMap → SceneModel 的唯一汇总入口：把 TASK-005～TASK-011 已分别构建并自校验的
 *     领域地图、车道模型、ribbon、节点 / 两类箭头实例数据与标签描述符，汇总为后续 worker 传输、
 *     渲染资源、相机 fit 与标签可见集唯一消费的不可变场景模型。
 *   - worker 在独立线程调用本模块后通过 postMessage 把 ArrayBuffer 转移给主线程；
 *     本模块只建立传输契约（typed array 所有权与可转移缓冲区集合），不执行跨线程传输。
 *   - 纯数值与不可变描述符：不创建 Three / R3F / React / 浏览器对象，也不读写全局可变状态。
 *
 * 唯一消费不变量（SPEC 4.1 / 任务约束）：
 *   - 后续箭头、标签可见集、camera fit 与渲染资源都只消费本 SceneModel；
 *     任何模块都不得再回读领域节点 / 领域边 / 原始 JSON 推导第二套几何。
 *   - 汇总阶段不再做第二次坐标转换或颜色转换：坐标已在适配层一次性映射（SPEC 6.1 / 6.2），
 *     颜色已在 geometry 层一次性线性化（SPEC 5.2 / 7.3）；本模块只搬运最终 typed array、
 *     合并真实几何 bounds 与组装诊断计数，不存在第二套坐标 / 颜色来源。
 *
 * 数组交叉校验不变量（SPEC 5.2 / 任务约束）：
 *   - 矩阵数组长度 = 实例数 × 16、颜色数组长度 = 实例数 × 3、
 *     ribbon position / color 长度 = ribbonVertexCount × 3。
 *   - 所有矩阵保持 Three Matrix4 兼容列主序（平移位于索引 12 / 13 / 14），
 *     由各 geometry 子系统保证；本层只校验总长度与诊断计数一致，不重复校验单个矩阵布局。
 *   - 所有颜色保持线性 sRGB [0, 1] 浮点；标签描述符数量 = labelCandidateCount。
 *
 * 内容范围不变量（SPEC 12.1 / 任务约束）：
 *   - contentBounds 必须覆盖 lane offset 后的 ribbon、两类箭头与节点圆柱的真实几何范围，
 *     不得只使用节点坐标，也不得纳入标签锚点或 Ground。
 *   - 节点圆柱范围从最终节点实例矩阵推导（平移位于索引 12 / 14，半径位于索引 0 / 10），
 *     不回读领域节点，保证节点几何的唯一事实来源是实例矩阵而非第二套派生。
 *
 * 整体拒绝不变量（SPEC 16 / 任务约束）：
 *   - 任一数组长度、诊断计数、数值有限性、bounds 顺序或元数据不一致时立即拒绝整个模型，
 *     不修剪、不补零、不输出部分场景。
 *   - 失败抛出 MAP_GEOMETRY_INVALID 结构化错误；调用方（worker）不得把部分模型提交给主线程。
 *
 * 依赖方向（SPEC 3.3）：仅依赖 domain（SceneMap / NumericBox3 / MapTransform / SceneMapMetadata /
 *   MapDataError）、geometry（buildTrackModel / buildRibbonGeometry / buildNodeInstanceData /
 *   buildNodeArrowData / buildEdgeArrowData）与 labels（buildLabelDescriptors / LabelDescriptor）。
 */
import { MapDataError, MapErrorCode } from '../domain/mapDataError'
import type {
  MapTransform,
  NumericBox3,
  SceneMap,
  SceneMapMetadata,
} from '../domain/sceneMap'
import { buildTrackModel } from '../geometry/buildTrackModel'
import { buildRibbonGeometry } from '../geometry/ribbonGeometry'
import { buildNodeInstanceData } from '../geometry/nodeInstanceData'
import { buildNodeArrowData } from '../geometry/nodeArrowData'
import { buildEdgeArrowData } from '../geometry/edgeArrowData'
import { buildLabelDescriptors } from '../labels/buildLabelDescriptors'
import type { LabelDescriptor } from '../labels/labelDescriptor'

/*
 * SPEC 7.1：节点圆柱 Y 范围（米）。共享基准圆柱高度 0.05、实例中心 Y 0.035，
 * 故底面 0.010、顶面 0.060。该值用于节点圆柱 contentBounds 贡献的 Y 分量，
 * 只表达“节点圆柱真实几何范围”，不进入 config 或被组件直接读取。
 * 与 nodeInstanceData / config 同源 SPEC 7.1，各层各自引用同一规格，不形成第二套语义。
 */
const NODE_BOTTOM_Y = 0.010
const NODE_TOP_Y = 0.060

/*
 * 颜色 [0, 1] 边界校验容差（Float32 舍入保护）。
 * 线性 sRGB 颜色恒在 [0, 1]；Float32 表示在精确边界处可能有末位抖动，故用小容差避免误报，
 * 同时仍能拒绝 NaN / 超范围等真正非法的颜色值。
 */
const COLOR_RANGE_EPSILON = 1e-6

/*
 * 几何层逻辑路径前缀：场景模型汇总错误发生在已构建的最终数据上，不对应原始 JSON path。
 * 用稳定逻辑路径标识失败集合，使测试与诊断可定位，同时不伪造原始响应路径。
 */
const SCENE_MODEL_LOGICAL_PATH = 'sceneModel'

/*
 * 场景诊断只读快照（SPEC 5.2 SceneDiagnostics / 14.2）。
 *
 * 字段语义：
 *   - nodeCount：节点实例数（= 节点总数，真实样本 1767）。
 *   - nodeArrowCount：节点朝向箭头实例数（非普通节点数，真实样本 464）。
 *   - edgeArrowCount：边方向箭头实例数（每条边一个，真实样本 3043）。
 *   - ribbonVertexCount：ribbon 非索引顶点数（真实样本 48669，由实际三角化结果给出）。
 *   - labelCandidateCount：标签候选总数（节点数 + 边数，真实样本 4810）。
 *   - pairedTrackCount：精确反向双车道组数（真实样本 979）。
 *
 * 计数不变量：每个计数都与对应 typed array 长度交叉一致，由 validateSceneModel 强制。
 * 诊断是只读快照：不持有 mutable Three 对象，也不被渲染逻辑直接消费来改变绘制行为。
 */
export interface SceneDiagnostics {
  readonly nodeCount: number
  readonly nodeArrowCount: number
  readonly edgeArrowCount: number
  readonly ribbonVertexCount: number
  readonly labelCandidateCount: number
  readonly pairedTrackCount: number
}

/*
 * 不可变场景模型（SPEC 5.2 SceneModel）—— worker 交付给渲染层的唯一结果。
 *
 * 字段语义（SPEC 5.2 / 6.2 / 12.1）：
 *   - metadata：可追溯地图元数据（mapId / mapName / version），来自 TASK-005 的不可变领域元数据。
 *   - transform：显式场景原点（absoluteWorldOriginX / Z），来自 TASK-005 由 source bounds 派生；
 *     供可逆定位与诊断，不形成第二套坐标来源。
 *   - nodeMatrices / nodeColors：节点本体实例矩阵（count × 16）与线性颜色（count × 3）。
 *   - nodeArrowMatrices / nodeArrowColors：节点朝向箭头实例矩阵与线性颜色。
 *   - edgeArrowMatrices / edgeArrowColors：边方向箭头实例矩阵与线性颜色。
 *   - ribbonPositions / ribbonColors：合并后 ribbon 非索引顶点坐标与顶点颜色（vertexCount × 3）。
 *   - labels：全部标签描述符（节点 + 边），与渲染技术无关的轻量描述符。
 *   - contentBounds：合并 ribbon / 两类箭头 / 节点圆柱真实几何后的数值内容范围，排除标签与 Ground。
 *   - diagnostics：只读诊断快照，与各数组长度交叉校验。
 *
 * 所有权不变量（SPEC 4.1 / 4.3 / 任务约束）：
 *   - typed array 的底层 ArrayBuffer 通过 collectTransferableBuffers 枚举后由 worker 转移；
 *     转移后 worker 不得再次访问。本结构不携带原始 DTO、未消费业务字段、Three 对象、
 *     React 状态、隐藏缓存或可变全局引用。
 *   - labels 是普通 JS 描述符，随结构化克隆传递，不进入可转移缓冲区集合。
 */
export interface SceneModel {
  readonly metadata: SceneMapMetadata
  readonly transform: MapTransform
  readonly nodeMatrices: Float32Array
  readonly nodeColors: Float32Array
  readonly nodeArrowMatrices: Float32Array
  readonly nodeArrowColors: Float32Array
  readonly edgeArrowMatrices: Float32Array
  readonly edgeArrowColors: Float32Array
  readonly ribbonPositions: Float32Array
  readonly ribbonColors: Float32Array
  readonly labels: readonly LabelDescriptor[]
  readonly contentBounds: NumericBox3
  readonly diagnostics: SceneDiagnostics
}

/*
 * 构造场景模型汇总错误（SPEC 14.1 MAP_GEOMETRY_INVALID）。
 * 整体拒绝，不返回部分模型；message 含可读中文，便于 overlay 与测试匹配。
 */
function sceneModelError(
  message: string,
  context?: Readonly<Record<string, unknown>>,
): MapDataError {
  return new MapDataError({
    code: MapErrorCode.MAP_GEOMETRY_INVALID,
    message,
    jsonPath: SCENE_MODEL_LOGICAL_PATH,
    context,
  })
}

/*
 * 从最终节点实例矩阵推导节点圆柱真实几何 bounds（SPEC 12.1 / 8.1）。
 *
 * 节点圆柱范围只读最终实例矩阵，不回读领域节点，保证节点几何唯一事实来源是实例矩阵：
 *   - X 半径 = 矩阵索引 0（X 缩放 = 节点半径）；X 范围 = [tx - rX, tx + rX]，tx = 索引 12。
 *   - Z 半径 = 矩阵索引 10（Z 缩放 = 节点半径）；Z 范围 = [tz - rZ, tz + rZ]，tz = 索引 14。
 *   - Y 范围恒为 SPEC 7.1 节点底面 / 顶面（实例中心 Y 不被缩放，所有节点共享基准高度）。
 *
 * nodeCount = 0 时返回退化 bounds（min > max），由 validateSceneModel 捕获并整体拒绝，
 * 不在此处隐式补默认值。
 */
function computeNodeCylinderBounds(
  matrices: Float32Array,
  nodeCount: number,
): NumericBox3 {
  let minX = Number.POSITIVE_INFINITY
  let minZ = Number.POSITIVE_INFINITY
  let maxX = Number.NEGATIVE_INFINITY
  let maxZ = Number.NEGATIVE_INFINITY
  for (let i = 0; i < nodeCount; i++) {
    const m = i * 16
    const tx = matrices[m + 12]
    const tz = matrices[m + 14]
    const radiusX = matrices[m + 0]
    const radiusZ = matrices[m + 10]
    const xMin = tx - radiusX
    const xMax = tx + radiusX
    const zMin = tz - radiusZ
    const zMax = tz + radiusZ
    if (xMin < minX) minX = xMin
    if (xMax > maxX) maxX = xMax
    if (zMin < minZ) minZ = zMin
    if (zMax > maxZ) maxZ = zMax
  }
  return {
    minX,
    minY: NODE_BOTTOM_Y,
    minZ,
    maxX,
    maxY: NODE_TOP_Y,
    maxZ,
  }
}

/*
 * 合并多个数值 bounds 为一个紧致 AABB（SPEC 12.1 contentBounds 合并）。
 *
 * 忽略 null（某子系统无几何贡献时可为 null，如全普通节点样本的节点箭头）。
 * 全部为 null 时返回退化 bounds（min > max），由 validateSceneModel 捕获并整体拒绝。
 * 不纳入标签锚点或 Ground：本函数的调用方只传入 ribbon / 两类箭头 / 节点圆柱四类真实几何范围。
 */
function mergeBounds(boxes: ReadonlyArray<NumericBox3 | null>): NumericBox3 {
  let minX = Number.POSITIVE_INFINITY
  let minY = Number.POSITIVE_INFINITY
  let minZ = Number.POSITIVE_INFINITY
  let maxX = Number.NEGATIVE_INFINITY
  let maxY = Number.NEGATIVE_INFINITY
  let maxZ = Number.NEGATIVE_INFINITY
  for (const box of boxes) {
    if (box === null) continue
    if (box.minX < minX) minX = box.minX
    if (box.minY < minY) minY = box.minY
    if (box.minZ < minZ) minZ = box.minZ
    if (box.maxX > maxX) maxX = box.maxX
    if (box.maxY > maxY) maxY = box.maxY
    if (box.maxZ > maxZ) maxZ = box.maxZ
  }
  return { minX, minY, minZ, maxX, maxY, maxZ }
}

/*
 * 场景模型汇总主入口（SPEC 4.1 / 5.2 / 12.1）。
 *
 * 调用方契约：
 *   - 输入是 TASK-005 交付的不可变 SceneMap（坐标已一次性转换、实体语义已校验）。
 *   - 成功返回 SceneModel：最终 typed array、全部标签描述符、数值内容 bounds 与只读诊断快照。
 *   - 失败抛出 MAP_GEOMETRY_INVALID：任一子系统构建失败或汇总自校验不一致均整体拒绝，
 *     不返回部分模型、不补零、不截断。
 *
 * 汇总顺序（SPEC 4.1 数据流）：
 *   1. buildTrackModel：唯一车道事实来源，供 ribbon / 边箭头 / 边标签共同消费。
 *   2. 各 geometry 子系统：ribbon / 节点 / 两类箭头实例数据（已完成自身有限性与计数校验）。
 *   3. edgeLaneOffsets：从轨迹模型提取 edgeId → laneOffset，供标签编排复用，不重新判断重合。
 *   4. buildLabelDescriptors：节点 + 边标签，顺序稳定。
 *   5. contentBounds：合并 lane offset 后的 ribbon、两类箭头与节点圆柱真实几何范围。
 *   6. 组装诊断与模型，交付前整体自校验。
 *
 * 不二次转换不变量：本函数直接搬运各子系统已生成的 typed array 与 bounds，
 * 不重算坐标、不重算颜色；contentBounds 的节点圆柱贡献只读实例矩阵索引，不回读领域节点。
 */
export function buildSceneModel(sceneMap: SceneMap): SceneModel {
  // 1. 轨迹模型（TASK-006）：唯一车道事实来源，供 ribbon / 边箭头 / 边标签共同消费。
  const trackModel = buildTrackModel(sceneMap)

  // 2. 各几何子系统实例数据（TASK-007～TASK-010），均已完成自身有限性与计数校验。
  const ribbon = buildRibbonGeometry(trackModel.tracks)
  const nodeInstances = buildNodeInstanceData(sceneMap.nodes)
  const nodeArrows = buildNodeArrowData(sceneMap.nodes)
  const edgeArrows = buildEdgeArrowData(trackModel.tracks)

  // 3. 边车道偏移映射：从轨迹模型提取 edgeId → laneOffset，供标签编排复用（SPEC 9.3 / 11.2）。
  //    不重新判断重合轨迹；laneOffset 已由 TASK-006 一次性确定，与 ribbon / 边箭头同源。
  const edgeLaneOffsets = new Map<string, number>()
  for (let i = 0; i < trackModel.tracks.length; i++) {
    const lane = trackModel.tracks[i]
    edgeLaneOffsets.set(lane.edgeId, lane.laneOffset)
  }

  // 4. 标签描述符（TASK-011）：节点 + 边标签，顺序固定为“节点标签 + 边标签”，重复构建稳定。
  const labelCollection = buildLabelDescriptors(
    sceneMap.nodes,
    sceneMap.edges,
    edgeLaneOffsets,
  )

  // 5. 内容 bounds：合并 lane offset 后的 ribbon、两类箭头与节点圆柱真实几何范围（SPEC 12.1）。
  //    明确排除标签锚点与 Ground；节点圆柱范围从最终实例矩阵推导，不回读领域节点。
  const nodeCylinderBounds = computeNodeCylinderBounds(
    nodeInstances.matrices,
    nodeInstances.nodeCount,
  )
  const contentBounds = mergeBounds([
    ribbon.bounds,
    edgeArrows.bounds,
    nodeArrows.bounds,
    nodeCylinderBounds,
  ])

  // 6. 组装只读诊断快照（SPEC 5.2 SceneDiagnostics / 14.2）。
  //    各计数直接取自已校验子系统的输出，不在汇总阶段重算或舍入。
  const diagnostics: SceneDiagnostics = {
    nodeCount: nodeInstances.nodeCount,
    nodeArrowCount: nodeArrows.arrowCount,
    edgeArrowCount: edgeArrows.arrowCount,
    ribbonVertexCount: ribbon.vertexCount,
    labelCandidateCount: labelCollection.labelCandidateCount,
    pairedTrackCount: trackModel.grouping.pairedTrackCount,
  }

  // 7. 组装不可变场景模型。typed array 与元数据直接搬运，不二次转换坐标或颜色。
  const model: SceneModel = {
    metadata: sceneMap.metadata,
    transform: sceneMap.transform,
    nodeMatrices: nodeInstances.matrices,
    nodeColors: nodeInstances.colors,
    nodeArrowMatrices: nodeArrows.matrices,
    nodeArrowColors: nodeArrows.colors,
    edgeArrowMatrices: edgeArrows.matrices,
    edgeArrowColors: edgeArrows.colors,
    ribbonPositions: ribbon.positions,
    ribbonColors: ribbon.colors,
    labels: labelCollection.descriptors,
    contentBounds,
    diagnostics,
  }

  // 8. 交付前整体自校验（SPEC 16 / 任务约束）：任一不一致立即拒绝整个模型，不返回部分场景。
  validateSceneModel(model)

  return model
}

/*
 * 断言数组长度 = count × unit（SPEC 5.2 / 任务“数组长度交叉校验”）。
 * 不一致立即整体拒绝，不截断、不补齐。
 */
function assertLength(
  name: string,
  actual: number,
  count: number,
  unit: number,
): void {
  const expected = count * unit
  if (actual !== expected) {
    throw sceneModelError(
      `${name} 长度 ${actual} 与期望 ${count} × ${unit} = ${expected} 不一致。`,
      { name, actual, count, unit, expected },
    )
  }
}

/*
 * 断言 typed array 全部元素为有限数（SPEC 16：任何 NaN / Infinity 立即构建失败）。
 * 发现非有限值立即整体拒绝，不输出部分模型。
 */
function assertFiniteArray(arr: Float32Array, name: string): void {
  for (let i = 0; i < arr.length; i++) {
    if (!Number.isFinite(arr[i])) {
      throw sceneModelError(`${name} 第 ${i} 个元素 ${arr[i]} 非有限。`, {
        name,
        index: i,
        value: arr[i],
      })
    }
  }
}

/*
 * 断言颜色 typed array 全部元素为有限数且位于线性 sRGB [0, 1]（SPEC 5.2 / 7.3）。
 * 使用 COLOR_RANGE_EPSILON 容忍 Float32 末位抖动，同时拒绝 NaN / Infinity / 超范围颜色。
 */
function assertColorArray(arr: Float32Array, name: string): void {
  for (let i = 0; i < arr.length; i++) {
    const v = arr[i]
    if (!Number.isFinite(v)) {
      throw sceneModelError(`${name} 第 ${i} 个颜色分量 ${v} 非有限。`, {
        name,
        index: i,
        value: v,
      })
    }
    if (v < -COLOR_RANGE_EPSILON || v > 1 + COLOR_RANGE_EPSILON) {
      throw sceneModelError(`${name} 第 ${i} 个颜色分量 ${v} 超出线性 sRGB [0, 1]。`, {
        name,
        index: i,
        value: v,
      })
    }
  }
}

/*
 * 场景模型整体自校验（SPEC 5.2 / 12.1 / 14.1 / 16 / 任务约束）。
 *
 * 只读断言：不修改模型；任一不一致立即抛出 MAP_GEOMETRY_INVALID，整体拒绝。
 * buildSceneModel 在返回前调用本函数；本函数亦单独导出，供测试对篡改后的模型直接验证拒绝。
 *
 * 校验范围：
 *   - 元数据完整性（mapId / mapName / version 非空字符串）。
 *   - 场景原点有限性。
 *   - 诊断计数为非负整数，且彼此与数组长度严格一致。
 *   - 五类 typed array 长度 = 对应实例数 × {16, 3} 或 ribbonVertexCount × 3。
 *   - 矩阵 / 顶点有限；颜色有限且在线性 sRGB [0, 1]。
 *   - 标签描述符数量 = labelCandidateCount；每个描述符锚点 / 偏移为有限数。
 *   - contentBounds 六分量有限且满足 min ≤ max。
 */
export function validateSceneModel(model: SceneModel): void {
  const d = model.diagnostics

  // —— 元数据完整性（SPEC 5.2 / 任务“缺失元数据”异常路径）——
  // mapId / mapName / version 是可追溯元数据，必须为非空字符串；空值表示上游契约破裂。
  if (
    typeof model.metadata.mapId !== 'string' ||
    model.metadata.mapId.length === 0 ||
    typeof model.metadata.mapName !== 'string' ||
    model.metadata.mapName.length === 0 ||
    typeof model.metadata.version !== 'string' ||
    model.metadata.version.length === 0
  ) {
    throw sceneModelError(
      '场景模型元数据缺失：mapId / mapName / version 必须为非空字符串。',
      {
        mapId: model.metadata.mapId,
        mapName: model.metadata.mapName,
        version: model.metadata.version,
      },
    )
  }

  // —— 场景原点有限性（SPEC 6.2）——
  if (
    !Number.isFinite(model.transform.absoluteWorldOriginX) ||
    !Number.isFinite(model.transform.absoluteWorldOriginZ)
  ) {
    throw sceneModelError('场景原点含非有限数，无法交付场景模型。', {
      absoluteWorldOriginX: model.transform.absoluteWorldOriginX,
      absoluteWorldOriginZ: model.transform.absoluteWorldOriginZ,
    })
  }

  // —— 诊断计数：非负整数（SPEC 5.2）——
  const counts: ReadonlyArray<readonly [string, number]> = [
    ['nodeCount', d.nodeCount],
    ['nodeArrowCount', d.nodeArrowCount],
    ['edgeArrowCount', d.edgeArrowCount],
    ['ribbonVertexCount', d.ribbonVertexCount],
    ['labelCandidateCount', d.labelCandidateCount],
    ['pairedTrackCount', d.pairedTrackCount],
  ]
  for (const [name, value] of counts) {
    if (!Number.isInteger(value) || value < 0) {
      throw sceneModelError(`诊断计数 ${name} = ${value} 不是非负整数。`, {
        name,
        value,
      })
    }
  }

  // —— 跨实体计数关系（SPEC 8.2 / 10.2 / 11.2）——
  // 节点箭头只产生于非普通节点，其数量不得超过节点总数。
  if (d.nodeArrowCount > d.nodeCount) {
    throw sceneModelError(
      `节点箭头数 ${d.nodeArrowCount} 超过节点总数 ${d.nodeCount}，计数关系不一致。`,
      { nodeArrowCount: d.nodeArrowCount, nodeCount: d.nodeCount },
    )
  }
  // 每个节点恰一个标签、每条边恰一个标签且恰一个边箭头（SPEC 10.2 / 11.2），
  // 故 labelCandidateCount = nodeCount + edgeArrowCount；不一致表示子系统对边数认知分裂。
  if (d.labelCandidateCount !== d.nodeCount + d.edgeArrowCount) {
    throw sceneModelError(
      `标签候选数 ${d.labelCandidateCount} ≠ 节点数 ${d.nodeCount} + 边箭头数 ${d.edgeArrowCount}，计数关系不一致。`,
      {
        labelCandidateCount: d.labelCandidateCount,
        nodeCount: d.nodeCount,
        edgeArrowCount: d.edgeArrowCount,
      },
    )
  }

  // —— 数组长度与诊断计数交叉校验（SPEC 5.2 / 任务“篡改长度”异常路径）——
  assertLength('nodeMatrices', model.nodeMatrices.length, d.nodeCount, 16)
  assertLength('nodeColors', model.nodeColors.length, d.nodeCount, 3)
  assertLength(
    'nodeArrowMatrices',
    model.nodeArrowMatrices.length,
    d.nodeArrowCount,
    16,
  )
  assertLength('nodeArrowColors', model.nodeArrowColors.length, d.nodeArrowCount, 3)
  assertLength(
    'edgeArrowMatrices',
    model.edgeArrowMatrices.length,
    d.edgeArrowCount,
    16,
  )
  assertLength('edgeArrowColors', model.edgeArrowColors.length, d.edgeArrowCount, 3)
  assertLength(
    'ribbonPositions',
    model.ribbonPositions.length,
    d.ribbonVertexCount,
    3,
  )
  assertLength('ribbonColors', model.ribbonColors.length, d.ribbonVertexCount, 3)

  if (model.labels.length !== d.labelCandidateCount) {
    throw sceneModelError(
      `labels 长度 ${model.labels.length} 与 labelCandidateCount ${d.labelCandidateCount} 不一致。`,
      {
        labelsLength: model.labels.length,
        labelCandidateCount: d.labelCandidateCount,
      },
    )
  }

  // —— 矩阵 / 顶点有限性（SPEC 16 / 任务“注入 NaN / Infinity”异常路径）——
  assertFiniteArray(model.nodeMatrices, 'nodeMatrices')
  assertFiniteArray(model.nodeArrowMatrices, 'nodeArrowMatrices')
  assertFiniteArray(model.edgeArrowMatrices, 'edgeArrowMatrices')
  assertFiniteArray(model.ribbonPositions, 'ribbonPositions')

  // —— 颜色有限性 + 线性 sRGB [0, 1]（SPEC 5.2 / 7.3 / 任务“颜色布局”）——
  assertColorArray(model.nodeColors, 'nodeColors')
  assertColorArray(model.nodeArrowColors, 'nodeArrowColors')
  assertColorArray(model.edgeArrowColors, 'edgeArrowColors')
  assertColorArray(model.ribbonColors, 'ribbonColors')

  // —— 标签描述符有限性（SPEC 16）——
  // 描述符锚点 / 偏移由 TASK-011 构建时校验，此处对最终模型做兜底断言，杜绝非有限数据泄漏到渲染层。
  for (let i = 0; i < model.labels.length; i++) {
    const label = model.labels[i]
    if (
      !Number.isFinite(label.anchorX) ||
      !Number.isFinite(label.anchorY) ||
      !Number.isFinite(label.anchorZ) ||
      !Number.isFinite(label.localOffsetX) ||
      !Number.isFinite(label.localOffsetY)
    ) {
      throw sceneModelError(`标签 ${label.id} 锚点或局部偏移含非有限数。`, {
        labelId: label.id,
        anchorX: label.anchorX,
        anchorY: label.anchorY,
        anchorZ: label.anchorZ,
        localOffsetX: label.localOffsetX,
        localOffsetY: label.localOffsetY,
      })
    }
  }

  // —— 内容 bounds 有限性与顺序（SPEC 12.1 / 16 / 任务“bounds 极值”异常路径）——
  const b = model.contentBounds
  if (
    !Number.isFinite(b.minX) ||
    !Number.isFinite(b.minY) ||
    !Number.isFinite(b.minZ) ||
    !Number.isFinite(b.maxX) ||
    !Number.isFinite(b.maxY) ||
    !Number.isFinite(b.maxZ)
  ) {
    throw sceneModelError('contentBounds 含非有限数。', {
      minX: b.minX,
      minY: b.minY,
      minZ: b.minZ,
      maxX: b.maxX,
      maxY: b.maxY,
      maxZ: b.maxZ,
    })
  }
  if (!(b.minX <= b.maxX) || !(b.minY <= b.maxY) || !(b.minZ <= b.maxZ)) {
    throw sceneModelError('contentBounds 不满足 min ≤ max。', {
      minX: b.minX,
      minY: b.minY,
      minZ: b.minZ,
      maxX: b.maxX,
      maxY: b.maxY,
      maxZ: b.maxZ,
    })
  }
}

/*
 * 枚举可转移 ArrayBuffer（SPEC 4.1 / 任务约束）。
 *
 * 所有权契约：
 *   - 返回每个最终 typed array 的底层 ArrayBuffer，恰好出现一次，无重复。
 *   - 不包含标签描述符或任何不可转移对象：描述符是普通 JS 对象，随结构化克隆传递，
 *     不进入转移列表；只有 typed array 的 ArrayBuffer 是可转移的。
 *   - 重复缓冲区（两个 typed array 共享同一 ArrayBuffer）会破坏 postMessage 转移语义
 *     （同一缓冲区不能被转移两次），在此显式检测并整体拒绝，把错误拦在汇总层而非运行时通信层。
 *
 * 本函数只建立传输契约：枚举所有权集合，不执行跨线程 postMessage（传输由后续 worker 入口负责）。
 */
export function collectTransferableBuffers(
  model: SceneModel,
): readonly ArrayBuffer[] {
  // 固定顺序枚举全部最终 typed array，保证可转移集合显式、稳定、可测试。
  const typedArrays: readonly Float32Array[] = [
    model.nodeMatrices,
    model.nodeColors,
    model.nodeArrowMatrices,
    model.nodeArrowColors,
    model.edgeArrowMatrices,
    model.edgeArrowColors,
    model.ribbonPositions,
    model.ribbonColors,
  ]
  const buffers: ArrayBuffer[] = []
  const seen = new Set<ArrayBuffer>()
  for (const arr of typedArrays) {
    const buf = arr.buffer
    // 运行时收敛 ArrayBufferLike → ArrayBuffer：本工程的 typed array 全部由
    // `new Float32Array(n)` 构造，底层恒为普通 ArrayBuffer；若未来出现 SharedArrayBuffer
    // 支撑的视图（非 postMessage 转移语义），在此整体拒绝而非静默误传。
    if (!(buf instanceof ArrayBuffer)) {
      throw sceneModelError(
        '可转移缓冲区不是 ArrayBuffer（可能是 SharedArrayBuffer），不符合转移契约。',
        { bufferTag: Object.prototype.toString.call(buf) },
      )
    }
    if (seen.has(buf)) {
      throw sceneModelError(
        '可转移缓冲区集合存在重复 ArrayBuffer，typed array 所有权不一致。',
        { byteLength: buf.byteLength },
      )
    }
    seen.add(buf)
    buffers.push(buf)
  }
  return buffers
}
