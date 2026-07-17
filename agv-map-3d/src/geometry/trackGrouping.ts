/*
 * 精确反向轨迹分组（geometry 层，SPEC 2.4 / 5.3 第 13 项 / 9.2 / 9.3 / 15.2 / 16）。
 *
 * 信任边界定位（TASK-006）：
 *   - 本模块消费 TASK-005 的 SceneEdge（场景坐标 x/z），输出 TrackGrouping。
 *   - 分组只看几何（控制点序列），不看 isBackEdge、snodeId/enodeId 拓扑或数组下标。
 *   - 输出是纯描述符（成对边 ID + 诊断计数），不创建 Three / React / 浏览器对象。
 *
 * isBackEdge 隔离不变量（SPEC 2.4 / 任务约束）：
 *   - isBackEdge 只决定颜色，绝不参与重合判断、方向推断、点序反转、箭头反转或车道分配。
 *   - 本模块全程不读取 isBackEdge；颜色组合统计（868 false/true、111 false/false）只由
 *     上层测试在分组结果上交叉比对，不影响分组本身。
 *
 * canonical 匹配不变量（SPEC 9.2）：
 *   - LINE canonical 正向 [S,E]、反向 [E,S]；BEZIER 正向 [S,C1,C2,E]、反向 [E,C2,C1,S]。
 *   - 两条边成对当且仅当：同 kind 且正向序列与对方反向序列逐项最大差 ≤ TRACK_MATCH_EPSILON。
 *   - 量化 key（1e-6 网格）只用于缩小候选范围；最终是否成组只由原始 number 坐标二次确认。
 *
 * 双精度确认不变量（SPEC 9.2 / 任务约束）：
 *   - 量化 cell 由 Math.round(value / EPSILON) 得到整数索引；cell 内坐标差 ≤ 0.5e-6。
 *   - 候选桶内的每一对都使用原始 number 坐标逐项比较，最大差超过 EPSILON 不得成组。
 *   - 只用字符串量化 key 而不做原始坐标二次确认的实现对落在同桶但误差 > EPSILON 的边会误分组。
 *
 * 异常不变量（SPEC 5.3 第 13 项 / 9.2）：
 *   - 三重轨迹（同桶同轨迹出现 ≥3 条或某边同时与 ≥2 条反向重合）→ MAP_GEOMETRY_INVALID。
 *   - 同向重复（正向序列逐项重合）→ MAP_GEOMETRY_INVALID。
 *   - 混合 LINE/BEZIER 同物理轨迹（贝塞尔采样点全部落在直线段 EPS 内）→ MAP_GEOMETRY_INVALID。
 *   - 上述异常整体拒绝，不返回部分分组、不跳过坏实体、不降级为单边。
 *
 * 依赖方向（SPEC 3.3）：仅依赖 domain 与本层 trackModel / centerlineSampling，不依赖上层。
 */
import { MapDataError, MapErrorCode } from '../domain/mapDataError'
import type { SceneBezierEdge, SceneEdge, ScenePoint } from '../domain/sceneMap'
import {
  BEZIER_SEGMENTS,
  TRACK_MATCH_EPSILON,
} from './trackModel'
import type {
  CoincidentTrackPair,
  TrackGrouping,
} from './trackModel'
import { sampleCenterline } from './centerlineSampling'

/*
 * 几何层逻辑路径前缀：分组错误发生在已转换的 SceneEdge 集合上，不对应原始 JSON path。
 * 用稳定逻辑路径让测试与诊断可定位失败集合，同时不伪造原始响应路径。
 */
const EDGE_LOGICAL_PATH = 'sceneMap.edges'

/*
 * 量化到 1e-6 网格的整数 cell 索引（SPEC 9.2）。
 * Math.round 到最近网格点；同一 cell 内的坐标差 ≤ 0.5 × TRACK_MATCH_EPSILON。
 * 该值只用于构造候选桶 key，不参与最终成组判定。
 */
function quantizeCell(value: number): number {
  return Math.round(value / TRACK_MATCH_EPSILON)
}

