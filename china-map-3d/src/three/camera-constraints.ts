/**
 * 受约束东南斜俯视相机的纯计算契约（TASK-011）。
 *
 * 角色与依赖方向：
 * - 本模块属于渲染层的纯计算子层（src/three），但**不**依赖 three / React / R3F / DOM——只依赖
 *   坐标层 src/lib/projection（MAIN_MAP_WORLD_BOUNDS —— 主图世界米制包围盒的唯一源）与渲染派生
 *   常量 src/three/terrain-layout（TERRAIN_PLANE_LAYOUT.centerZ —— 主图世界 z 中心）。所有相机
 *   约束（最近/最远距离、最大极角、target 边界、FOV、near/far）与默认机位都由这两份几何事实派生，
 *   没有任何魔法绝对坐标。这让自动化测试可在 Node 环境直接断言「约束只随地图包围盒变化，与画布
 *   尺寸 / DOM / 组件状态无关」——即 SPEC §4.1「范围限制由地图包围盒和地形尺度推导」。
 *
 * 纯计算契约（TASK-011 实现约束「相机约束为显式状态/纯计算契约，不得散落魔法坐标或逐帧临时修正」）：
 * - 本模块导出三组确定性原语：冻结的 MAP_CAMERA_CONSTRAINTS（约束不变量）、DEFAULT_CAMERA_POSE
 *   （默认机位）、clampDistance / clampPolarAngle / clampTarget（钳制函数）。三者共享同一份派生自
 *   MAIN_MAP_WORLD_BOUNDS 的尺度常量，不存在第二套魔法坐标。
 * - 钳制函数是「输入 → 合法输出」的纯函数：超界输入被确定性夹回边界，合法输入原样返回；同一输入
 *   在任意时刻产生同一输出（无隐式状态、无 DOM 读取、无随机）。OrbitControls 组件（MapOrbitControls）
 *   每帧调用 clampTarget 把 target 钳回地图包围盒；距离/极角由 OrbitControls 内部按 minDistance /
 *   maxDistance / maxPolarAngle 强制，但本模块的 clampDistance / clampPolarAngle 作为同一不变量的
 *   纯计算镜像，供自动化测试与（未来）入场状态机在不依赖控制器实例的情况下复算。
 *
 * 「resize 后约束仍成立」的工程语义（TASK-011 验证方式 1）：
 * - 约束只随 MAIN_MAP_WORLD_BOUNDS 变化，而后者是模块加载时一次性投影并冻结的常量，不感知画布
 *   尺寸；窗口 resize 改变的只是相机 aspect / 画布像素尺寸，不会影响米制约束。故钳制函数在 resize
 *   前后对同一输入给出同一输出——这是「显式状态/纯计算」的直接结果，而非额外的 resize 监听逻辑。
 *
 * 默认东南斜俯视机位（SPEC §2「默认视角」、§4.1）：
 * - target = 主图世界中心在地表的点 (0, 0, centerZ)：x 关于原点对称故 x=0，z 取主图南北中点 centerZ，
 *   y=0（海平面，即地形未位移前的参考面）。
 * - 相机位于 target 的东南上方八分域：相对 target 的方向单位向量由方位角（东南 45°）+ 仰角（30°）
 *   派生——水平分量按 cos(仰角) 缩放后分解到 +X（东，sin(方位角)）与 +Z（南，cos(方位角)），
 *   垂直分量 = sin(仰角)。相机落在 (+X, +Y, +Z) → 俯瞰西北，使青藏高原（西、高）落在画面左上、
 *   东部平原（东、低）落在右下，凸显西高东低。
 * - 距离 = MAP_HALF_DIAGONAL · DEFAULT_DISTANCE_FACTOR：以「主图米制半对角线」为统一尺度，使整张
 *   主图在东南斜俯视默认视角下完整落入画面（系数经 TASK-009 既验证机位校准，并非魔法绝对米数）。
 */

import { MAIN_MAP_WORLD_BOUNDS } from '../lib/projection'
import { TERRAIN_PLANE_LAYOUT } from './terrain-layout'

/** 把角度（度）换算为弧度（Math.PI/180 的内联等价，避免引入 three 依赖以保持本模块纯 TS）。 */
function degToRad(degrees: number): number {
  return (degrees * Math.PI) / 180
}

