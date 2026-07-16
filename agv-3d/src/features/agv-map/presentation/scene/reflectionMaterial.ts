import { MeshReflectorMaterial } from '@react-three/drei/materials/MeshReflectorMaterial'
import type { GroundMaterialTheme, ReflectionTheme } from '../../config/visualTheme'
import { hslToLinearColor } from './colorConvert'

/**
 * 平面反射材质工厂（SPEC §8.3、§8.4 真实平面反射，TASK-013）。
 *
 * 职责：把视觉主题的地面基础色/粗糙度/金属度与反射参数（mirror/mixStrength/mixBlur）转换为单一
 * drei MeshReflectorMaterial 实例。该材质继承 MeshStandardMaterial 并在 onBeforeCompile 注入反射
 * 采样着色器（采样 tDiffuse 清晰反射、tDiffuseBlur 模糊反射，按 mirror/mixBlur 混合），是 SPEC
 * 已确认的唯一平面反射方案（§8.4、TASK-013 实现约束：不使用普通材质高光/环境贴图 fallback）。
 *
 * 与 createNodeMaterial / createPathMaterial 同为展示层 GPU 资源工厂，遵循相同的不变量：
 * - 纯函数：相同主题产生相同材质参数；不读取系统时间、相机或展示状态（SPEC §7.1 精神）。
 * - 色彩管线：基础色经 colorConvert.hslToLinearColor 由 sRGB HSL 线性化（§8.5）。
 * - 模糊着色器固定启用：USE_BLUR define 在首帧编译前注入，使片元始终走"一次粗糙模糊"混合
 *   路径（SPEC §8.4、TASK-013）；hasBlur uniform 同步置 true。
 * - 反射纹理（tDiffuse/tDepth/tDiffuseBlur）与 textureMatrix 在组件挂载时由反射会话绑定，
 *   此处不绑定（材质构造期尚无 RenderTarget）。
 * - 确定性释放：返回材质由 PlaneReflectionGround 持有并显式 dispose（SPEC §5.4）；工厂不挂全局缓存。
 *
 * 该模块位于展示层（创建 Three.js 场景对象），不属 domain/geometry 纯数据层（SPEC §5.1）。
 */

/**
 * 按地面与反射视觉主题创建 MeshReflectorMaterial（唯一实例）。
 *
 * 材质参数语义（SPEC §8.3、§8.4）：
 * - color/roughness/metalness 取地面主题：深色哑光底，高粗糙度配合 mixBlur 产生粗糙倒影。
 * - mirror/mixStrength/mixBlur 取反射主题：mirror 控制反射覆盖、mixStrength 控制反射亮度、
 *   mixBlur 与 roughness 联合控制模糊混合（§8.4、TASK-013）。
 * - 深度相关参数（depthScale/minDepthThreshold 等）保持默认 0：不启用深度相关模糊，反射模糊
 *   仅由一次粗糙 BlurPass 统一处理。
 *
 * @param ground 地面基础材质主题（取自 ENVIRONMENT_THEME.ground）。
 * @param reflection 反射视觉主题（取自 ENVIRONMENT_THEME.reflection）。
 */
export function createReflectionMaterial(
  ground: GroundMaterialTheme,
  reflection: ReflectionTheme,
): MeshReflectorMaterial {
  // 构造期只传 MeshStandardMaterial 标准属性（color/roughness/metalness）。drei MeshReflectorMaterial
  // 构造器先调用 super(parameters)，此时反射私有字段（_mirror/_mixBlur 等）尚未初始化，若在
  // parameters 中传入 mirror/mixStrength/mixBlur 会触发其 setter 读取 undefined 抛错；故反射参数
  // 在构造后（私有字段已初始化）再经 setter 赋值（与 drei <MeshReflectorMaterial> 经 applyProps 赋值同效）。
  const material = new MeshReflectorMaterial({
    color: hslToLinearColor(ground.color),
    roughness: ground.roughness,
    metalness: ground.metalness,
  })
  material.mirror = reflection.mirror
  material.mixStrength = reflection.mixStrength
  material.mixBlur = reflection.mixBlur
  // 默认 mixContrast=1、distortion=1、depth 相关=0，不启用扭曲与深度模糊。
  // 固定启用模糊着色路径（SPEC §8.4 一次粗糙模糊）；define 须在首帧编译前注入。
  material.hasBlur = true
  material.defines = { ...material.defines, USE_BLUR: '' }
  material.needsUpdate = true
  return material
}