/*
 * 边的 canonical 控制点序列（SPEC 9.2）。
 *
 * - LINE：[start, end]，2 个点。
 * - BEZIER：[start, control1, control2, end]，4 个点。
 *
 * 这是分组比较的唯一几何事实来源；不读取节点坐标、不读取 isBackEdge、不读取拓扑。
 * 点序保持“边自身 start → end”；反向序列由比较函数按 SPEC 顺序显式反转。
 */
function canonicalPoints(edge: SceneEdge): readonly ScenePoint[] {
  if (edge.kind === 'line') {
    return [edge.start, edge.end]
  }
  const bez = edge as SceneBezierEdge
  return [bez.start, bez.control1, bez.control2, bez.end]
}

/*
 * 无向候选桶 key（SPEC 9.2 “无向候选桶”）。
 *
 * 把 canonical 点量化到 cell 后排序拼接，得到与方向无关、与点序无关的字符串 key：
 *   - 边 A=[S,E] 与其反向边 B=[E,S] 的排序 cell 多重集相同 → 同桶。
 *   - BEZIER [S,C1,C2,E] 与反向 [E,C2,C1,S] 的排序 cell 多重集相同 → 同桶。
 *
 * LINE（2 cell）与 BEZIER（4 cell）的 cell 数不同，天然分桶；本函数不做 kind 区分，
 * 由桶内比较函数再按 kind 校验，避免在同桶内跨类型比较。
 */
function undirectedBucketKey(edge: SceneEdge): string {
  const cells = canonicalPoints(edge).map(
    (p) => `${quantizeCell(p.x)}:${quantizeCell(p.z)}`,
  )
  cells.sort()
  return cells.join('|')
}

/*
 * canonical 序列正向 / 反向逐项最大坐标差（SPEC 9.2 双精度确认）。
 *
 * forward：ca[i] 对 cb[i]；reverse：ca[i] 对 cb[n-1-i]。
 * 返回两个方向的最大绝对坐标差，调用方据此判断是否 ≤ TRACK_MATCH_EPSILON。
 * 使用原始 number 坐标，不含量化误差，是最终成组判定的唯一依据。
 */
function directionalMaxDiff(
  ca: readonly ScenePoint[],
  cb: readonly ScenePoint[],
): { readonly forward: number; readonly reverse: number } {
  const n = ca.length
  let forward = 0
  let reverse = 0
  for (let i = 0; i < n; i++) {
    const ri = n - 1 - i
    forward = Math.max(
      forward,
      Math.abs(ca[i].x - cb[i].x),
      Math.abs(ca[i].z - cb[i].z),
    )
    reverse = Math.max(
      reverse,
      Math.abs(ca[i].x - cb[ri].x),
      Math.abs(ca[i].z - cb[ri].z),
    )
  }
  return { forward, reverse }
}

/*
 * 两同 kind 边的几何方向关系（SPEC 9.2）。
 *
 * - 'reverse'：正向序列与对方反向序列逐项重合（精确反向成对）。
 * - 'forward'：正向序列与对方正向序列逐项重合（同向重复，属错误）。
 * - 'none'：既不正向也不反向重合。
 *
 * 调用方必须保证 a.kind === b.kind；本函数对跨 kind 直接返回 'none'
 * （跨类型同轨迹由 detectMixedTypeTrack 独立扫描，避免在同桶内做无意义比较）。
 * 当正反向都重合（控制点对称退化）时按 'forward' 处理，交由同向重复错误兜底。
 */
function sameKindDirection(
  a: SceneEdge,
  b: SceneEdge,
): 'reverse' | 'forward' | 'none' {
  if (a.kind !== b.kind) return 'none'
  const { forward, reverse } = directionalMaxDiff(
    canonicalPoints(a),
    canonicalPoints(b),
  )
  const fwd = forward <= TRACK_MATCH_EPSILON
  const rev = reverse <= TRACK_MATCH_EPSILON
  if (fwd) return 'forward'
  if (rev) return 'reverse'
  return 'none'
}

/*
 * 分组错误（SPEC 14.1 MAP_GEOMETRY_INVALID）。
 * 整体拒绝，不返回部分分组；message 必须含可读中文，便于 overlay 与测试匹配。
 */
function groupingError(message: string, context?: Readonly<Record<string, unknown>>): MapDataError {
  return new MapDataError({
    code: MapErrorCode.MAP_GEOMETRY_INVALID,
    message,
    jsonPath: EDGE_LOGICAL_PATH,
    context,
  })
}

