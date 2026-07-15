import { MeshStandardMaterial } from 'three'
import type { NodeVisualTheme } from '../../config/visualTheme'
import { hslToLinearColor } from './colorConvert'

/**
 * 节点标准材质工厂（SPEC §8.2、§8.3、§11.1，TASK-009）。
 *
 * 职责：把 visualTheme 中的节点主题（基础色、自发光强度、金属度、粗糙度）转换为四类节点
 * 共用同构的 MeshStandardMaterial。每类节点由 NodeLayer 各创建一个实例，运行期不重建。
 *
 * 与 createPathMaterial 同为展示层 GPU 资源工厂，遵循相同的不变量：
 * - 纯函数：相同主题产生相同材质参数；不读取系统时间、相机或展示状态（SPEC §7.1 精神）。
 * - 色彩管线：颜色经 colorConvert.hslToLinearColor 由 sRGB HSL 线性化，直接作为工作空间
 *   Color 传入构造器，保证 ACES 色调映射与 sRGB 输出一致（SPEC §8.5）。
 * - 确定性释放：返回的材质由调用方（NodeLayer）持有并显式 dispose（SPEC §5.4）；工厂不挂
 *   全局缓存，避免隐式单例与跨实例泄漏。
 *
 * 为什么抽成独立工厂：
 * - 使 NodeLayer 的材质生命周期与几何对齐为 useMemo + primitive + 显式 dispose，
 *   而非依赖 R3F 对 JSX <meshStandardMaterial> 的隐式释放（SPEC §5.4 要求显式释放路径，
 *   且释放不得依赖后续 TASK 才能证明）。
 * - 把"主题 → 材质参数"映射抽离为可单独验证的纯函数，覆盖材质类型、参数来源与 dispose
 *   生命周期的自动化测试（TASK-009 验证方式）。
 */

/**
 * 按节点视觉主题创建 MeshStandardMaterial（每类一个实例）。
 *
 * 材质参数语义（SPEC §8.2、§8.3）：
 * - color / emissive 同取基础色：基础色既受光照塑形（diffuse），又按 emissiveIntensity
 *   自发光，emissiveIntensity 编码"低于/接近/高于 Bloom 阈值"的目标层次（§8.2 末列）。
 * - emissiveIntensity 由主题统一提供，组件内不散落发光强度数值（§12）。
 * - metalness / roughness 由主题统一提供，固定标准物理材质参数（§8.3）。
 *
 * @param theme 单类节点的完整视觉主题（取自 NODE_VISUAL_THEME[type]）。
 */
export function createNodeMaterial(theme: NodeVisualTheme): MeshStandardMaterial {
  const baseColor = hslToLinearColor(theme.color.baseColor)
  return new MeshStandardMaterial({
    color: baseColor,
    emissive: baseColor,
    emissiveIntensity: theme.color.emissiveIntensity,
    metalness: theme.material.metalness,
    roughness: theme.material.roughness,
  })
}