/**
 * 主图世界包围盒的派生尺度（米，模块加载时一次性计算）。
 *
 * 这些尺度是相机约束的**唯一**几何输入——任何约束数值都由它们表达，禁止另写魔法绝对米数：
 * - MAP_HALF_WIDTH_X：主图在东（+X）方向的半宽 = (maxX − minX)/2（关于原点对称，故也 = maxX）。
 * - MAP_HALF_HEIGHT_Z：主图在南（+Z）方向的半高 = (maxZ − minZ)/2（墨卡托纬度非线性，关于原点不对称）。
 * - MAP_HALF_DIAGONAL：主图在 XZ 平面的半对角线 = hypot(半宽, 半高)，作为距离约束的统一尺度。
 */
const MAP_HALF_WIDTH_X = (MAIN_MAP_WORLD_BOUNDS.maxX - MAIN_MAP_WORLD_BOUNDS.minX) / 2
const MAP_HALF_HEIGHT_Z = (MAIN_MAP_WORLD_BOUNDS.maxZ - MAIN_MAP_WORLD_BOUNDS.minZ) / 2
const MAP_HALF_DIAGONAL = Math.hypot(MAP_HALF_WIDTH_X, MAP_HALF_HEIGHT_Z)

/**
 * 垂直夸张后地形的最高世界 y（米），用于约束「相机不得穿入地形」。
 *
 * 真实最高海拔 9000m（SPEC §5.1 编码上限）× 最大夸张 k=3.0（SPEC §3.2）= 27000m。相机在低极角
 * （贴近地平）时其世界 y 趋近 0，若同时距离过近会穿入夸张后的地形；最近距离必须保证即便在最大极角
 * 下相机仍高于该峰值（详见 CAMERA_MIN_DISTANCE 的推导）。
 */
const MAX_DISPLACED_TERRAIN_Y = 9000 * 3.0

/**
 * 默认相机距离系数：距离 = MAP_HALF_DIAGONAL · 本系数。
 *
 * 取 2.1：使整张主图（半对角线 MAP_HALF_DIAGONAL）在东南斜俯视 30° 仰角下完整落入垂直半视场内，
 * 并留适度余量；该系数经 TASK-009 既验证机位（[6.5e6, 5e6, 6.5e6] 距 centerZ 约 10.4e6 m）校准——
 * 在 MAP_HALF_DIAGONAL ≈ 4.9e6 m 下 2.1 倍 ≈ 10.4e6 m，与既验证效果一致。它是「相对地图尺度的系数」，
 * 而非魔法绝对米数：若地图范围变化，默认距离会随 MAP_HALF_DIAGONAL 自动伸缩。
 */
const DEFAULT_DISTANCE_FACTOR = 2.1

/**
 * 默认相机水平方位角（度）：东南 45°。
 *
 * 方位角从 +Z（南）向 +X（东）量起：45° 即东南角平分线，水平分量在 +X 与 +Z 各占 sin/cos(45°)=1/√2，
 * 与 SPEC §4.1「相机置于地图东南上方」一致。本常量显式参与 DEFAULT_POSITION 的方向向量推导
 * （见下），而非隐式埋在 1/√2 系数里。
 */
const DEFAULT_AZIMUTH_DEGREES = 45

/**
 * 默认相机仰角（度）：水平面以上 30°。
 *
 * 「斜俯视」：相机既高于地形（俯视）又不正俯（保留侧向梯度感），30° 经验上既能呈现青藏高原隆起的
 * 立体感，又不至于过平使北方墨卡托放大区压扁。仰角 → 方向向量 y 分量 = sin(30°) = 0.5。
 */
const DEFAULT_ELEVATION_DEGREES = 30

/**
 * 相机垂直视场角（度）。
 *
 * 42° 在大屏常见 16:9 / 21:9 宽屏下水平视场足够覆盖主图横向跨度，同时垂直方向不会过窄导致南北边缘
 * 出画。本值同时参与默认距离与 near/far 的尺度协调，作为相机约束的明确配置（非魔法）。
 */
const CAMERA_FOV_DEGREES = 42

/**
 * 最大极角（弧度，从 +Y 轴量起）：约 88°。
 *
 * 极角 0 = 相机在正上方俯视，π/2 = 相机在水平面看（贴地），> π/2 = 相机钻到地表下方看天。
 * 取 88°：允许几乎水平的低空斜视但禁止到达水平（90°）及以下，从而禁止「翻到地图背面 / 看到地底」
 * （SPEC §4.1「不允许转到地图背面/看到地底」）。由 OrbitControls 的 maxPolarAngle 强制。
 *
 * 声明在 CAMERA_MIN_DISTANCE 之前：后者按本极角的 cos 反推「不穿地形」下界，const 不可前向引用。
 */
