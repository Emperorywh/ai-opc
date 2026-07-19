/**
 * 地形渲染配置与配置不变量（TASK-009）。
 *
 * 角色与依赖方向：
 * - 本模块属于运行时配置层（src/config），是「垂直夸张系数 k」与「地形网格分段预算」的**唯一**
 *   权威。渲染层（ChinaTerrainMesh）、场景装配（ChinaMapScreen）、自动化测试都只能通过本模块取得
 *   合法配置——禁止在组件内自行硬编码 k 或分段数，也禁止在别处另写一套校验（SPEC §3.2、§7.1、§7.2）。
 * - 单向依赖：本模块只依赖契约层 src/geo-contracts（复用高程编解码的唯一源 decodeUint16ToElevation，
 *   保证 CPU/GPU 共享同一解码语义），不依赖 React、R3F、Three.js 或任何 DOM/场景对象。这使得本模块
 *   可在 Node 测试环境直接断言「非法配置被拒绝」「生产默认未被偷偷改低」等配置不变量。
 *
 * 垂直夸张 k（SPEC §3.2、§13）：
 * - 真实海拔 h（米）→ 世界 y：y = h·k。k 在 GPU vertex shader 中应用（见 ChinaTerrainMesh 的着色器），
 *   CPU 高程查询层（src/lib/elevation）只产出真实米制 h，不感知 k——二者解耦，改 k 只改垂直起伏，
 *   不改平面位置、不改真实高程解码（TASK-009 输出约束）。
 * - 合法范围 [1.5, 3.0]；默认 2.0。k 过小（<1.5）起伏不明显，过大（>3.0）与墨卡托高纬放大叠加使
 *   北方视觉过扁（SPEC §13 风险权衡），故两端都拒绝，不允许外部传入越界 k「悄悄」生效。
 *
 * 网格分段预算（SPEC §7.1、§7.2）：
 * - 纹理分辨率（4096²）≠ 网格分段数。位移发生在 GPU vertex shader（按顶点 UV 采样 heightmap），
 *   故 mesh 分段远低于纹理分辨率也能呈现纹理级起伏。默认 2048²（≈4.2M 顶点，独显无压力），上限
 *   4096²（≈16.7M 顶点，GPU 充裕时可上调；临界，由人工帧率实测后决定，SPEC §7.2）。
 * - **绝对禁止** CPU 为高精网格逐顶点采样并写入 position（SPEC §7.1 红线）；分段只决定 GPU 顶点密度，
 *   不决定「是否走 GPU 位移」——位移恒在 shader 内。
 * - 下限 1：保留极低分段用于自动化/低资源测试环境（如 64²），但**生产默认必须保持 2048²**，测试配置
 *   与生产配置边界清楚分离（本模块分别导出 PRODUCTION_TERRAIN_CONFIG 与 TEST_TERRAIN_CONFIG）。
 *
 * CPU/GPU 解码一致性（TASK-009 输出约束「y 使用真实海拔乘夸张系数，不受后续颜色映射影响」）：
 * - 着色器内的解码公式（见 ChinaTerrainMesh 的 vertex shader）与本模块的 decodeNormalizedToElevation
 *   是同一仿射：h = normalized · (max − min) + min。min/max 来自经契约校验的 heightmap 元数据
 *   （src/geo-contracts decodeUint16ToElevation 的唯一源），由配置层透传给着色器 uniform——不存在
 *   第二套解码常量。位移 = decode(normalized) · k，**只**用于世界 y，不参与任何颜色映射（分层设色
 *   由后续 TASK 在片元着色器内按真实 h 重新采样，见 SPEC §3.1）。
 */

/** 垂直夸张系数 k 的下限（含）。低于此值起伏过弱，SPEC §3.2 明确范围起点。 */
export const TERRAIN_EXAGGERATION_MIN = 1.5
/** 垂直夸张系数 k 的上限（含）。高于此值与墨卡托高纬放大叠加使北方过扁（SPEC §13）。 */
export const TERRAIN_EXAGGERATION_MAX = 3.0
/** 垂直夸张系数 k 的生产默认值（SPEC §2 决策摘要、§3.2）。 */
export const TERRAIN_EXAGGERATION_DEFAULT = 2.0

/** 地形网格分段数（每边）的下限（含）。1 为数学下限；测试环境可用极低值降低顶点预算。 */
export const TERRAIN_MESH_SEGMENTS_MIN = 1
/**
 * 地形网格分段数（每边）的上限（含）。SPEC §7.2：4096² ≈ 16.7M 顶点为临界上限，
 * 默认 2048²；超过 4096² 必然爆显存/顶点内存，故硬性拒绝，不允许外部配置越界。
 */