/*
 * 点到线段的距离（用于跨类型同轨迹判定）。
 * 标准投影+夹紧算法；只消费已转换的场景坐标，不引入坐标变换。
 */
function distancePointToSegment(
  p: ScenePoint,
  a: ScenePoint,
  b: ScenePoint,
): number {
  const abx = b.x - a.x
  const abz = b.z - a.z
  const apx = p.x - a.x
  const apz = p.z - a.z
  const abLenSq = abx * abx + abz * abz
  // 线段退化的情况由上游弦长校验排除（chord > 1e-9），此处 abLenSq > 0。
  const t = abLenSq > 0 ? Math.max(0, Math.min(1, (apx * abx + apz * abz) / abLenSq)) : 0
  const cx = a.x + t * abx
  const cz = a.z + t * abz
  return Math.hypot(p.x - cx, p.z - cz)
}

/*
 * 跨类型同轨迹扫描：检测 LINE 与 BEZIER 是否落在同一物理轨迹（SPEC 9.2 混合边类型）。
 *
 * 设计理由：
 *   - 主分桶按 canonical 控制点排序 cell，LINE（2 点）与 BEZIER（4 点）cell 数不同，天然分桶，
 *     因此同桶内永远不会出现 LINE 与 BEZIER，主流程无法发现跨类型同轨迹。
 *   - 混合类型同轨迹是 SPEC 明确禁止的错误形态，必须独立扫描才能发现。
 *
 * 扫描策略：
 *   - 按“端点 [start,end] 量化 cell 的无向 key”二次分桶；端点 key 相同的 LINE 与 BEZIER 才可能同轨迹。
 *   - 对每个同时含 LINE 与 BEZIER 的端点桶，逐对采样 BEZIER（33 点），
 *     若全部采样点到 LINE 段的距离 ≤ TRACK_MATCH_EPSILON，则判定为同一物理轨迹 → 报错。
 *   - 真实样本不存在该形态（979 组全部同类型），该扫描对真实样本计数无影响。
 */
function detectMixedTypeTrack(edges: readonly SceneEdge[]): void {
  // 端点无向 key 分桶。
  const endpointBuckets = new Map<string, { lines: SceneEdge[]; beziers: SceneEdge[] }>()
  for (const edge of edges) {
    const cells = [edge.start, edge.end]
      .map((p) => `${quantizeCell(p.x)}:${quantizeCell(p.z)}`)
      .sort()
      .join('|')
    let entry = endpointBuckets.get(cells)
    if (!entry) {
      entry = { lines: [], beziers: [] }
      endpointBuckets.set(cells, entry)
    }
    if (edge.kind === 'line') entry.lines.push(edge)
    else entry.beziers.push(edge)
  }

  for (const { lines, beziers } of endpointBuckets.values()) {
    if (lines.length === 0 || beziers.length === 0) continue
    for (const line of lines) {
      for (const bez of beziers) {
        if (lineBezierPathCoincident(line, bez as SceneBezierEdge)) {
          throw groupingError(
            '存在 LINE 与 BEZIER 落在同一物理轨迹的混合类型轨迹组，v1 不支持该形态。',
            { lineId: line.id, bezierId: bez.id },
          )
        }
      }
    }
  }
}

/*
 * 判定 BEZIER 是否落在 LINE 段上（SPEC 9.2 混合边类型几何确认）。
 *
 * 端点已由外层端点桶匹配（无向），此处只需验证曲线全部采样点都在直线段容差内。
 * 采样复用 sampleCenterline（固定 33 点），保证与主采样口径一致。
 * 任一采样点到 LINE 段距离 > TRACK_MATCH_EPSILON 即判定为不同轨迹。
 */
function lineBezierPathCoincident(
  line: SceneEdge,
  bez: SceneBezierEdge,
): boolean {
  if (line.kind !== 'line') return false
  const samples = sampleCenterline(bez)
  for (const p of samples) {
    if (distancePointToSegment(p, line.start, line.end) > TRACK_MATCH_EPSILON) {
      return false
    }
  }
  return true
}

