# workers — 解析与几何预计算 worker

## 职责
- 在独立线程请求并 `JSON.parse` 样本、调用适配器严格校验、执行几何预计算。
- 生成实例矩阵、ribbon 顶点、标签描述符与数值 bounds。
- 通过 `postMessage` 转移 ArrayBuffer 给主线程，转移后不再访问。

## 依赖方向（SPEC 3.3）
- 允许依赖：`domain`、`adapters`、`geometry`、`labels`、本层自身。
- 允许的外部包：仅 Node 内置。
- **禁止**依赖 `three`、`@react-three/*`、`troika-three-text`：worker 不得创建 `THREE.Object3D`、Geometry、Material 或 React 状态，只输出可转移的 typed array 与不可变描述符。

## 关键不变量
- 不创建任何 Three 资源；rendering 层是 typed array → Three 资源的唯一适配层。
- typed array 长度必须由诊断计数交叉校验（矩阵 `count × 16`、RGB `count × 3`、position `vertexCount × 3`）。
- 任何 NaN/Infinity 立即令构建失败，不输出部分数据。