export const TERRAIN_MESH_SEGMENTS_MAX = 4096
/** 地形网格分段数（每边）的生产默认值（SPEC §7.2 默认档）。 */
export const TERRAIN_MESH_SEGMENTS_DEFAULT = 2048

/** 配置解析失败的稳定错误码，供自动化测试精确断言「非法配置被拒绝」。 */
export type TerrainConfigFailureCode =
  | 'terrain-config.exaggeration-not-finite'
  | 'terrain-config.exaggeration-out-of-range'
  | 'terrain-config.segments-not-integer'
  | 'terrain-config.segments-out-of-range'

/** 配置解析失败结果：携带稳定 code 与简体中文说明，绝不静默夹回默认（否则非法配置会被偷偷放行）。 */
export interface TerrainConfigFailure {
  readonly ok: false
  readonly code: TerrainConfigFailureCode
  readonly message: string
}

/** 配置解析成功结果：携带经校验的夸张系数与网格分段。 */
export interface TerrainConfigSuccess {
  readonly ok: true
  readonly exaggeration: number
  readonly meshSegments: number
}

/** 配置解析的统一结果类型：成功带值，失败带 code/message；二者判别联合。 */
export type TerrainConfigResult = TerrainConfigSuccess | TerrainConfigFailure

/** 已解析的冻结地形渲染配置（供渲染层消费的稳定形态）。 */
export interface TerrainRenderConfig {
  /** 垂直夸张系数 k（合法范围 [1.5, 3.0]）。世界 y = 真实海拔 h · k。 */
  readonly exaggeration: number
  /** 地形 plane 每边分段数（合法范围 [1, 4096]，整数）。决定 GPU 顶点密度，不决定位移方式。 */
  readonly meshSegments: number
}

function configFail(code: TerrainConfigFailureCode, message: string): TerrainConfigFailure {
  return { ok: false, code, message }
}

/**
 * 解析并校验地形渲染配置（垂直夸张 + 网格分段）。
 *
 * 校验语义（非法配置一律显式失败，绝不静默夹回默认，否则生产默认可能被外部传入悄悄改低/改高）：
 * - exaggeration 非有限 → exaggeration-not-finite；越出 [1.5, 3.0]（含端点）→ exaggeration-out-of-range。
 * - meshSegments 非整数 → segments-not-integer；越出 [1, 4096]（含端点）→ segments-out-of-range。
 * - NaN/Infinity 因比较恒为 false，故先过 Number.isFinite 再过范围，避免漏检。
 *
 * 成功返回的配置对象已 Object.freeze，消费者不应（也无法）就地修改——改配置应重新调用 resolveTerrainConfig，
 * 使配置变化在渲染层走受控路径（uniform 更新），杜绝隐式状态。
 */
export function resolveTerrainConfig(input: {
  exaggeration?: number
  meshSegments?: number
}): TerrainConfigResult {
  const exaggeration = input.exaggeration ?? TERRAIN_EXAGGERATION_DEFAULT
  if (!Number.isFinite(exaggeration)) {
    return configFail(
      'terrain-config.exaggeration-not-finite',
      `垂直夸张系数必须为有限数值，实际为 ${exaggeration}。`,
    )
  }
  if (exaggeration < TERRAIN_EXAGGERATION_MIN || exaggeration > TERRAIN_EXAGGERATION_MAX) {
    return configFail(
      'terrain-config.exaggeration-out-of-range',
      `垂直夸张系数必须落在 [${TERRAIN_EXAGGERATION_MIN}, ${TERRAIN_EXAGGERATION_MAX}]，实际为 ${exaggeration}。`,
    )
  }

  const meshSegments = input.meshSegments ?? TERRAIN_MESH_SEGMENTS_DEFAULT
  if (!Number.isInteger(meshSegments)) {
    return configFail(
      'terrain-config.segments-not-integer',
      `网格分段数必须为整数，实际为 ${meshSegments}。`,
    )
  }
  if (meshSegments < TERRAIN_MESH_SEGMENTS_MIN || meshSegments > TERRAIN_MESH_SEGMENTS_MAX) {
    return configFail(
      'terrain-config.segments-out-of-range',
      `网格分段数必须落在 [${TERRAIN_MESH_SEGMENTS_MIN}, ${TERRAIN_MESH_SEGMENTS_MAX}]，实际为 ${meshSegments}。`,
    )
  }

  return {
    ok: true,
    exaggeration,
    meshSegments,
  }
}

