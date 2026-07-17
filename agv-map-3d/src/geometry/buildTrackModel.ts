/*
 * 轨迹模型编排（geometry 层，SPEC 4.1 / 9.1 / 9.2 / 9.3 / 10.2 / 16）。
 *
 * 信任边界定位（TASK-006）：
 *   - 本模块是 SceneMap → TrackModel 的唯一编排入口。
 *   - 它先做精确反向分组（决定每条边的车道偏移），再对每条边构建方向性车道几何，
 *     保证 ribbon、边箭头与边标签共同消费同一份偏移后中心线 / 弧长 / 切线 / laneOffset。
 *   - 输出是纯数值与不可变描述符；不创建 Three / React / 浏览器对象，也不读写全局状态。
 *
 * 唯一车道事实来源不变量（SPEC 9.3 / 任务约束）：
 *   - 车道偏移只在本文发生一次：成对边 laneOffset = PAIRED_LANE_OFFSET，单边 laneOffset = 0。
 *   - 下游 ribbon / 边箭头 / 边标签不得再从原始 SceneEdge 重复推导车道偏移或重新采样。
 *
 * isBackEdge 隔离不变量（SPEC 2.4 / 9.1 / 任务约束）：
 *   - 分组只看几何；isBackEdge 只作为颜色语义透传到 LaneGeometry，不影响点序、切线或偏移。
 *
 * 依赖方向（SPEC 3.3）：仅依赖 domain 与本层（trackModel / centerlineSampling / trackGrouping）。
 */
import type { SceneMap } from '../domain/sceneMap'
import type { LaneGeometry, TrackModel } from './trackModel'
import { PAIRED_LANE_OFFSET } from './trackModel'
import { buildLaneGeometry } from './centerlineSampling'
import { groupCoincidentTracks } from './trackGrouping'

/*
 * SceneMap → TrackModel 唯一编排入口（SPEC 4.1 / 9.1 / 9.2 / 9.3）。
 *
 * 调用方契约：
 *   - 输入是 TASK-005 交付的不可变 SceneMap（坐标已一次性转换、实体语义已校验）。
 *   - 成功返回 TrackModel：每条边的方向性车道几何 + 精确反向分组结果。
 *   - 失败抛出 MAP_GEOMETRY_INVALID：分组异常或车道几何异常均整体拒绝，不返回部分结果。
 *
 * 编排顺序（SPEC 9.3：偏移由分组决定）：
 *   1. groupCoincidentTracks：识别精确反向成对，得到成对边集合。
 *   2. 对每条边：成对边 laneOffset = PAIRED_LANE_OFFSET，单边 laneOffset = 0。
 *   3. buildLaneGeometry：方向性采样 → 切线 → 弧长 → 应用车道偏移 → 有限性校验。
 *   4. 填入 paired 标志，组装 TrackModel（含 O(1) 查找索引）。
 */
export function buildTrackModel(sceneMap: SceneMap): TrackModel {
  // 1. 精确反向分组：决定车道偏移取值，不读取 isBackEdge。
  const grouping = groupCoincidentTracks(sceneMap.edges)

  // 2. 按分组结果决定每条边的车道偏移；构建方向性车道几何。
  const tracks: LaneGeometry[] = new Array<LaneGeometry>(sceneMap.edges.length)
  const trackByEdgeId = new Map<string, LaneGeometry>()
  for (let i = 0; i < sceneMap.edges.length; i++) {
    const edge = sceneMap.edges[i]
    const paired = grouping.pairedEdgeIds.has(edge.id)
    // 成对边沿自身左法线偏移 PAIRED_LANE_OFFSET；单边偏移 0。
    const laneOffset = paired ? PAIRED_LANE_OFFSET : 0
    const geometry = buildLaneGeometry(edge, laneOffset)
    const lane: LaneGeometry = { ...geometry, paired }
    tracks[i] = lane
    trackByEdgeId.set(edge.id, lane)
  }

  return {
    tracks,
    trackByEdgeId,
    grouping,
  }
}
