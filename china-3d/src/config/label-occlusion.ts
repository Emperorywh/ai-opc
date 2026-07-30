/**
 * 标签地形遮挡的视觉与采样配置——唯一事实源（TASK-010，SPEC §7.5）。
 *
 * 角色与依赖方向：
 * - 本模块属于运行时配置层（src/config），是「遮挡 / 可见状态的目标透明度、射线采样点数与
 *   余量、帧循环降频间隔、透明度过渡阻尼系数」的**唯一**权威。遮挡判定领域层
 *   （src/lib/label-occlusion 的纯函数）、渲染层（src/three/PlaceLabels 经组件读取）、自动化
 *   测试都只能通过本模块取得这些参数——禁止在判定函数 / 组件 / 测试里各自复制一份透明度或
 *   采样常量。
 * - 单向依赖：本模块只依赖坐标层 src/lib/projection（MAIN_MAP_WORLD_BOUNDS——主图世界米制
 *   包围盒的唯一源，用来把近 / 远端余量表达成主图尺度的分数，不写死绝对米数）。不依赖
 *   React / R3F / Three.js / DOM，故自动化测试可在 Node 环境直接断言「目标透明度落在合理
 *   区间」「采样点数为正整数」「降频间隔为正整数」「余量为正有限」等不变量。
 *
 * 与 Billboard 朝向 / 深度测试的关系（不得通过关闭深度测试让标签永久穿透地形）：
 * - 本配置只决定「遮挡时淡化到多少、多久检查一次、过渡多快」——遮挡判定本身
 *   （src/lib/label-occlusion）只输出可见性状态，渲染层据此调制 fillOpacity（不关闭深度
 *   测试）。遮挡时降低透明度是为了让被前方山体硬切的标签以「淡化」而非「突兀整块消失」的
 *   方式呈现可信的遮挡关系；可见时恢复完全可见。
 * - 可见目标透明度固定 1.0（完全可见）；遮挡目标透明度取明显降低但仍可辨识的 0.18（深色
 *   背景下仍能隐约读出标签，提示「该标签在山后」，而非完全消失）。二者均为确定性目标，
 *   状态可恢复。
 *
 * 降频由统一帧循环驱动（SPEC §7.5「可降频到每 N 帧一次」；不建立新的计时器 / Clock）：
 * - checkFrameInterval 表示「每 N 个 R3F useFrame 帧」执行一次遮挡判定（渲染层用帧计数器
 *   对 N 取模）。不引入 setInterval / setTimeout / new THREE.Clock()——降频完全由 R3F 共享
 *   帧循环承载，与海面动画（SeaSurface 的 useFrame）共用同一帧循环，无独立漂移时钟。
 *
 * 无分配 / 无随机（不造成逐帧抖动或分配压力；不得用随机抽样造成闪烁）：
 * - maxSamples 为固定整数上限（渲染层按此固定次数采样，确定性），nearMargin / farMargin /
 *   verticalClearance 均为确定常量。任何抖动只可能来自「真实遮挡状态变化」，而非采样策略
 *   本身。
 */

import { MAIN_MAP_WORLD_BOUNDS } from '../lib/projection'

/**
 * 主图世界宽度（米），用于派生近 / 远端余量（表达成主图尺度的分数，不写死绝对米数）。
 * 与标签 / 省界配置同源（MAIN_MAP_WORLD_BOUNDS）。
 */
const MAIN_MAP_WORLD_WIDTH_METERS = MAIN_MAP_WORLD_BOUNDS.maxX - MAIN_MAP_WORLD_BOUNDS.minX

/**
 * 可见状态的目标透明度（fillOpacity，0–1）。
 *
 * 固定 1.0（完全可见）：标签未被前方地形遮挡时应完全清晰可读。
 */
export const LABEL_OCCLUSION_VISIBLE_OPACITY = 1.0

/**
 * 遮挡状态的目标透明度（fillOpacity，0–1）。
 *
 * 取 0.18：明显降低（与 1.0 形成清晰对比，传达「该标签在山后」），又未降到 0（深色科技风
 * 背景下仍能隐约辨识标签文本，不致完全消失）。确定性目标，状态可恢复。
 */
export const LABEL_OCCLUSION_OCCLUDED_OPACITY = 0.18

/**
 * 沿「标签→相机」射线均匀采样的最大点数（固定整数上限）。
 *
 * 取 48：在主图尺度（射线长可达 ~10⁷ m）下，48 个采样点足以捕捉主要山系（青藏高原 / 横断
 * 山系等宽数百公里的大尺度地貌），又把每次判定的查询次数（每点一次
 * ElevationProvider.queryAtWorld）控制在数十次量级，配合降频（每 6 帧一次）使 34 个标签的
 * 遮挡判定总开销可忽略。固定上限 + 均匀分布 = 确定性策略，无随机抽样。
 */
export const LABEL_OCCLUSION_MAX_SAMPLES = 48

