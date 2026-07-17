# labels — 标签描述符与可见集层

## 职责
- 生成节点、LINE、BEZIER 三类 `LabelDescriptor`（节点标签与边标签定位由两个独立纯函数实现）。
- 维护 4m uniform-grid 空间索引，基于视锥、投影字号、10/8px hysteresis 与 400 上限计算可见集。

## 依赖方向（SPEC 3.3）
- 允许依赖：`domain`、本层自身。
- 允许的外部包：仅 Node 内置。
- 禁止依赖 React、R3F、Three、Troika、浏览器 API 或更上层模块。

## 关键不变量
- 启动时只建立 `LabelDescriptor` 与空间索引，不创建任何 Troika Text。
- 候选截断顺序固定：work/park/charge 节点 → 普通节点 → 边；同级按屏幕距离再按 ID 字典序。
- 字号投影使用 camera world quaternion 把局部 `+Y` 转为 `cameraScreenUp`，禁止用固定世界 `+Y`。
