# workers — 解析与几何预计算 worker

## 职责
- 在独立线程请求并 `JSON.parse` 样本、调用适配器严格校验、执行几何预计算。
- 生成实例矩阵、ribbon 顶点、标签描述符与数值 bounds。
- 通过 `postMessage` 转移 ArrayBuffer 给主线程，转移后不再访问。
- 提供主线程 ↔ scene-build worker 的显式消息协议，并在 worker 内完成
  请求 → 解析 → 校验 → 归一化 → 场景模型构建的单向管线。

## 模块
- `sampleSource.ts`：唯一运行时样本 URL 常量（`/generated/sampleMap.json`）。
- `buildSceneModel.ts`：SceneMap → SceneModel 的汇总入口，产出可转移 typed array、
  标签描述符、内容 bounds 与诊断；提供 `collectTransferableBuffers` 与 `validateSceneModel`。
- `sceneBuildProtocol.ts`：worker 消息协议（输入请求、阶段进度、成功、失败），
  以及稳定阶段名常量；纯类型与常量，无运行时逻辑，application 层与 worker 入口共享。
- `sceneBuildPipeline.ts`：worker 内单向管线 `runSceneBuild`，依赖注入 fetch / send / now，
  编排 loading → preparing(parsing/validating/building) → success / failure，
  保证失败原子性与缓冲区转移所有权；可在 node 测试中独立驱动。
- `sceneBuildWorker.ts`：scene-build worker 浏览器入口，把全局 fetch / self.postMessage /
  performance.now 注入管线；只做 I/O 装配，不含可测试领域逻辑。

## 依赖方向（SPEC 3.3）
- 允许依赖：`domain`、`adapters`、`geometry`、`labels`、本层自身。
- 允许的外部包：仅 Node 内置。
- **禁止**依赖 `three`、`@react-three/*`、`troika-three-text`：worker 不得创建 `THREE.Object3D`、Geometry、Material 或 React 状态，只输出可转移的 typed array 与不可变描述符。

## 关键不变量
- 不创建任何 Three 资源；rendering 层是 typed array → Three 资源的唯一适配层。
- typed array 长度必须由诊断计数交叉校验（矩阵 `count × 16`、RGB `count × 3`、position `vertexCount × 3`）。
- 任何 NaN/Infinity 立即令构建失败，不输出部分数据。
- 每条 worker 回复消息都携带原 requestId；worker 不判断结果是否过期，当前请求归属由 application 层统一决定。
- 成功消息的 transfer list 由 `collectTransferableBuffers` 给出，覆盖且仅覆盖 SceneModel 的每个 ArrayBuffer；
  `postMessage` 转移后 worker 侧缓冲区已分离，worker 不得再次访问。
- 任一阶段失败整体终止：发送一条失败消息后立即返回，不输出部分 SceneModel、不发送 success；
  失败消息携带稳定 code、阶段、中文消息、JSON path、实体 ID（可用时）与上下文，全部可结构化克隆。

