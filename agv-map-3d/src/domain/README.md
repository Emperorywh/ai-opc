# domain — 领域层

## 职责
- 定义与真实样本校准的领域类型：`ScenePoint`、`SceneNode`、`SceneEdge`、`SceneMap`、`LabelDescriptor`、`NumericBox3`、`SceneModel`、`SceneDiagnostics` 等。
- 定义结构化错误 `MapDataError` 及稳定错误码枚举。
- 表达坐标转换、角度比较、颜色空间转换等纯数学函数的不变量，但本层不持有任何运行状态。

## 依赖方向（SPEC 3.3）
- 允许依赖：本层自身。
- 允许的外部包：仅 Node 内置。
- **禁止**依赖 `react`、`react-dom`、`three`、`@react-three/*`、`troika-three-text` 或任何浏览器全局（`window`、`document` 等）。
- 本层是整个依赖图的根，所有上层模块只能消费本层导出的不可变类型与纯函数。

## 关键不变量
- 不得搬运原始 JSON 中未被领域消费的业务元数据（actions、速度、载荷、车辆组等）。
- 角度比较使用数值容差，禁止与 `Math.PI / 2` 做字符串或精确相等判断。
- 颜色 typed array 保存线性 sRGB `[0,1]` 浮点值，hex 输入必须经标准 sRGB transfer function 转换。
