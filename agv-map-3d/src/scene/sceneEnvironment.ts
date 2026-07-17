/*
 * 场景环境灯光工厂（scene 装配层，SPEC 7.3 / 13 / 任务约束）。
 *
 * 信任边界定位（TASK-018）：
 *   - 本模块创建静态场景的基础光照：一盏半球光 + 一盏方向光，参数全部来自 config 唯一常量表。
 *   - 灯光是“静态环境”的一部分，与数据派生的 ribbon / 节点 / 箭头资源不同源：
 *     只读 config 灯光参数，不解析数据、不随相机或浏览状态变化。
 *
 * 无阴影不变量（SPEC 7.3 / 任务约束）：
 *   - v1 不启用阴影、不创建 shadow map；方向光 castShadow 恒为 false，禁止为静态场景引入阴影开销。
 *   - 半球光提供自上而下的环境光，方向光提供方向性明暗；二者组合使受光节点圆柱呈现稳定明暗差。
 *
 * 资源所有权不变量（SPEC 4.3）：
 *   - 半球光 / 方向光不持有 GPU 资源（无 geometry / material / texture），Three 的 Light 没有
 *     需要释放的 GPU 缓冲；dispose 为幂等空操作，仅满足统一 Handle 契约，不产生第二套释放语义。
 *   - 灯光以 Group 形式由 SceneEnvironmentLayer 通过 <primitive> 装配；R3F 不自动释放 primitive。
 *
 * 依赖方向（SPEC 3.3）：config（灯光参数）+ 本层自身；外部仅 three。
 *   不依赖 domain / application / workers / camera / labels，不回读数据。
 */
import {
  DirectionalLight,
  Group,
  HemisphereLight,
} from 'three'
import {
  DIRECTIONAL_LIGHT_PARAMS,
  HEMISPHERE_LIGHT_PARAMS,
} from '../config/mapVisualConfig'

/*
 * 场景环境灯光 Handle。
 *   - group：包含半球光与方向光的 Group，可被 <primitive object={group}> 直接装配。
 *   - dispose：幂等空操作（灯光无 GPU 资源），保持与 GroundMeshHandle 同构的释放契约。
 */
export interface SceneEnvironmentHandle {
  readonly group: Group
  dispose(): void
}

/*
 * 构造场景环境灯光（SPEC 7.3 半球光 / 方向光）。
 *
 * 灯光装配：
 *   - 半球光：天空色 #FFFFFF、地面色 #202020、强度 0.8（config HEMISPHERE_LIGHT_PARAMS）。
 *   - 方向光：白色、强度 1.0、位置 (80, 120, 60)（config DIRECTIONAL_LIGHT_PARAMS）。
 *   - 二者 castShadow = false：v1 无阴影资源（SPEC 7.3 / 任务约束）。
 *
 * 返回 Group 而非数组：单一 <primitive> 即可把全部灯光挂入场景，装配层无需逐灯遍历。
 */
export function createSceneEnvironment(): SceneEnvironmentHandle {
  const group = new Group()

  // 半球光：自上而下的环境光，受光节点圆柱呈现稳定底色。
  const hemisphere = new HemisphereLight(
    HEMISPHERE_LIGHT_PARAMS.skyColor,
    HEMISPHERE_LIGHT_PARAMS.groundColor,
    HEMISPHERE_LIGHT_PARAMS.intensity,
  )
  hemisphere.castShadow = false

  // 方向光：提供方向性明暗；位置固定 (80, 120, 60)，不投射阴影。
  const directional = new DirectionalLight(
    DIRECTIONAL_LIGHT_PARAMS.color,
    DIRECTIONAL_LIGHT_PARAMS.intensity,
  )
  directional.position.set(
    DIRECTIONAL_LIGHT_PARAMS.position[0],
    DIRECTIONAL_LIGHT_PARAMS.position[1],
    DIRECTIONAL_LIGHT_PARAMS.position[2],
  )
  directional.castShadow = false

  group.add(hemisphere)
  group.add(directional)

  let disposed = false
  return {
    group,
    dispose(): void {
      // 半球光 / 方向光无 GPU 资源（Three Light 不持有 geometry / material / texture），
      // 无需释放；保留幂等标志以匹配 Handle 契约，StrictMode 风格重复调用安全。
      if (disposed) return
      disposed = true
    },
  }
}
