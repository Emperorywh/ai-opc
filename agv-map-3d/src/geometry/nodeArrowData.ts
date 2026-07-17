/*
 * 节点朝向箭头实例数据生成（geometry 层，SPEC 2.2 / 2.5 / 5.2 / 7.1 / 7.2 / 8.2 / 12.1 / 15.2 / 15.3 / 16）。
 *
 * 信任边界定位（TASK-009）：
 *   - 本模块消费 TASK-005 交付的不可变 SceneNode（坐标已一次性转换到场景系 x/z），输出
 *     可供单一节点箭头 InstancedMesh 直接消费的实例矩阵、线性颜色 typed array、真实几何
 *     bounds 与诊断计数；主线程只把结果填入 InstancedMesh，不再回读节点 DTO 或重复推导。
 *   - 纯数值逻辑：不创建 Three BufferGeometry / Material / Mesh，也不依赖 R3F / React /
 *     浏览器 API。基准三角形以纯数据导出，渲染层负责据此构造共享 BufferGeometry。
 *
 * 判定不变量（SPEC 2.5 / 8.2 / 任务约束）：
 *   - 箭头判定只用 type !== 'node'：普通 node 一律不产生箭头，其 angle = null 也不得
 *     替换为零或当成朝向零的箭头（普通节点正常通过，箭头计数不增加）。
 *   - work / park / charge 每个节点恰产生一个箭头；不得读取不存在的 showArrow 字段。
 *   - 运行时仍校验类型属于已知闭合集合：绕过类型边界注入的未知字面量（如旧系统残留的
 *     warehouse / shelf）以 MAP_ENTITY_INVALID 整体失败，禁止给默认箭头样式。
 *
 * 基准几何不变量（SPEC 8.2 / 任务约束）：
 *   - 全部箭头共享一个位于 XZ 平面、局部朝 +X 的单位三角形 NODE_ARROW_VERTICES，
 *     从 +Y 观察为逆时针（正面朝上）。顶点本身不携带任何节点角度。
 *   - 角度只在实例矩阵中应用一次（rotationY = angle）；禁止先预旋转顶点再旋转实例。
 *
 * 角度映射不变量（SPEC 8.2，方向验收）：
 *   - 局部 +X 基准三角形经实例矩阵旋转后：angle = 0 → +X、angle = +π/2 → -Z、
 *     angle = -π/2 → +Z。
 *   - 该映射由矩阵 R = Ry(angle) 的 cos/sin 数值决定：旋转后 tip(0.5,0,0) 的场景偏移为
 *     (cos·r/2, -sin·r/2)，故 +π/2(cos=0,sin=1) 落到 -Z、-π/2(cos=0,sin=-1) 落到 +Z。
 *   - 角度计算全程使用数值 cos/sin 与容差比较，禁止与 Math.PI/2 等常量做字符串比较或
 *     精确相等判断；样本中的近似 π/2 不会被当成精确常量特殊处理。
 *
 * 矩阵列主序不变量（SPEC 5.2 / 8.2，Three.js Matrix4.toArray 兼容）：
 *   - 16 元素列主序，组合顺序固定 T × R × S；平移位于索引 12 / 13 / 14。
 *   - S = diag(radius, 1, radius)：X/Z 按节点半径等比缩放；Y 不缩放（三角形顶点 y 恒为 0，
 *     Y 缩放无几何意义，保留 1 与节点本体约定一致）。
 *   - R = Ry(angle) 写入：m[0] = cos·r、m[2] = -sin·r、m[8] = sin·r、m[10] = cos·r，
 *     其余旋转分量恒为 0；与 Three.js makeRotationY 列主序完全一致。
 *   - T = (sceneX, 0.066, sceneZ)：Y 为 SPEC 7.1 Node Arrow Y；坐标只从 SceneNode.position
 *     直接读取，不再做任何取负、轴交换或平移（场景坐标已在适配层一次性转换完成）。
 *
 * 对比色不变量（SPEC 8.2 / 7.2 / 任务约束）：
 *   - 箭头色在 #111111 与 #FFFFFF 中按 WCAG 相对亮度对比度择高，同类节点结果必须稳定；
 *     平局（对比度相等）稳定取黑色，避免依赖迭代顺序或哈希。
 *   - 节点基色 hex 取自 SPEC 7.2（与 nodeInstanceData 同源 SPEC，按本工程“各层各自引用
 *     同一 SPEC 来源、不形成第二套语义”的既定约定引用，非复制类型→颜色规则）。
 *   - 颜色以线性 sRGB [0,1] 浮点输出；候选色在模块加载时一次性线性化，避免每实例重复转换。
 *
 * 范围贡献不变量（SPEC 12.1 / 任务约束）：
 *   - bounds 为全部箭头真实变换后顶点的紧致轴对齐包围盒（minY = maxY = Node Arrow Y），
 *     供后续 computeContentBounds 合并 ribbon / 两类箭头 / 节点圆柱的真实几何范围。
 *   - arrowCount = 0（全普通节点样本）时 bounds 为 null：无几何贡献，是合法状态，不报错。
 *
 * 异常不变量（SPEC 5.3 第 11 项 / 14.1 / 16 / 任务约束）：
 *   - 无法形成有限矩阵、有效角度或有效范围时整体失败：作业节点 angle 为 null / 非有限、
 *     节点坐标非有限、矩阵 / 颜色结果非有限均抛出结构化错误，禁止跳过实体或使用默认朝向。
 *
 * 依赖方向（SPEC 3.3）：仅依赖 domain 与本层（colorSpace）。
 */
