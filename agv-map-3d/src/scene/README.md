# scene — R3F 场景装配层

## 职责
- 只消费 `SceneModel`、rendering 资源和 config 常量，装配 Ground / Ribbon / EdgeArrow / Node / NodeArrow / LazyLabel 图层。
- 按 SPEC 第 13 章规定的顺序与 `renderOrder` 组织 `<Canvas>` 子树。

## 依赖方向（SPEC 3.3）
- 允许依赖：`domain`、`application`、`rendering`、`config`、本层自身。
- 允许的外部包：Node 内置、`react`、`three`、`@react-three/fiber`、`@react-three/drei`、`troika-three-text`。
- 禁止解析数据、拼几何、决定业务规则，禁止跨层回读原始 JSON。

## 关键不变量
- 图层组件只接受已经完成的资源或只读描述符。
- 禁止在 JSX render 中遍历原始边生成顶点；React key 只能使用稳定实体 ID，禁止数组下标。
- Canvas 不得挂对象点击 handler 或 raycaster 业务逻辑。
