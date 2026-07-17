/*
 * 节点本体实例数据生成（geometry 层，SPEC 2.2 / 5.2 / 7.1 / 7.2 / 8.1 / 15.2 / 15.3 / 16）。
 *
 * 信任边界定位（TASK-008）：
 *   - 本模块消费 TASK-005 交付的不可变 SceneNode（坐标已一次性转换到场景系 x/z），
 *     输出可供单一节点 InstancedMesh 消费的实例矩阵与线性颜色 typed array，以及与数组
 *     长度交叉一致的只读诊断计数。
 *   - 纯数值逻辑：不创建 Three BufferGeometry / Material / Mesh，也不依赖 R3F / React /
 *     浏览器 API。主线程后续只需把 matrices / colors 填入 InstancedMesh，不再读取节点
 *     DTO 或重复计算坐标、半径与颜色。
 *   - 本 TASK 只交付节点本体实例数据，不包含节点朝向箭头、标签或场景组件。
 *
 * 矩阵列主序不变量（SPEC 5.2 / 8.1，Three.js Matrix4.toArray 兼容）：
 *   - 实例矩阵采用列主序 16 元素布局，组合顺序固定为 T × R × S。
 *   - 节点本体只需平移与缩放，旋转恒为单位矩阵：angle 不烘焙进本体矩阵——普通节点
 *     angle = null 保持领域语义，非普通节点的有限 angle 留给节点箭头 TASK 消费。
 *   - 平移分量固定位于索引 12、13、14，分别对应 sceneX、节点实例中心 Y、sceneZ。
 *   - 缩放为对角矩阵：索引 0 = radius（X）、索引 5 = 1（Y 不缩放，保留基准高度）、
 *     索引 10 = radius（Z）；Y 不被半径缩放是 SPEC 8.1 硬约束。
 *
 * 颜色空间不变量（SPEC 5.2 / 7.2 / 7.3）：
 *   - 四类节点颜色按 SPEC 7.2 固定 hex 选择，通过标准 sRGB transfer function 写为
 *     线性 [0,1] RGB 浮点；禁止把 8-bit sRGB 直接除以 255 当作线性值。
 *   - 颜色在模块加载时按类型一次性线性化，避免每实例重复转换。
 *
 * 实例数据所有权不变量（SPEC 4.1 / 8.1 / 任务约束）：
 *   - 所有节点共享一组实例数据契约：一个 matrices Float32Array（count × 16）与
 *     一个 colors Float32Array（count × 3），禁止按类型拆分重复管线或为每节点创建对象。
 *   - 生成逻辑只消费统一场景节点，不回读原始 JSON、不再次转换坐标。
 *   - typed array 长度由诊断计数交叉校验；任一非有限矩阵 / 颜色或非法领域节点
 *     都必须整体失败，不跳过实例或填默认值。
 *
 * 常量归属说明（SPEC 7.1 / 7.2）：
 *   - SPEC 7.1 常量表面向渲染层；但分层约束禁止 geometry 导入 config。
 *   - 此处定义的是“生成实例矩阵与线性颜色”必须直接消费的契约常量（半径、实例中心 Y、
 *     类型色 hex），它们是 SPEC 7.1 / 7.2 / 8.1 明确给出的数值，不是渲染层视觉策略。
 *   - 共享基准几何的高度 0.05m 与圆柱分段 24 属渲染层 config 契约（由其创建
 *     CylinderGeometry），本层不重复定义；实例中心 Y 0.035 由其派生（底面 0.010 + 高度 / 2）。
 *   - 渲染层如需引用同一名义值，由 config 自行定义；两层各自引用同一 SPEC 来源，
 *     不存在隐式第二套语义。
 *
 * 依赖方向（SPEC 3.3）：仅依赖 domain 与本层（colorSpace）。
 */
import { MapDataError, MapErrorCode } from '../domain/mapDataError'
import type { NodeType } from '../domain/mapPrimitives'
import type { SceneNode } from '../domain/sceneMap'
import { hexToLinearRGB } from './colorSpace'

/*
 * SPEC 7.1 / 8.1：节点半径（米），按类型固定。
 *   - 普通节点 node：0.10m。
 *   - work / park / charge：0.15m。
 * 半径写入实例矩阵的 X / Z 缩放分量；共享基准圆柱几何半径恒为 1，由实例缩放到目标半径。
 */
const NODE_RADIUS_BY_TYPE: Readonly<Record<NodeType, number>> = {
  node: 0.1,
  work: 0.15,
  park: 0.15,
  charge: 0.15,
}

/*
 * SPEC 7.2：节点颜色 hex，按类型固定。
 *   - node：#78909C；work：#2196F3；park：#F44336；charge：#8BC34A。
 * 模块加载时一次性线性化为 [0,1] sRGB 浮点，避免每实例重复转换；
 * 线性化复用 colorSpace 标准转移函数，与渲染端 outputColorSpace = SRGBColorSpace 闭环。
 */
