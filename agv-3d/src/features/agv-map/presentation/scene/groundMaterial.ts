import { MeshStandardMaterial } from 'three'
import type { GroundMaterialTheme } from '../../config/visualTheme'
import { hslToLinearColor } from './colorConvert'

/**
 * 地面深色不透明材质工厂（SPEC §8.3、§8.4，TASK-012）。
 *
 * 职责：把视觉主题的地面参数（深色基础色、高粗糙度、低金属度）转换为单一 MeshStandardMaterial，
 * 作为本期深色沙盘底。SPEC §8.4 最终采用 MeshReflectorMaterial 平面反射，但反射属后续任务；
 * TASK-012 不混入平面反射（完成标准），此处给出深色不透明基线作为待替换底，参数集中、可验证、
 * 具备显式释放路径（SPEC §5.4）。
 *
 * 不变量（与 nodeMaterial 同构的展示层 GPU 资源工厂）：
 * - 纯函数：相同主题产生相同材质参数；不读取系统时间、相机或展示状态（SPEC §7.1 精神）。
 * - 色彩管线：颜色经 colorConvert.hslToLinearColor 由 sRGB HSL 线性化（§8.5）。
 * - 地面接收节点阴影（receiveShadow 由 mesh 对象开启，材质不强制），但不投射阴影
 *   （SPEC §8.3 仅节点 castShadow）；castShadow 默认 false，不在材质侧开启。
 * - fog 默认启用：MeshStandardMaterial.fog 默认 true，场景接入线性雾后自动参与（§8.4）。
 * - 确定性释放：返回材质由 EnvironmentLayer 持有并显式 dispose（SPEC §5.4）；工厂不挂全局缓存。
 *
 * 该模块位于展示层（创建 Three.js 场景对象），不属 domain/geometry 纯数据层（SPEC §5.1）。
 */

/**
 * 按地面视觉主题创建 MeshStandardMaterial（唯一实例）。
 *
 * @param theme 地面视觉主题（取自 ENVIRONMENT_THEME.ground）。
 */
export function createGroundMaterial(theme: GroundMaterialTheme): MeshStandardMaterial {
  return new MeshStandardMaterial({
    color: hslToLinearColor(theme.color),
    roughness: theme.roughness,
    metalness: theme.metalness,
  })
}
