# ui — 加载、错误、图例与无障碍层

## 职责
- 渲染 loading / error overlay、颜色图例、纯文本操作说明和 a11y 容器。
- 显示稳定错误码、阶段名、简体中文原因，以及开发态附带的 JSON path 与实体 ID。

## 依赖方向（SPEC 3.3）
- 允许依赖：`domain`、`config`、本层自身。
- 允许的外部包：Node 内置、`react`。
- 禁止依赖 Three、R3F、Troika、原始 JSON 或更下层业务模块。

## 关键不变量
- overlay 在 error 状态下不显示部分地图；不得用 `console.error` 后留下空白画布。
- Canvas 外层容器可聚焦，`aria-label` 至少包含地图名、节点数、边数和操作提示。
- 不得维护第二套加载状态；所有可见状态来源于 application 层的状态机。
