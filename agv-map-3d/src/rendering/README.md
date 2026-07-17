# rendering — Three 资源适配与释放层

## 职责
- 把 worker 交付的 typed array 与不可变描述符装配为 Three 资源（Geometry、Material、InstancedMesh）。
- 拥有成对的资源释放职责；WebGL context restore 后从不可变 `SceneModel` 重建资源。

## 依赖方向（SPEC 3.3）
- 允许依赖：`domain`、`workers`（仅 `SceneModel` 契约类型）、`config`、本层自身。
- 允许的外部包：Node 内置、`three`。
- 禁止依赖 `scene`、`camera`、`ui`、`react`、`@react-three/*`、`geometry`、`labels`、`application`。
  - R3F 的 JSX 装配发生在 `scene` 层；本层只提供资源工厂与释放器，不直接挂载到 React 树。
  - 禁止依赖 `geometry` / `labels`：防止在适配层重算坐标 / 轨迹 / 矩阵 / 颜色或回读领域实体。

## 关键不变量
- 是 typed array → Three 资源的**唯一**适配层；任何上层不得自行 `new THREE.BufferGeometry` 解析数据。
- 恰好产出四个资源：一个 ribbon Mesh、节点 / 节点箭头 / 边箭头各一个 InstancedMesh；不得按实体或类型拆分。
- 实例矩阵与线性 sRGB 颜色直接消费 `SceneModel`，不做第二次坐标或颜色转换。
- 材质参数、深度策略与 renderOrder 全部来自 `config`，不在适配器与场景层各定义一份。
- 所有 Geometry、Material、实例属性由 `ResourceRegistry` 登记并成对释放；`dispose()` 幂等。
- 创建中途失败时释放本次已登记资源，禁止提交部分集合或转嫁清理责任。
- 不得回读原始 JSON 重新推导几何，只消费 `SceneModel`。

## 与 config 的关系（SPEC 7.1 / 7.3 / 7.4）
- 资源参数（圆柱基准、层高、材质参数、深度策略、renderOrder）统一来自 `config/mapVisualConfig.ts`。
- geometry 层为生成实例数据各自引用同一 SPEC 来源（半径、层高），是既定“各层各自引用同一 SPEC 来源”约定；
  本层引用 config 作为渲染资源参数入口，两层引用同一 SPEC，值由第 7 章唯一决定。
