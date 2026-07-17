/*
 * 地图实体图层 R3F 装配（scene 装配层，SPEC 7.4 / 8 / 9 / 10 / 13 / 15.3 / 任务约束）。
 *
 * 定位（TASK-018）：
 *   - 四个图层各自把 TASK-014 createMapResources 产出的单一 Three 对象通过 <primitive> 挂入场景：
 *       RibbonLayer → ribbon Mesh、EdgeArrowLayer → edgeArrows InstancedMesh、
 *       NodeLayer → nodes InstancedMesh、NodeArrowLayer → nodeArrows InstancedMesh。
 *   - 装配是只读的：图层不重算矩阵、不重建几何、不修改颜色、不决定业务规则（任务约束）。
 *     实例矩阵、线性 sRGB 颜色、renderOrder、层高、深度策略全部由 TASK-014 一次性写入对象。
 *
 * 资源所有权不变量（SPEC 4.3 / 任务“卸载只调用既有所有者的幂等释放边界”）：
 *   - 四个对象由 LoadOrchestrator 经资源端口持有；R3F <primitive> 不自动释放（fiber 源码
 *     type === 'primitive' 分支），故本组件不注册任何释放逻辑，卸载释放唯一归 orchestrator。
 *   - 禁止在图层内对 mesh.dispose / geometry.dispose / material.dispose 任何调用，
 *     避免与 orchestrator 的幂等释放形成第二套释放路径或竞态。
 *
 * 单一实例集合不变量（SPEC 8 / 9 / 10 / 15.3 / 任务约束）：
 *   - 每类实体恰用一个 <primitive> 装配一个对象；全部 ribbon 合并为一个 Mesh，
 *     节点 / 两类箭头各为单一 InstancedMesh。不得按实体创建子 Mesh / Line / 组件。
 *
 * 按需渲染不变量（SPEC 13 / 任务约束）：
 *   - 图层不注册 useFrame、不发起常驻帧请求；资源首次提交的 invalidate 由 app-root 统一发出。
 *
 * 依赖方向（SPEC 3.3）：本层自身 + react；外部仅 react。
 *   只消费上层传入的 Three 对象（Mesh / InstancedMesh，由 TASK-014 创建），
 *   不依赖 three 运行时对象创建、不回读 workers / domain / 原始数据。
 */
import type { InstancedMesh, Mesh } from 'three'

/*
 * 单个实体图层入参：接收已就绪的 Three 对象（由 orchestrator 从 MapResources 提供）。
 */
export interface EntityLayerProps<TMesh> {
  readonly mesh: TMesh
}

/*
 * Ribbon 图层：装配合并后唯一 ribbon Mesh（SPEC 9.4 / 15.3 Ribbon Mesh = 1）。
 * renderOrder / Ribbon Y / polygonOffset / vertexColors 已由 TASK-014 写入。
 */
export function RibbonLayer({ mesh }: EntityLayerProps<Mesh>): React.JSX.Element {
  return <primitive object={mesh} />
}

/*
 * 边箭头图层：装配唯一 edgeArrows InstancedMesh（SPEC 10.1 / 15.3 Edge Arrow instances = 3043）。
 */
export function EdgeArrowLayer({
  mesh,
}: EntityLayerProps<InstancedMesh>): React.JSX.Element {
  return <primitive object={mesh} />
}

/*
 * 节点图层：装配唯一 nodes InstancedMesh（SPEC 8.1 / 15.3 Node instances = 1767）。
 */
export function NodeLayer({
  mesh,
}: EntityLayerProps<InstancedMesh>): React.JSX.Element {
  return <primitive object={mesh} />
}

/*
 * 节点箭头图层：装配唯一 nodeArrows InstancedMesh（SPEC 8.2 / 15.3 Node Arrow instances = 464）。
 */
export function NodeArrowLayer({
  mesh,
}: EntityLayerProps<InstancedMesh>): React.JSX.Element {
  return <primitive object={mesh} />
}