import { MapDataError, MapErrorCode } from '../domain/mapDataError'
import type { NodeType } from '../domain/mapPrimitives'
import type { NumericBox3, SceneNode } from '../domain/sceneMap'
import {
  contrastRatio,
  hexToLinearRGB,
} from './colorSpace'

/*
 * SPEC 8.2：节点箭头共享基准三角形（局部朝 +X，位于 XZ 平面）。
 * 顶点顺序 [tip, back-left, back-right] 从 +Y 观察为逆时针，正面朝上：
 *   - tip   = ( 0.5, 0,  0.0)：箭尖位于局部 +X。
 *   - back1 = ( 0.0, 0, -0.5)：左后角位于 -Z。
 *   - back2 = ( 0.0, 0,  0.5)：右后角位于 +Z。
 * 三角形为“单位尺度”，具体半径由实例矩阵的 X/Z 缩放赋予；顶点本身不含角度，
 * 每个实例只在矩阵中旋转一次（SPEC 8.2 / 任务约束）。
 * 渲染层据此构造共享非索引 BufferGeometry（属性 itemSize = 3）。
 */
export const NODE_ARROW_VERTICES: readonly number[] = [
  0.5, 0, 0.0,
  0.0, 0, -0.5,
  0.0, 0, 0.5,
]

/*
 * SPEC 7.1：Node Arrow Y（米）。箭头实例平移 Y 固定 0.066，位于节点圆柱顶面 0.060 之上，
 * 避免与顶面争夺深度（配合渲染层 depthWrite = false）。该值同时作为 bounds 的 minY / maxY。
 * 与 config 视觉常量同源 SPEC 7.1，两层各自引用同一规格，不形成第二套语义。
 */
const NODE_ARROW_Y = 0.066

/*
 * SPEC 7.1 / 8.2：箭头实例的 X/Z 等比缩放（米）。
 * 箭头只为 work / park / charge 创建，SPEC 7.1 规定三者半径均为 0.15m，故箭头缩放统一 0.15。
 * 这是 SPEC 7.1 对箭头承载类型的唯一半径值（非类型→半径规则表的复制）；
 * 渲染层如同名视觉常量由 config 自行定义，两层引用同一 SPEC 来源。
 */
const NODE_ARROW_RADIUS = 0.15

