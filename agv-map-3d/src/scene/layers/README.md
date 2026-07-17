# scene/layers — 只读 R3F 图层组件

## 职责
- 各图层组件（GroundLayer、RibbonLayer、EdgeArrowLayer、NodeLayer、NodeArrowLayer、LazyLabelLayer 等）落在本目录。
- 仅做资源装配与帧协调，不解析数据、不拼几何、不决定业务规则。

## 依赖方向
继承 `scene` 层策略：依赖 `domain` / `application` / `rendering` / `config`，外部包限定 React、Three、R3F、Troika。

## 关键不变量
- 标签层只有一个帧协调器；禁止每个标签各自注册 `useFrame` 或嵌套 `<Billboard>`。
- 初始 fit 后首屏已挂载 Text 数为 0；任意时刻已挂载 Text 不超过 400。
