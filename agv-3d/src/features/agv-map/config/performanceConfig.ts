/**
 * 性能与像素预算集中配置（SPEC §11.1、§12）。
 *
 * 配置按职责集中、所有参数携带单位后缀（SPEC §12）。本文件承载主画布物理像素预算与
 * 有效 DPR 计算逻辑：在任意 CSS 尺寸与设备像素比下，把实际渲染像素限制在 4K 预算内，
 * 避免操作系统缩放使 4K 目标画布膨胀到 6K/8K（SPEC §11.1）。
 *
 * 阴影贴图与反射 RenderTarget 分辨率同样属于性能预算，按所属任务随用随加（§2.3 不创建未实现
 * 能力的空模块）：TASK-012 落地阴影贴图分辨率（SHADOW_MAP_SIZE_PIXELS，SPEC §8.3、§11.1）；
 * TASK-013 落地反射 RenderTarget 分辨率（REFLECTION_TARGET_SIZE_PIXELS，SPEC §8.4、§11.1）。
 *
 * 不变量：
 * - effectiveDpr 为纯函数：相同输入产生相同输出，不读取 DOM 以外的隐式状态；
 *   DOM 尺寸与 devicePixelRatio 由调用方传入。
 * - 像素预算为硬上限：当设备像素比或 CSS 尺寸使物理像素超过预算时，DPR 严格按 SPEC §11.1
 *   公式向下钳制（可低于 1），保证物理像素总数不超过 3840×2160；不施加会突破预算的下限覆盖
 *   （TASK-011）。CSS 尺寸本身不受影响，画面布局由 Canvas 跟随容器（§9.3）。
 */

/** 主画布最大物理宽度，单位像素（SPEC §11.1：3840）。 */
export const MAX_RENDER_WIDTH_PX = 3840

/** 主画布最大物理高度，单位像素（SPEC §11.1：2160）。 */
export const MAX_RENDER_HEIGHT_PX = 2160

/** 主画布最大物理像素总数（SPEC §11.1：3840 × 2160）。 */
export const MAX_RENDER_PIXELS = MAX_RENDER_WIDTH_PX * MAX_RENDER_HEIGHT_PX

/**
 * 阴影贴图分辨率，单位像素（SPEC §8.3、§11.1：固定 2048×2048）。
 *
 * 方向光阴影贴图宽高同取该值；只有节点投射阴影（SPEC §8.3），贴图只需覆盖节点足迹，
 * 2048 在 V76 基线下兼顾边缘清晰度与显存（§11.1 性能预算）。由 EnvironmentLayer 消费，
 * 不在组件内散落（§12 性能预算集中）。
 */
export const SHADOW_MAP_SIZE_PIXELS = 2048

/**
 * 反射 RenderTarget 分辨率，单位像素（SPEC §8.4、§11.1：固定 1024×1024）。
 *
 * 平面反射的颜色 RenderTarget、深度纹理与模糊输出 RenderTarget 宽高同取该值（SPEC §11.1
 * "反射 RenderTarget 1024×1024"）。该值为固定预算，不随主画布 DPR、CSS 尺寸、resize 或
 * 4K 主渲染尺寸变化（SPEC §11.1、TASK-013 resize 不变性实现约束）：主画布放大或系统缩放
 * 只改变主渲染分辨率，反射 RenderTarget 始终为 1024×1024，避免随主画布膨胀到 2K/4K。
 *
 * 1024 在 V76 基线下兼顾倒影清晰度与显存（HalfFloat 1024² 约 8 MiB/张；反射固定占用颜色、
 * 深度与模糊输出 RenderTarget 共约 24 MiB，外加 BlurPass 内部两张中间目标）。由
 * PlaneReflectionGround 消费，不在组件内散落数字（§12 性能预算集中）。
 */
export const REFLECTION_TARGET_SIZE_PIXELS = 1024

/**
 * 瞬态/非法输入的安全默认 DPR（SPEC §9.3、TASK-011 异常路径）。
 *
 * 仅用于零尺寸、负值或非有限的瞬态输入（如 resize 中容器尚未量得的 0×0、SSR 无 window）：
 * 这些输入无法参与预算公式，回退到中性 DPR 1，保证不产生 NaN/Infinity 相机参数，
 * 也不触发任何下载、解析或编译（§9.3）。一旦容器获得正有限尺寸，立即按下方公式重算。
 *
 * 注意：该常量不作为正有限尺寸的下限。对正有限尺寸严格使用 SPEC §11.1 公式，
 * 允许 DPR < 1 以保证物理像素总数不超过 3840×2160 预算（见 computeEffectiveDpr）。
 */
export const DPR_FLOOR = 1

/**
 * 计算有效设备像素比（SPEC §11.1，TASK-011）。
 *
 * 对正有限尺寸严格使用 SPEC 公式，不施加任何会突破总像素预算的下限：
 *
 *   effectiveDpr = min(devicePixelRatio, sqrt(MAX_RENDER_PIXELS / (cssWidth × cssHeight)))
 *
 * - 当 CSS 尺寸较小（如 1080p 窗口）时，平方根项通常大于设备像素比，DPR 取设备像素比，
 *   画面保持原生清晰度。
 * - 当 CSS 尺寸使 CSS 像素总数超过 4K 预算（如 4K 大屏叠加操作系统缩放产生超大逻辑窗口）时，
 *   平方根项 < 1，DPR 被向下钳制到该值（可能小于 1）。此时画布以低于 CSS 1:1 的分辨率渲染、
 *   由浏览器上采样，从而把物理像素总数牢牢限制在 3840×2160 内，避免 5K/6K/8K 膨胀（§11.1）。
 *   DPR<1 是有意的预算钳制，而非退化：场景依然完整渲染，仅在超大窗口下适度模糊（TASK-011）。
 * - 两个正数的 min 必为正数，故正有限尺寸路径永不产生 0、负值或 NaN。
 * - 输入瞬态非法（devicePixelRatio 非有限/非正，或 CSS 尺寸非有限/非正）时回退到 DPR_FLOOR，
 *   保证 resize 零尺寸帧、SSR 等瞬态不产生 NaN 相机/渲染参数，也不触发新加载（§9.3、TASK-011）。
 *
 * 不变量：对任意正有限 (devicePixelRatio, cssWidth, cssHeight)，物理像素总数
 * (effectiveDpr × cssWidth) × (effectiveDpr × cssHeight) ≤ MAX_RENDER_PIXELS。
 *
 * @param devicePixelRatio 浏览器 window.devicePixelRatio（或等效物理/CSS 像素比）。
 * @param cssWidth 渲染容器 CSS 宽度，单位像素。
 * @param cssHeight 渲染容器 CSS 高度，单位像素。
 */
export function computeEffectiveDpr(
  devicePixelRatio: number,
  cssWidth: number,
  cssHeight: number,
): number {
  // 瞬态/非法输入：回退中性 DPR，不参与预算计算（§9.3 不产生 NaN、不触发新加载）。
  if (!Number.isFinite(devicePixelRatio) || devicePixelRatio <= 0) return DPR_FLOOR
  if (!Number.isFinite(cssWidth) || !Number.isFinite(cssHeight)) return DPR_FLOOR
  if (cssWidth <= 0 || cssHeight <= 0) return DPR_FLOOR
  // 正有限尺寸：严格 SPEC §11.1 公式，不施加会突破预算的下限（允许 DPR<1）。
  const cssPixels = cssWidth * cssHeight
  const budgetRatio = Math.sqrt(MAX_RENDER_PIXELS / cssPixels)
  return Math.min(devicePixelRatio, budgetRatio)
}
