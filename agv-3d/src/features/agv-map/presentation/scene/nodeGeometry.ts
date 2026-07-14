import { BufferAttribute, BoxGeometry, BufferGeometry } from 'three'
import type { NodeDimensions } from '../../config/geometryConfig'
import type { RawNodeType } from '../../domain/rawDto'

/**
 * 节点几何构建（SPEC §7.2、§6.2）。
 *
 * 职责：把节点尺寸配置转换为低面数 BufferGeometry，供 NodeLayer 的四类 InstancedMesh 各取一个。
 *
 * 不变量：
 * - 纯函数：相同类型与尺寸产生相同几何，不读取系统时间、随机源或展示状态。
 * - 模型前向 +X（SPEC §6.2、§7.2）：方向性节点（work/charge/park）的尖端/小面位于 +X，
 *   绕 Y 旋转后由实例矩阵（rotationY = angle）表达朝向；普通节点（node）为立方体，无方向性。
 * - 原点居中：几何包围盒以本地原点为中心，X ∈ [−sizeXM/2, +sizeXM/2]，
 *   Y ∈ [−sizeYM/2, +sizeYM/2]，Z ∈ [−sizeZM/2, +sizeZM/2]。
 *   实例矩阵把中心平移到 worldY = sizeYM/2，使底部（本地 y = −sizeYM/2）落到地面 y = 0（SPEC §7.2）。
 * - 外法线：自定义网格以三角形列表给出，buildSolidGeometry 逐面校正绕序（凸体以原点为内点），
 *   保证 computeVertexNormals 得到外法线，避免内壁被背面剔除。
 *
 * 该模块位于展示层（创建 Three.js 场景对象），不属 domain/geometry 纯数据层（SPEC §5.1）。
 * 几何尺寸来源几何配置，节点放置矩阵由 geometry 层 nodeInstances 预编译，二者经 RenderPacket 解耦。
 */

/** 三维坐标。 */
type Vec3 = readonly [number, number, number]
/** 一个三角形（三个顶点，绕序由 buildSolidGeometry 逐面校正为外法线）。 */
type Tri = readonly [Vec3, Vec3, Vec3]

/** 三维叉积（几何法线方向由绕序决定）。 */
function cross(a: Vec3, b: Vec3): Vec3 {
  return [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  ]
}

/** 三维减法。 */
function sub(a: Vec3, b: Vec3): Vec3 {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
}

/**
 * 由三角形列表构建非索引 BufferGeometry，并逐面校正为外法线。
 *
 * 校正原理：所有节点几何都是原点居中的凸体（原点为内点）。对每个三角形，几何法线
 * (b−a)×(c−a) 若与"从原点指向三角形质心"的方向同向，则为外法线；反向则翻转该三角形的
 * 绕序（b↔c）。逐面校正不依赖整体绕序一致性，可吸收手工三角形列表中单面绕序写反的情况，
 * 比基于有符号体积的整体翻转更稳健（整体翻转无法修复局部不一致的绕序）。
 *
 * 非索引布局使每顶点只属于一个三角形，computeVertexNormals 据此得到逐面（flat）法线，
 * 契合低面数剪影的硬边风格。
 */
function buildSolidGeometry(triangles: readonly Tri[]): BufferGeometry {
  const positions = new Float32Array(triangles.length * 9)
  for (let i = 0; i < triangles.length; i += 1) {
    let a = triangles[i][0]
    let b = triangles[i][1]
    let c = triangles[i][2]
    // 几何法线（方向取决于当前绕序）。
    const normal = cross(sub(b, a), sub(c, a))
    // 三角形质心（从原点出发的方向）；凸体外法线与之同向。
    const cx = (a[0] + b[0] + c[0]) / 3
    const cy = (a[1] + b[1] + c[1]) / 3
    const cz = (a[2] + b[2] + c[2]) / 3
    if (normal[0] * cx + normal[1] * cy + normal[2] * cz < 0) {
      // 内法线：翻转绕序使其朝外。
      const tmp = b
      b = c
      c = tmp
    }
    const o = i * 9
    positions[o + 0] = a[0]
    positions[o + 1] = a[1]
    positions[o + 2] = a[2]
    positions[o + 3] = b[0]
    positions[o + 4] = b[1]
    positions[o + 5] = b[2]
    positions[o + 6] = c[0]
    positions[o + 7] = c[1]
    positions[o + 8] = c[2]
  }
  const geometry = new BufferGeometry()
  geometry.setAttribute('position', new BufferAttribute(positions, 3))
  geometry.computeVertexNormals()
  return geometry
}

