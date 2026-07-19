/**
 * 政治边界补充数据领域真值目录（TASK-006）。
 *
 * 这是「SPEC §6 红线点名了哪些九段线段、哪些岛礁 / 附属岛屿、哪些争议区」的单一定义点，
 * 被资产深度校验（scripts/verify-assets/political-deep.ts）引用，未来若新增离线生产脚本
 * （把项目自补坐标落盘为生产资产）也从此处取锚点，避免两处手写表漂移。与 province-catalog /
 * place-catalog 同构：集中承载 SPEC 点名必备项，作为深度校验的硬编码锚点。
 *
 * 依赖方向：属于离线资产生产 / 校验层（scripts/，tsx 运行），单向依赖 src/geo-contracts
 * 契约层（不依赖其具体校验器，仅复用其常量语义），不依赖浏览器 / React / Three.js 或任何运行时状态。
 *
 * 政治红线点名项（SPEC §6，逐条对应）：
 * - 九段线含台湾东侧那段（标准十段画法）→ REQUIRED_NINE_DASH_SEGMENT_INDICES（1..10），
 *   其中 segmentIndex=10 固定为台湾东侧段（TAIWAN_EAST_SEGMENT_INDEX），SPEC §6 红线
 *   「含台湾东侧那段」的硬锚点。
 * - 钓鱼岛、赤尾屿等附属岛屿点位 → REQUIRED_ISLAND_NAMES 含「钓鱼岛」「赤尾屿」。
 * - 曾母暗沙（SPEC §3.3「南端覆盖到曾母暗沙 ≈ 3.58°N」，中国领土最南标志）→ REQUIRED_ISLAND_NAMES 含「曾母暗沙」。
 * - 藏南（阿鲁纳恰尔）、阿克赛钦 → REQUIRED_DISPUTED_REGIONS 含「藏南」「阿克赛钦」。
 *
 * 完整性边界（不得越权声称，TASK-006 验证方式 3「人工核对」）：
 * - 本目录**只承载 SPEC §6 点名必备项**，不声称是南海诸岛完整岛礁名录闭包——
 *   完整岛礁名录（西沙 / 中沙 / 南沙群岛的全部岛、礁、沙、滩及其规范名称）属人工对照公开标准地图
 *   的核对项，无法由自动化清单替代。深度校验只断言「点名项在」，不断言「名录已穷尽」。
 * - 九段线 / 争议区边界的**几何顶点坐标**是否与国标一致，亦属人工核对项；自动化只能断言
 *   「段数齐、点名项在、坐标落在中国主图范围」，不能断言「顶点与国标逐点重合」。
 * - 所有数据为非官方审图数据，公开发布前必须取得自然资源主管部门审图号（SPEC §8、§13）。
 */

/**
 * 九段线（十段画法）的段序号清单。
 *
 * 十段画法 = 南海 9 段 + 台湾东侧 1 段。段序号从 1 起、唯一且为正整数
 * （契约层 src/geo-contracts/political.ts 已冻结该结构约束）。
 * 这里把 1..10 全部列为必备，深度校验据此断言「恰好 10 段且序号 1..10 全在」，
 * 任一缺段（尤其台湾东侧第 10 段）都会被确定性发现。
 */
export const REQUIRED_NINE_DASH_SEGMENT_INDICES: readonly number[] = [
  1, 2, 3, 4, 5, 6, 7, 8, 9, 10,
]

/**
 * 九段线（十段画法）的恰好段数（SPEC §6「十段线画法」、§5.3）。
 * 单独命名导出，使深度校验与测试可以「按名引用 10」而非「按目录长度推断」，
 * 一旦段数漂移，与该常量的比较会立刻暴露不一致。
 */
export const EXPECTED_NINE_DASH_SEGMENT_COUNT = REQUIRED_NINE_DASH_SEGMENT_INDICES.length

/**
 * 台湾东侧段的段序号（SPEC §6 红线「含台湾东侧那段，即标准十段线画法」）。
 *
 * 该段是「九段线 vs 十段线」画法差异的唯一标志：缺它即退回旧九段画法（政治边界不完整）。
 * 深度校验对 segmentIndex===10 做**独立硬编码锚点**断言（不经
 * REQUIRED_NINE_DASH_SEGMENT_INDICES 间接得出），即便有人误改本目录常量，该锚点仍要求资产必须含此段。
 */
export const TAIWAN_EAST_SEGMENT_INDEX = 10

/**
 * SPEC §6 点名的必备岛礁 / 附属岛屿规范名称。
 *
 * - 钓鱼岛、赤尾屿：SPEC §6「钓鱼岛、赤尾屿等附属岛屿点位」明确点名。
 * - 曾母暗沙：SPEC §3.3「南端覆盖到曾母暗沙 ≈ 3.58°N」，中国领土最南标志，
 *   也是九段线南端锚点，缺它则南海范围政治表达不完整。
 *
 * 完整南海诸岛名录（西沙 / 中沙 / 南沙群岛的全部岛礁沙滩及规范名称）属人工核对项
 * （TASK-006 验证方式 3），本目录不声称穷尽。深度校验只断言「点名项在」。
 */
export const REQUIRED_ISLAND_NAMES: readonly string[] = [
  '钓鱼岛', // 钓鱼岛本岛（SPEC §6 点名附属岛屿）
  '赤尾屿', // 钓鱼岛附属岛屿（SPEC §6 点名）
  '曾母暗沙', // 中国领土最南标志（SPEC §3.3 点名）
]

/**
 * SPEC §6 点名的必备争议区修正目标区域。
 *
 * - 藏南（阿鲁纳恰尔）：SPEC §6「藏南（阿鲁纳恰尔）...按中国主张画法」。
 * - 阿克赛钦：SPEC §6「阿克赛钦...按中国主张画法」。
 *
 * 两者在 DataV 基础省界中画法可能非国标（SPEC §5.2 已知缺陷），必须以争议区修正形式
 * 按中国主张补充表达。深度校验据此断言「两区修正均在」，任一缺失即红线不完整。
 */
export const REQUIRED_DISPUTED_REGIONS: readonly string[] = [
  '藏南', // SPEC §6 点名争议区
  '阿克赛钦', // SPEC §6 点名争议区
]

/**
 * 政治边界补充数据的事实来源标识（与 public/geo/data-sources.json 的来源条目对齐）。
 *
 * 政治边界补充数据由项目自行维护（非 DataV 官方数据），其来源声明在生产 data-sources.json
 * 中以该 id 登记：isOfficialSurvey=false + 非空 disclaimer + 可追溯 originUrl/version/license。
 * 3D 主图与 2D 南海附图复用同一份事实源，不维护两套坐标（SPEC §3.8、§6、TASK-006 实现约束）。
 */
export const POLITICAL_SOURCE_ID = 'src-project-political'
