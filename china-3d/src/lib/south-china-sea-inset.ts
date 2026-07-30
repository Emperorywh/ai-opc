/**
 * 南海诸岛 2D 标准附图的数据准备（领域层，TASK-012，SPEC §3.8 / §5.4 / §6）。
 *
 * 角色与依赖方向：
 * - 本模块属于运行时访问层（src/lib），把「政治边界补充契约（PoliticalBoundaryContract，TASK-004 共享
 *   事实源，与主图 3D 政治要素层 src/lib/political-features 同源）+ 附图 2D 子范围四至（InsetExtent）
 *   + 标注布局参数（viewBox / 字号 / 点径 / 偏移，由配置层传入）」确定性地变换为「十段线各段的归一化
 *   视口 (u,v) 折线 + 岛礁点位的归一化视口 (u,v) + 规范名称 + 标注摆放（锚点 + 偏移）」，供渲染层
 *   （src/components/SouthChinaSeaInset 的 SVG overlay）只消费、不再计算。
 * - 单向依赖：契约层 src/geo-contracts（PoliticalBoundaryContract 类型、红线点名领域真值
 *   political-catalog 的 EXPECTED_NINE_DASH_SEGMENT_COUNT / TAIWAN_EAST_SEGMENT_INDEX）、同层坐标权威
 *   src/lib/projection（projectToInset——lon/lat→附图归一化视口 (u,v) 的唯一入口，内部走与主图同一
 *   projectToMercator；InsetExtent / InsetViewportPoint 类型）、同层红线扫描共享单源
 *   src/lib/political-red-line（collectPoliticalRedLineGaps）。禁止依赖 React / R3F / Three.js / DOM /
 *   hover 状态 / src/config（与主图政治要素准备层同构的分层约束；标注布局参数经入参配置传入，见
 *   SouthChinaSeaInsetPrepConfig）。
 *
 * 唯一事实源（SPEC §5.4「复用 §5.2 边界 + §5.3 九段线/岛礁数据，投影到附图 2D 子范围」）：
 * - 十段线段序号、岛礁规范名称与坐标全部来自入参 PoliticalBoundaryContract（由 src/lib/political-boundary
 *   从 public/geo/china-political-boundary.json 加载，与主图政治要素层 fetch 同一份资产）。本模块不内置
 *   任何坐标、不补写任何段或点、不维护第二套十段线 / 岛礁数组。
 * - 坐标变换复用 projectToInset（TASK-002 同一墨卡托投影的 2D 子范围映射）：同一岛礁点位在主图
 *   （projectToWorld）与附图（projectToInset）来自同一墨卡托结果，仅视口映射不同（SPEC §3.8「坐标用
 *   同一 geoMercator 投影的 2D 子范围」）。本模块把 projectToInset 的成功值 InsetViewportPoint 直接作为
 *   折线顶点 / 点位坐标，不重组、不二次归一化、不引入第二套投影公式。
 *
 * 标注摆放（「标注齐全」的两层含义：名称都在 + 全部可读不被裁剪不互叠）：
 * - 岛礁规范名称默认放在光点右侧（text-anchor=start，标准读图惯例）。但钓鱼岛 / 赤尾屿贴近附图东缘且
 *   二者几乎同纬度相邻：右锚会越出 viewBox 被边框裁剪，双左锚又让两个名称横向互叠成不可读的一团
 *   （无头实测截图确认）。故准备层对每个岛礁做确定性贪心摆放：按固定候选序
 *   [右(start) → 左(end) → 上(middle) → 下(middle)] 取第一个「完整落在边框内且不与已摆放标注盒相交」
 *   的候选；标注盒用 CJK 全宽字形近似（宽 = 字数 × 字号，上沿 0.85em / 下沿 0.15em）。处理顺序 = 契约
 *   出现顺序（确定、单源），无随机、无迭代收敛。四个候选均不可放的退化情形（生产数据不存在）回退右锚
 *   ——由「生产资产全部标注框内且不互叠」的不变量测试兜底，任何数据 / 配置漂移会在构建期爆响。
 * - 摆放只输出「决策」（labelAnchor + labelDx/labelDy，viewBox user units 的相对光点偏移）；渲染层做
 *   x = cx + labelDx、y = cy + labelDy、textAnchor = labelAnchor 的纯映射，零决策。
 *
 * 红线完整性（SPEC §6：十段含台湾东侧段、点名岛礁均在；删台湾东侧段或任一点名岛礁 → 附图准备明确失败，
 * 不能静默显示残缺附图）：
 * - 准备入口对红线缺项做独立断言：collectPoliticalRedLineGaps（src/lib/political-red-line，TASK-004 抽取
 *   的共享扫描单源）扫描契约、对照 political-catalog 同一份红线目录，返回缺项；本模块据缺项按既定顺序
 *   抛 SouthChinaSeaInsetPrepError（稳定 code，south-china-sea-inset.* 前缀）。任一缺段（尤其台湾东侧
 *   第 10 段）/ 缺点名岛礁 → 整条准备失败，绝不产出「缺段 / 缺点的残缺附图」（残缺附图会把「政治边界
 *   不完整」伪装成「成功呈现」，违反 SPEC §6 红线「南海诸岛右下 2D 附图作为合规惯例存在」）。
 * - 红线「目录」与「扫描逻辑」与主图政治要素准备（src/lib/political-features）共用同一份单源，本模块
 *   只是 collectPoliticalRedLineGaps 的第二个消费者、抛各自错误码，不存在第二套段数 / 段序号 / 岛礁名
 *   清单或扫描代码。
 * - 十段线按段（segmentIndex）独立组织输出（PreparedInsetLine[]），不合并为单条连续折线——使每段可
 *   独立审计、台湾东侧段（segmentIndex=10）可独立定位（与主图政治要素层同构）。
 *
 * 异常语义（与主图政治要素准备同构：无效输入或查询失败时整条准备明确失败）：
 * - 输入非法（features 空 / 布局配置非有限）→ 抛 empty-features / config-not-finite。
 * - 红线缺项 → 抛对应 code（segment-count-mismatch / segment-missing / taiwan-east-segment-missing /
 *   required-island-missing）。
 * - 任一顶点 projectToInset 失败（越出附图四至——正常四至含全部红线要素，不触发；畸形四至或越界坐标
 *   会触发）→ 抛 projection-failed，绝不产出部分折线 / 部分点位。
 * - 渲染层（src/components/SouthChinaSeaInset）捕获任一上述错误后按 SPEC §6 红线上报整页错误（与
 *   TASK-011 主图政治要素同一暴露通道），不静默显示残缺附图、不崩溃页面其余有效层。
 */

