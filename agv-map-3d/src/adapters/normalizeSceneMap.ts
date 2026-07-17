/*
 * 一次性坐标转换与不可变场景地图构建（adapters 层，SPEC 2.3 / 5.2 / 6.1 / 6.2 / 15.2 / 16）。
 *
 * 信任边界定位（TASK-005）：
 *   - 本模块消费 parseSampleEnvelope + validateMapSemantics 产出的实体级可信 RawMap，
 *     一次性完成“地图坐标 → 场景坐标”的轴映射与重心平移，输出不可变 SceneMap。
 *   - 坐标转换在本模块发生且仅发生一次：节点、边端点与贝塞尔控制点都走同一个
 *     toScenePoint；后续几何、标签、应用与 R3F 层只消费 ScenePoint{x,z}，
 *     不存在第二次取负、交换轴、平移或回读原始 JSON 的机会。
 *   - 本模块不重新执行字段级或跨实体语义校验（由 TASK-003 / TASK-004 完成），
 *     只校验自身坐标不变量：source bounds 必须有限且非退化，场景原点必须有限。
 *
 * 轴映射规则（SPEC 6.1，唯一坐标规则）：
 *   - absoluteWorld = (mapX, 0, -mapY)
 *   - 场景原点取已验证 source bounds 的中心：
 *       absoluteWorldOriginX = (mapMinX + mapMaxX) / 2
 *       absoluteWorldOriginZ = -(mapMinY + mapMaxY) / 2
 *   - 所有平面坐标统一减去场景原点：
 *       sceneX = mapX - absoluteWorldOriginX
 *       sceneZ = -mapY - absoluteWorldOriginZ
 *
 * 边坐标所有权（SPEC 2.3 / 6.1）：
 *   - 边自身 sx/sy/ex/ey/cx/cy/dx/dy 是显示几何唯一事实来源；转换使用边自身坐标，
 *     绝不以引用节点坐标覆盖端点。端点偏差在 TASK-004 已校验通过；
 *     本模块保留边与节点的原有差异，转换前后偏差距离不变。
 *
 * 精度（SPEC 2.3 / 6.2）：
 *   - 全程使用 JavaScript number；内部计算与测试不得人为取整；
 *     只有后续 GPU typed array 写入阶段才允许转 Float32。
 *   - 本模块输出仍是 number 精度的不可变领域数据，不出现任何 Float32Array。
 *
 * 依赖方向（SPEC 3.3）：
 *   - 依赖 domain（场景领域类型与 MapDataError）与 adapters（RawMap）。
 *   - 不依赖 Three / R3F / React / Troika / 浏览器 API；可在 worker 与主线程任意 JS 环境运行。
 */
import { MapDataError, MapErrorCode } from '../domain/mapDataError'
import type {
  MapTransform,
  SceneBezierEdge,
  SceneEdge,
  SceneLineEdge,
  SceneMap,
  SceneNode,
  ScenePoint,
  SourceBounds2D,
} from '../domain/sceneMap'
import type { RawEdge, RawMap } from './rawMap'
import { NODES_COLLECTION_PATH } from './parseSampleEnvelope'

/*
 * 唯一的地图平面坐标 → 场景平面坐标转换函数（SPEC 6.2）。
 *
 * 轴映射（单次转换不变量）：
 *   - mapX 直接映射到绝对世界 X，再减去场景原点 X，得到 sceneX（仅一次平移）。
 *   - mapY 先取负映射到绝对世界 Z，再减去场景原点 Z，得到 sceneZ（仅一次取负 + 一次平移）。
 *   - 禁止几何 / 标签 / 组件再次调用本函数或各自重复取负、交换轴、平移。
 *
 * origin 所有权：
 *   - origin 必须由已验证 source bounds 计算并作为显式 MapTransform 传入；
 *     禁止把 81.82 / 12.54 或任何样本中心散落为魔法数。
 *   - 本函数不校验 origin 有限性；调用方 buildMapTransform 负责保证 origin 有限，
 *     从而保证输出不出现 NaN / Infinity。
 */
export function toScenePoint(
  mapX: number,
  mapY: number,
  origin: MapTransform,
): ScenePoint {
  // 单次轴映射：mapX → sceneX（仅平移），mapY → sceneZ（取负后平移）。
  return {
    x: mapX - origin.absoluteWorldOriginX,
    z: -mapY - origin.absoluteWorldOriginZ,
  }
}

/*
 * 计算二维 source bounds（SPEC 2.3 / 6.1）。
 *
 * 范围必须覆盖全部节点坐标、边端点与贝塞尔控制点；真实样本中与节点 bounds 相同。
 * origin 所有权要求 bounds 先于 transform 计算，且由本函数集中扫描，避免在多处散落。
 *
 * 失败语义（SPEC 14.1 MAP_GEOMETRY_INVALID）：
 *   - 扫描到的任一坐标非有限（NaN / Infinity）→ 整体拒绝。这捕获了绕过
 *     parseSampleEnvelope 的非法 RawMap，确保不输出 NaN / Infinity 场景坐标。
 *   - 无任何扫描点（空节点且空边）→ 退化 source bounds，整体拒绝。
 *   - 失败时不输出部分 bounds、不补默认值。
 */