/** 普通节点：低面数立方体（SPEC §7.2，无方向性）。Three.js BoxGeometry 已自带逐面法线。 */
function buildCube(dim: NodeDimensions): BufferGeometry {
  return new BoxGeometry(dim.sizeXM, dim.sizeYM, dim.sizeZM)
}

/**
 * 工作节点：楔形（三角棱柱），尖端指向 +X（SPEC §7.2）。
 *
 * 横截面（XY 平面）为三角形：后侧（x=−hx）占满全高、前侧（x=+hx）收于中线高度的一个点，
 * 沿 Z 方向拉伸 ±hz。该形状具有明确的 +X 指向，且剪影在任意俯角下可辨识。
 */
function buildWedge(dim: NodeDimensions): BufferGeometry {
  const hx = dim.sizeXM / 2
  const hy = dim.sizeYM / 2
  const hz = dim.sizeZM / 2
  // 后矩形（x=−hx）四角 + 前端尖端（x=+hx, y=0）在 z=±hz 两侧。
  const a: Vec3 = [-hx, -hy, -hz]
  const b: Vec3 = [-hx, +hy, -hz]
  const c: Vec3 = [+hx, 0, -hz]
  const d: Vec3 = [-hx, -hy, +hz]
  const e: Vec3 = [-hx, +hy, +hz]
  const f: Vec3 = [+hx, 0, +hz]
  const triangles: readonly Tri[] = [
    [a, b, c], // 后端三角形（z=−hz）
    [d, f, e], // 前端三角形（z=+hz，反序朝外）
    [a, d, e], [a, e, b], // 后侧面（x=−hx 矩形）
    [b, e, f], [b, f, c], // 上斜面（后上角 → 尖端）
    [c, f, d], [c, d, a], // 下斜面（尖端 → 后下角）
  ]
  return buildSolidGeometry(triangles)
}

/**
 * 充电节点：带单侧尖端的六棱柱（六角铅笔），尖端指向 +X（SPEC §7.2）。
 *
 * 六边形作为 YZ 横截面，沿 X 方向构成棱柱；+X 端收为六面锥尖。六边形尖顶铺满 YZ 尺寸包围盒
 * （Y ∈ ±hy、Z ∈ ±hz），使几何包围盒与配置一致、底部精确落在 y=−sizeYM/2。
 */
