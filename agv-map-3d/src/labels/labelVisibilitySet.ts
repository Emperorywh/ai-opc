/*
 * 标签稳定有界可见集与差量（labels 层，SPEC 11.3 / 5.2 / 16）。
 *
 * 信任边界定位（TASK-021）：
 *   - 本模块是“空间索引 + 相机数值输入 + 当前已挂载集合 → 目标 ID 集合 + 创建 / 销毁差量”的
 *     唯一纯计算入口，集中 SPEC §11.3 第 1~7 项：视锥粗筛、精确点测试、投影字号、10/8 迟滞、
 *     稳定优先级截断与差量推导。不创建 Troika Text / Three / React 对象（任务约束）。
 *   - 只消费不可变 LabelDescriptor（经空间索引）与显式相机数值输入（LabelCameraInput），
 *     不依赖 R3F / Troika / 原始 JSON / 全局相机单例（任务约束）。
 *
 * 可见集算法不变量（SPEC 11.3 第 1~7 项）：
 *   1. 用 view-projection 矩阵构造 6 平面视锥（一次）。
 *   2. 对每个占用 cell 的外扩 1.5m AABB 做粗筛（正顶点法）。
 *   3. 对命中 cell 内的描述符做精确点视锥测试，再算投影字号 fontPixels。
 *   4. 迟滞：未挂载 fontPixels >= 10 进入候选；已挂载 fontPixels > 8 维持候选。
 *   5. 候选按 (kind 优先级, 屏幕中心距离, ID 字典序) 稳定排序后截断到 400。
 *   6. 差量：create = 目标 − 已挂载；destroy = 已挂载 − 目标；只对差集操作，不重建整个列表。
 *
 * 稳定排序不变量（SPEC 11.3 第 6 项 / 任务约束）：
 *   - 优先级固定 operational-node(0) → node(1) → edge(2)；同级先比屏幕中心距离（升序），
 *     再比稳定 ID（字典序升序）；禁止数组下标、遍历时序或对象地址破坏确定性。
 *
 * 初始 fit 空集不变量（SPEC 11.3 第 4 项 / 任务验证方式第 3 项）：
 *   - 标准 fit 距离下，全部标签投影字号 < 进入阈值 10px，故目标集合为空、create 为空。
 *
 * 退化输入不变量（SPEC 16 / 任务约束）：
 *   - 相机输入非法（矩阵 / 四元数非有限、画布非正）时返回 null，调用方不得据此更新挂载集合，
 *     禁止产生 NaN / Infinity。
 *
 * 依赖方向（SPEC 3.3）：仅依赖本层（labelSpatialIndex / labelProjection / labelVisibilityConfig /
 *   labelDescriptor）；外部仅 Node 内置；纯函数无副作用。
 */
import type { LabelKind } from './labelDescriptor'
import type { LabelSpatialIndex, OccupiedCell } from './labelSpatialIndex'
import { cellGridBounds } from './labelSpatialIndex'
import type { LabelCameraInput, FrustumPlane } from './labelProjection'
import {
  boxIntersectsFrustum,
  computeCameraScreenUp,
  computeFontPixelSize,
  computeScreenCenterDistancePx,
  extractFrustumPlanes,
  isValidLabelCameraInput,
  pointInFrustum,
} from './labelProjection'
import {
  LABEL_CELL_FRUSTUM_PAD,
  LABEL_ENTER_THRESHOLD_PX,
  LABEL_EXIT_THRESHOLD_PX,
  LABEL_MAX_MOUNTED,
} from './labelVisibilityConfig'

/*
 * 可见集查询输入（任务“稳定有界标签可见集”）。
 *   - spatialIndex：启动时建立的只读 4m uniform-grid 索引。
 *   - camera：显式相机数值输入（view-projection 矩阵、世界四元数、画布像素尺寸）。
 *   - mountedIds：当前已挂载标签 ID 集合（差量基准），可为空。
 */
export interface LabelVisibilityQuery {
  readonly spatialIndex: LabelSpatialIndex
  readonly camera: LabelCameraInput
  readonly mountedIds: ReadonlySet<string>
}

