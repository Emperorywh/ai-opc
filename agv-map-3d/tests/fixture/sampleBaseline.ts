/*
 * 固定样本身份基线（tests/fixture，SPEC 第 2 章 / 15.1 / 15.2）。
 *
 * 定位：
 *   - 本文件集中存放 SPEC 第 2 章给出的样本身份黄金值：响应元数据、数量、类型分布、
 *     source bounds、数据质量基线、中文字符集合与第 2.6 节固定回归实体。
 *   - 这些值是 SPEC 明文给出的“期望”，不是从样本推导后回填的伪造通过结果。
 *     回归测试从受校验数据“推导”实际值，再与这些常量交叉比对，证明样本未被同 ID
 *     不同内容冒充。
 *
 * 适用边界：
 *   - 实体级可推导事实在 TASK-004 落地；SPEC 2.4 重合轨迹/双车道计数在 TASK-006
 *     （轨迹 canonical 分组算法）落地后补齐（见 SAMPLE_TRACK_COUNTS）。
 *   - 数值为 SPEC 的显示舍入值；回归断言使用 toBeCloseTo 容差比较，不在 fixture 内取整。
 *
 * 哈希常量不在此处：EXPECTED_SAMPLE_SHA256 由构建期 scripts/sample-supply-chain.mjs
 *   持有，测试直接从该模块导入，避免哈希常量出现两份。
 */

/*
 * SPEC 2.1 响应元数据固定值。
 * floor / mapState / mapVersionId 不被渲染管线消费，不进入 RawMapMetadata；
 * 此处仅作为样本身份黄金值供回归测试直接读取原始响应包校验。
 */
export const SAMPLE_METADATA = {
  code: 200,
  message: 'success',
  mapId: 'eca3f1d5803247148085688b971c54fb',
  mapName: '中环大地图',
  floor: 1,
  mapState: 'ENABLED',
  mapVersionId: 109,
  version: 'V1784091415507',
} as const

/*
 * SPEC 2.1 文件级身份（字节数、行数）。
 * SHA-256 不在此处——由 scripts/sample-supply-chain.mjs 的 EXPECTED_SAMPLE_SHA256 提供。
 */
export const SAMPLE_FILE = {
  bytes: 6_597_038,
  lines: 138_411,
} as const

/*
 * SPEC 2.2 节点数量与类型分布。
 * 四类节点数量之和必须等于 nodeTotal。
 */
export const SAMPLE_NODE_COUNTS = {
  total: 1767,
  node: 1303,
  work: 389,
  park: 64,
  charge: 11,
} as const

/*
 * SPEC 2.2 边数量、判别联合分布与方向色分布。
 * nodeArrowCount = 非 node 节点数（work + park + charge）。
 * labelCandidateTotal = 节点数 + 边数（每实体一个标签候选）。
 */
export const SAMPLE_EDGE_COUNTS = {
  total: 3043,
  LINE: 2934,
  BEZIER: 109,
  isBackEdgeFalse: 2165,
  isBackEdgeTrue: 878,
  nodeArrowCount: 464,
  edgeArrowCount: 3043,
  labelCandidateTotal: 4810,
  zones: 0,
  nodeEdgeGroups: 0,
} as const

/*
 * SPEC 2.3 节点坐标 source bounds 与基准尺寸（地图坐标系，显示舍入值）。
 * 真实样本的 source bounds 与节点 bounds 相同（边端点/控制点未越界），
 * 因此后续 normalizeSceneMap 的绝对世界原点为 (-81.82, 0, -12.54)。
 */
export const SAMPLE_BOUNDS = {
  minX: -165.74,
  maxX: 2.1,
  minY: -25.12,
  maxY: 50.2,
  width: 167.84,
  depth: 75.32,
  centerX: -81.82,
  centerY: 12.54,
} as const

/*
 * SPEC 2.3 边弦长与端点偏差数据质量基线。
 * - shortestChord：最短直线边弦长。
 * - chordBelow030Count：弦长小于 0.30m 的边数（固定 0.30m 箭头不可用的依据）。
 * - startDeviationCount / endDeviationCount：端点与引用节点坐标不重合的边起点/终点数。
 * - edgesWithDeviation：存在任一端点偏差的边记录数（SPEC 2.3 记 482）。
 * - maxStartDeviation / maxEndDeviation：最大起点/终点偏差。
 */