function buildHexPencil(dim: NodeDimensions): BufferGeometry {
  const hx = dim.sizeXM / 2
  const hy = dim.sizeYM / 2
  const hz = dim.sizeZM / 2
  const xb = -hx // 棱柱后端面
  const xf = hx * 0.5 // 棱柱前端面（锥尖起始），柱身占 75%、锥尖占 25%
  const apex: Vec3 = [hx, 0, 0]

  // 尖顶六边形（YZ 平面，从 +Y 起顺时针列举）：顶/底点在 Y 轴极值，左/右点在 Z 轴极值，
  // 中间点取半高，铺满 [−hy,+hy]×[−hz,+hz]。
  const hexYZ: readonly Vec3[] = [
    [0, +hy, 0],
    [0, +hy / 2, +hz],
    [0, -hy / 2, +hz],
    [0, -hy, 0],
    [0, -hy / 2, -hz],
    [0, +hy / 2, -hz],
  ]
  const back = hexYZ.map((v): Vec3 => [xb, v[1], v[2]])
  const front = hexYZ.map((v): Vec3 => [xf, v[1], v[2]])

  const triangles: Tri[] = []
  // 后端面：从顶点 0 扇出 4 个三角形（外法线由 buildSolidGeometry 逐面校正）。
  for (let i = 1; i < 5; i += 1) {
    triangles.push([back[0], back[i], back[i + 1]])
  }
  // 柱身侧面：6 个四边形，各拆 2 个三角形。
  for (let i = 0; i < 6; i += 1) {
    const j = (i + 1) % 6
    triangles.push([back[i], back[j], front[j]], [back[i], front[j], front[i]])
  }
  // 锥尖：6 个三角形汇聚到 apex（+X 侧）。
  for (let i = 0; i < 6; i += 1) {
    const j = (i + 1) % 6
    triangles.push([front[i], front[j], apex])
  }
  return buildSolidGeometry(triangles)
}

/**
 * 停车节点：带切角长方体（截头四棱锥），前端面收窄指向 +X（SPEC §7.2）。
 *
 * 后端面（x=−hx）为完整矩形，前端面（x=+hx）按比例 s 居中收窄，四面侧墙为梯形。
 * 整体呈指向 +X 的切角长方体，剪影矮宽（park 高度最小），与充电六棱柱形成明确区分。
 */
function buildChamferedBox(dim: NodeDimensions): BufferGeometry {
  const hx = dim.sizeXM / 2
  const hy = dim.sizeYM / 2
  const hz = dim.sizeZM / 2
  const s = 0.5 // 前端面收窄比例（切角量）
  // 后端面（完整）四角。
  const bBL: Vec3 = [-hx, -hy, -hz]
  const bTL: Vec3 = [-hx, +hy, -hz]
  const bTR: Vec3 = [-hx, +hy, +hz]
  const bBR: Vec3 = [-hx, -hy, +hz]
  // 前端面（按 s 收窄、居中）四角。
  const fBL: Vec3 = [+hx, -hy * s, -hz * s]
  const fTL: Vec3 = [+hx, +hy * s, -hz * s]
  const fTR: Vec3 = [+hx, +hy * s, +hz * s]
  const fBR: Vec3 = [+hx, -hy * s, +hz * s]
  const triangles: readonly Tri[] = [
    [bBL, bBR, bTR], [bBL, bTR, bTL], // 后端面
    [fBL, fTL, fTR], [fBL, fTR, fBR], // 前端面（反序朝 +X）
    [bBL, fBL, fBR], [bBL, fBR, bBR], // 底面（y=−）
    [bTL, bTR, fTR], [bTL, fTR, fTL], // 顶面（y=+）
    [bBL, bTL, fTL], [bBL, fTL, fBL], // 左面（z=−）
    [bBR, fBR, fTR], [bBR, fTR, bTR], // 右面（z=+）
  ]
  return buildSolidGeometry(triangles)
}

/** 按类型索引的几何构建器，穷尽封闭联合，避免遗漏类型。 */
const NODE_GEOMETRY_BUILDERS: Record<
  RawNodeType,
  (dim: NodeDimensions) => BufferGeometry
> = {
  node: buildCube,
  work: buildWedge,
  charge: buildHexPencil,
  park: buildChamferedBox,
}

/**
 * 按节点类型与尺寸构建低面数几何（SPEC §7.2）。
 *
 * 返回的 BufferGeometry 原点居中、底部在 y=−sizeYM/2、方向性节点尖端朝 +X。
 * 调用方（NodeLayer）负责在组件卸载或尺寸变更时显式 dispose。
 */
export function buildNodeGeometry(type: RawNodeType, dim: NodeDimensions): BufferGeometry {
  return NODE_GEOMETRY_BUILDERS[type](dim)
}
