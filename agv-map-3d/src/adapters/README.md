# adapters — 原始响应适配层

## 职责
- 提供 `unknown → RawMap` 的唯一边界 `parseSampleEnvelope`，逐字段严格校验样本响应包。
- 一次性完成坐标转换与场景重心平移，输出适配后的不可变 `SceneMap`。
- 实现唯一坐标函数 `toScenePoint(mapX, mapY, origin)`，`origin` 由已验证的 source bounds 计算并以显式 `MapTransform` 传递。

## 依赖方向（SPEC 3.3）
- 允许依赖：`domain`、本层自身。
- 允许的外部包：仅 Node 内置。
- 禁止依赖 React、R3F、Three、Troika、浏览器 API 或任何更上层模块。

## 关键不变量
- 唯一合法提取路径为 `data.currentMapInfoVersion.mapJson`，不得从根对象直接读取 nodes/edges。
- 边自身的 `sx/sy/ex/ey/cx/cy/dx/dy` 是显示几何唯一事实来源，`snodeId/enodeId` 仅表示拓扑。
- 坐标只在本层转换一次；几何层、标签层和 R3F 层禁止再次取负、交换轴或平移。
- 失败时抛出带 `code`、JSON path、实体 ID 的 `MapDataError`，禁止跳过坏实体、补零或猜测控制点。