/*
 * 主分组入口：识别精确反向成对轨迹并校验异常形态（SPEC 9.2 / 5.3 第 13 项）。
 *
 * 调用方契约：
 *   - 输入是 TASK-005 交付的 SceneEdge 数组（场景坐标，已通过实体级语义校验）。
 *   - 成功返回 TrackGrouping：成对 ID、成对边集合与诊断计数。
 *   - 失败抛出 MAP_GEOMETRY_INVALID：三重、同向重复、混合类型等异常整体拒绝。
 *
 * 算法（SPEC 9.2）：
 *   1. 跨类型同轨迹扫描（防御性，主分桶按 cell 数天然隔离类型）。
 *   2. 按 canonical 控制点无向 cell key 分桶。
 *   3. 桶内同 kind 两两比较：同向重合 → 报错；精确反向 → 候选成对。
 *   4. 每条边至多落入一个反向对（度 ≥2 → 三重报错）。
 *   5. 统计成对组数、成对边数、唯一物理轨迹数与按 kind 的拆分计数。
 */
export function groupCoincidentTracks(
  edges: readonly SceneEdge[],
): TrackGrouping {
  // 1. 跨类型同轨迹扫描（SPEC 9.2 混合边类型）。
  detectMixedTypeTrack(edges)

  // 2. canonical 无向 cell key 分桶，保留首次入桶顺序以便成对 ID 顺序稳定。
  const buckets = new Map<string, SceneEdge[]>()
  for (const edge of edges) {
    const key = undirectedBucketKey(edge)
    let arr = buckets.get(key)
    if (!arr) {
      arr = []
      buckets.set(key, arr)
    }
    arr.push(edge)
  }

  const pairs: CoincidentTrackPair[] = []
  const pairedEdgeIds = new Set<string>()
  let linePairCount = 0
  let cubicPairCount = 0

  for (const bucket of buckets.values()) {
    if (bucket.length < 2) continue
    // 桶内同 kind 两两比较；不同 kind 不在同桶（cell 数不同），防御性断言。
    const reversePairs: Array<[number, number]> = []
    const degree = new Array<number>(bucket.length).fill(0)
    for (let i = 0; i < bucket.length; i++) {
      for (let j = i + 1; j < bucket.length; j++) {
        const a = bucket[i]
        const b = bucket[j]
        // cell 数不同 → 不同 kind；防御性跳过（不应进入此分支）。
        if (a.kind !== b.kind) continue
        const rel = sameKindDirection(a, b)
        if (rel === 'forward') {
          throw groupingError(
            '存在同向重复轨迹：两条边正向控制点序列在容差内完全重合。',
            { edgeAId: a.id, edgeBId: b.id },
          )
        }
        if (rel === 'reverse') {
          reversePairs.push([i, j])
          degree[i] += 1
          degree[j] += 1
        }
      }
    }
    // 度 ≥2 表示某边同时与 ≥2 条边反向重合 → 三重轨迹。
    for (let i = 0; i < bucket.length; i++) {
      if (degree[i] >= 2) {
        throw groupingError(
          '存在三重（或更多）轨迹：同一物理轨迹出现超过两条精确反向边。',
          { edgeId: bucket[i].id, degree: degree[i] },
        )
      }
    }
    // 记录成对组（顺序：扫描时先出现者在前）。
    for (const [i, j] of reversePairs) {
      const a = bucket[i]
      const b = bucket[j]
      const kind = a.kind === 'line' ? 'line' : 'cubic'
      pairs.push({ kind, edgeIds: [a.id, b.id] })
      pairedEdgeIds.add(a.id)
      pairedEdgeIds.add(b.id)
      if (kind === 'line') linePairCount += 1
      else cubicPairCount += 1
    }
  }

  const pairedTrackCount = pairs.length
  const pairedEdgeCount = pairedEdgeIds.size
  // 唯一物理轨迹数 = 成对组数 + 未成对的单边轨迹数。
  const uniqueTrackCount = pairedTrackCount + (edges.length - pairedEdgeCount)

  return {
    pairs,
    pairedEdgeIds,
    pairedTrackCount,
    pairedEdgeCount,
    uniqueTrackCount,
    linePairCount,
    cubicPairCount,
  }
}

/*
 * 重新导出 BEZIER_SEGMENTS，供需要与采样口径对齐的调用方引用同一常量。
 */
export { BEZIER_SEGMENTS }
