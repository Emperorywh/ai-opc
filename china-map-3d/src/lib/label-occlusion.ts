/**
 * 标签地形遮挡判定（领域层，TASK-017）。
 *
 * 角色与依赖方向：
 * - 本模块属于运行时访问层（src/lib），与 place-labels.ts / elevation.ts 同层。它把「标签世界坐标 +
 *   相机世界坐标 + 地形世界 y 采样器」确定性地变换为「标签相对相机是否被前方地形遮挡」的可见性状态
 *   （visible / occluded / indeterminate），供渲染层（src/three/PlaceLabels）只消费、不再自行实现射线
 *   行进或距离比较（TASK-017 输出约束「遮挡判断能力与标签渲染解耦」）。
 * - 单向依赖：本模块**不**依赖 React / R3F / Three.js / DOM / hover 状态 / 资产数据——它是纯函数，
 *   只接收坐标与一个抽象采样器闭包（TerrainWorldYSampler）。这使遮挡判定可在 Node 环境（vitest）用
 *   确定性几何夹具完整覆盖「无遮挡 / 前方山体遮挡 / 命中点位于标签之后 / 射线擦边 / 相机移动」等场景
 *   （TASK-017 验证方式 1），无需启动 WebGL / 浏览器（视觉验收留给 TASK-017 验证方式 4、5）。
 *
 * 与 Billboard 朝向正交（TASK-017 实现约束「Billboard 面向相机与地形遮挡是两个独立概念，不得通过关闭
 *   深度测试让标签永久穿透地形」）：
 * - Billboard 让文本恒面向相机（TASK-016），解决「被自身朝向遮挡」。本模块解决「被前方地形遮挡」——
 *   二者正交：本判定只关心「标签→相机」连线是否被地形抬起打断，与文本朝向无关。渲染层据此调制标签
 *   透明度（fillOpacity），深度测试保持开启（既不关闭深度测试让标签永久穿透，也通过淡化避免被前方
 *   山体硬切时整块标签突兀消失的违和感）。
 *
 * 高度场射线行进（SPEC §7.5「对每个标签做一次 raycast，标签位置→相机，命中地形且命中点更近则降低
 *   透明度」、TASK-017 可验证结果）：
 * - 把「标签→相机」连线参数化为 P(t) = label + t·(camera − label)，t∈[0,1]。在 t∈(near, far) 的内部
 *   区间均匀取 maxSamples 个采样点（跳过标签端 nearMargin 与相机端 farMargin，避免采到标签自身锚点
 *   地形或相机贴地点）。
 * - 每个采样点取其世界 (x, z) 查地形世界 y = h·k（由采样器闭包提供，与 GPU 位移同一高程事实源经夸张
 *   系数 k 还原，故判定与实际地形起伏一致）。
 * - 距离比较：若地形 y 高出「射线 y」超过 verticalClearance，则该处地形挡在标签与相机之间 → occluded
 *   （命中点比标签更近相机）。verticalClearance 提供抗擦边抖动的余量（地形需「明显」高过视线才算遮挡，
 *   擦边不计），避免采样落在山脊正上方时因亚采样 / 浮点抖动造成的可见性来回翻转。
 * - 任一采样点遮挡即整体 occluded（短路返回）；全部采样点都未遮挡 → visible。
 *
 * 不确定状态与生命周期（TASK-017 输出约束「字体加载未完成、地形不可用或标签已卸载时有明确生命周期
 *   处理，不产生错误射线或僵尸更新」）：
 * - 退化射线（标签与相机重合 / 非有限）→ indeterminate（无法判定，不伪造可见 / 遮挡）。
 * - 射线过短（nearMargin + farMargin ≥ 射线长，无可采样内部区间）→ indeterminate。
 * - 全部采样点查询失败（地形不可用 / 越出元数据范围 / provider 已释放 / 反投影失败 → 采样器返回
 *   null）→ indeterminate（不伪造结果）。渲染层据此「保持当前透明度」，既不伪造遮挡淡化已可见标签，
 *   也不在偶发查询失败时抖动。这与 elevation「不以魔法 0 混淆异常与海平面」同构：错误显式区分，
 *   绝不伪装成成功读数。
 *
 * 无分配约束（TASK-017 输出约束「不为每次检查重复创建大对象」、可验证结果「不会造成逐帧抖动或分配
 *   压力」）：
 * - 本函数全程不 new 数组 / 对象：循环用 number 局部量、短路返回字符串字面量。可被渲染层在帧循环中
 *   高频调用（每 N 帧一次 × 数十个标签）而不产生 GC 压力。状态（目标 / 当前透明度数组）由渲染层在
 *   挂载期一次性分配并复用，本函数只读输入、只返回字面量。
 */