import type { PoliticalBoundaryContract } from '../geo-contracts'
import { EXPECTED_NINE_DASH_SEGMENT_COUNT, TAIWAN_EAST_SEGMENT_INDEX } from '../geo-contracts'
import { collectPoliticalRedLineGaps } from './political-red-line'
import { projectToInset } from './projection'
import type { InsetExtent, InsetViewportPoint } from './projection'

/**
 * 准备好的单段十段线（附图 2D 视口）。
 *
 * 按 segmentIndex 独立组织（不与其他段合并为连续折线），使每段可独立审计、台湾东侧段（segmentIndex=10）
 * 可独立定位。uvPolyline 为该段各顶点的归一化视口坐标 (u,v)∈[0,1]²，由 projectToInset 投影得到。
 */
export interface PreparedInsetLine {
  /** 段序号（1..10），与源契约 segmentIndex 一一对应；台湾东侧段 segmentIndex=10。 */
  readonly segmentIndex: number
  /** 该段折线顶点的归一化视口坐标（u 随经度向东、v 随纬度向北），直接复用 projectToInset 成功值。 */
  readonly uvPolyline: readonly InsetViewportPoint[]
}

/** 岛礁规范名称标注锚点（SVG text-anchor 取值）：'start' 右锚 / 'end' 左锚 / 'middle' 居中（上 / 下）。 */
export type InsetLabelAnchor = 'start' | 'end' | 'middle'

