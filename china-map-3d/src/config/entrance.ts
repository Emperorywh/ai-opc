/**
 * 加载与入场编排的时序配置——唯一事实源（TASK-020）。
 *
 * 角色与依赖方向：
 * - 本模块属于运行时配置层（src/config），是「加载→地形升起→省名标签错峰淡入→水面 / 边界淡入→可交互」
 *   这一确定性入场状态机的**时序唯一**权威。入场状态机领域层（src/lib/entrance-state 的纯函数）、
 *   单一帧循环驱动器（src/three/EntranceController）、各渲染层（经 useFrame 读取共享入场帧派生各自
 *   rise / 透明度）、DOM 加载进度（ChinaMapScreen 的 Loader）、自动化测试都只能通过本模块取得入场时序——
 *   禁止在状态机 / 组件 / 测试里各自复制一份升起时长或错峰系数（TASK-020 实现约束「入场必须由单一显式
 *   状态流编排，禁止在地形、标签、海面和边界组件中各建独立定时器或布尔状态」「所有动画使用统一 R3F
 *   帧循环 / 时钟」）。
 * - 单向依赖：本模块不依赖 React / R3F / Three.js / DOM（纯数值常量），故自动化测试可在 Node 环境直接
 *   断言「地形升起约 1.2 秒」「总入场时长有限」「错峰窗口为 (0,1) 分数」「受跟踪资产数为正整数」等不变量
 *   （TASK-020 验证方式 1、2），无需启动浏览器 / WebGL。
 *
 * 入场阶段时序（SPEC §2「加载入场」、§4.3「就绪后：地形升起 / 标签依次淡入 / 水面边界随后淡入」、
 *   §12.8「入场：进度条→地形升起→标签淡入，过程顺滑」、TASK-020 输出约束「地形约 1.2 秒内从平面升至
 *   最终夸张高度」）：
 * - 地形升起（terrain-rise）：约 1.2 秒。地形通过 uRise uniform 从 0（平面）插值到 1（夸张后真实高度），
 *   复用 GPU 位移、不建第二套几何（TASK-020 实现约束「地形升起必须复用 GPU 位移，不得复制或重建几何」）。
 * - 省名标签错峰淡入（labels-fade-in）：省名标签按自西向东（世界 x 升序）错峰淡入，西部先亮、东部后亮。
 * - 水面 / 边界淡入（scene-layers-fade-in）：海面 + 省级贴地边界 + 十段线 / 岛礁点位随后淡入。
 * - 可交互（interactive）：全部淡入完成后一次性释放 OrbitControls（TASK-020 输出约束「状态到达可交互后
 *   释放 OrbitControls」）。
 *
 * 统一时间源（TASK-020 实现约束「禁止多 Clock 漂移和逐帧对象分配」）：
 * - 入场 elapsed 由 EntranceController 的单一 useFrame 从 R3F 共享 clock（state.clock.getElapsedTime()）
 *   派生（入场开始时刻幂等捕获一次），写入共享入场帧 ref。各渲染层只读该共享帧、复用本模块的时序常数
 *   与 src/lib/entrance-state 的纯函数派生各自 rise / 透明度——不存在第二份 clock / 计时器 / 布尔组合。
 */

/**
 * 地形从平面升至夸张后真实高度的时长（秒）。
 *
 * 取 1.2（SPEC §4.3「≈1.2s」、TASK-020 输出约束「约 1.2 秒」）。uRise uniform 在该时长内由 0 平滑插值到 1
 * （smoothstep），地形顶点位移 = h·k·uRise 随之从 0（平面）升至 h·k（夸张后真实高度）。时长有限、确定，
 * 使自动化可断言「elapsed=1.2 时 rise=1（升毕）、elapsed=0 时 rise=0（平面）」。
 */
export const ENTRANCE_TERRAIN_RISE_SECONDS = 1.2

