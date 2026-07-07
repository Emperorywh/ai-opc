// ============================================================================
// 双车道偏移工具：配对索引 + 法线偏移（SPEC §4.4，TASK_005）
// ----------------------------------------------------------------------------
// 设计要点：
// 1. 纯函数，不依赖 React / three / config，仅产出裸数值，便于 node 端单测
//    与 CPU 端几何管线（geometry.ts）直接复用；laneOffset 幅度由调用方传入。
// 2. 配对判定**只用节点 id（snodeId / enodeId）**，绝不依赖坐标
//    （SPEC §4.4 明确：几何定位信任边自带坐标，与配对职责分离）。
// 3. 配对不仅看「同 key 数量恰为 2」，还必须校验桶内存在一条与当前边
//    **精确反向**的边，规避「2 条同向重复」被误判为 paired 而错误偏移。
// 4. 偏移方向**全图统一**：法线 = 行驶切线顺时针 90°（行驶方向右侧），
//    paired 边一律向自身 +N 偏移 laneOffset/2；反向边切线天然相反，
//    其 +N 指向另一侧，两条 paired 自动分居中心线两侧，无需逐边判断左右。
// 5. **isBackEdge 不得参与偏移**：它只用于渲染颜色（SPEC §4.4 明确）。
//    真实样例存在双向配对但两条边 isBackEdge 均为 false 的情况。
// ============================================================================

import type { Edge } from '../data/types.ts'

// ----------------------------------------------------------------------------
// 配对类型：成对双向边为 paired，否则为 orphan
// （含无配对 / 2 条同向重复 / 3 条以上歧义，均不做双车道偏移）
// 采用字面量联合而非 enum，以兼容 erasableSyntaxOnly。
// ----------------------------------------------------------------------------
export type PairKind = 'paired' | 'orphan'

// ----------------------------------------------------------------------------
// 场景 xz 平面点（与 render/coordinates.ts 的 ScenePoint2 结构同构）
// 此处用内联结构而非 import，保持本模块零外部类型耦合；
// 调用方传入的 point / 切线均已是场景坐标（坐标映射由 coordinates.ts 完成）。
// ----------------------------------------------------------------------------
type PointXZ = { x: number; z: number }

// 法线（场景 xz 平面）：行驶切线顺时针 90° 后的单位向量
export interface SceneNormal2 {
  nx: number
  nz: number
}

// ----------------------------------------------------------------------------
// 归一化无向键：min(u,v) + "-" + max(u,v)（字符串字典序归一化）
// 同一对节点无论方向（u→v 或 v→u）都产出同一 key，
// 便于把潜在配对边聚合到同一桶内，再由 getPairKind 做精确反向校验。
// ----------------------------------------------------------------------------
function pairKey(u: string, v: string): string {
  // 字典序较小者始终在前，保证键唯一稳定（u<=v 时 u-v，否则 v-u）
  return u <= v ? `${u}-${v}` : `${v}-${u}`
}

// ----------------------------------------------------------------------------
// 预建配对索引：Map<key, Edge[]>
// key 为两端节点 id 的归一化无向键；value 为共享该 key 的所有边。
// 注意：落入同一桶**不代表**必然配对——同向重复 / 三条以上也共享 key，
// 真正的 paired 判定交给 getPairKind 在桶内做精确反向校验。
// ----------------------------------------------------------------------------
export function buildPairIndex(edges: Edge[]): Map<string, Edge[]> {
  const index = new Map<string, Edge[]>()
  for (const edge of edges) {
    const key = pairKey(edge.snodeId, edge.enodeId)
    const bucket = index.get(key)
    if (bucket) {
      bucket.push(edge)
    } else {
      index.set(key, [edge])
    }
  }
  return index
}