export const SAMPLE_EDGE_QUALITY = {
  shortestChord: 0.04,
  chordBelow030Count: 517,
  startDeviationCount: 272,
  endDeviationCount: 297,
  edgesWithDeviation: 482,
  maxStartDeviation: 0.013,
  maxEndDeviation: 0.03,
} as const

/*
 * SPEC 2.5 角度、名称与字体基线。
 * - nodeAngleNullCount：普通 node 的 angle 为 null 的数量。
 * - nonNodeAngleFiniteCount：work/park/charge 的 angle 为有限弧度的数量。
 * - chineseNodeNameCount：名称包含中文的节点数。
 * - edgeNameAllNumeric：边名是否全部为纯数字字符串。
 * - maxNameCodePoints：最长名称的 Unicode code point 数。
 * - chineseCharset：样本出现过的中文字符集合（排序字符串）。
 */
export const SAMPLE_NAME_BASELINE = {
  nodeAngleNullCount: 1303,
  nonNodeAngleFiniteCount: 464,
  chineseNodeNameCount: 66,
  edgeNameAllNumeric: true,
  maxNameCodePoints: 6,
  chineseCharset: '丝充制口抛桩点电碱站绒网门',
} as const

/*
 * SPEC 2.4 重合轨迹与双车道计数基线（TASK-006 轨迹 canonical 分组算法落地后补齐）。
 *
 * 这些值是 SPEC 第 2.4 节明文给出的“期望”，不由样本推导回填：
 *   - pairedTrackCount：精确反向重合轨迹组数（每组恰好两条、方向相反）。
 *   - pairedEdgeCount：成对边数 = pairedTrackCount × 2。
 *   - uniqueTrackCount：唯一物理轨迹数 = pairedTrackCount + 单边轨迹数。
 *   - linePairCount / cubicPairCount：按几何类型拆分的双车道组数。
 *   - falseTruePairCount / falseFalsePairCount / trueTruePairCount：按 isBackEdge 组合拆分
 *     （颜色组合只用于交叉比对，不参与分组判定）。
 *   - inexactReverseTopologyPairCount：拓扑反向但几何不精确反序的边对数（不得进入双车道组）。
 *
 * 回归测试从受校验数据“推导”实际计数后与这些常量交叉比对，证明分组算法未被同 ID
 * 不同内容冒充，且 18 对非精确反序边未被误分组。
 */
export const SAMPLE_TRACK_COUNTS = {
  pairedTrackCount: 979,
  pairedEdgeCount: 1958,
  uniqueTrackCount: 2064,
  linePairCount: 977,
  cubicPairCount: 2,
  falseTruePairCount: 868,
  falseFalsePairCount: 111,
  trueTruePairCount: 0,
  inexactReverseTopologyPairCount: 18,
} as const

/*
 * SPEC 9.3：成对边单侧中心偏移（米）；成对中心线间距 = 2 × 该值。
 */
export const PAIRED_LANE_OFFSET = 0.03
export const PAIRED_CENTERLINE_DISTANCE = PAIRED_LANE_OFFSET * 2

/*
 * SPEC 5.3 第 12 项：端点偏差门限（米）。
 * 与 validateMapSemantics 内部常量保持同一 SPEC 来源；测试据此构造“刚好超限”用例。
 */
export const ENDPOINT_DEVIATION_LIMIT = 0.05

/*
 * SPEC 5.3 第 10 项：边弦长下界（米）。
 * 与 validateMapSemantics 内部常量保持同一 SPEC 来源。
 */
export const EDGE_CHORD_EPSILON = 1e-9

/*
 * 第 2.6 节固定回归实体黄金值。
 * 每项同时记录完整 ID 与数据特征；回归测试必须按 ID 查询再交叉比对特征，
 * 禁止依赖数组下标。ID 存在但特征不符时，样本身份测试必须失败。
 *
 * 注意：两类“重合对”仅校验存在性与 isBackEdge 组合；几何是否精确反向重合
 * 依赖轨迹 canonical 分组算法（后续几何 TASK），本 TASK 不提前推导。
 */
