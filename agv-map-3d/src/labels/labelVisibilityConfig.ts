/*
 * 标签可见集唯一常量表（labels 层，SPEC 11.3 / 7.1 / 16）。
 *
 * 信任边界定位（TASK-021）：
 *   - 本模块集中 SPEC §11.3 标签可见集的全部固定阈值与尺寸：4m uniform-grid 边长、cell 视锥外扩、
 *     进入 / 退出迟滞、最大已挂载上限与查询频率；以及 §7.1 的标签字号（用于投影字号计算）。
 *   - labels 层禁止依赖 config / camera（SPEC 3.3 分层），故这些常量在本层就地定义、引用同一 SPEC
 *     来源，与 nodeLabel 的 NODE_RADIUS_BY_TYPE 同构（各层各自引用同一规格，不形成第二套语义）。
 *
 * 常量来源不变量（SPEC 11.3 / 7.1 / 任务约束）：
 *   - LABEL_GRID_CELL_SIZE = 4.0m：uniform-grid 单元边长（SPEC 11.3 表格）。
 *   - LABEL_CELL_FRUSTUM_PAD = 1.5m：占用 cell 视锥粗筛时 X/Z 各向外扩张（SPEC 11.3 第 2 项）。
 *   - LABEL_ENTER_THRESHOLD_PX = 10：未挂载标签进入阈值（SPEC 11.3 第 5 项）。
 *   - LABEL_EXIT_THRESHOLD_PX = 8：已挂载标签退出阈值（SPEC 11.3 第 5 项）。
 *   - LABEL_MAX_MOUNTED = 400：目标可见集硬上限（SPEC 11.3 表格 / 任务约束）。
 *   - LABEL_FONT_SIZE_METERS = 0.20：标签字号，与 Troika Text fontSize 同源（SPEC 7.1 / 11.1）。
 *   - LABEL_QUERY_MIN_INTERVAL_MS = 100：controls 移动期间查询最小间隔（10Hz，SPEC 11.3 第 8 项）。
 *
 * 依赖方向（SPEC 3.3）：仅依赖本层自身，外部仅允许 Node 内置；常量是纯数据。
 */

/*
 * SPEC 11.3 表格：uniform-grid 单元边长（米）。
 * 启动时按本边长把 4810 个标签描述符分桶；真实样本约产生 331 个占用 cell（SPEC 11.3 第 2 项）。
 */
export const LABEL_GRID_CELL_SIZE = 4.0

/*
 * SPEC 11.3 第 2 项：占用 cell 视锥粗筛时 X/Z 各向外扩张（米）。
 * 粗筛保守外扩后仍由精确点视锥测试（第 3 项）过滤，避免在 cell 边界误删可见标签。
 */
export const LABEL_CELL_FRUSTUM_PAD = 1.5

/*
 * SPEC 11.3 第 5 项：进入阈值（像素）。
 * 未挂载标签只有投影字号 >= 该阈值才进入候选集，保证远处 / 小字标签不被挂载。
 */
export const LABEL_ENTER_THRESHOLD_PX = 10

/*
 * SPEC 11.3 第 5 项：退出阈值（像素）。
 * 已挂载标签直到投影字号 <= 该阈值才退出候选集，形成 10/8 迟滞，避免边界抖动。
 */
export const LABEL_EXIT_THRESHOLD_PX = 8

/*
 * SPEC 11.3 表格 / 任务约束：目标可见集硬上限。
 * 候选超过该上限时按稳定优先级截断；隐藏但已创建的文字对象不算懒加载，本层不预创建任何 Text。
 */
export const LABEL_MAX_MOUNTED = 400

/*
 * SPEC 7.1 / 11.1 / 11.3 第 4 项：标签字号（米）。
 * 用于把“沿 cameraScreenUp 偏移 0.20m 的线段”投影成屏幕像素字号；与 Troika Text fontSize 同源。
 */
export const LABEL_FONT_SIZE_METERS = 0.20

/*
 * SPEC 11.3 第 8 项：controls 移动期间查询最小间隔（毫秒）= 100ms（10Hz）。
 * controls 'end' 与 resize 不受本节流，立即查询一次。
 */
export const LABEL_QUERY_MIN_INTERVAL_MS = 100