/** 准备好的单个岛礁 / 附属岛屿点位（附图 2D 视口，含规范名称与标注摆放决策）。 */
export interface PreparedInsetPoint {
  /** 规范名称（钓鱼岛 / 赤尾屿 / 曾母暗沙 / 黄岩岛 / 永兴岛），与源契约 name 一一对应。 */
  readonly name: string
  /** 归一化视口 u（随经度向东，由 projectToInset 得到）。 */
  readonly u: number
  /** 归一化视口 v（随纬度向北，由 projectToInset 得到）。 */
  readonly v: number
  /** 标注锚点（SVG text-anchor），由准备层贪心摆放裁决，渲染层只消费。 */
  readonly labelAnchor: InsetLabelAnchor
  /** 标注相对光点的 viewBox 横向偏移（user units）：渲染层 labelX = cx + labelDx。 */
  readonly labelDx: number
  /** 标注相对光点的 viewBox 纵向偏移（user units，基线）：渲染层 labelY = cy + labelDy。 */
  readonly labelDy: number
}

/** 准备好的南海附图全部要素（渲染层 SVG overlay 直接消费的稳定产物）。 */
export interface PreparedSouthChinaSeaInset {
  /** 十段线各段（按 segmentIndex 升序，台湾东侧段 segmentIndex=10 在内）。 */
  readonly lines: readonly PreparedInsetLine[]
  /** 岛礁 / 附属岛屿点位 + 规范名称与标注摆放（按源契约出现顺序）。 */
  readonly points: readonly PreparedInsetPoint[]
}

/**
 * 南海附图准备的入参配置（领域层声明的「我需要什么」，由 src/config/south-china-sea-inset 提供具体值）。
 *
 * 与省界 ProvinceBorderPrepConfig / 政治要素 PoliticalFeaturePrepConfig 同构：配置值由调用方（渲染层
 * 装配处）从配置层取出传入，本模块不反向依赖 src/config。标注摆放需要 viewBox 尺度与字形度量
 * （标注盒是否出框 / 互叠在该尺度下判定）。
 */
export interface SouthChinaSeaInsetPrepConfig {
  /** SVG viewBox 宽度（user units）。 */
  readonly viewboxWidth: number
  /** SVG viewBox 高度（user units，墨卡托比例派生）。 */
  readonly viewboxHeight: number
  /** 规范名称字号（user units，CJK 全宽字形宽 ≈ 1em）。 */
  readonly labelFontSize: number
  /** 岛礁光点半径（user units），标注与光点的间隔基量。 */
  readonly pointRadius: number
  /** 规范名称相对光点的横向 / 纵向间隔（user units）。 */
  readonly labelOffsetX: number
  /** 附图边框内边距（user units），标注盒不得越过（= 边框描边宽度）。 */
  readonly frameMargin: number
}

/** 准备失败的稳定错误码（供自动化测试精确断言「缺段 / 缺点 / 越界 → 附图准备明确失败」）。 */
export type SouthChinaSeaInsetPrepFailureCode =
  | 'south-china-sea-inset.empty-features'
  | 'south-china-sea-inset.config-not-finite'
  | 'south-china-sea-inset.segment-count-mismatch'
  | 'south-china-sea-inset.segment-missing'
  | 'south-china-sea-inset.taiwan-east-segment-missing'
  | 'south-china-sea-inset.required-island-missing'
  | 'south-china-sea-inset.projection-failed'

/**
 * 南海附图准备错误：携带稳定 code 与简体中文说明。
 * 红线缺项（段 / 点）、空契约、配置非法、或任一投影失败时抛出，使整条准备明确失败、不产出残缺附图。
 */
export class SouthChinaSeaInsetPrepError extends Error {
  readonly code: SouthChinaSeaInsetPrepFailureCode
  constructor(code: SouthChinaSeaInsetPrepFailureCode, message: string) {
    super(message)
    this.name = 'SouthChinaSeaInsetPrepError'
    this.code = code
  }
}

