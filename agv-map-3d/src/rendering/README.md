# rendering — Three 资源适配与释放层

## 职责
- 把 worker 交付的 typed array 与不可变描述符装配为 Three 资源（Geometry、Material、InstancedMesh、Troika Text）。
- 拥有成对的资源释放职责；WebGL context restore 后从不可变 `SceneModel` 重建资源。

## 依赖方向（SPEC 3.3）
- 允许依赖：`domain`、本层自身。
- 允许的外部包：Node 内置、`three`。
- 禁止依赖 `scene`、`camera`、`ui`、`react`、`@react-three/*`。
  - R3F 的 JSX 装配发生在 `scene` 层；本层只提供资源工厂与释放器，不直接挂载到 React 树。

## 关键不变量
- 是 typed array → Three 资源的**唯一**适配层；任何上层不得自行 `new THREE.BufferGeometry` 解析数据。
- 所有 Geometry、Material、Texture、Troika Text 和事件监听器必须由创建者成对释放。
- 不得回读原始 JSON 重新推导几何，只消费 `SceneModel`。
