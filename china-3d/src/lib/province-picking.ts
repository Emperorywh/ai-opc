/**
 * 省级悬停拾取的所属判定（领域层，TASK-009，SPEC §4.2）。
 *
 * 角色与依赖方向：
 * - 本模块属于运行时访问层（src/lib），与 province-borders.ts / elevation.ts 同层。它把「一个经纬度
 *   点 + 34 省行政区几何（EPSG:4326 lon/lat 多边形 / 多多边形）」确定性地变换为「该点所属行政区的
 *   稳定标识（adminId）或 null（海域 / 地图外 / 无归属）」，供渲染层（src/three/ProvinceHoverPicker）
 *   只消费、不再自行实现点在多边形内判断（SPEC §4.2「raycast 命中地形后用屏幕坐标反查所属省」的
 *   「反查所属省」环节是交互领域能力，边界和标签视图只能消费最终状态）。
 * - 单向依赖：本模块只依赖契约层 src/geo-contracts（AdministrativeGeometryFeature /
 *   AdministrativeGeometry / LonLatRing / LonLatCoordinate 类型）。**禁止**依赖 React / R3F /
 *   Three.js / DOM / 投影 / 高程——它是纯函数，输入经纬度 + 几何，输出 adminId | null。这使所属
 *   判定可在 Node 环境（vitest）用确定性几何夹具完整覆盖「普通省份 / 多岛省份（MultiPolygon）/
 *   内环（洞 / 飞地）/ 相邻边界 / 海域 / 地图外」等场景，无需启动 WebGL / 浏览器。
 *
 * 点在多边形内判断（射线法 / even-odd rule）：
 * - 对单个闭合环，从待判点向正东（+经度）发射水平射线，统计其与环各条边的交点数：奇数 = 点在环内，
 *   偶数 = 点在环外。这是经典 even-odd 拓扑判定，对凸 / 凹 / 复杂多边形一致正确。
 * - 实现用 `(yi > lat) !== (yj > lat)` 判定边的两端点是否跨过待判点的纬度线，再用线性插值算出该边
 *   与纬度线交点的经度，比较待判点经度是否在其西侧（lon < 交点经度）——等价于「射线向东穿越该边」。
 *   逐边异或累加（inside = !inside）即得奇偶性。
 * - 边界点（点恰好落在环上）属于测度零的退化情形，射线法结论不确定；hover 场景下指针极少精确落在
 *   亚度级的省界上，且省界本身就是有一定宽度的发光线，故边界歧义不影响实际交互（本模块只要求
 *   「相邻省份正确切换、不残留多高亮」）。
 *
 * 多边形 / 多多边形 / 内环：
 * - Polygon：rings[0] 为外环，rings[1..] 为内环（洞 / 飞地）。点属于该多边形当且仅当「在外环内」
 *   且「不在任一内环内」（洞里的点不属于该省——如飞地嵌套场景）。
 * - MultiPolygon：每个 polygon 独立按上述规则判定，点属于该多多边形当且仅当「属于任一 polygon」
 *   （多岛省份的任一岛屿 / 大陆块命中即归属该省）。
 * - 行政区归属：点属于某行政区当且仅当「点在其几何内（按上述规则）」。多省互不重叠（行政区几何
 *   互斥），故 findProvinceAtLonLat 返回首个命中即可，无歧义。
 *
 * 海域 / 地图外 / 无归属（SPEC §4.2「移出后还原」）：
 * - 点不在任何行政区几何内 → 返回 null（海域 / 邻国陆地 / 地图范围外都归为 null，统一表达「无省份
 *   焦点」）。渲染层据此把 hoveredAdminId 置 null，触发全部省份回到基线态（移出还原不变量）。
 * - 输入非有限经纬度 / features 为空 → 返回 null（不伪造归属，与 elevation「不以魔法值混淆异常」
 *   同构）。
 *
 * 为什么直接在 lon/lat 上判定而不先投影：墨卡托是保角（共形）投影，拓扑关系（在内 / 在外）在
 * lon/lat 与世界坐标下一致；行政区几何本就以 EPSG:4326 存储，故无需先把点与几何投影到同一平面。
 * 调用方（ProvinceHoverPicker）把指针命中的世界 (x,z) 经 projection.invertWorld 反算成 (lon,lat)
 * 后喂入本模块，反查只忠实还原坐标（见 src/lib/projection invertWorld 注释），不做范围裁剪。
 *
 * 无分配约束：本函数全程不 new 数组 / 对象（probe 单对象复用语义除外——见实现，仅一个常量对象），
 * 射线法用 number 局部量 + 逐边异或，短路返回。可被渲染层在指针移动事件中调用（pointer move 频率
 * 受浏览器节流，每次 O(全体环顶点数) ~ 数千次比较，微秒级）而不产生 GC 压力（SPEC §7.4）。
 */

import type {
  AdministrativeGeometry,
  AdministrativeGeometryFeature,
  LonLatCoordinate,
  LonLatRing,
} from '../geo-contracts'

/**
 * 单个待判点（EPSG:4326 经纬度，度）。
 *
 * 本模块不依赖投影，直接在源坐标基准（lon/lat）上做点在多边形内判断——见文件头「为什么直接在
 * lon/lat 上判定」。调用方把指针命中的世界 (x,z) 经 projection.invertWorld 反算成 (lon,lat) 后喂入。
 */