/**
 * 解析并校验地形渲染配置；失败时抛错（供「配置不可非法」的启动期路径使用）。
 * 渲染层默认走本入口：非法配置在组件挂载期即暴露，而非带入运行时产生静默退化。
 */
export function resolveTerrainConfigOrThrow(input: {
  exaggeration?: number
  meshSegments?: number
}): TerrainRenderConfig {
  const result = resolveTerrainConfig(input)
  if (!result.ok) {
    throw new RangeError(`${result.code}：${result.message}`)
  }
  return Object.freeze({ exaggeration: result.exaggeration, meshSegments: result.meshSegments })
}

/**
 * 生产默认地形渲染配置（冻结）：k=2.0、分段 2048²（SPEC §3.2、§7.2）。
 *
 * 本常量是「生产默认未被偷偷改低」的自动化锚点：测试断言其夸张系数 = 2.0、分段 = 2048，
 * 任何调低生产默认的改动都会被测试捕获。低资源测试环境请改用 TEST_TERRAIN_CONFIG，不得改本常量。
 */
export const PRODUCTION_TERRAIN_CONFIG: TerrainRenderConfig = Object.freeze({
  exaggeration: TERRAIN_EXAGGERATION_DEFAULT,
  meshSegments: TERRAIN_MESH_SEGMENTS_DEFAULT,
})

/**
 * 测试 / 低资源环境地形渲染配置（冻结）：k=2.0（保留真实起伏语义）、分段 64²（大幅降低顶点预算）。
 *
 * 仅用于自动化环境（Node 测试无 GPU、CI 低显存）下驱动渲染层装配而不爆顶点内存。生产默认值不得
 * 被本配置污染——两条路径分别导出，边界清楚（TASK-009 输出约束「测试配置与生产配置边界清楚」）。
 */
export const TEST_TERRAIN_CONFIG: TerrainRenderConfig = Object.freeze({
  exaggeration: TERRAIN_EXAGGERATION_DEFAULT,
  meshSegments: 64,
})

/**
 * 把「归一化高程码」解码为真实米制海拔（与 vertex shader 内的解码公式**同一仿射**）。
 *
 * 着色器把 heightmap 纹理的归一化值（code/65535，FloatType 存储以保留 16 位精度）按下式解码：
 *   h = normalized · (max − min) + min
 * 这与 src/geo-contracts decodeUint16ToElevation（code/65535·(max−min)+min）在「normalized = code/65535」
 * 下完全一致——本函数是 CPU 侧对该公式的镜像，供测试断言「相同 UV 的 CPU/GPU 解码语义一致」。
 *
 * 注意：normalized 来自 GPU 纹理的硬件双线性采样（已在 [0,1] 内），故此处不再 clamp；若调用方持有
 * 未归一化的 uint16 编码，请直接用契约层的 decodeUint16ToElevation（它会校验整数范围）。
 */
export function decodeNormalizedToElevation(
  normalized: number,
  minValueMeters: number,
  maxValueMeters: number,
): number {
  // 与 src/geo-contracts decodeUint16ToElevation 的区间自洽校验同语义（min < max），避免本层另写一套。
  if (!(minValueMeters < maxValueMeters)) {
    throw new RangeError(
      `解码区间必须满足 minValueMeters < maxValueMeters，实际为 ${minValueMeters} / ${maxValueMeters}。`,
    )
  }
  // normalized = code/65535（由 GPU 纹理硬件双线性给出，已在 [0,1] 内），仿射还原成真实米制。
  return normalized * (maxValueMeters - minValueMeters) + minValueMeters
}

/**
 * 由真实米制海拔与夸张系数计算位移后的世界 y（米）：y = h · k（SPEC §3.2）。
 *
 * 这是 vertex shader 内 `displaced.y = h * uExaggeration` 的 CPU 侧镜像，供测试断言「y 使用真实海拔
 * 乘夸张系数」。改 k 只改 y，不改 h（真实高程解码）也不改平面位置——k 的作用边界由此函数显式表达。
 */
export function displaceElevationToWorldY(elevationMeters: number, exaggeration: number): number {
  return elevationMeters * exaggeration
}

/**
 * 断言两个数在给定绝对容差内相等（导出供测试复用，避免在测试内重写）。
 * @internal 仅供测试断言「CPU 镜像解码 == 契约层解码」使用。
 */
export function elevationWithinTolerance(actual: number, expected: number, tolerance: number): boolean {
  return Math.abs(actual - expected) <= tolerance
}