/**
 * 省名标签错峰淡入的总时长（秒）。
 *
 * 取 1.6：34 个省名标签按自西向东错峰，首个标签在阶段起点开始、末个标签在「错峰窗口」末尾开始，全部在
 * 本时长内完成淡入。错峰使读图视线随「西部高原 → 东部平原」的自然地势顺序展开，符合 SPEC §4.3「按地理
 * 顺序错峰，如自西向东」。省会光点 / 岛礁名称标签随本阶段整体淡入（非错峰），与省名标签同阶段可见。
 */
export const ENTRANCE_LABELS_FADE_SECONDS = 1.6

/**
 * 水面 / 边界淡入的时长（秒）。
 *
 * 取 0.8：海面 + 省级贴地边界 + 十段线 / 岛礁点位在省名标签淡入完成后整体淡入。短于省名淡入（标签是读图
 * 主角，先建立），又不过短（淡入可感知、不突兀）。本阶段结束即进入可交互态、释放相机。
 */
export const ENTRANCE_SCENE_LAYERS_FADE_SECONDS = 0.8

/**
 * 省名标签错峰窗口占省名淡入总时长的分数（不含末个标签自身的淡入时长）。
 *
 * 取 0.6：首个标签在阶段起点（delay=0）开始、末个标签在 0.6 × 1.6 = 0.96 秒处开始，每个标签淡入时长
 * = 总时长 − 错峰窗口 = 0.4 × 1.6 = 0.64 秒；末个标签在 0.96 + 0.64 = 1.6 秒处完成（恰为本阶段结束）。
 * 必须落在 (0,1)：=0 退化为全部同时淡入（无错峰）、=1 使末个标签无时间淡入（末个永远 incomplete）。
 */
export const ENTRANCE_LABEL_STAGGER_WINDOW_FRACTION = 0.6

/**
 * 入场受跟踪的静态资产数（heightmap / 省级行政区几何 / 政治边界补充契约 / 地点目录 / 离线字体清单）。
 *
 * DOM 加载进度 = 已就绪资产数 / 本值，只反映真实受跟踪资产状态，不伪造计时进度（TASK-020 输出约束
 * 「DOM 加载进度反馈只反映真实受跟踪资产，不伪造计时进度」）。任一资产失败即整体进入 error 终态，
 * 绝不退化为低清 / 平面 / 旧资产 / 远程请求（TASK-020 实现约束「加载失败必须显式终止状态机并保留诊断」）。
 */
export const ENTRANCE_TRACKED_ASSET_COUNT = 5

/**
 * 入场时序的全部参数（冻结）。
 *
 * 这是入场状态机领域层（src/lib/entrance-state）、单一帧循环驱动器（src/three/EntranceController）、各渲染层
 * （useFrame 内派生 rise / 透明度）与自动化测试共享的同一份时序事实源：地形升起 / 省名淡入 / 水面边界淡入
 * 时长 + 错峰窗口分数全部在此，不存在第二套入场时序。冻结防止运行时被偷偷改（如把升起时长改 0 会跳过
 * 升起动画、把错峰窗口改 1 会使末个标签永不 complete），任何调整都必须改本模块并同步测试。
 */
export const ENTRANCE_DURATIONS = Object.freeze({
  /** 地形从平面升至夸张后真实高度的时长（秒）。 */
  terrainRiseSeconds: ENTRANCE_TERRAIN_RISE_SECONDS,
  /** 省名标签错峰淡入总时长（秒）。 */
  labelsFadeSeconds: ENTRANCE_LABELS_FADE_SECONDS,
  /** 水面 / 边界淡入时长（秒）。 */
  sceneLayersFadeSeconds: ENTRANCE_SCENE_LAYERS_FADE_SECONDS,
  /** 省名标签错峰窗口占省名淡入总时长的分数（(0,1)）。 */
  labelStaggerWindowFraction: ENTRANCE_LABEL_STAGGER_WINDOW_FRACTION,
})