/*
 * SPEC 8.2：箭头候选色 hex。只在 #111111 与 #FFFFFF 中按 WCAG 对比度择高。
 * 模块加载时一次性线性化为 [0,1] sRGB 浮点，避免每实例重复转换。
 */
const ARROW_BLACK_HEX = '#111111'
const ARROW_WHITE_HEX = '#FFFFFF'
const ARROW_BLACK_LINEAR = hexToLinearRGB(ARROW_BLACK_HEX)
const ARROW_WHITE_LINEAR = hexToLinearRGB(ARROW_WHITE_HEX)

/*
 * 产生箭头的节点类型联合（SPEC 2.2 / 8.2）。
 * 普通节点 'node' 不在本联合中：判定 type !== 'node' 后，运行时收敛到本三态之一。
 */
type ArrowNodeType = Exclude<NodeType, 'node'>

/*
 * SPEC 7.2：箭头承载类型的节点基色 hex（WCAG 对比度的“节点基色”输入）。
 * 与 nodeInstanceData 的类型→颜色同源 SPEC 7.2；此处仅引用 3 个箭头承载类型的 hex，
 * 用于派生黑白择色结果，不重新表达类型→线性颜色的渲染契约。
 */
const NODE_BASE_HEX_BY_ARROW_TYPE: Readonly<Record<ArrowNodeType, string>> = {
  work: '#2196F3',
  park: '#F44336',
  charge: '#8BC34A',
}

/*
 * SPEC 8.2：每个箭头承载类型的最终箭头线性颜色（WCAG 对比度择高，模块加载时一次性预计算）。
 * 同类节点结果稳定：纯函数 + 平局取黑色，不依赖实例顺序。
 */
const ARROW_LINEAR_COLOR_BY_TYPE: Readonly<
  Record<ArrowNodeType, readonly [number, number, number]>
> = {
  work: chooseArrowLinearColor(NODE_BASE_HEX_BY_ARROW_TYPE.work),
  park: chooseArrowLinearColor(NODE_BASE_HEX_BY_ARROW_TYPE.park),
  charge: chooseArrowLinearColor(NODE_BASE_HEX_BY_ARROW_TYPE.charge),
}

/*
 * 几何层逻辑路径前缀：节点箭头错误发生在已转换的 SceneNode 上，不对应原始 JSON path。
 * 用稳定逻辑路径标识失败位置，使测试与诊断可定位，同时不伪造原始响应路径。
 */
const NODE_ARROW_LOGICAL_PATH = 'sceneMap.nodes#arrow'

/*
 * 节点箭头实例数据输出契约（SPEC 5.2 nodeArrowMatrices / nodeArrowColors /
 * SceneDiagnostics.nodeArrowCount / 12.1 contentBounds）。
 *
 * 字段语义：
 *   - matrices：列主序实例矩阵 Float32Array，长度 = arrowCount × 16，每个矩阵组合顺序
 *     T × R × S，平移位于索引 12 / 13 / 14。
 *   - colors：线性 sRGB [0,1] Float32Array，长度 = arrowCount × 3，元素序为 (r, g, b)。
 *   - arrowCount：箭头实例数（真实样本固定 464 = work + park + charge），与 matrices /
 *     colors 长度交叉一致。
 *   - bounds：全部箭头真实变换后顶点的紧致 NumericBox3（minY = maxY = Node Arrow Y），
 *     供 computeContentBounds 合并；arrowCount = 0 时为 null（无几何贡献）。
 *
 * 所有权不变量：主线程只把本结果填入单一 InstancedMesh（SPEC 8.2 不按类型拆 mesh），
 * 不再回读节点 DTO 或重复推导坐标 / 半径 / 颜色 / 旋转。
 */
export interface NodeArrowData {
  readonly matrices: Float32Array
  readonly colors: Float32Array
  readonly arrowCount: number
  readonly bounds: NumericBox3 | null
}

/*
 * 按 WCAG 对比度在黑色 / 白色候选中择高，返回该候选的线性 sRGB 三元组（SPEC 8.2）。
 * 平局（两候选对比度相等）稳定取黑色，使结果只依赖基色、不依赖迭代或哈希顺序。
 */
