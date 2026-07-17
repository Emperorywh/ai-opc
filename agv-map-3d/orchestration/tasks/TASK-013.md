---
id: TASK-013
title: 在 Worker 中完成完整场景构建管线
---

## 任务描述

### 可验证结果

浏览器主线程可以通过显式消息协议委托 worker 从唯一运行时样本 URL 完成请求、JSON 解析、严格校验、领域归一化和场景模型构建。成功结果携带同一请求 ID 并一次性转移全部 ArrayBuffer；失败结果携带稳定错误码和阶段，且不返回部分场景。

### 输入

- SPEC 第 3.1、3.3、4.1、4.3、5、14.1、15.1～15.3 节规定的运行时 URL、worker 边界、数据流、错误和传输契约。
- TASK-002 交付的哈希校验样本供应链及唯一运行时 URL。
- TASK-003～TASK-005 交付的严格解析、实体语义校验和一次性领域坐标转换。
- TASK-006～TASK-012 交付的轨迹、几何、实例、标签和统一场景模型构建能力。
- TASK-001 交付的构建、测试和 worker 打包基线。

### 输出

- 带单调请求 ID 的 worker 输入、阶段进度、成功和失败消息契约，所有跨线程数据均可结构化克隆。
- worker 内从同源静态样本请求到完整场景模型的单向管线，以及解析、校验、几何构建的阶段耗时数据。
- 成功消息对应的完整 transfer list，覆盖场景模型中每个且仅一个 ArrayBuffer。
- `SAMPLE_FETCH_FAILED`、`SAMPLE_JSON_INVALID`、`MAP_ENVELOPE_INVALID`、`MAP_ENTITY_INVALID`、`MAP_GEOMETRY_INVALID` 的稳定序列化错误结果。
- 覆盖真实样本成功构建、阶段消息、请求 ID、转移所有权及各阶段失败的自动化测试。

### 实现约束

- worker 运行时只能请求 TASK-002 交付的 `/generated/sampleMap.json`，不得访问源样本路径、远程 API、备用 URL、内嵌小样本或降级地图。
- `JSON.parse`、未知输入解析、领域归一化和场景模型构建全部发生在 worker；主线程不得回读原始 JSON 或重复执行其中任一步骤。
- worker 只能依赖领域、适配、几何、标签和场景构建纯能力，不得创建 Three 对象、React 状态、DOM 对象或 GPU 资源。
- 每条阶段、成功和失败消息都必须携带原请求 ID；worker 不判断结果是否过期，当前请求归属由后续 application 层统一决定。
- 请求开始时报告加载阶段；进入解析、校验和几何构建后报告准备阶段，阶段名必须稳定且可供 UI 显示。
- 成功前必须再次通过 TASK-012 的完整场景模型自校验；transfer list 中每个 ArrayBuffer 恰好出现一次，不得复制大型 typed array。
- `postMessage` 成功转移后，worker 不得再次读取已转移的 typed array 或 ArrayBuffer。
- 任一步骤失败都必须序列化为包含错误码、阶段、中文消息及可用上下文的失败消息；不得抛出不可克隆对象、吞掉错误、输出部分数组或继续后续阶段。
- 样本 SHA-256 仍由构建前供应链负责；worker 不建立第二套哈希或数据来源逻辑。
- 新增或修改的代码必须使用多行简体中文注释说明消息阶段、请求关联、缓冲区转移与失败原子性；不得主动格式化无关代码。

### 验证方式

在 `C:\code\ai-opc\agv-map-3d` 执行：

```powershell
npm run lint
npm test -- --run
npm run build
```

- 正常路径：通过 worker 消息边界处理真实样本，预期依次产生带同一请求 ID 的加载、准备和成功消息，成功结果通过 TASK-012 全部计数与有限性断言。
- 正常路径：检查成功消息 transfer list，预期覆盖全部 typed array 缓冲区且无重复；模拟真实 transfer 后，worker 侧缓冲区已分离且没有后续访问。
- 关键异常路径：分别模拟非 2xx 响应、网络失败和非法 JSON，预期得到 `SAMPLE_FETCH_FAILED` 或 `SAMPLE_JSON_INVALID`，不产生成功消息。
- 关键异常路径：输入提取路径错误、实体非法、零切线或轨迹组异常样本，预期分别保留 TASK-003～TASK-012 的稳定错误码、JSON path、实体 ID 和对应阶段，不产生部分场景模型。
- 预期结果：三个命令退出码均为 0，worker 构建产物可被生产构建打包，消息顺序、请求关联、传输所有权和错误序列化断言全部通过。

### 完成标准

- 唯一运行时样本已能在 worker 内完整构建为 TASK-012 场景模型，主线程不承担 JSON 和几何计算。
- 相关 lint、测试和构建全部通过，此前 TASK 的解析、领域与几何规则未被复制或破坏。
- 所有消息均具备稳定请求 ID、阶段和可克隆结果，全部缓冲区仅转移一次且 worker 转移后不再访问。
- 各失败路径整体终止，没有备用 URL、部分地图、隐藏 fallback、Three/React 跨线程耦合或不可观测异常。
- 当前状态可建立仅覆盖 `agv-map-3d` 子目录的独立 Git checkpoint，并安全进入 TASK-014。

### 回退边界

回退本 TASK 的 Git checkpoint 时，只移除 worker 消息协议、运行时构建管线、缓冲区转移及其验证；TASK-001～TASK-012 的样本供应链和全部主线程无关的纯领域/几何能力仍可独立运行。