/**
 * 标签或相机的世界坐标（米，x 东 / y 高程 / z 南，与 src/lib/projection 主图世界坐标系一致）。
 * 本模块不依赖 three，故用纯 TS 接口表达坐标，避免把 three 拉进领域层运行时依赖图。
 */
export interface LabelOcclusionVec3 {
  readonly x: number
  readonly y: number
  readonly z: number
}

/**
 * 地形世界 y 采样器：(worldX, worldZ) → 世界地形 y = h·k（米），或 null 表示该点不可采样
 * （越出元数据范围 / provider 已释放 / 反投影失败）。
 *
 * 由渲染 / 场景层从共享 ElevationProvider + 夸张系数 k 构造（见 ChinaMapScreen.PlaceLabelsLayer）：
 *   (x, z) => { const q = provider.queryAtWorld(x, z); return q.ok ? q.meters * k : null }
 * 本模块不持有 provider 引用、不复制高程数据——采样器是注入的纯查询闭包，使本函数可在 Node 环境
 * 用合成采样器（常数 / 高斯峰 / 阶梯）完整覆盖各遮挡场景，无需真实 heightmap。
 */
export type TerrainWorldYSampler = (worldX: number, worldZ: number) => number | null

/**
 * 遮挡判定的可配置参数（全部有限、确定性，由 src/config/label-occlusion 提供生产值）。
 * 各字段语义见 computeLabelVisibility 内的逐行注释。
 */
export interface LabelOcclusionConfig {
  /** 沿射线均匀采样的最大点数（固定上限，避免长射线无限采样）。 */
  readonly maxSamples: number
  /** 标签端跳过的近端长度（米，沿射线弧长）：避免采到标签自身锚点地形造成自我遮挡。 */
  readonly nearMarginMeters: number
  /** 相机端跳过的远端长度（米，沿射线弧长）：避免采到相机贴地点。 */
  readonly farMarginMeters: number
  /** 判定遮挡的垂直余量（米）：地形需高出射线 y 该值才算遮挡，抗擦边抖动。 */
  readonly verticalClearanceMeters: number
}

/**
 * 标签相对相机的可见性状态（确定、可恢复，TASK-017 实现约束「可见/遮挡状态必须确定且可恢复」）。
 * - visible：标签→相机连线未被前方地形打断，标签应保持完全可见。
 * - occluded：连线上存在前方地形高过视线（命中点比标签更近相机），标签应降低透明度。
 * - indeterminate：无法判定（退化射线 / 全部采样失败）；渲染层保持当前透明度，不抖动。
 */
export type LabelVisibility = 'visible' | 'occluded' | 'indeterminate'

/** 单个标签遮挡判定的输入。 */
export interface LabelOcclusionInput {
  /** 标签世界坐标（米；y = h·k + 浮高，由领域层 preparePlaceLabels 准备）。 */
  readonly label: LabelOcclusionVec3
  /** 相机世界坐标（米；由 R3F 帧循环读取 camera.position）。 */
  readonly camera: LabelOcclusionVec3
  /** 地形世界 y 采样器（抽象闭包，由场景层从共享 ElevationProvider + k 构造）。 */
  readonly sampler: TerrainWorldYSampler
}

