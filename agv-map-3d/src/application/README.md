# application — 应用编排层

## 职责
- 实现显式加载状态机：`idle → loading → preparing → ready / error`。
- 编排 worker 请求、结果提交、过期 requestId 丢弃与 ArrayBuffer 释放。
- 持有 `SceneModel` 与 `MapTransform`，作为渲染层、相机层和 UI 层的唯一数据来源。

## 依赖方向（SPEC 3.3）
- 允许依赖：`domain`、`adapters`、`geometry`、`labels`、`workers`、本层自身。
- 允许的外部包：Node 内置、`react`（仅用于状态 hook，不直接接触 Three）。
- 禁止依赖 `rendering`、`scene`、`camera`、`ui`、`three`。

## 关键不变量
- 状态转换只能由本层 reducer 完成，禁止多个组件各自维护“是否加载完成”。
- 每次加载分配单调递增 `requestId`；只有当前 requestId 的 worker 结果可提交。
- 任何箭头、标签或 camera fit 都必须消费同一个 `SceneModel`，不得从原始边/节点重复推导。
