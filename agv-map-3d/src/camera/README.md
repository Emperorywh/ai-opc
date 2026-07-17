# camera — 相机 fit、裁剪面与浏览控制层

## 职责
- 实现 `computeContentBounds`（合并双车道 ribbon、两类箭头与节点圆柱真实几何 bounds）。
- 实现标准 3/4 fit、动态 near/far 推导、OrbitControls 配置、target clamp 与键盘导航。

## 依赖方向（SPEC 3.3）
- 允许依赖：`domain`、`config`、本层自身。
- 允许的外部包：Node 内置、`three`（OrbitControls、Matrix4 等）。
- 禁止依赖 React、R3F 装配、渲染层业务或原始 JSON。

## 关键不变量
- fit 以 controls target 为球心计算半径 R；先定 3/4 方向再算距离，禁止先俯视 fit 再旋转。
- near/far 全部由 camera-space bounds 与内容尺寸推导，禁止任意大常量。
- 用户是否浏览由显式 `hasUserNavigated` 决定 resize 行为；Home 键复位并清零该标志。