/**
 * 标签端跳过的近端长度（米，沿射线弧长）= 主图世界宽度 / 2048 ≈ 3.5 km。
 *
 * 跳过标签紧邻区域，避免采到标签自身锚点地形（标签虽浮于锚点之上 h·k + 浮高，锚点正下方
 * 地形不会自我遮挡，但紧邻锚点的同一山体可能在浮高不足时被误判；近端余量是结构性保险）。
 * 派生自主图尺度，不写死绝对米数。
 */
export const LABEL_OCCLUSION_NEAR_MARGIN_METERS = MAIN_MAP_WORLD_WIDTH_METERS / 2048

/**
 * 相机端跳过的远端长度（米，沿射线弧长）= 主图世界宽度 / 2048 ≈ 3.5 km。
 *
 * 跳过相机紧邻区域，避免采到相机贴地点（相机受约束恒在较高世界 y，其正下方地形与遮挡判定
 * 无关）。与近端余量同尺度（对称保险）。
 */
export const LABEL_OCCLUSION_FAR_MARGIN_METERS = MAIN_MAP_WORLD_WIDTH_METERS / 2048

/**
 * 判定遮挡的垂直余量（米）。
 *
 * 地形世界 y 需高出「射线在该处的 y」超过本值才算遮挡。取 200 m：远大于浮点 / 亚采样抖动
 * 量级（避免采样落在山脊正上方时因微差造成可见性来回翻转、即「擦边抖动」），又远小于真实
 * 山系的高差（数千米），不会漏判真实遮挡。确定性常量，使擦边场景有稳定结论（擦边 → 可见）。
 */
export const LABEL_OCCLUSION_VERTICAL_CLEARANCE_METERS = 200

/**
 * 遮挡判定的降频帧间隔（每 N 个 useFrame 帧判一次，N 为正整数）。
 *
 * 取 6：在 60 fps 下约 10 Hz 的判定频率——人眼 / 交互对遮挡淡化的响应无需逐帧（淡化过渡由
 * damp 平滑），降频到 10 Hz 可把 34 个标签 × 48 次采样的总开销压到可忽略，同时仍在相机旋转
 * 中及时反映遮挡变化（旋转手势下相机姿态变化的时间尺度远大于 100 ms）。由 R3F 统一帧循环
 * 驱动（帧计数器对 6 取模），不建独立计时器 / Clock。
 */
export const LABEL_OCCLUSION_CHECK_FRAME_INTERVAL = 6

/**
 * 透明度过渡的指数阻尼系数（1/秒，越大越快）。
 *
 * 渲染层用 THREE.MathUtils.damp(current, target, lambda, dt) = lerp(current, target,
 * 1 − exp(−lambda·dt)) 每帧把当前透明度向目标阻尼。取 6.0：在 60 fps 下约 0.3 s 内完成
 * 可见↔遮挡的淡化过渡——既不会瞬间跳变（突兀），也不会拖沓（迟钝）。dt 由 useFrame 提供
 * （统一时钟），故过渡帧率无关。
 */
export const LABEL_OCCLUSION_DAMP_LAMBDA = 6.0

/**
 * 标签地形遮挡的全部参数（冻结）。
 *
 * 这是遮挡判定领域层（src/lib/label-occlusion）、渲染层（src/three/PlaceLabels）与自动化
 * 测试共享的同一份事实源：目标透明度（可见 / 遮挡）/ 采样点数 / 近远端余量 / 垂直余量 /
 * 降频间隔 / 阻尼系数全部在此，不存在第二套遮挡常量。冻结防止运行时被偷偷改（如把遮挡透明
 * 度改成 1.0 会让遮挡失效、把降频间隔改 0 会退化为逐帧判定造成抖动），任何调整都必须改本
 * 模块并同步测试。
 */
export const LABEL_OCCLUSION_CONFIG = Object.freeze({
  /** 可见状态目标透明度（fillOpacity）。 */
  visibleOpacity: LABEL_OCCLUSION_VISIBLE_OPACITY,
  /** 遮挡状态目标透明度（fillOpacity）。 */
  occludedOpacity: LABEL_OCCLUSION_OCCLUDED_OPACITY,
  /** 射线均匀采样最大点数（固定整数上限）。 */
  maxSamples: LABEL_OCCLUSION_MAX_SAMPLES,
  /** 标签端近端余量（米，沿射线弧长）。 */
  nearMarginMeters: LABEL_OCCLUSION_NEAR_MARGIN_METERS,
  /** 相机端远端余量（米，沿射线弧长）。 */
  farMarginMeters: LABEL_OCCLUSION_FAR_MARGIN_METERS,
  /** 判定遮挡的垂直余量（米，抗擦边抖动）。 */
  verticalClearanceMeters: LABEL_OCCLUSION_VERTICAL_CLEARANCE_METERS,
  /** 降频帧间隔（每 N 个 useFrame 帧判一次）。 */
  checkFrameInterval: LABEL_OCCLUSION_CHECK_FRAME_INTERVAL,
  /** 透明度过渡指数阻尼系数（1/秒）。 */
  dampLambda: LABEL_OCCLUSION_DAMP_LAMBDA,
})