/** CJK 全宽字形的标注盒度量（em 分数）：上沿 0.85em、下沿 0.15em（基线以上 / 以下）。 */
const LABEL_ASCENT_EM = 0.85
const LABEL_DESCENT_EM = 0.15

/** 标注盒（viewBox user units 轴对齐矩形），用于出框与互叠判定。 */
interface LabelBox {
  readonly x0: number
  readonly y0: number
  readonly x1: number
  readonly y1: number
}

/** 标注摆放候选（固定优先级序：右 → 左 → 上 → 下）。 */
interface LabelCandidate {
  readonly anchor: InsetLabelAnchor
  readonly dx: number
  readonly dy: number
}

/**
 * 计算某候选下的标注盒。name 为 CJK 全宽字形（宽 = 字数 × 字号）；cx/cy 为光点 viewBox 坐标。
 */
function computeLabelBox(
  cx: number,
  cy: number,
  name: string,
  candidate: LabelCandidate,
  fontSize: number,
): LabelBox {
  const width = name.length * fontSize
  const x0 =
    candidate.anchor === 'start'
      ? cx + candidate.dx
      : candidate.anchor === 'end'
        ? cx + candidate.dx - width
        : cx + candidate.dx - width / 2
  const baseline = cy + candidate.dy
  return {
    x0,
    y0: baseline - LABEL_ASCENT_EM * fontSize,
    x1: x0 + width,
    y1: baseline + LABEL_DESCENT_EM * fontSize,
  }
}

/** 标注盒是否完整落在边框内（留 frameMargin 内边距）。 */
function boxFitsFrame(box: LabelBox, width: number, height: number, margin: number): boolean {
  return box.x0 >= margin && box.x1 <= width - margin && box.y0 >= margin && box.y1 <= height - margin
}

/** 两个标注盒是否相交（互叠）。 */
function boxesOverlap(a: LabelBox, b: LabelBox): boolean {
  return a.x0 < b.x1 && a.x1 > b.x0 && a.y0 < b.y1 && a.y1 > b.y0
}

/**
 * 为单个岛礁点位确定性摆放规范名称标注（贪心：固定候选序取第一个框内且不互叠者）。
 *
 * 候选序（详见模块头「标注摆放」）：
 * 1. 右（start，dx = r+gap，dy = fs/3——基线微抬与光点视觉居中）：标准读图惯例，首选。
 * 2. 左（end）：贴东缘点位防右锚出框。
 * 3. 上（middle，基线 = 光点上方 r+gap）：同纬度相邻点位（钓鱼岛 / 赤尾屿）左右锚都互叠时的解。
 * 4. 下（middle，基线 = 光点下方 r+gap+0.85em）。
 * 均不可放（生产数据不存在的退化情形）回退右锚——不静默残缺，由「生产标注框内不互叠」不变量测试兜底。
 *
 * @param placed 已摆放的标注盒（按契约顺序先入先判），本函数不修改它（调用方推入）。
 */
function placeIslandLabel(
  cx: number,
  cy: number,
  name: string,
  config: SouthChinaSeaInsetPrepConfig,
  placed: readonly LabelBox[],
): { readonly anchor: InsetLabelAnchor; readonly dx: number; readonly dy: number } {
  const r = config.pointRadius
  const gap = config.labelOffsetX
  const fs = config.labelFontSize
  const candidates: readonly LabelCandidate[] = [
    { anchor: 'start', dx: r + gap, dy: fs / 3 },
    { anchor: 'end', dx: -(r + gap), dy: fs / 3 },
    { anchor: 'middle', dx: 0, dy: -(r + gap) },
    { anchor: 'middle', dx: 0, dy: r + gap + LABEL_ASCENT_EM * fs },
  ]
  for (const candidate of candidates) {
    const box = computeLabelBox(cx, cy, name, candidate, fs)
    if (!boxFitsFrame(box, config.viewboxWidth, config.viewboxHeight, config.frameMargin)) continue
    if (placed.some((other) => boxesOverlap(box, other))) continue
    return { anchor: candidate.anchor, dx: candidate.dx, dy: candidate.dy }
  }
  // 退化回退：四候选均不可放（生产数据不存在），回退右锚标准惯例。
  const fallback = candidates[0]
  return { anchor: fallback.anchor, dx: fallback.dx, dy: fallback.dy }
}

