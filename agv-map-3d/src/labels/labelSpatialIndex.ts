/*
 * 标签 4m uniform-grid 空间索引（labels 层，SPEC 11.3 / 16）。
 *
 * 信任边界定位（TASK-021）：
 *   - 本模块把 SPEC §11.3 第 2 项的“4m uniform-grid 占用 cell 视锥粗筛”前置数据结构集中为
 *     一个只读空间索引：启动时对 4810 个 LabelDescriptor 分桶，运行时只读遍历占用 cell。
 *   - 只消费不可变 LabelDescriptor（anchorX/anchorY/anchorZ），不创建 Troika Text / Three / React
 *     对象，不接触相机、画布或视锥（任务约束）；视锥粗筛在可见集模块完成。
 *
 * 空间分桶不变量（SPEC 11.3 第 2 项 / 任务约束）：
 *   - 描述符按 floor(anchorX / cellSize)、floor(anchorZ / cellSize) 落入 cell（col, row）。
 *   - 每个占用 cell 记录其 (col,row) 与桶内描述符（保持输入顺序，重复构建完全稳定）。
 *   - 占用 cell 按 (col, row) 升序遍历，保证粗筛遍历顺序确定；粗筛本身与顺序无关，但确定性便于断言。
 *   - 真实样本约产生 331 个占用 cell（SPEC 11.3 第 2 项）。
 *
 * 不变量（SPEC 16 / 任务约束）：
 *   - 描述符锚点必须为有限数（由 buildLabelDescriptors 保证）；本模块对非有限锚点防御性整体失败，
 *     不静默跳过、不补默认 cell。
 *   - 本索引不携带 bounds、不参与内容 bounds 或地面尺寸（SPEC 11.2 / 12.1）。
 *
 * 依赖方向（SPEC 3.3）：domain（MapDataError / 错误码）+ labels（labelDescriptor）；外部仅 Node 内置。
 */
import { MapDataError, MapErrorCode } from '../domain/mapDataError'
import type { LabelDescriptor } from './labelDescriptor'

/*
 * 空间索引逻辑路径前缀：索引错误发生在已构建的描述符集合上，不对应原始 JSON path。
 */
const LABEL_SPATIAL_INDEX_LOGICAL_PATH = 'labelSpatialIndex.build'

/*
 * 占用 cell（只读）：栅格坐标 (col,row) + 桶内描述符（输入顺序）。
 * cell 的 XZ 网格范围由 (col,row,cellSize) 唯一确定（见 cellGridBounds），不在此冗余存储。
 */
export interface OccupiedCell {
  readonly col: number
  readonly row: number
  readonly descriptors: readonly LabelDescriptor[]
}

/*
 * 只读 uniform-grid 空间索引（SPEC 11.3 第 2 项）。
 *   - cellSize：栅格边长（米），真实样本固定 4.0m。
 *   - occupiedCells：按 (col,row) 升序排列的占用 cell，重复构建完全稳定。
 *   - descriptorCount：索引覆盖的描述符总数，与输入长度交叉一致。
 */
export interface LabelSpatialIndex {
  readonly cellSize: number
  readonly occupiedCells: readonly OccupiedCell[]
  readonly descriptorCount: number
}

/*
 * cell XZ 网格范围（未外扩，SPEC 11.3 第 2 项粗筛前由可见集外扩 1.5m）。
 * [minX, maxX] × [minZ, maxZ] = [col×cellSize, (col+1)×cellSize] × [row×cellSize, (row+1)×cellSize]。
 */
export function cellGridBounds(
  col: number, row: number, cellSize: number,
): { readonly minX: number; readonly maxX: number; readonly minZ: number; readonly maxZ: number } {
  return {
    minX: col * cellSize,
    maxX: (col + 1) * cellSize,
    minZ: row * cellSize,
    maxZ: (row + 1) * cellSize,
  }
}

/*
 * 构造空间索引（SPEC 11.3 第 2 项）。
 *
 * 调用方契约：
 *   - descriptors 为 buildLabelDescriptors 产出的不可变描述符集合（锚点均已保证有限）。
 *   - cellSize 为正有限数（真实样本固定 LABEL_GRID_CELL_SIZE = 4.0m）。
 *   - 成功返回只读 LabelSpatialIndex；cellSize 非法或锚点非有限时整体失败抛出 MapDataError。
 *
 * 构建（确定性，重复构建完全稳定）：
 *   1. 校验 cellSize 与描述符锚点有限性（防御性，杜绝 NaN 泄漏到栅格坐标）。
 *   2. 按 (col,row) 分桶，桶内保持输入顺序。
 *   3. 占用 cell 按 (col,row) 升序输出，供可见集粗筛确定遍历。
 */
export function buildLabelSpatialIndex(
  descriptors: readonly LabelDescriptor[],
  cellSize: number,
): LabelSpatialIndex {
  if (!Number.isFinite(cellSize) || !(cellSize > 0)) {
    throw new MapDataError({
      code: MapErrorCode.MAP_GEOMETRY_INVALID,
      message: `标签空间索引 cellSize 非法（必须为正有限数），实际为 ${cellSize}。`,
      jsonPath: LABEL_SPATIAL_INDEX_LOGICAL_PATH,
      context: { cellSize },
    })
  }

  // 桶：以 "col,row" 字符串为键，保证负坐标无碰撞且顺序无关。
  const bucketMap = new Map<string, { col: number; row: number; list: LabelDescriptor[] }>()
  for (let i = 0; i < descriptors.length; i++) {
    const d = descriptors[i]
    if (!Number.isFinite(d.anchorX) || !Number.isFinite(d.anchorZ)) {
      throw new MapDataError({
        code: MapErrorCode.MAP_GEOMETRY_INVALID,
        message: `标签 ${d.id} 锚点含非有限数，无法落入空间索引栅格。`,
        jsonPath: LABEL_SPATIAL_INDEX_LOGICAL_PATH,
        entityId: d.id,
        context: { anchorX: d.anchorX, anchorZ: d.anchorZ },
      })
    }
    const col = Math.floor(d.anchorX / cellSize)
    const row = Math.floor(d.anchorZ / cellSize)
    const key = col + ',' + row
    let bucket = bucketMap.get(key)
    if (bucket === undefined) {
      bucket = { col, row, list: [] }
      bucketMap.set(key, bucket)
    }
    bucket.list.push(d)
  }

  // 按 (col,row) 升序输出占用 cell，桶内描述符保持输入顺序；重复构建完全稳定。
  const buckets = Array.from(bucketMap.values())
  buckets.sort(compareCellPosition)
  const occupiedCells: OccupiedCell[] = new Array<OccupiedCell>(buckets.length)
  for (let i = 0; i < buckets.length; i++) {
    const b = buckets[i]
    occupiedCells[i] = { col: b.col, row: b.row, descriptors: b.list }
  }

  return {
    cellSize,
    occupiedCells,
    descriptorCount: descriptors.length,
  }
}

/*
 * 占用 cell 按 (col,row) 升序比较（先 col 再 row），保证遍历顺序确定。
 */
function compareCellPosition(
  a: { col: number; row: number },
  b: { col: number; row: number },
): number {
  if (a.col !== b.col) return a.col < b.col ? -1 : 1
  if (a.row !== b.row) return a.row < b.row ? -1 : 1
  return 0
}