// ----------------------------------------------------------------------------
// 判定单条边的配对类型
// paired 必须同时满足：
//   1. 同 key 下恰好 2 条边（排除 1 条孤儿、3 条以上歧义）；
//   2. 桶内存在另一条与当前边精确反向（snodeId/enodeId 互换）的边
//      （排除 2 条同向重复）。
// 任一不满足即 orphan：不做双车道偏移，画在几何中心线上。
// 用 e !== edge 引用比较锁定「另一条边」，避免自环（snodeId==enodeId）
// 时把当前边自身误判为自身的反向。
// ----------------------------------------------------------------------------
export function getPairKind(edge: Edge, index: Map<string, Edge[]>): PairKind {
  const key = pairKey(edge.snodeId, edge.enodeId)
  const bucket = index.get(key)
  // 无桶或非恰好 2 条：孤儿或歧义，一律不配对
  if (!bucket || bucket.length !== 2) {
    return 'orphan'
  }
  // 桶内存在另一条与当前边精确反向的边 → paired
  const hasReverse = bucket.some(
    (e) => e !== edge && e.snodeId === edge.enodeId && e.enodeId === edge.snodeId,
  )
  return hasReverse ? 'paired' : 'orphan'
}

// ----------------------------------------------------------------------------
// 统一法线：行驶切线顺时针 90°（行驶方向右侧），即 (tz, -tx)，并归一化
// - 切线 (1,0) → 法线 (0,-1)；切线 (-1,0) → 法线 (0,1)
//   因此互为反向的两条 paired 边切线相反，法线也相反，自动分居中心线两侧。
// - 归一化保证 laneOffset 具有稳定米制语义（不受切线长度影响）；
//   零切线（理论不应出现，bezier tessellate 已回退）返回零向量避免 NaN。
// ----------------------------------------------------------------------------
export function normalOf(tx: number, tz: number): SceneNormal2 {
  // 顺时针 90°：(tx, tz) -> (tz, -tx)
  const nx = tz
  const nz = -tx
  const len = Math.hypot(nx, nz)
  // 零向量无法归一化，原样返回零向量，杜绝 NaN 污染下游偏移
  if (len === 0) {
    return { nx: 0, nz: 0 }
  }
  return { nx: nx / len, nz: nz / len }
}

// ----------------------------------------------------------------------------
// 偏移符号：paired 边偏移（1），孤儿边不偏移（0）
// paired 边一律向自身 +N 偏移；反向边因切线相反其 +N 指向另一侧，
// 故全图统一 sign=1 即可让双向边自然分离，无需为反向边翻号。
// 返回字面量联合 0 | 1，便于直接喂给 applyLaneOffset 的 sign 参数。
// ----------------------------------------------------------------------------
export function offsetSign(pairKind: PairKind): 0 | 1 {
  return pairKind === 'paired' ? 1 : 0
}

// ----------------------------------------------------------------------------
// 应用双车道法线偏移：point 沿 normalOf(tx,tz) * sign * laneOffset/2 平移
// - sign=0（孤儿）：偏移量为 0，返回原位置（中心线），不引入任何位移；
// - sign=1（paired）：沿行驶方向右侧法线偏移 laneOffset/2
//   （两条 paired 各偏一半 → 双车道总间距恰为 laneOffset）。
// laneOffset 由调用方传入（取自 config/constants），本函数保持纯；
// 返回新的 {x,z}，不修改入参 point。
// ----------------------------------------------------------------------------
export function applyLaneOffset(
  point: PointXZ,
  tx: number,
  tz: number,
  sign: 0 | 1,
  laneOffset: number,
): PointXZ {
  // 孤儿边不偏移：直接返回原位置，避免无谓的法线 / 乘法运算
  if (sign === 0) {
    return { x: point.x, z: point.z }
  }
  // paired 边：沿右侧单位法线偏移 laneOffset/2
  const { nx, nz } = normalOf(tx, tz)
  const delta = sign * (laneOffset / 2)
  return {
    x: point.x + nx * delta,
    z: point.z + nz * delta,
  }
}