/**
 * 把政治边界补充契约确定性地准备为南海附图 2D 视口要素（十段线各段归一化折线 + 岛礁点位 + 规范名称
 * 与标注摆放）。
 *
 * 流水线：
 * 1. 入参校验：features 非空（空契约 → empty-features）；布局配置全部有限（→ config-not-finite）。
 * 2. 红线完整性（collectPoliticalRedLineGaps 共享扫描单源）：十段含台湾东侧段、点名岛礁均在，缺任一项
 *    即按既定顺序抛对应 code。
 * 3. 逐段九段线：各顶点经 projectToInset 投影到归一化视口 (u,v)，组成该段折线；任一投影失败 →
 *    projection-failed。
 * 4. 逐岛礁点位：经纬度经 projectToInset 投影到 (u,v)，附规范名称；标注经贪心摆放（候选序
 *    右→左→上→下，框内且不互叠）得 labelAnchor + labelDx/labelDy；任一投影失败 → projection-failed。
 * 5. 按段序号升序输出，使台湾东侧段（segmentIndex=10）位置确定、可审计。
 *
 * 争议区修正（disputedBoundaryCorrection）不被本模块消费——附图只呈现十段线与岛礁点位（SPEC §3.8），
 * 争议区按中国主张画法的修正影响省级边界表达，由主图省界层承载。本模块与主图政治要素准备层一样跳过
 * disputedBoundaryCorrection（src/lib/political-features 同构）。
 *
 * @param contract 政治边界补充契约（TASK-004 共享事实源，与主图政治要素层同源，已通过 political-boundary
 *   契约校验）。
 * @param extent 附图 2D 子范围四至（EPSG:4326 度，来自 src/config/south-china-sea-inset）。
 * @param config 标注布局配置（viewBox / 字号 / 点径 / 偏移 / 边框内边距，来自配置层冻结值）。
 * @returns 十段线各段归一化折线 + 岛礁点位 + 规范名称与标注摆放（渲染层 SVG overlay 直接消费）。
 * @throws {SouthChinaSeaInsetPrepError} 空契约、配置非法、红线缺项、或任一投影失败时。
 */
