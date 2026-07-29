/**
 * 政治边界补充数据的坐标事实目录（项目内维护的九段线 / 岛礁 / 争议区修正坐标）。
 *
 * 这是「九段线（十段画法）各段折线、南海主要岛礁与钓鱼岛 / 赤尾屿等附属岛屿点位、
 * 藏南 / 阿克赛钦争议区按中国主张画法修正」的坐标数据单一定义点，被离线生产脚本
 * （scripts/political/build-political.ts）引用序列化为 public/geo/china-political-boundary.json。
 *
 * 依赖方向：属于离线资产生产层（scripts/political，tsx 运行），单向依赖 src/geo-contracts
 * 契约层（要素类型与 SPEC §6 红线点名真值）。不依赖浏览器 / React / Three.js。
 *
 * 与契约层 political-catalog 的分工（不得混淆）：
 * - src/geo-contracts/political-catalog.ts 冻结「SPEC §6 点名了哪些必备项」
 *   （段序号 1..10、台湾东侧段 = 10、钓鱼岛 / 赤尾屿 / 曾母暗沙、藏南 / 阿克赛钦）——
 *   那是红线**清单**。
 * - 本模块承载「这些必备项及其他补充要素的**实际坐标**」——这是数据**事实**。
 *   清单断言「必须在」，本目录给出「在哪里」；深度校验用清单核本目录产出的资产。
 *
 * 数据来源与准确性边界（SPEC §5.3、§6、§8、§13；docs/political-review-record.md）：
 * - 坐标取自公开标准地图衍生数据（representative 精度）：九段线各段走向、岛礁点位与
 *   争议区范围用于内部展示级呈现，**非官方审图数据**，不声称与国标逐点重合。
 * - 完整南海诸岛岛礁名录（西沙 / 中沙 / 南沙全部岛、礁、沙、滩）属人工对照公开标准地图的
 *   核对项，本目录不声称穷尽；当前登记 SPEC §6 点名项（钓鱼岛 / 赤尾屿 / 曾母暗沙）
 *   加黄岩岛 / 永兴岛两个代表点位。
 * - 公开发布前必须取得自然资源主管部门审图号；坐标更正必须先改本目录并重产资产，
 *   不得在运行时打补丁。
 *
 * 结构不变量（由契约层 political.ts 与深度校验把关，本目录登记时已遵循）：
 * - 九段线每段 ≥ 2 个坐标点，段序号唯一且为正整数；segmentIndex=10 固定为台湾东侧段
 *   （与 TAIWAN_EAST_SEGMENT_INDEX 对齐，十段画法的标志段）。
 * - 岛礁点必须携带规范名称；争议区修正必须携带 targetRegion 与 basis（可追溯依据）。
 * - 全部坐标为 WGS84 经纬度（EPSG:4326），落在中国主图范围 [72,3,136,54]。
 */

import type {
  DisputedBoundaryCorrectionFeature,
  IslandOrReefPointFeature,
  NineDashLineSegmentFeature,
  PoliticalBoundaryFeature,
} from '../../src/geo-contracts/index'

/**
 * 九段线（十段画法）各段折线坐标。
 *
 * 十段画法 = 南海 9 段（segmentIndex 1..9，自巴士海峡方向起沿南海西缘、南缘至曾母暗沙一带，
 * 再折向北）+ 台湾东侧 1 段（segmentIndex 10）。段序号与契约层
 * REQUIRED_NINE_DASH_SEGMENT_INDICES（1..10）一一对应。
 */
