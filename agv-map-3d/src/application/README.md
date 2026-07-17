# application — 应用编排层

## 职责
- 实现显式加载状态机：`idle → loading → preparing → ready / error`。
- 编排 worker 请求、结果提交、过期 requestId 丢弃与 ArrayBuffer 释放。
- 持有 `SceneModel` 与 `MapTransform`，作为渲染层、相机层和 UI 层的唯一数据来源。

## 模块（TASK-016）
- `loadState.ts`：五种互斥状态、允许事件与纯 reducer；状态转换唯一所有者，不执行副作用。
- `loadPorts.ts`：worker / 资源 / 字体三类依赖注入端口；application 不依赖 rendering / three / config。
- `loadOrchestrator.ts`：把端口异步结果归一化为事件交给 reducer，按 released 清单幂等释放资源。

## 依赖方向（SPEC 3.3）
- 允许依赖：`domain`、`adapters`、`geometry`、`labels`、`workers`、本层自身。
- 允许的外部包：Node 内置、`react`（仅用于状态 hook，不直接接触 Three）。
- 禁止依赖 `rendering`、`scene`、`camera`、`ui`、`config`、`three`。
  - worker 创建 / 终止、Three 资源创建、字体预加载与字形清单、字体 URL 等
    跨层能力一律以端口形式由后续 app-root / scene 装配层注入。

## 关键不变量
- 状态转换只能由本层 reducer 完成，禁止多个组件各自维护“是否加载完成”。
- 每次加载分配单调递增 `requestId`；只有当前 requestId 的 worker / 资源 / 字体结果可提交。
- ready 门禁：`preparing` 同时持有 model、resources 且 fontReady 才推进；三道门禁顺序任意。
- 过期成功结果不进入资源适配或状态；过期资源直接释放；过期字体回调静默忽略。
- 任何箭头、标签或 camera fit 都必须消费同一个 `SceneModel`，不得从原始边/节点重复推导。