const NODE_LINEAR_COLOR_BY_TYPE: Readonly<
  Record<NodeType, readonly [number, number, number]>
> = {
  node: hexToLinearRGB('#78909C'),
  work: hexToLinearRGB('#2196F3'),
  park: hexToLinearRGB('#F44336'),
  charge: hexToLinearRGB('#8BC34A'),
}

/*
 * SPEC 7.1 / 8.1：节点实例中心 Y（米）。
 * 共享基准几何高度 0.05m、底面 0.010m，故中心 Y = 0.010 + 0.05 / 2 = 0.035m，
 * 顶面 = 0.060m。该值写入实例矩阵平移 Y（索引 13）；几何层不创建圆柱，
 * 基准高度与圆柱分段 24 属渲染层 config 契约，不在本层重复定义。
 */
const NODE_INSTANCE_CENTER_Y = 0.035

/*
 * 几何层逻辑路径前缀：节点实例错误发生在已转换的 SceneNode 上，不再对应原始 JSON path。
 * 用稳定的逻辑路径标识失败位置，使测试与诊断可定位，同时不伪造原始响应路径。
 */
const NODE_INSTANCE_LOGICAL_PATH = 'sceneMap.nodes'

/*
 * 节点本体实例数据输出契约（SPEC 5.2 nodeMatrices / nodeColors / SceneDiagnostics.nodeCount）。
 *
 * 字段语义：
 *   - matrices：列主序实例矩阵 Float32Array，长度 = nodeCount × 16，每个矩阵组合顺序
 *     T × R × S（R 为单位矩阵），平移位于索引 12 / 13 / 14。
 *   - colors：线性 sRGB [0,1] Float32Array，长度 = nodeCount × 3，元素序为 (r, g, b)。
 *   - nodeCount：节点实例数（真实样本固定 1767），与 matrices / colors 长度交叉一致。
 *
 * 所有权不变量：主线程只把本结果填入单一 InstancedMesh，不再回读节点 DTO 或重复推导。
 */
export interface NodeInstanceData {
  readonly matrices: Float32Array
  readonly colors: Float32Array
  readonly nodeCount: number
}

/*
 * 构造节点实例错误（SPEC 14.1）。
 * 未知类型用 MAP_ENTITY_INVALID；非有限坐标 / 颜色 / 矩阵用 MAP_GEOMETRY_INVALID。
 * 整体拒绝，不返回部分实例数据；message 含可读中文，便于 overlay 与测试匹配。
 */
function nodeInstanceError(
  code: MapErrorCode,
  message: string,
  context?: Readonly<Record<string, unknown>>,
  entityId?: string | null,
): MapDataError {
  return new MapDataError({
    code,
    message,
    jsonPath: NODE_INSTANCE_LOGICAL_PATH,
    entityId: entityId ?? null,
    context,
  })
}

/*
 * 运行时校验节点类型属于允许的闭合四类集合（SPEC 2.2 / 5.1）。
 *
 * NodeType 在 TypeScript 层是闭合联合，但运行时仍可能被 `as unknown as SceneNode`
 * 绕过边界注入未知字面量（如旧系统残留的 warehouse / shelf）。本函数以类型表自身的
 * key 集合做成员判定，未知类型立即以 MAP_ENTITY_INVALID 整体失败，
 * 禁止给默认半径、默认颜色或默认样式。
 *
 * 通过本断言后，node.type 在运行时已收敛为已知四类之一，后续 NODE_RADIUS_BY_TYPE /
 * NODE_LINEAR_COLOR_BY_TYPE 查找不会得到 undefined。
 */
function assertKnownNodeType(type: string, nodeId: string): void {
  if (!(type in NODE_RADIUS_BY_TYPE)) {
    throw nodeInstanceError(
      MapErrorCode.MAP_ENTITY_INVALID,
      `节点类型 ${type} 不在允许集合 (node|work|park|charge) 中，无法选择半径与颜色。`,
      { type },
      nodeId,
    )
  }
}

/*
 * 节点本体实例数据生成主入口（SPEC 4.1 / 8.1）。
 *
 * 调用方契约：
 *   - 输入是 TASK-005 交付的不可变 SceneNode 数组（坐标已一次性转换、实体语义已校验）。
 *   - 成功返回 NodeInstanceData：单一合并 matrices / colors typed array 与 nodeCount。
 *   - 失败抛出 MapDataError：未知类型 → MAP_ENTITY_INVALID；非有限坐标 / 颜色 / 矩阵
 *     → MAP_GEOMETRY_INVALID；均整体拒绝，不返回部分实例或填默认值。
 *
 * 矩阵写入（列主序 T × R × S，节点本体 R = I）：
 *   - 索引 0 = radius（X 缩放）、索引 5 = 1（Y 不缩放，保留基准高度）、
 *     索引 10 = radius（Z 缩放）。
 *   - 索引 12 / 13 / 14 = sceneX / 0.035 / sceneZ（平移）；索引 15 = 1；其余恒为 0。
 *   - 坐标只从 SceneNode.position 直接读取，不再做任何取负、轴交换或平移——
 *     场景坐标已在适配层一次性转换完成，重复转换会被数值特征断言识别为错误实现。
 */