function chooseArrowLinearColor(
  baseHex: string,
): readonly [number, number, number] {
  const contrastBlack = contrastRatio(baseHex, ARROW_BLACK_HEX)
  const contrastWhite = contrastRatio(baseHex, ARROW_WHITE_HEX)
  return contrastBlack >= contrastWhite ? ARROW_BLACK_LINEAR : ARROW_WHITE_LINEAR
}

/*
 * 构造节点箭头错误（SPEC 14.1）。
 * 未知类型用 MAP_ENTITY_INVALID；非有限角度 / 坐标 / 矩阵 / 颜色用 MAP_GEOMETRY_INVALID。
 * 整体拒绝，不返回部分实例数据；message 含可读中文，便于 overlay 与测试匹配。
 */
function nodeArrowError(
  code: MapErrorCode,
  message: string,
  context?: Readonly<Record<string, unknown>>,
  entityId?: string | null,
): MapDataError {
  return new MapDataError({
    code,
    message,
    jsonPath: NODE_ARROW_LOGICAL_PATH,
    entityId: entityId ?? null,
    context,
  })
}

/*
 * 运行时校验非普通节点类型属于已知箭头承载三态（SPEC 2.2 / 8.2 / 任务约束）。
 *
 * NodeType 在 TypeScript 层是闭合联合，但运行时仍可能被 `as unknown as SceneNode` 绕过
 * 边界注入未知字面量。本函数在“type !== 'node'”判定之后做收敛校验：未知类型立即以
 * MAP_ENTITY_INVALID 整体失败，禁止给默认箭头颜色 / 朝向 / 样式。通过后 node.type 收敛为
 * ArrowNodeType，后续 ARROW_LINEAR_COLOR_BY_TYPE 查找不会得到 undefined。
 */
function assertArrowNodeType(
  type: string,
  nodeId: string,
): asserts type is ArrowNodeType {
  if (!(type in NODE_BASE_HEX_BY_ARROW_TYPE)) {
    throw nodeArrowError(
      MapErrorCode.MAP_ENTITY_INVALID,
      `节点类型 ${type} 不在箭头承载集合 (work|park|charge) 中，无法生成节点箭头。`,
      { type },
      nodeId,
    )
  }
}

/*
 * 节点箭头实例数据生成主入口（SPEC 4.1 / 8.2）。
 *
 * 调用方契约：
 *   - 输入是 TASK-005 交付的不可变 SceneNode 数组（坐标已一次性转换、实体语义已校验）。
 *   - 成功返回 NodeArrowData：单一合并 matrices / colors typed array、arrowCount 与
 *     真实几何 bounds（或 arrowCount = 0 时的 null）。
 *   - 失败抛出 MapDataError：未知类型 → MAP_ENTITY_INVALID；非有限角度 / 坐标 / 矩阵 / 颜色
 *     → MAP_GEOMETRY_INVALID；均整体拒绝，不返回部分实例或填默认值。
 *
 * 两遍扫描：
 *   1) 先统计箭头实例数（type !== 'node'）以精确预分配 typed array，避免动态扩容。
 *   2) 再遍历写入矩阵 / 颜色并累计 bounds。普通节点在两遍中都被跳过，不产生箭头数据。
 *
 * 矩阵写入（列主序 T × R × S，见模块头不变量）：
 *   - m[0] = cos·r、m[2] = -sin·r、m[8] = sin·r、m[10] = cos·r；
 *     m[5] = 1（Y 不缩放）；m[12]/m[13]/m[14] = sceneX / 0.066 / sceneZ；m[15] = 1。
 *   - 行主序实现会把平移放到索引 3/7/11、把 -sin/sin 放到 1/8，本布局会使其失败。
 */
