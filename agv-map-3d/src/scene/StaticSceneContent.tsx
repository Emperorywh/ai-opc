/*
 * 静态场景内容装配（scene 装配层，SPEC 13 / 15.3 / 任务约束）。
 *
 * 定位（TASK-018）：
 *   - 本组件是“已完成渲染资源 + 有限地面 + 静态灯光 + 背景色”到 R3F 子树的唯一装配点。
 *   - 按 SPEC §13 顺序组织图层：背景色 → 场景环境 → 地面 → ribbon → 边箭头 → 节点 → 节点箭头。
 *     renderOrder 由各对象自身携带（SPEC 7.4），本组件不重设提交顺序、不替代深度测试。
 *
 * 只读装配不变量（任务约束）：
 *   - 入参为已完成的 MapResources 与只读 groundBounds；本组件不创建实体几何、不回读原始 JSON、
 *     不重算矩阵或颜色。实体对象由 orchestrator 提供，地面 / 灯光由各自工厂创建。
 *   - 不挂载任何文字对象（标签懒挂载属于后续 TASK）；初始总览 Text 数恒为 0（任务输出）。
 *
 * draw call 契约（SPEC 7.4 / 15.3 / 任务输出）：
 *   - 地面 1 + ribbon 1 + 边箭头 1 + 节点 1 + 节点箭头 1 = 5 个 Mesh / InstancedMesh，
 *     每个一次 draw call，初始实体 draw call ≤ 5；本组件不为每实体拆分 Mesh / Line / 组件。
 *
 * 依赖方向（SPEC 3.3）：rendering（MapResources）+ domain（NumericBox3）+ config（背景色）+ 本层各图层 + react。
 *   不依赖 camera / workers / application / 原始数据；相机与 Canvas 装配属于 app-root。
 */
import type { NumericBox3 } from '../domain/sceneMap'
import type { MapResources } from '../rendering/mapResources'
import { BACKGROUND_COLOR } from '../config/mapVisualConfig'
import { SceneEnvironmentLayer } from './SceneEnvironmentLayer'
import { GroundLayer } from './GroundLayer'
import {
  EdgeArrowLayer,
  NodeArrowLayer,
  NodeLayer,
  RibbonLayer,
} from './EntityLayers'

/*
 * 静态场景内容入参。
 *   - resources：orchestrator 在 ready 状态交付的已完成 Three 资源集合（TASK-014）。
 *   - groundBounds：TASK-017 computeGroundBounds 交付的只读数值地面范围。
 */
export interface StaticSceneContentProps {
  readonly resources: MapResources
  readonly groundBounds: NumericBox3
}

/*
 * 静态场景内容装配主组件。
 *
 * 装配顺序遵循 SPEC §13（SceneEnvironment → Ground → Ribbon → EdgeArrow → Node → NodeArrow）；
 * 背景色以 <color attach="background"> 设入 scene，使 WebGL 清屏色与 SPEC §7.2 一致。
 * 本组件不包含 Canvas 与相机：那些属于 app-root（相机控制器为后续 TASK）。
 */
export function StaticSceneContent({
  resources,
  groundBounds,
}: StaticSceneContentProps): React.JSX.Element {
  return (
    <>
      {/* 背景色：attach="background" 设入 scene.background，使 clear 色与 SPEC §7.2 #111318 一致。 */}
      <color attach="background" args={[BACKGROUND_COLOR]} />
      {/* 灯光：半球光 + 方向光，无阴影（SPEC 7.3）。 */}
      <SceneEnvironmentLayer />
      {/* 有限地面：renderOrder=0，最先提交（SPEC 7.4 / 12.1）。 */}
      <GroundLayer groundBounds={groundBounds} />
      {/* 合并 ribbon：renderOrder=10（SPEC 7.4 / 9.4 唯一 Mesh）。 */}
      <RibbonLayer mesh={resources.ribbon} />
      {/* 边方向箭头：renderOrder=20（SPEC 7.4 / 10.1 唯一 InstancedMesh）。 */}
      <EdgeArrowLayer mesh={resources.edgeArrows} />
      {/* 节点：renderOrder=30（SPEC 7.4 / 8.1 唯一 InstancedMesh）。 */}
      <NodeLayer mesh={resources.nodes} />
      {/* 节点朝向箭头：renderOrder=40（SPEC 7.4 / 8.2 唯一 InstancedMesh，depthWrite=false）。 */}
      <NodeArrowLayer mesh={resources.nodeArrows} />
    </>
  )
}