const CAMERA_MAX_POLAR_ANGLE_RAD = degToRad(88)

/**
 * 相机最近距离（米）。
 *
 * 取以下两道约束的较大者，使「不穿入夸张后的地形」成为结构性保证（而非巧合）：
 * 1. 地图尺度下界 MAP_HALF_DIAGONAL · 0.3：足够近能看到地形细节，又保证画面不只剩一小块山头。
 * 2. 地形峰值下界：在最大极角下相机世界 y = 最近距离 · cos(maxPolarAngle)，必须高于夸张后地形峰值
 *    MAX_DISPLACED_TERRAIN_Y，否则相机会穿入地表。反推得 最近距离 ≥ 峰值 / cos(maxPolarAngle)，
 *    再乘 1.5 安全余量。cos88°≈0.035，该下界 ≈ 27000/0.035·1.5 ≈ 1.16e6 m。
 * 实测地图尺度下界（≈1.48e6 m）更大，故最终取地图尺度下界；但保留 max(...) 使「地形峰值约束」
 * 显式参与推导——若未来夸张系数或极角上限变化使峰值下界反超，本式会自动收紧而非放任穿地。
 */
const CAMERA_MIN_DISTANCE = Math.max(
  MAP_HALF_DIAGONAL * 0.3,
  (MAX_DISPLACED_TERRAIN_Y / Math.cos(CAMERA_MAX_POLAR_ANGLE_RAD)) * 1.5,
)

/**
 * 相机最远距离（米）。
 *
 * 取 MAP_HALF_DIAGONAL · 4：再远则主图缩成画面中心的小块，失去探索意义；该上限仍远小于相机 far
 * 平面（CAMERA_FAR = CAMERA_MAX_DISTANCE · 2），不触发深度裁剪。距离由 OrbitControls 的
 * minDistance / maxDistance 强制，clampDistance 是同一不变量的纯计算镜像。
 */
const CAMERA_MAX_DISTANCE = MAP_HALF_DIAGONAL * 4

/**
 * 相机远裁剪平面（米）。
 *
 * 取 CAMERA_MAX_DISTANCE · 2：保证在最远距离下主图任意角落（含 target 平移到边界后的对角远点）
 * 都落在视锥内不被远裁剪；同时不过大以保留深度缓冲精度（大屏高 DPR 下深度精度与 near/far 比相关）。
 */
const CAMERA_FAR = CAMERA_MAX_DISTANCE * 2

/**
 * 相机近裁剪平面（米）。
 *
 * 取 MAP_HALF_DIAGONAL · 0.0002 ≈ 1000m：相对地图尺度足够小（不裁掉近距离地形），又远大于 0 以
 * 放大深度缓冲有效精度（near/far 比从 1:40000 起步，远好于 1:几十万的极端比例）。near 与 far 一起
 * 决定深度精度，本值在 TASK-009 既验证场景下无 z-fighting，沿用。
 */
const CAMERA_NEAR = Math.max(MAP_HALF_DIAGONAL * 0.0002, 1000)

/**
 * 受约束相机的全部不变量（冻结）。
 *
 * 这是 OrbitControls 装配（MapOrbitControls）与自动化测试共享的同一份事实源：距离 / 极角由
 * OrbitControls 内置 minDistance / maxDistance / maxPolarAngle 强制，target 边界由 MapOrbitControls
 * 每帧调用 clampTarget 强制；不存在第二套约束实现。冻结防止运行时被偷偷放宽（如把 maxPolarAngle
 * 改成 > 90° 会允许看到地底），任何调整都必须改本模块并同步测试。
 */