export function buildNodeArrowData(
  nodes: readonly SceneNode[],
): NodeArrowData {
  // 第 1 遍：统计箭头实例数（type !== 'node'），精确预分配。
  let arrowCount = 0
  for (let i = 0; i < nodes.length; i++) {
    if (nodes[i].type !== 'node') {
      // 收敛校验放在判定之后：未知类型在统计阶段即整体失败，避免漏判。
      assertArrowNodeType(nodes[i].type, nodes[i].id)
      arrowCount++
    }
  }

  // 预分配连续 Float32 结果：matrices = arrowCount × 16，colors = arrowCount × 3（SPEC 5.2 / 8.2）。
  const matrices = new Float32Array(arrowCount * 16)
  const colors = new Float32Array(arrowCount * 3)

  // bounds 累计器（number 精度）：仅在实际发射箭头时更新；arrowCount = 0 时保持 null。
  let minX = Number.POSITIVE_INFINITY
  let minZ = Number.POSITIVE_INFINITY
  let maxX = Number.NEGATIVE_INFINITY
  let maxZ = Number.NEGATIVE_INFINITY

  // 第 2 遍：写入实例矩阵 / 颜色并累计真实几何 bounds。
  let out = 0 // 箭头实例写入游标
  for (let i = 0; i < nodes.length; i++) {
    const node = nodes[i]
    // 箭头判定只用 type !== 'node'：普通节点跳过，不产生箭头（其 angle = null 不替换为零）。
    if (node.type === 'node') {
      continue
    }

    // 已在第 1 遍收敛校验；此处 type 为 ArrowNodeType，查表同源，互不漂移。
    const type = node.type as ArrowNodeType
    const color = ARROW_LINEAR_COLOR_BY_TYPE[type]

    // 角度有限性校验（SPEC 5.3 第 11 项 / 任务异常路径）：作业节点 angle 必须为有限弧度。
    // null / NaN / Infinity 整体失败，禁止替换为零或当成有效朝向。
    const angle = node.angle
    if (angle === null || !Number.isFinite(angle)) {
      throw nodeArrowError(
        MapErrorCode.MAP_GEOMETRY_INVALID,
        `节点 ${node.id} 类型 ${type} 的角度为 ${angle}，必须为有限弧度才能生成节点箭头。`,
        { type, angle },
        node.id,
      )
    }

    // 坐标有限性前置校验：SceneNode 来自已校验适配层，但仍拦截绕过边界的非有限注入
    // （SPEC 16 / 任务异常路径）。任一非有限立即整体失败，不写出部分矩阵。
    const sceneX = node.position.x
    const sceneZ = node.position.z
    if (!Number.isFinite(sceneX) || !Number.isFinite(sceneZ)) {
      throw nodeArrowError(
        MapErrorCode.MAP_GEOMETRY_INVALID,
        `节点 ${node.id} 场景坐标含非有限数，无法生成节点箭头矩阵。`,
        { x: sceneX, z: sceneZ },
        node.id,
      )
    }

    // 旋转分量（SPEC 8.2）：R = Ry(angle)，数值 cos/sin 决定方向映射，不做特殊常量比较。
    const cos = Math.cos(angle)
    const sin = Math.sin(angle)
    const r = NODE_ARROW_RADIUS

    // 列主序实例矩阵 T × R × S（见模块头不变量）。缩放 S = diag(r, 1, r) 与旋转 R 相乘后，
    // 旋转列被半径等比缩放：m[0]/m[2] = (cos/-sin)·r，m[8]/m[10] = (sin/cos)·r。
    const m = out * 16
    matrices[m + 0] = cos * r // 列 0 行 0：cos·radius
    matrices[m + 1] = 0
    matrices[m + 2] = -sin * r // 列 0 行 2：-sin·radius
    matrices[m + 3] = 0
    matrices[m + 4] = 0
    matrices[m + 5] = 1 // 列 1 行 1：Y 不缩放
    matrices[m + 6] = 0
    matrices[m + 7] = 0
    matrices[m + 8] = sin * r // 列 2 行 0：sin·radius
    matrices[m + 9] = 0
    matrices[m + 10] = cos * r // 列 2 行 2：cos·radius
    matrices[m + 11] = 0
    matrices[m + 12] = sceneX // 列 3 行 0：平移 X = sceneX
    matrices[m + 13] = NODE_ARROW_Y // 列 3 行 1：平移 Y = Node Arrow Y
    matrices[m + 14] = sceneZ // 列 3 行 2：平移 Z = sceneZ
    matrices[m + 15] = 1 // 列 3 行 3：齐次 1

    // 线性颜色写入（r, g, b）；颜色已在模块加载时一次性按 WCAG 择高并线性化。
    const c = out * 3
    colors[c + 0] = color[0]
    colors[c + 1] = color[1]
    colors[c + 2] = color[2]

    // 真实几何 bounds 贡献（SPEC 12.1）：对基准三角形 3 个顶点做与矩阵一致的 T × R × S 变换，
    // 取紧致 AABB。局部顶点 (lx, lz) ∈ {(0.5, 0), (0, -0.5), (0, 0.5)}，
    // 变换后 wx = sceneX + (cos·lx + sin·lz)·r、wz = sceneZ + (-sin·lx + cos·lz)·r、wy = Node Arrow Y。
    for (let v = 0; v < NODE_ARROW_VERTICES.length; v += 3) {
      const lx = NODE_ARROW_VERTICES[v]
      const lz = NODE_ARROW_VERTICES[v + 2] // 顶点 y 分量恒为 0，跳过 ly
      const wx = sceneX + (cos * lx + sin * lz) * r
      const wz = sceneZ + (-sin * lx + cos * lz) * r
      if (wx < minX) minX = wx
      if (wx > maxX) maxX = wx
      if (wz < minZ) minZ = wz
      if (wz > maxZ) maxZ = wz
    }

    out++
  }

  // 写入游标必须等于第 1 遍统计的箭头数（保证无越界、无遗漏）。
  if (out !== arrowCount) {
    throw nodeArrowError(
      MapErrorCode.MAP_GEOMETRY_INVALID,
      '节点箭头写入数与统计数不符，发射逻辑错误。',
      { written: out, arrowCount },
    )
  }

  // 有限性不变量（SPEC 16）：matrices / colors 任一非有限立即整体失败。
  // 该断言同时兜底“非法视觉常量”——若半径 / 颜色常量被未来编辑破坏为非有限，
  // 写入结果会在此被捕获，杜绝非有限数据泄漏到渲染层。
  assertFiniteNodeArrow(matrices, colors)

  // arrowCount = 0（全普通节点）是合法状态：无几何贡献，bounds 返回 null。
  // computeContentBounds 据此跳过节点箭头范围合并。
  const bounds: NumericBox3 | null =
    arrowCount === 0
      ? null
      : { minX, minY: NODE_ARROW_Y, minZ, maxX, maxY: NODE_ARROW_Y, maxZ }

  return {
    matrices,
    colors,
    arrowCount,
    bounds,
  }
}

/*
 * 断言全部输出为有限数（SPEC 16：任何 NaN / Infinity 立即构建失败）。
 * 逐一检查 matrices 与 colors；发现非有限值立即整体报错，不输出部分实例数据。
 */
function assertFiniteNodeArrow(
  matrices: Float32Array,
  colors: Float32Array,
): void {
  for (let i = 0; i < matrices.length; i++) {
    if (!Number.isFinite(matrices[i])) {
      throw nodeArrowError(
        MapErrorCode.MAP_GEOMETRY_INVALID,
        '节点箭头实例矩阵含非有限数。',
        { index: i, value: matrices[i] },
      )
    }
  }
  for (let i = 0; i < colors.length; i++) {
    if (!Number.isFinite(colors[i])) {
      throw nodeArrowError(
        MapErrorCode.MAP_GEOMETRY_INVALID,
        '节点箭头实例颜色含非有限数。',
        { index: i, value: colors[i] },
      )
    }
  }
}