export interface FixedNodeEntity {
  readonly kind: 'node'
  readonly id: string
  readonly type: 'node' | 'work' | 'park' | 'charge'
  readonly x: number
  readonly y: number
  readonly name: string
}

export interface FixedLineEdgeEntity {
  readonly kind: 'line'
  readonly id: string
  readonly sx: number
  readonly sy: number
  readonly ex: number
  readonly ey: number
}

export interface FixedBezierEdgeEntity {
  readonly kind: 'bezier'
  readonly id: string
  readonly sx: number
  readonly sy: number
  readonly cx: number
  readonly cy: number
  readonly dx: number
  readonly dy: number
  readonly ex: number
  readonly ey: number
}

export interface FixedDeviationEntity {
  readonly kind: 'deviation'
  readonly id: string
  readonly ex: number
  readonly ey: number
  readonly nodeId: string
  readonly nodeX: number
  readonly nodeY: number
}

export interface FixedChordEntity {
  readonly kind: 'chord'
  readonly id: string
  readonly chord: number
}

export interface FixedBackEdgePairEntity {
  readonly kind: 'backEdgePair'
  readonly ids: readonly [string, string]
  readonly isBackEdge: readonly [boolean, boolean]
}

export const FIXED_ENTITIES = {
  // 普通节点：无朝向箭头，type === 'node'，angle === null。
  normalNode: {
    kind: 'node',
    id: 'd0f03a8cbbda4c0db552804327a3eca0',
    type: 'node',
    x: 0.16,
    y: -21.29,
    name: '2',
  } as const satisfies FixedNodeEntity,
  // 中文充电节点：名称含中文，type === 'charge'，angle 为有限弧度。
  chineseChargeNode: {
    kind: 'node',
    id: '178744a47a574902aa2a9a2f0b589bdf',
    type: 'charge',
    x: -139.35,
    y: 13.6,
    name: '门口充电桩1',
  } as const satisfies FixedNodeEntity,
  // 直线边：LINE，控制点全 null。
  lineEdge: {
    kind: 'line',
    id: 'd59c4b420b78410db1d6634b999a7d7e',
    sx: -1.82,
    sy: -21.3,
    ex: -1.82,
    ey: -22.32,
  } as const satisfies FixedLineEdgeEntity,
  // 贝塞尔边：BEZIER，S/C1/C2/E 四点。
  bezierEdge: {
    kind: 'bezier',
    id: '7d85a192ccc7465d95944c62ed0ea0e5',
    sx: -85.07,
    sy: 2.94,
    cx: -85.07,
    cy: 2.44,
    dx: -84.57,
    dy: 1.94,
    ex: -84.07,
    ey: 1.94,
  } as const satisfies FixedBezierEdgeEntity,
  // 最大端点偏差示例：边终点与引用节点偏差 0.030m（仍通过 0.05m 门限）。
  maxDeviationEdge: {
    kind: 'deviation',
    id: 'a1ff1b1cc1e54f368a63219402130e58',
    ex: -120.32,
    ey: -1.35,
    nodeId: '', // 由测试按 enodeId 动态解析，避免在 fixture 硬编码拓扑对端
    nodeX: -120.35,
    nodeY: -1.35,
  } as const,
  // 最短反向边对：弦长均为 0.04m。
  shortestChordPair: [
    { kind: 'chord', id: 'fd4326119a754ccca73cfac11791b4e3', chord: 0.04 },
    { kind: 'chord', id: '291261571e3e41db924d47b7f0452de3', chord: 0.04 },
  ] as const,
  // false/false 重合对：两条边 isBackEdge 均为 false（重合性由后续几何 TASK 验证）。
  falseFalsePair: {
    kind: 'backEdgePair',
    ids: ['7a9e751a83bf462bad3beec0a359e532', 'be0a26966b784dccb33717918c22cc81'],
    isBackEdge: [false, false],
  } as const satisfies FixedBackEdgePairEntity,
  // false/true 重合对：isBackEdge 组合为 false/true。
  falseTruePair: {
    kind: 'backEdgePair',
    ids: ['0729d7e682d74e18bf35d1d070ea7095', '4e9045b85995454a9953b0dc21c88645'],
    isBackEdge: [false, true],
  } as const satisfies FixedBackEdgePairEntity,
} as const