/**
 * 沿「标签→相机」射线在高度场上行进，判定标签是否被前方地形遮挡（纯函数，可在 Node 直接断言）。
 *
 * 射线方向：从标签指向相机（camera − label）。我们在其内部区间均匀采样、对每个采样点比较地形世界 y
 * 与射线 y：地形明显高过视线（超出 verticalClearance）即遮挡。短路返回，全程无分配。
 *
 * @returns 'occluded' 任一采样点被前方地形挡住；'visible' 全部采样点未被挡；'indeterminate' 退化 / 全失败。
 */
export function computeLabelVisibility(
  input: LabelOcclusionInput,
  config: LabelOcclusionConfig,
): LabelVisibility {
  const { label, camera, sampler } = input
  // 射线向量 = 相机 − 标签；用其弧长 segLen 把「沿射线的米制距离」换算成参数 t = dist / segLen ∈ [0,1]。
  const dx = camera.x - label.x
  const dy = camera.y - label.y
  const dz = camera.z - label.z
  const segLen = Math.hypot(dx, dy, dz)
  // 退化射线（标签与相机重合）或非有限 → 无法判定。返回 indeterminate，绝不产生错误射线 / 伪造遮挡。
  if (!Number.isFinite(segLen) || segLen < 1e-9) {
    return 'indeterminate'
  }

  // 采样区间 [tStart, tEnd]（米，沿射线弧长）：跳过标签端近端 nearMargin、相机端远端 farMargin。
  const tStart = config.nearMarginMeters
  const tEnd = segLen - config.farMarginMeters
  // 射线过短（无内部采样区间）→ 无法判定（标签与相机几乎贴合，无可遮挡意义）。
  if (!(tEnd > tStart)) {
    return 'indeterminate'
  }
  const span = tEnd - tStart
  // 至少 1 个采样点（config 由生产配置保证 maxSamples ≥ 1；此处兜底防御畸形配置）。
  const sampleCount = config.maxSamples > 0 ? config.maxSamples : 1

  let anySampled = false
  // 在 (tStart, tEnd) 内均匀取 sampleCount 个内部点（i = 1..sampleCount，分母 sampleCount+1，跳过两端）。
  // 采样点数固定上限、沿区间均匀分布——确定性策略，无随机抽样（TASK-017 约束「不得用随机抽样造成闪烁」）。
  for (let i = 1; i <= sampleCount; i++) {
    const t = tStart + (span * i) / (sampleCount + 1)
    // 沿全段的分数位置 f ∈ (0, 1)：把弧长距离 t 还原成参数 f，再插值得到采样点世界坐标。
    const f = t / segLen
    const px = label.x + dx * f
    const py = label.y + dy * f
    const pz = label.z + dz * f
    // 查采样点处的地形世界 y。采样器返回 null 表示该点不可用（越界 / released / 反投影失败）。
    const terrainY = sampler(px, pz)
    if (terrainY === null || !Number.isFinite(terrainY)) {
      // 该采样点地形不可用：跳过，不据此判可见 / 遮挡（避免在不可用区段伪造结论）。
      continue
    }
    anySampled = true
    // 距离比较：地形世界 y 高出「射线在该处的 y」超过 verticalClearance → 该处地形挡在标签与相机之间
    // （命中点比标签更近相机）→ 遮挡。短路返回，不再采样后续点。
    if (terrainY > py + config.verticalClearanceMeters) {
      return 'occluded'
    }
  }

  // 全部采样点查询失败（地形整体不可用）→ 无法判定；渲染层保持当前透明度，不伪造可见 / 遮挡。
  if (!anySampled) {
    return 'indeterminate'
  }
  // 全部采样点的地形均未高过视线 → 标签相对相机可见。
  return 'visible'
}