export const MAP_CAMERA_CONSTRAINTS: Readonly<{
  minDistance: number
  maxDistance: number
  maxPolarAngleRad: number
  targetMinX: number
  targetMaxX: number
  targetMinZ: number
  targetMaxZ: number
  targetY: number
  fovDegrees: number
  near: number
  far: number
}> = Object.freeze({
  /** 最近距离（米）。低于此被钳制回该值，避免穿入夸张后的地形。 */
  minDistance: CAMERA_MIN_DISTANCE,
  /** 最远距离（米）。高于此被钳制回该值，避免飞出使主图缩成点。 */
  maxDistance: CAMERA_MAX_DISTANCE,
  /** 最大极角（弧度，从 +Y 量起）。约 88°，禁止翻面 / 看到地底。 */
  maxPolarAngleRad: CAMERA_MAX_POLAR_ANGLE_RAD,
  /** target 在世界 x（东）方向的下界（米）= 主图西界。 */
  targetMinX: MAIN_MAP_WORLD_BOUNDS.minX,
  /** target 在世界 x（东）方向的上界（米）= 主图东界。 */
  targetMaxX: MAIN_MAP_WORLD_BOUNDS.maxX,
  /** target 在世界 z（南）方向的下界（米）= 主图北界。 */
  targetMinZ: MAIN_MAP_WORLD_BOUNDS.minZ,
  /** target 在世界 z（南）方向的上界（米）= 主图南界。 */
  targetMaxZ: MAIN_MAP_WORLD_BOUNDS.maxZ,
  /** target 固定的世界 y（米）= 0（海平面参考面；平移只在地表平面内）。 */
  targetY: 0,
  /** 垂直视场角（度）。 */
  fovDegrees: CAMERA_FOV_DEGREES,
  /** 近裁剪平面（米）。 */
  near: CAMERA_NEAR,
  /** 远裁剪平面（米）。 */
  far: CAMERA_FAR,
})

/**
 * 三维向量（米，世界坐标）。本模块不依赖 three，故用纯 TS 接口表达 target / position；
 * MapOrbitControls 在装配时把它转成 THREE.Vector3 喂给 OrbitControls。
 */
export interface CameraVec3 {
  readonly x: number
  readonly y: number
  readonly z: number
}

/** 完整相机姿态：位置 + 观察目标（米，世界坐标）。 */
export interface CameraPose {
  readonly position: CameraVec3
  readonly target: CameraVec3
}

/**
 * 默认东南斜俯视相机姿态（冻结）。
 *
 * 由 target（主图世界中心在地表的点）+ 东南上方方向（方位角 + 仰角）+ 默认距离纯计算派生：
 * - target = (0, 0, centerZ)：x 关于原点对称故 0，z 取主图南北中点，y=0。
 * - 方向单位向量：水平总长 = cos(仰角)，按方位角分解到 +X（sin(方位角)）与 +Z（cos(方位角)），
 *   垂直分量 = sin(仰角)。方位角 45° / 仰角 30° → (+X, +Y, +Z) 东南上方。
 * - distance = MAP_HALF_DIAGONAL · DEFAULT_DISTANCE_FACTOR。
 * - position = target + 方向 · distance。
 *
 * ChinaMapScreen 把 position 喂给 R3F Canvas 的 camera prop、target 由 MapOrbitControls 写入
 * OrbitControls 实例，二者共用本常量，杜绝两处各算一遍产生漂移。
 */
const DEFAULT_ELEVATION_RAD = degToRad(DEFAULT_ELEVATION_DEGREES)
const DEFAULT_AZIMUTH_RAD = degToRad(DEFAULT_AZIMUTH_DEGREES)
/** 默认方向单位向量的 +X（东）分量 = cos(仰角)·sin(方位角)。 */
const DEFAULT_DIRECTION_X = Math.cos(DEFAULT_ELEVATION_RAD) * Math.sin(DEFAULT_AZIMUTH_RAD)
/** 默认方向单位向量的 +Z（南）分量 = cos(仰角)·cos(方位角)。 */
const DEFAULT_DIRECTION_Z = Math.cos(DEFAULT_ELEVATION_RAD) * Math.cos(DEFAULT_AZIMUTH_RAD)
/** 默认方向单位向量的 +Y（上）分量 = sin(仰角)。 */
const DEFAULT_DIRECTION_Y = Math.sin(DEFAULT_ELEVATION_RAD)
const DEFAULT_DISTANCE = MAP_HALF_DIAGONAL * DEFAULT_DISTANCE_FACTOR
const DEFAULT_TARGET: CameraVec3 = { x: 0, y: 0, z: TERRAIN_PLANE_LAYOUT.centerZ }
const DEFAULT_POSITION: CameraVec3 = {
  x: DEFAULT_TARGET.x + DEFAULT_DIRECTION_X * DEFAULT_DISTANCE,
  y: DEFAULT_TARGET.y + DEFAULT_DIRECTION_Y * DEFAULT_DISTANCE,
  z: DEFAULT_TARGET.z + DEFAULT_DIRECTION_Z * DEFAULT_DISTANCE,
}

export const DEFAULT_CAMERA_POSE: CameraPose = Object.freeze({
  position: Object.freeze({ ...DEFAULT_POSITION }),
  target: Object.freeze({ ...DEFAULT_TARGET }),
})

