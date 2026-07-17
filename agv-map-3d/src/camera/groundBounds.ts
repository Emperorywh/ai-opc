/*
 * 有限地面范围推导（camera 层，SPEC 12.1 / 12.3 / 7.1 / 16）。
 *
 * 信任边界定位（TASK-017）：
 *   - 本模块消费 TASK-012 交付的唯一数值内容包围盒 contentBounds（已合并 lane offset 后的
 *     ribbon、两类箭头与节点圆柱真实几何范围，排除标签与地面），按 SPEC 12.1 固定规则
 *     推导有限地面 XZ 范围，供后续 GroundLayer 与动态裁剪面推导共享，不另建几何范围。
 *   - 地面是有限平面：XZ 由内容尺寸 + 固定 padding 决定，Y 固定为 SPEC 7.1 Ground Y = 0。
 *     背景色负责视口边缘，禁止用足量大数平面或无限 far plane（SPEC 12.1）。
 *   - 地面参与裁剪面推导（clipBounds = expanded content bounds ∪ Ground bounds）但不参与 fit；
 *     本模块只交付数值范围，不决定相机或材质。
 *
 * 唯一消费不变量（SPEC 12.1 / 任务约束）：
 *   - 本模块只读 contentBounds 的六个数值分量，不回读原始 JSON / 几何数组 / 节点坐标，
 *     不维护第二套 bounds，也不做第二次坐标转换（坐标已在适配层一次性映射）。
 *   - 地面 padding 固定为 max(5m, max(contentWidth, contentDepth) × 10%)，
 *     不随视口、相机或用户浏览变化；本规则是 SPEC 12.1 唯一地面尺寸规则。
 *
 * 无效输入不变量（SPEC 16 / 任务约束）：
 *   - contentBounds 任一分量非有限、或 min > max 时返回 null，调用方不得提交地面状态，
 *     禁止产生 NaN / Infinity。
 *   - 合法输入恒得到有限地面范围（min ≤ max、六分量有限、Y 恒为 [0, 0]）。
 *
 * 依赖方向（SPEC 3.3）：仅依赖 domain（NumericBox3），是纯函数；
 *   不依赖 Three / R3F / React / 浏览器 API。
 */
import type { NumericBox3 } from '../domain/sceneMap'

/*
 * SPEC 12.1：地面 padding 下限（米）。
 * 地面每侧 padding = max(本下限, max(内容宽, 内容深) × GROUND_PADDING_RATIO)，
 * 保证小地图也至少有 5m 边距，避免地面紧贴内容。
 */
export const GROUND_PADDING_MIN_METERS = 5

/*
 * SPEC 12.1：地面 padding 相对内容最大水平维度的比例（10%）。
 */
export const GROUND_PADDING_RATIO = 0.1

/*
 * SPEC 7.1：地面层 Y（米）。地面是位于 Y = 0 的有限平面，minY = maxY = 0。
 */
export const GROUND_Y = 0

/*
 * 校验 contentBounds 是否为合法数值范围（SPEC 16 / 任务约束）。
 * 六分量均有限且满足 min ≤ max 才视为合法；否则上层不得据其推导地面 / fit / 裁剪。
 */
function isValidBounds(b: NumericBox3): boolean {
  return (
    Number.isFinite(b.minX) &&
    Number.isFinite(b.minY) &&
    Number.isFinite(b.minZ) &&
    Number.isFinite(b.maxX) &&
    Number.isFinite(b.maxY) &&
    Number.isFinite(b.maxZ) &&
    b.minX <= b.maxX &&
    b.minY <= b.maxY &&
    b.minZ <= b.maxZ
  )
}

/*
 * 推导地面 padding（SPEC 12.1）。
 *
 * 地面推导规则（SPEC 12.1）：
 *   - padding = max(5m, max(contentWidth, contentDepth) × 10%)。
 *   - 宽 / 深取 contentBounds 的 X / Z 维度（地面是 XZ 平面），不使用 Y 维度。
 *   - 取宽深较大者 × 10%，保证地面在任何长宽比的内容下都等比例留边；
 *     小地图（宽深均 < 50m）由 5m 下限兜底。
 */
export function computeGroundPadding(contentBounds: NumericBox3): number {
  const width = contentBounds.maxX - contentBounds.minX
  const depth = contentBounds.maxZ - contentBounds.minZ
  const longest = Math.max(width, depth)
  return Math.max(
    GROUND_PADDING_MIN_METERS,
    longest * GROUND_PADDING_RATIO,
  )
}

/*
 * 推导有限地面范围（SPEC 12.1 / 7.1 / 12.3）。
 *
 * 地面推导语义：
 *   - XZ 范围 = 内容 XZ 范围每侧加 padding（SPEC 12.1）。
 *   - Y 恒为 [0, 0]：地面位于 SPEC 7.1 Ground Y = 0 的有限平面，不随内容 Y 范围变化。
 *   - 该范围既描述 GroundLayer 的有限平面尺寸，也作为 clipBounds 的 Ground 贡献参与
 *     动态 near / far 推导（SPEC 12.3 step 1）。
 *
 * 无效输入不变量：contentBounds 非有限或 min > max 时返回 null，禁止产生 NaN / Infinity。
 * 调用方（后续 GroundLayer / 裁剪面）收到 null 时不得提交，应保持上一稳定状态或不渲染地面。
 */
export function computeGroundBounds(
  contentBounds: NumericBox3,
): NumericBox3 | null {
  if (!isValidBounds(contentBounds)) return null
  const padding = computeGroundPadding(contentBounds)
  return {
    minX: contentBounds.minX - padding,
    maxX: contentBounds.maxX + padding,
    minY: GROUND_Y,
    maxY: GROUND_Y,
    minZ: contentBounds.minZ - padding,
    maxZ: contentBounds.maxZ + padding,
  }
}