/*
 * 可见集计算结果（任务“目标 ID 集合和创建 / 销毁差量”）。
 *   - targetIds：截断到 400 后的目标集合，按稳定优先级顺序排列（重复输入完全一致）。
 *   - createIds：需新建的标签 ID（targetIds − mountedIds）。
 *   - destroyIds：需销毁的标签 ID（mountedIds − targetIds）。
 *   - candidateCount：迟滞后的候选总数（截断前），供诊断 / 断言。
 *   - mountedAfter：应用差量后的已挂载数 = targetIds.length，恒 <= 400。
 */
export interface LabelVisibilityResult {
  readonly targetIds: readonly string[]
  readonly createIds: readonly string[]
  readonly destroyIds: readonly string[]
  readonly candidateCount: number
  readonly mountedAfter: number
}

/*
 * 候选条目（排序中间结构）。
 */
interface Candidate {
  readonly id: string
  readonly kindRank: number
  readonly distancePx: number
}

/*
 * SPEC 11.3 第 6 项：kind → 截断优先级（值小者优先保留）。
 * operational-node（work/park/charge）最高、node 次之、edge 最低。
 */
const KIND_RANK: Readonly<Record<LabelKind, number>> = {
  'operational-node': 0,
  node: 1,
  edge: 2,
}

/*
 * 标签可见集主入口（SPEC 11.3 第 1~7 项）。
 *
 * 调用方契约：
 *   - spatialIndex 为启动时建立的只读索引；camera 为当前帧的显式相机数值输入；
 *     mountedIds 为当前已挂载标签集合。
 *   - 成功返回 LabelVisibilityResult；camera 非法时返回 null（不得更新挂载集合）。
 *
 * 算法（SPEC 11.3，确定性、重复输入得到完全相同结果）：
 *   1. 校验相机输入；提取 6 平面视锥与 cameraScreenUp（每查询一次）。
 *   2. 遍历占用 cell：外扩 1.5m AABB 粗筛；命中 cell 内描述符做精确点视锥测试 + 投影字号。
 *   3. 迟滞：未挂载 fontPixels >= 10、已挂载 fontPixels > 8 进入候选。
 *   4. 候选按 (kindRank, distancePx, id) 稳定排序，截断到 LABEL_MAX_MOUNTED(400)。
 *   5. 目标集合 = 截断后 ID；差量 create = 目标 − 已挂载、destroy = 已挂载 − 目标。
 */
export function computeLabelVisibilitySet(
  query: LabelVisibilityQuery,
): LabelVisibilityResult | null {
  const { spatialIndex, camera, mountedIds } = query

  // 1. 相机输入非法 → 不更新（SPEC 16 / 任务约束）。禁止 NaN / Infinity 进入视锥或字号计算。
  if (!isValidLabelCameraInput(camera)) return null

  const planes = extractFrustumPlanes(camera.viewProjectionMatrix)
  const screenUp = computeCameraScreenUp(camera.cameraWorldQuaternion)
  const cellSize = spatialIndex.cellSize
  const pad = LABEL_CELL_FRUSTUM_PAD

  // 2~3. 粗筛 + 精确测试 + 投影字号 + 迟滞 → 候选集合。
  const candidates: Candidate[] = []
  for (let ci = 0; ci < spatialIndex.occupiedCells.length; ci++) {
    const cell = spatialIndex.occupiedCells[ci]
    const bounds = cellGridBounds(cell.col, cell.row, cellSize)
    // cell AABB 外扩 1.5m（X/Z 各外扩），Y 取标签锚点固定高度 0.250。
    const minY = cell.descriptors[0].anchorY
    if (
      !boxIntersectsFrustum(
        planes,
        bounds.minX - pad, minY, bounds.minZ - pad,
        bounds.maxX + pad, minY, bounds.maxZ + pad,
      )
    ) {
      continue
    }
    gatherCellCandidates(cell, planes, camera, screenUp, mountedIds, candidates)
  }

  // 4. 稳定排序：kindRank → 屏幕中心距离 → ID 字典序（SPEC 11.3 第 6 项）。
  candidates.sort(compareCandidate)

  // 截断到 400（SPEC 11.3 表格 / 任务约束）。
  const limit = Math.min(candidates.length, LABEL_MAX_MOUNTED)
  const targetIds: string[] = new Array<string>(limit)
  const targetSet = new Set<string>()
  for (let i = 0; i < limit; i++) {
    const id = candidates[i].id
    targetIds[i] = id
    targetSet.add(id)
  }

  // 5. 差量：create = 目标 − 已挂载；destroy = 已挂载 − 目标（SPEC 11.3 第 7 项）。
  const createIds: string[] = []
  for (let i = 0; i < targetIds.length; i++) {
    const id = targetIds[i]
    if (!mountedIds.has(id)) createIds.push(id)
  }
  const destroyIds: string[] = []
  for (const id of mountedIds) {
    if (!targetSet.has(id)) destroyIds.push(id)
  }
  // destroyIds 按已挂载集合遍历；为确定性输出，按 ID 字典序排序。
  destroyIds.sort(compareStringAsc)

  return {
    targetIds,
    createIds,
    destroyIds,
    candidateCount: candidates.length,
    mountedAfter: targetIds.length,
  }
}