export function prepareSouthChinaSeaInset(
  contract: PoliticalBoundaryContract,
  extent: InsetExtent,
  config: SouthChinaSeaInsetPrepConfig,
): PreparedSouthChinaSeaInset {
  if (contract.features.length === 0) {
    throw new SouthChinaSeaInsetPrepError(
      'south-china-sea-inset.empty-features',
      '南海附图准备需要至少一个要素，实际 contract.features 为空。',
    )
  }
  const configNumbers: readonly [string, number][] = [
    ['viewboxWidth', config.viewboxWidth],
    ['viewboxHeight', config.viewboxHeight],
    ['labelFontSize', config.labelFontSize],
    ['pointRadius', config.pointRadius],
    ['labelOffsetX', config.labelOffsetX],
    ['frameMargin', config.frameMargin],
  ]
  for (const [field, value] of configNumbers) {
    if (!Number.isFinite(value)) {
      throw new SouthChinaSeaInsetPrepError(
        'south-china-sea-inset.config-not-finite',
        `南海附图布局配置 ${field} 必须为有限数值，实际为 ${value}。`,
      )
    }
  }

  // 红线完整性（SPEC §6：十段含台湾东侧段、点名岛礁均在；扫描逻辑与主图政治要素准备共用
  // collectPoliticalRedLineGaps 单源，红线目录唯一来自 political-catalog）。
  const gaps = collectPoliticalRedLineGaps(contract)
  if (gaps.segmentCount !== EXPECTED_NINE_DASH_SEGMENT_COUNT) {
    throw new SouthChinaSeaInsetPrepError(
      'south-china-sea-inset.segment-count-mismatch',
      `九段线必须恰好含 ${EXPECTED_NINE_DASH_SEGMENT_COUNT} 段（十段画法），实际为 ${gaps.segmentCount} 段——拒绝准备残缺南海附图。`,
    )
  }
  if (gaps.missingSegmentIndices.length > 0) {
    throw new SouthChinaSeaInsetPrepError(
      'south-china-sea-inset.segment-missing',
      `九段线缺少段序号：[${gaps.missingSegmentIndices.join(', ')}]（十段画法需 1..10 全在）——拒绝准备残缺南海附图。`,
    )
  }
  if (!gaps.taiwanEastSegmentPresent) {
    throw new SouthChinaSeaInsetPrepError(
      'south-china-sea-inset.taiwan-east-segment-missing',
      `九段线缺少台湾东侧段（segmentIndex=${TAIWAN_EAST_SEGMENT_INDEX}），SPEC §6 红线要求十段画法含台湾东侧那段——拒绝准备残缺南海附图。`,
    )
  }
  if (gaps.missingIslandNames.length > 0) {
    throw new SouthChinaSeaInsetPrepError(
      'south-china-sea-inset.required-island-missing',
      `缺少 SPEC §6 点名岛礁 / 附属岛屿：[${gaps.missingIslandNames.join('、')}]——拒绝准备缺失岛礁点位的残缺南海附图。`,
    )
  }

  const lines: PreparedInsetLine[] = []
  const points: PreparedInsetPoint[] = []
  const placedLabelBoxes: LabelBox[] = []

  for (const feature of contract.features) {
    if (feature.type === 'nineDashLineSegment') {
      // 逐顶点投影到附图归一化视口；任一失败 → projection-failed，绝不产出部分折线。
      const uv: InsetViewportPoint[] = []
      for (let i = 0; i < feature.coordinates.length; i++) {
        const coord = feature.coordinates[i]
        const result = projectToInset(coord.lon, coord.lat, extent)
        if (!result.ok) {
          throw new SouthChinaSeaInsetPrepError(
            'south-china-sea-inset.projection-failed',
            `九段线第 ${feature.segmentIndex} 段的第 ${i} 个顶点投影失败 lon=${coord.lon} lat=${coord.lat}：${result.code}。`,
          )
        }
        uv.push(result.value)
      }
      lines.push({ segmentIndex: feature.segmentIndex, uvPolyline: uv })
    } else if (feature.type === 'islandOrReefPoint') {
      // 岛礁点位投影到附图归一化视口；失败 → projection-failed。标注贪心摆放（框内不互叠）。
      const { lon, lat } = feature.coordinate
      const result = projectToInset(lon, lat, extent)
      if (!result.ok) {
        throw new SouthChinaSeaInsetPrepError(
          'south-china-sea-inset.projection-failed',
          `岛礁点位「${feature.name}」投影失败 lon=${lon} lat=${lat}：${result.code}。`,
        )
      }
      const cx = result.value.u * config.viewboxWidth
      const cy = (1 - result.value.v) * config.viewboxHeight
      const placement = placeIslandLabel(cx, cy, feature.name, config, placedLabelBoxes)
      placedLabelBoxes.push(computeLabelBox(cx, cy, feature.name, placement, config.labelFontSize))
      points.push({
        name: feature.name,
        u: result.value.u,
        v: result.value.v,
        labelAnchor: placement.anchor,
        labelDx: placement.dx,
        labelDy: placement.dy,
      })
    }
    // disputedBoundaryCorrection 不被附图消费（见函数注释）。
  }

  // 按段序号升序输出，使台湾东侧段（segmentIndex=10）位置确定、可审计。
  lines.sort((a, b) => a.segmentIndex - b.segmentIndex)

  return { lines, points }
}