export function computeSourceBounds(rawMap: RawMap): SourceBounds2D {
  let minX = Infinity
  let maxX = -Infinity
  let minY = Infinity
  let maxY = -Infinity
  let count = 0

  const include = (x: number, y: number): void => {
    if (!Number.isFinite(x) || !Number.isFinite(y)) {
      throw new MapDataError({
        code: MapErrorCode.MAP_GEOMETRY_INVALID,
        message: 'source bounds 计算遇到非有限坐标，无法建立场景变换。',
        jsonPath: NODES_COLLECTION_PATH,
        context: { x, y },
      })
    }
    if (x < minX) minX = x
    if (x > maxX) maxX = x
    if (y < minY) minY = y
    if (y > maxY) maxY = y
    count += 1
  }

  for (const node of rawMap.nodes) {
    include(node.x, node.y)
  }
  for (const edge of rawMap.edges) {
    include(edge.sx, edge.sy)
    include(edge.ex, edge.ey)
    if (edge.edgeType === 'BEZIER') {
      include(edge.cx, edge.cy)
      include(edge.dx, edge.dy)
    }
  }

  if (count === 0) {
    throw new MapDataError({
      code: MapErrorCode.MAP_GEOMETRY_INVALID,
      message: 'source bounds 退化：地图不含任何节点或边端点，无法建立场景变换。',
      jsonPath: NODES_COLLECTION_PATH,
    })
  }

  return { minX, maxX, minY, maxY }
}

/*
 * 由已验证 source bounds 构建显式场景变换（SPEC 6.1 / 6.2）。
 *
 * 场景原点取 bounds 中心，并按 absoluteWorld = (mapX, 0, -mapY) 映射到绝对世界：
 *   - absoluteWorldOriginX = (minX + maxX) / 2
 *   - absoluteWorldOriginZ = -(minY + maxY) / 2
 *
 * origin 所有权：origin 只在本函数由 bounds 派生，禁止把样本中心散落为魔法数。
 * bounds 已由 computeSourceBounds 保证有限；本函数额外断言中心有限，防止极端
 * 输入下 (minX + maxX) 溢出产生非有限原点。
 */
export function buildMapTransform(bounds: SourceBounds2D): MapTransform {
  const centerX = (bounds.minX + bounds.maxX) / 2
  const centerZ = -(bounds.minY + bounds.maxY) / 2
  if (!Number.isFinite(centerX) || !Number.isFinite(centerZ)) {
    throw new MapDataError({
      code: MapErrorCode.MAP_GEOMETRY_INVALID,
      message: '场景原点非有限：source bounds 中心计算溢出，无法建立场景变换。',
      jsonPath: NODES_COLLECTION_PATH,
      context: { centerX, centerZ },
    })
  }
  return {
    absoluteWorldOriginX: centerX,
    absoluteWorldOriginZ: centerZ,
  }
}

/*
 * 唯一的一次性坐标转换入口（SPEC 4.1 / 6.1 / 6.2）。
 *
 * 调用方契约：
 *   - 输入是 parseSampleEnvelope + validateMapSemantics 通过的实体级可信 RawMap。
 *   - 成功返回不可变 SceneMap：全部平面坐标已统一到场景系（x/z），origin 显式可诊断。
 *   - 失败抛出 MapDataError：source bounds 非有限 / 退化、场景原点非有限等。
 *   - 不重新执行字段级或语义校验；不输出部分地图、不补默认值、不猜测坐标。
 */
export function normalizeSceneMap(rawMap: RawMap): SceneMap {
  // 先由全部节点、边端点与贝塞尔控制点计算 source bounds（SPEC 6.1）。
  const sourceBounds = computeSourceBounds(rawMap)
  // 由 bounds 中心派生显式场景变换；origin 所有权归本模块，禁止魔法数。
  const transform = buildMapTransform(sourceBounds)

  // 一次性转换节点：每个节点的 (x, y) 只经 toScenePoint 一次，输出 ScenePoint{x,z}。
  const nodes: SceneNode[] = rawMap.nodes.map((node) => ({
    id: node.id,
    name: node.name,
    type: node.type,
    position: toScenePoint(node.x, node.y, transform),
    angle: node.angle,
  }))

  // 一次性转换边：使用边自身坐标，绝不以引用节点坐标覆盖端点（SPEC 2.3 / 6.1）。
  const edges: SceneEdge[] = rawMap.edges.map((edge) =>
    normalizeEdge(edge, transform),
  )

  return {
    metadata: {
      mapId: rawMap.metadata.mapId,
      mapName: rawMap.metadata.mapName,
      version: rawMap.metadata.version,
    },
    transform,
    sourceBounds,
    nodes,
    edges,
  }
}

/*
 * 单条边的一次性坐标转换（SPEC 5.2 / 6.1）。
 *
 * 使用边自身端点与控制点坐标（sx/sy/ex/ey，BEZIER 额外 cx/cy/dx/dy）；
 * startNodeId / endNodeId 只透传拓扑关系，不参与坐标推导。
 * 判别联合由 edgeType 收敛：LINE → kind:'line'，BEZIER → kind:'cubic'。
 */
function normalizeEdge(edge: RawEdge, transform: MapTransform): SceneEdge {
  // 端点对所有 LINE / BEZIER 通用，使用边自身坐标一次性转换。
  const start = toScenePoint(edge.sx, edge.sy, transform)
  const end = toScenePoint(edge.ex, edge.ey, transform)
  const common = {
    id: edge.id,
    name: edge.name,
    startNodeId: edge.snodeId,
    endNodeId: edge.enodeId,
    isBackEdge: edge.isBackEdge,
  }

  if (edge.edgeType === 'LINE') {
    const line: SceneLineEdge = {
      ...common,
      kind: 'line',
      start,
      end,
    }
    return line
  }

  // BEZIER：两个控制点也走同一个 toScenePoint，保证单次转换不变量。
  const cubic: SceneBezierEdge = {
    ...common,
    kind: 'cubic',
    start,
    control1: toScenePoint(edge.cx, edge.cy, transform),
    control2: toScenePoint(edge.dx, edge.dy, transform),
    end,
  }
  return cubic
}