export function buildNodeInstanceData(
  nodes: readonly SceneNode[],
): NodeInstanceData {
  const nodeCount = nodes.length

  // 预分配连续 Float32 结果：matrices = count × 16，colors = count × 3（SPEC 5.2 / 8.1）。
  const matrices = new Float32Array(nodeCount * 16)
  const colors = new Float32Array(nodeCount * 3)

  for (let i = 0; i < nodeCount; i++) {
    const node = nodes[i]

    // 运行时类型校验：捕获绕过类型边界注入的未知节点类型（SPEC 2.2 / 5.1）。
    assertKnownNodeType(node.type, node.id)

    // 类型已收敛为已知四类；半径与颜色查表同源，共用同一类型集合，互不漂移。
    const radius = NODE_RADIUS_BY_TYPE[node.type]
    const color = NODE_LINEAR_COLOR_BY_TYPE[node.type]

    // 坐标有限性前置校验：SceneNode 来自已校验适配层，但仍拦截绕过边界的非有限注入
    // （SPEC 16 / 任务异常路径）。任一非有限立即整体失败，不写出部分矩阵。
    const sceneX = node.position.x
    const sceneZ = node.position.z
    if (!Number.isFinite(sceneX) || !Number.isFinite(sceneZ)) {
      throw nodeInstanceError(
        MapErrorCode.MAP_GEOMETRY_INVALID,
        `节点 ${node.id} 场景坐标含非有限数，无法生成实例矩阵。`,
        { x: sceneX, z: sceneZ },
        node.id,
      )
    }

    // 列主序实例矩阵（T × R × S，节点本体 R = I，故等价于 T × S）。
    // 平移位于索引 12 / 13 / 14；缩放位于对角索引 0 / 5 / 10；Y 不被半径缩放。
    const m = i * 16
    matrices[m + 0] = radius // 列 0 行 0：X 缩放 = radius
    matrices[m + 1] = 0
    matrices[m + 2] = 0
    matrices[m + 3] = 0
    matrices[m + 4] = 0
    matrices[m + 5] = 1 // 列 1 行 1：Y 缩放 = 1（不缩放，保留基准高度）
    matrices[m + 6] = 0
    matrices[m + 7] = 0
    matrices[m + 8] = 0
    matrices[m + 9] = 0
    matrices[m + 10] = radius // 列 2 行 2：Z 缩放 = radius
    matrices[m + 11] = 0
    matrices[m + 12] = sceneX // 列 3 行 0：平移 X = sceneX
    matrices[m + 13] = NODE_INSTANCE_CENTER_Y // 列 3 行 1：平移 Y = 0.035
    matrices[m + 14] = sceneZ // 列 3 行 2：平移 Z = sceneZ
    matrices[m + 15] = 1 // 列 3 行 3：齐次 1

    // 线性颜色写入（r, g, b）；颜色已在模块加载时一次性线性化。
    const c = i * 3
    colors[c + 0] = color[0]
    colors[c + 1] = color[1]
    colors[c + 2] = color[2]
  }

  // 有限性不变量（SPEC 16）：matrices / colors 任一非有限立即整体失败。
  // 该断言同时兜底“非法视觉常量”——若类型表常量被未来编辑破坏为非有限，
  // 写入的 radius / 颜色会在此被捕获，杜绝非有限数据泄漏到渲染层。
  assertFiniteNodeInstance(matrices, colors)

  return {
    matrices,
    colors,
    nodeCount,
  }
}

/*
 * 断言全部输出为有限数（SPEC 16：任何 NaN / Infinity 立即构建失败）。
 * 逐一检查 matrices 与 colors；发现非有限值立即整体报错，不输出部分实例数据。
 */
function assertFiniteNodeInstance(
  matrices: Float32Array,
  colors: Float32Array,
): void {
  for (let i = 0; i < matrices.length; i++) {
    if (!Number.isFinite(matrices[i])) {
      throw nodeInstanceError(
        MapErrorCode.MAP_GEOMETRY_INVALID,
        '节点实例矩阵含非有限数。',
        { index: i, value: matrices[i] },
      )
    }
  }
  for (let i = 0; i < colors.length; i++) {
    if (!Number.isFinite(colors[i])) {
      throw nodeInstanceError(
        MapErrorCode.MAP_GEOMETRY_INVALID,
        '节点实例颜色含非有限数。',
        { index: i, value: colors[i] },
      )
    }
  }
}