/**
 * 把任意距离钳制到 [minDistance, maxDistance]（米，纯函数）。
 *
 * NaN 回落到默认距离——NaN 不应出现在合法相机状态中，回落而非抛错是为了让 OrbitControls 的逐帧
 * 钳制路径在偶发数值异常下仍能稳定收敛（默认距离本身在合法区间内）。±Infinity 走 Math.min/max
 * 自然夹到最近端点（+Infinity→maxDistance、-Infinity→minDistance），语义即「无穷远 / 无穷近」。
 * 合法值原样返回（含端点），超下界夹回 minDistance、超上界夹回 maxDistance。
 *
 * OrbitControls 自身按 minDistance / maxDistance 强制距离；本函数是同一不变量的纯计算镜像，
 * 供自动化测试在不持有控制器实例时断言「过近/过远输入被确定性夹回」。
 */
export function clampDistance(distance: number): number {
  if (Number.isNaN(distance)) return DEFAULT_DISTANCE
  const { minDistance, maxDistance } = MAP_CAMERA_CONSTRAINTS
  return Math.min(Math.max(distance, minDistance), maxDistance)
}

/**
 * 把任意极角（弧度，从 +Y 量起）钳制到 [0, maxPolarAngleRad]（纯函数）。
 *
 * 极角上界由 maxPolarAngleRad（≈88°）强制：超过该值（贴近或越过水平面 / 钻入地表下）夹回上界，
 * 禁止「翻到地图背面 / 看到地底」（SPEC §4.1）。下界 0（正俯视）合法，不设最小极角限制。
 * NaN 回落到默认极角（默认机位的极角，稳定且合法）；±Infinity 走 Math.min/max 自然夹到端点
 * （+Infinity→maxPolarAngleRad、-Infinity→0），与 clampDistance / clampTarget 同一非有限处理策略。
 *
 * OrbitControls 自身按 maxPolarAngle 强制极角；本函数是同一不变量的纯计算镜像，供自动化测试
 * 断言「超过最大极角的输入被确定性夹回」。
 */
export function clampPolarAngle(polarAngle: number): number {
  if (Number.isNaN(polarAngle)) return defaultPolarAngle()
  const { maxPolarAngleRad } = MAP_CAMERA_CONSTRAINTS
  return Math.min(Math.max(polarAngle, 0), maxPolarAngleRad)
}

/**
 * 把任意 target（世界坐标）钳制到地图包围盒内（纯函数）。
 *
 * target.x 夹到 [targetMinX, targetMaxX]、target.z 夹到 [targetMinZ, targetMaxZ]、target.y 强制为
 * targetY（=0，海平面参考面——平移只在地表平面内，禁止把 target 抬离地表产生方向错乱）。各分量
 * NaN 回落到默认 target 的对应分量；±Infinity 走 Math.min/max 自然夹到最近边界——与 clampDistance /
 * clampPolarAngle 同一非有限处理策略，三者只此一套（无第二套魔法修正）。
 *
 * 这是「禁止把观察目标拖出地图有效范围」的唯一实现（SPEC §4.1、TASK-011 可验证结果）：MapOrbitControls
 * 每帧调用本函数把 OrbitControls 平移后的 target 拉回包围盒；不存在第二套平移边界逻辑。
 */
export function clampTarget(target: CameraVec3): CameraVec3 {
  const { targetMinX, targetMaxX, targetMinZ, targetMaxZ, targetY } = MAP_CAMERA_CONSTRAINTS
  const x = Number.isNaN(target.x) ? DEFAULT_TARGET.x : Math.min(Math.max(target.x, targetMinX), targetMaxX)
  const z = Number.isNaN(target.z) ? DEFAULT_TARGET.z : Math.min(Math.max(target.z, targetMinZ), targetMaxZ)
  return { x, y: targetY, z }
}

/**
 * 由默认姿态派生默认极角（弧度，从 +Y 量起），供 clampPolarAngle 的非有限回落使用。
 *
 * 默认方向的水平分量总长（XZ 平面内）= cos(仰角)，y 分量 = sin(仰角)；极角 = atan2(水平, y)，
 * 与距离无关。仰角 30° → 极角 60°（正俯视为 0°、水平为 90°，60° 即「斜俯视」）。
 */
function defaultPolarAngle(): number {
  return Math.atan2(Math.cos(DEFAULT_ELEVATION_RAD), Math.sin(DEFAULT_ELEVATION_RAD))
}