/*
 * 对命中 cell 内的描述符做精确点视锥测试、投影字号与迟滞判定，合格者加入候选集合（SPEC 11.3 第 3~5 项）。
 *
 * 迟滞（SPEC 11.3 第 5 项）：
 *   - 未挂载：fontPixels >= LABEL_ENTER_THRESHOLD_PX(10) 进入候选。
 *   - 已挂载：fontPixels > LABEL_EXIT_THRESHOLD_PX(8) 维持候选（<= 8 退出）。
 */
function gatherCellCandidates(
  cell: OccupiedCell,
  planes: readonly FrustumPlane[],
  camera: LabelCameraInput,
  screenUp: { x: number; y: number; z: number },
  mountedIds: ReadonlySet<string>,
  out: Candidate[],
): void {
  const descriptors = cell.descriptors
  for (let i = 0; i < descriptors.length; i++) {
    const d = descriptors[i]
    // 精确点视锥测试：cell 粗筛命中后逐描述符过滤（SPEC 11.3 第 3 项）。
    if (!pointInFrustum(planes, d.anchorX, d.anchorY, d.anchorZ)) continue
    const fontPixels = computeFontPixelSize(camera, screenUp, d.anchorX, d.anchorY, d.anchorZ)
    const mounted = mountedIds.has(d.id)
    // 迟滞：未挂载进入阈值 10、已挂载退出阈值 8（SPEC 11.3 第 5 项）。
    if (mounted ? fontPixels > LABEL_EXIT_THRESHOLD_PX : fontPixels >= LABEL_ENTER_THRESHOLD_PX) {
      const distancePx = computeScreenCenterDistancePx(camera, d.anchorX, d.anchorY, d.anchorZ)
      out.push({
        id: d.id,
        kindRank: KIND_RANK[d.kind],
        distancePx,
      })
    }
  }
}

/*
 * 候选稳定排序（SPEC 11.3 第 6 项）：kindRank 升序 → 屏幕中心距离升序 → ID 字典序升序。
 * 三级键均为确定值，不依赖数组下标、遍历时序或对象地址。
 */
function compareCandidate(a: Candidate, b: Candidate): number {
  if (a.kindRank !== b.kindRank) return a.kindRank < b.kindRank ? -1 : 1
  if (a.distancePx !== b.distancePx) return a.distancePx < b.distancePx ? -1 : 1
  return compareStringAsc(a.id, b.id)
}

/*
 * 字符串字典序升序（UTF-16 code unit，与默认 < 一致，稳定 ID 比较用）。
 */
function compareStringAsc(a: string, b: string): number {
  if (a < b) return -1
  if (a > b) return 1
  return 0
}