export interface ProvincePickPoint {
  readonly lon: number
  readonly lat: number
}

/**
 * 判定点是否落在单个闭合环内（射线法 / even-odd，纯函数）。
 *
 * 从点向正东发射水平射线，统计与环边的交点数：奇 = 内，偶 = 外。环不要求显式首尾重合（射线法对
 * 开环 / 闭环一致——开环视为隐式闭合不影响 even-odd 结论，因首尾接缝边贡献的交点数与闭合环一致）。
 * 环 < 3 顶点视为退化，直接返回 false（契约保证每环 ≥ 3，此处为防御）。
 */
function pointInRing(point: LonLatCoordinate, ring: LonLatRing): boolean {
  const n = ring.length
  // 退化环（< 3 顶点不足以表达一个面）→ 不在内。
  if (n < 3) return false
  const { lon, lat } = point
  let inside = false
  // j 始终为 i 的前一个顶点（i=0 时 j=n-1，即末顶点，形成闭合接缝边）。
  for (let i = 0, j = n - 1; i < n; j = i, i++) {
    const vi = ring[i]
    const vj = ring[j]
    const yi = vi.lat
    const yj = vj.lat
    // 该边的两端点是否跨过待判点的纬度线（一端严格大于 lat、另一端不大于 lat）。严格不等号保证
    // 「边经过待判点所在纬度线时只计一次」（避免端点恰好落在纬度线上时重复计数导致奇偶错乱）。
    if ((yi > lat) !== (yj > lat)) {
      // 线性插值算该边与纬度线 lat 交点的经度 xCross；待判点 lon < xCross 即射线向东穿越该边。
      const xi = vi.lon
      const xj = vj.lon
      const xCross = ((xj - xi) * (lat - yi)) / (yj - yi) + xi
      if (lon < xCross) {
        inside = !inside
      }
    }
  }
  return inside
}

/**
 * 判定点是否落在单个多边形（外环 + 内环 / 洞）内（纯函数）。
 *
 * rings[0] 为外环，rings[1..] 为内环（洞 / 飞地）。点在多边形内当且仅当「在外环内」且「不在任一
 * 内环内」（洞挖空外环）。rings 为空 → false。
 */
function pointInPolygon(point: LonLatCoordinate, rings: readonly LonLatRing[]): boolean {
  if (rings.length === 0) return false
  // 不在外环内 → 必不在多边形内。
  if (!pointInRing(point, rings[0])) return false
  // 在任一内环（洞）内 → 不在多边形内。
  for (let k = 1; k < rings.length; k++) {
    if (pointInRing(point, rings[k])) return false
  }
  return true
}

/**
 * 判定点是否落在行政区几何内（Polygon / MultiPolygon 统一入口，纯函数）。
 *
 * Polygon：复用 pointInPolygon（外环 + 内环）。MultiPolygon：点属于任一 polygon 即在几何内（多岛
 * 省份的任一岛屿 / 大陆块命中即归属）。
 */
function pointInGeometry(point: LonLatCoordinate, geometry: AdministrativeGeometry): boolean {
  if (geometry.type === 'Polygon') {
    return pointInPolygon(point, geometry.rings)
  }
  // MultiPolygon：逐 polygon 判定，任一命中即在几何内。
  for (const polygon of geometry.polygons) {
    if (pointInPolygon(point, polygon.rings)) return true
  }
  return false
}

/**
 * 查找一个经纬度点所属的省级行政区（纯函数，可在 Node 直接断言）。
 *
 * 逐个 feature 判定点是否在其几何内（按 Polygon / MultiPolygon / 内环规则），返回首个命中的
 * adminId；全部未命中（海域 / 地图外 / 邻国陆地）或输入退化（非有限经纬度 / features 空）→
 * 返回 null。
 *
 * 行政区几何互斥（一地属一省），故首个命中即唯一归属，无需进一步裁决。多岛省份（海南 / 台湾等
 * MultiPolygon）的任一岛屿命中即归属该省；带飞地 / 洞的省份按外环 + 内环规则正确排除洞内点。
 *
 * @param point 待判点（EPSG:4326 经纬度）。
 * @param features 34 省行政区几何（已通过 administrative-geometry 契约校验，adminId 唯一）。
 * @returns 命中行政区的稳定标识（CN- 前缀），或 null（海域 / 地图外 / 退化输入）。
 */
export function findProvinceAtLonLat(
  point: ProvincePickPoint,
  features: readonly AdministrativeGeometryFeature[],
): string | null {
  // 退化输入（非有限经纬度 / 空 features）→ 无归属，绝不伪造。与 elevation「不以魔法值混淆异常」同构。
  if (!Number.isFinite(point.lon) || !Number.isFinite(point.lat)) return null
  if (features.length === 0) return null
  const probe: LonLatCoordinate = { lon: point.lon, lat: point.lat }
  // 逐省判定，首个命中即返回（行政区互斥，无歧义）。
  for (const feature of features) {
    if (pointInGeometry(probe, feature.geometry)) {
      return feature.adminId
    }
  }
  // 全部未命中 → 海域 / 地图外 / 邻国陆地，统一表达「无省份焦点」。
  return null
}