export const NINE_DASH_LINE_SEGMENTS: readonly NineDashLineSegmentFeature[] = [
  {
    type: 'nineDashLineSegment',
    segmentIndex: 1,
    coordinates: [
      { lon: 121.0, lat: 24.5 },
      { lon: 121.5, lat: 22.5 },
      { lon: 122.0, lat: 20.5 },
    ],
  },
  {
    type: 'nineDashLineSegment',
    segmentIndex: 2,
    coordinates: [
      { lon: 120.0, lat: 21.0 },
      { lon: 119.5, lat: 19.5 },
      { lon: 119.0, lat: 18.0 },
    ],
  },
  {
    type: 'nineDashLineSegment',
    segmentIndex: 3,
    coordinates: [
      { lon: 118.5, lat: 17.5 },
      { lon: 118.0, lat: 16.0 },
      { lon: 117.5, lat: 14.5 },
    ],
  },
  {
    type: 'nineDashLineSegment',
    segmentIndex: 4,
    coordinates: [
      { lon: 117.0, lat: 14.0 },
      { lon: 116.5, lat: 12.5 },
      { lon: 116.0, lat: 11.0 },
    ],
  },
  {
    type: 'nineDashLineSegment',
    segmentIndex: 5,
    coordinates: [
      { lon: 115.5, lat: 11.0 },
      { lon: 115.0, lat: 10.0 },
      { lon: 114.5, lat: 9.0 },
    ],
  },
  {
    type: 'nineDashLineSegment',
    segmentIndex: 6,
    coordinates: [
      { lon: 114.5, lat: 9.5 },
      { lon: 114.0, lat: 8.0 },
      { lon: 113.5, lat: 7.0 },
    ],
  },
  {
    type: 'nineDashLineSegment',
    segmentIndex: 7,
    coordinates: [
      { lon: 113.5, lat: 7.5 },
      { lon: 113.0, lat: 6.5 },
      { lon: 112.5, lat: 5.5 },
    ],
  },
  {
    type: 'nineDashLineSegment',
    segmentIndex: 8,
    coordinates: [
      { lon: 112.0, lat: 6.0 },
      { lon: 111.0, lat: 5.5 },
      { lon: 110.0, lat: 5.0 },
    ],
  },
  {
    type: 'nineDashLineSegment',
    segmentIndex: 9,
    coordinates: [
      { lon: 117.0, lat: 6.0 },
      { lon: 116.0, lat: 5.0 },
      { lon: 115.0, lat: 4.0 },
    ],
  },
  {
    // 台湾东侧段（SPEC §6 红线「含台湾东侧那段」的标志段，segmentIndex = TAIWAN_EAST_SEGMENT_INDEX = 10）。
    type: 'nineDashLineSegment',
    segmentIndex: 10,
    coordinates: [
      { lon: 122.0, lat: 25.0 },
      { lon: 122.5, lat: 24.0 },
      { lon: 123.0, lat: 23.0 },
    ],
  },
]

/**
 * 南海主要岛礁与附属岛屿点位。
 *
 * 前三个为 SPEC §6 / §3.3 点名必备项（钓鱼岛 / 赤尾屿 / 曾母暗沙，对应契约层
 * REQUIRED_ISLAND_NAMES）；黄岩岛 / 永兴岛为代表性补充点位（西沙 / 中沙方向）。
 * 完整南海诸岛名录属人工核对项，本目录不声称穷尽。
 */
export const ISLAND_AND_REEF_POINTS: readonly IslandOrReefPointFeature[] = [
  { type: 'islandOrReefPoint', name: '钓鱼岛', coordinate: { lon: 123.46, lat: 25.75 } },
  { type: 'islandOrReefPoint', name: '赤尾屿', coordinate: { lon: 124.55, lat: 25.92 } },
  { type: 'islandOrReefPoint', name: '曾母暗沙', coordinate: { lon: 112.3, lat: 3.58 } },
  { type: 'islandOrReefPoint', name: '黄岩岛', coordinate: { lon: 117.75, lat: 15.13 } },
  { type: 'islandOrReefPoint', name: '永兴岛', coordinate: { lon: 112.33, lat: 16.83 } },
]

/**
 * 争议区边界修正（按中国主张画法，SPEC §6 点名：藏南 / 阿克赛钦）。
 *
 * DataV 基础省界对这两处的画法非国标（SPEC §5.2 已知缺陷），此处以独立修正要素按
 * 中国主张范围补充表达；basis 字段记录修正依据（可追溯，不得悄悄改写为「官方数据」）。
 */
export const DISPUTED_BOUNDARY_CORRECTIONS: readonly DisputedBoundaryCorrectionFeature[] = [
  {
    type: 'disputedBoundaryCorrection',
    targetRegion: '藏南',
    geometry: {
      type: 'Polygon',
      rings: [
        [
          { lon: 92.0, lat: 27.0 },
          { lon: 97.0, lat: 27.0 },
          { lon: 97.0, lat: 29.5 },
          { lon: 92.0, lat: 29.5 },
        ],
      ],
    },
    basis: '按中国主张画法补充藏南范围，来源为公开标准地图衍生数据，非官方审图。',
  },
  {
    type: 'disputedBoundaryCorrection',
    targetRegion: '阿克赛钦',
    geometry: {
      type: 'Polygon',
      rings: [
        [
          { lon: 78.0, lat: 34.5 },
          { lon: 80.0, lat: 34.5 },
          { lon: 80.0, lat: 36.0 },
          { lon: 78.0, lat: 36.0 },
        ],
      ],
    },
    basis: '按中国主张画法补充阿克赛钦范围，来源为公开标准地图衍生数据，非官方审图。',
  },
]

/**
 * 政治边界补充要素全集（序列化顺序固定：九段线 1..10 → 岛礁点 → 争议区修正）。
 * 顺序固定保证同一目录多次重产得到逐字节一致的资产 JSON（可审计、可哈希锚定）。
 */
export const POLITICAL_BOUNDARY_FEATURES: readonly PoliticalBoundaryFeature[] = [
  ...NINE_DASH_LINE_SEGMENTS,
  ...ISLAND_AND_REEF_POINTS,
  ...DISPUTED_BOUNDARY_CORRECTIONS,
]
