# geometry — 几何纯函数层

## 职责
- 实现 ribbon 三角化、节点/边箭头基准几何、bounds 合并、双车道偏移等纯函数。
- 处理精确反向轨迹识别、贝塞尔定段采样、弧长定位等数学逻辑。

## 依赖方向（SPEC 3.3）
- 允许依赖：`domain`、本层自身。
- 允许的外部包：仅 Node 内置。
- 禁止依赖 React、R3F、Three、Troika、浏览器 API 或更上层模块。

## 关键不变量
- 所有函数为纯函数，输入输出均为不可变数据或 typed array，不接触 Three 对象。
- 不读取原始 JSON；只消费适配后的 `SceneEdge` / `SceneNode` / `ScenePoint`。
- ribbon 固定非索引 quad、bevel join、butt cap、`+Y` 绕序；贝塞尔固定 32 段 33 点。
- 输出的 position、color、bounds 必须全部为有限数。
