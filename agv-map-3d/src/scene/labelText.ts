/*
 * 单个标签的 Troika Text 资源工厂（scene 装配层，SPEC 7.3 / 11.1 / 11.2 / 11.4 / 13 / 4.3 / 任务约束）。
 *
 * 信任边界定位（TASK-022）：
 *   - 本模块是“LabelDescriptor + 本地字体 URL → 一个配置好全部 SPEC 固定参数的 Troika Text 对象”的唯一入口。
 *   - 标签文字参数（fontSize / sdfGlyphSize / gpuAccelerateSDF / whiteSpace / color / font /
 *     anchorX / anchorY / depthTest / depthWrite / toneMapped / renderOrder）全部在此一次性写入，
 *     渲染层不得在组件内出现同义魔法数字或第二套文字参数（SPEC 11.1 / 任务约束）。
 *   - 只消费不可变 LabelDescriptor（锚点 / 局部偏移 / 文本 / 类别）与本地字体 URL；不读原始 JSON、
 *     不重算坐标、不创建空间索引或可见集（任务约束）。
 *
 * 字体门禁接入不变量（SPEC 11.1 / 4.2 / 任务约束）：
 *   - fontUrl 固定为同源本地 .woff（LABEL_FONT_URL）；预加载已由 application 层门禁完成，
 *     故本工厂创建的 Text 复用 preloadFont 的 SDF 缓存，不触发远端 / Unicode CDN 补字。
 *   - 调用方（LabelTextItem）负责在挂载后调用 text.sync() 与卸载时 text.dispose()，
 *     使“文字对象由创建方成对释放”成立（SPEC 4.3 / 任务约束）。
 *
 * 文字参数固定不变量（SPEC 11.1 / 任务约束）：
 *   - fontSize = LABEL_FONT_SIZE_METERS（0.20）：与投影字号计算同源常量，不形成第二套字号。
 *   - sdfGlyphSize = LABEL_FONT_SDF_GLYPH_SIZE（64）：与 preloadFont 同 SDF 分辨率，缓存可直接复用。
 *   - gpuAccelerateSDF = false：关闭实验性 GPU SDF，保证基线确定性。
 *   - whiteSpace = 'nowrap'、无 maxWidth：文本不换行、不压缩。
 *   - color = ENTITY_DISPLAY_COLORS.label（#FFFFFF）：白色标签，与 SPEC §7.2 同源。
 *   - depthTest = false、depthWrite = false、toneMapped = false：复刻始终可读的 2D 标签语义（SPEC 7.3）。
 *
 * 锚点对齐不变量（SPEC 11.2 / 任务约束）：
 *   - node / operational-node → anchorX = 'left'、anchorY = 'top'（屏幕右下方）。
 *   - edge → anchorX = 'center'、anchorY = 'top'。
 *   - 对齐由 kind 派生，与 LabelDescriptor.kind 契约一致；不在渲染层维护第二套派生。
 *
 * 初始位姿不变量（SPEC 11.4 / 任务约束）：
 *   - Text.position 初值为世界锚点 (anchorX, anchorY, anchorZ)；quaternion 初值为单位四元数。
 *   - 标签根变换（Text 的 position/quaternion）由单一帧协调器在每帧批量写入 camera quaternion 与
 *     由 camera 朝向推导的屏幕偏移后的世界位姿；本工厂只给确定性的初始值，避免首帧出现 NaN / 偏移。
 *
 * 依赖方向（SPEC 3.3）：labels（LabelDescriptor / 类别 / 字号常量）+ config（颜色 / 层高 / renderOrder /
 *   字体 URL / SDF 尺寸）+ 本层自身；外部仅 three + troika。不依赖 application / workers / camera / 原始数据。
 */
import { Text } from 'troika-three-text'
import type { LabelDescriptor, LabelKind } from '../labels/labelDescriptor'
import { LABEL_FONT_SIZE_METERS } from '../labels/labelVisibilityConfig'
import { ENTITY_DISPLAY_COLORS, RENDER_ORDER } from '../config/mapVisualConfig'
import { LABEL_FONT_SDF_GLYPH_SIZE, LABEL_FONT_URL } from '../config/fontConfig'

/*
 * SPEC 11.1：关闭实验性 GPU SDF，保证基线确定性。
 */
const LABEL_GPU_ACCELERATE_SDF = false

/*
 * SPEC 11.1：标签文本不换行、不压缩；不设置 maxWidth。
 */
const LABEL_WHITE_SPACE = 'nowrap'

/*
 * SPEC 11.2：按标签类别派生 Troika 文本对齐（与 LabelDescriptor.kind 契约一致）。
 * node / operational-node → 'left'（屏幕右下方起算）；edge → 'center'。
 * anchorY 统一 'top'（顶部对齐锚点，文本向下展开）。
 */
function labelAnchorX(kind: LabelKind): string {
  return kind === 'edge' ? 'center' : 'left'
}

/*
 * 标签 Text 工厂入参。
 *   - descriptor：不可变标签描述符（锚点 / 局部偏移 / 文本 / 类别）。
 *   - fontUrl：本地字体 URL（默认 LABEL_FONT_URL，禁止远端）。
 */
export interface CreateLabelTextParams {
  readonly descriptor: LabelDescriptor
  readonly fontUrl?: string
}

/*
 * 构造一个配置好全部 SPEC 固定参数的 Troika Text（SPEC 11.1 / 11.2 / 7.3 / 11.4）。
 *
 * 调用方契约：
 *   - descriptor 为已通过字体门禁后可见集中的一个标签（调用方保证字体已预载）。
 *   - 返回的 Text 尚未 sync：调用方在挂载后调用 text.sync(onSynced) 触发布局 / SDF 同步，
 *     并在 onSynced 内 invalidate 请求一次渲染（SPEC 13 demand 帧调度）。
 *   - 卸载时调用方调用 text.dispose() 释放 GPU 资源（SPEC 4.3 成对释放）。
 *
 * 文字参数全部固定（SPEC 11.1 / 任务约束）：不得通过替代参数改变既定视觉语义。
 * 初始 position 为世界锚点、quaternion 为单位四元数；逐帧朝向与屏幕偏移由帧协调器覆写。
 */
export function createLabelText(params: CreateLabelTextParams): Text {
  const { descriptor, fontUrl = LABEL_FONT_URL } = params
  const text = new Text()
  // 文本内容与本地字体：font 复用 preloadFont 缓存，不触发远端补字（SPEC 11.1）。
  text.text = descriptor.text
  text.font = fontUrl
  // 文字参数固定（SPEC 11.1）。
  text.fontSize = LABEL_FONT_SIZE_METERS
  text.sdfGlyphSize = LABEL_FONT_SDF_GLYPH_SIZE
  text.gpuAccelerateSDF = LABEL_GPU_ACCELERATE_SDF
  text.whiteSpace = LABEL_WHITE_SPACE
  text.color = ENTITY_DISPLAY_COLORS.label
  // 锚点对齐按类别派生（SPEC 11.2）。
  text.anchorX = labelAnchorX(descriptor.kind)
  text.anchorY = 'top'
  // 深度与色调：复刻始终可读的 2D 标签语义（SPEC 7.3）。
  text.depthTest = false
  text.depthWrite = false
  text.toneMapped = false
  // 提交顺序：标签在所有实体之后绘制（SPEC 7.4 label = 50）。
  text.renderOrder = RENDER_ORDER.label
  // 初始位姿：世界锚点 + 单位四元数；逐帧朝向由协调器覆写（SPEC 11.4）。
  text.position.set(descriptor.anchorX, descriptor.anchorY, descriptor.anchorZ)
  return text
}
