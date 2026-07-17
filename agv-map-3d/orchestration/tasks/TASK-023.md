---
id: TASK-023
title: 闭环故障呈现与可恢复资源生命周期
---

## 任务描述

### 可验证结果

加载、字体、数据和 WebGL 故障都会进入可读且无部分地图的统一错误界面；卸载、HMR、重新加载和 WebGL 上下文恢复均能按资源所有权安全清理或重建，不产生过期提交、重复监听或持续增长的 GPU/worker 资源。

### 输入

- SPEC §4.2～§4.3、§13、§14.1、§15.3、§16。
- TASK-014 已交付的 Three 资源创建/释放边界，TASK-015 的字体失败信号，TASK-016 的加载状态机、requestId 和 worker 编排。
- TASK-018～TASK-022 已交付的场景装配、相机/事件生命周期、标签对象和 demand 帧协调。

### 输出

- `idle/loading/preparing/ready/error` 的可见 UI 闭环：加载时显示文件名和阶段，错误时显示稳定错误码、阶段、简体中文原因，开发环境可附 JSON path 与实体 ID，且不显示部分地图。
- 在开始场景提交前识别 WebGL 不可用并产生 `WEBGL_UNAVAILABLE`；WebGL context lost 时暂停提交、释放或冻结受影响资源并呈现 `WEBGL_CONTEXT_LOST`。
- context restored 后只从既有不可变 SceneModel 和只读运行状态协调各既有所有者重建实体、地面与当前标签资源，通过 TASK-022 的同一显式入口请求渲染并恢复 ready；不重新请求样本、不重新解析数据、不形成第二套业务规则。
- 组件卸载、HMR 和重新加载时终止旧 worker、拒绝过期 requestId 结果，并成对清理 Geometry、Material、Texture、Troika Text、controls/键盘/WebGL 监听器。
- React StrictMode 下初始化与清理幂等，重复挂载/卸载不重复注册事件、不重复提交或泄漏资源。
- 覆盖全部稳定错误码、状态 UI、过期结果、释放顺序、context 恢复和重复生命周期的自动化测试与人工 WebGL 验收记录。

### 实现约束

- application 状态机仍是加载状态的唯一写入者；UI、场景、worker 和 WebGL 事件只能提交显式事件，不得分别保存“是否完成”或直接互相改状态。
- 必须复用 TASK-014、TASK-018 与 TASK-022 各自的资源所有权和释放/重建边界；生命周期协调者不得自行 dispose 一部分对象、复制资源适配逻辑或把可变 Three 对象放入全局状态。
- 过期 worker 结果不得提交；其可转移缓冲引用必须及时释放。旧 worker 必须在新加载、卸载或 HMR 时终止。
- 字体、哈希、JSON、数据契约、几何和 WebGL 错误均禁止 fallback、跳过坏实体、系统字体、简化地图或空白画布。
- context restore 只重建可丢失的主线程资源，不能回读原始 JSON、重跑适配规则或改变 SceneModel。
- 仅本地运行，不增加 CSP 响应头、部署探针或生产托管逻辑；这不放宽本任务的错误可读性和本地生命周期要求。
- 新增或修改的代码必须使用多行简体中文注释说明错误投影、context 恢复、资源所有权与幂等生命周期不变量；不得主动格式化无关代码。

### 验证方式

1. 执行 `node --version`，预期为 `v24.16.0`；执行 `npm ci`，预期成功。
2. 执行 `npm run lint`、`npm test -- --run` 和 `npm run build`；这些自动命令不得启动浏览器，预期全部通过。
3. 正常路径：用 fake worker、可计数资源所有者和事件源模拟 ready、卸载、重新加载、StrictMode 双初始化及 context lost→restored；预期旧 worker 被终止、实体/地面/文字资源分别由原所有者成对释放和重建、恢复复用同一 SceneModel，并回到完整 ready 场景。
4. 关键异常路径：逐一注入 `SAMPLE_FETCH_FAILED`、`SAMPLE_HASH_MISMATCH`、`SAMPLE_JSON_INVALID`、`MAP_ENVELOPE_INVALID`、`MAP_ENTITY_INVALID`、`MAP_GEOMETRY_INVALID`、`FONT_ASSET_FAILED`、`FONT_GLYPH_MISSING`、`WEBGL_UNAVAILABLE`、`WEBGL_CONTEXT_LOST` 及过期 requestId；预期错误码/阶段/中文原因稳定、无部分地图、无静默降级、无迟到提交。
5. 人工 WebGL 与真实生命周期验收仅由用户执行，Coding Agent 不启动浏览器：用户在本地生产预览中验证 WebGL 不可用提示、触发 context lost/restore，并重复挂载/卸载场景 20 次；预期错误可读、恢复后场景一致，worker、监听器、Geometry、Material 和 GPU memory 计数不单调增长。

### 完成标准

- 所有规定错误均有确定性可读 UI，WebGL 恢复及卸载/HMR/StrictMode 生命周期闭环可验证。
- 非浏览器自动化测试全部通过，用户已完成 WebGL 与真实资源生命周期人工验收。
- TASK-001～TASK-022 的正常路径、视觉基线、标签和交互行为没有回归。
- 不存在部分地图、fallback、重复状态、过期提交、重复监听、资源双重所有权或跨层恢复逻辑。
- 可以创建仅包含 TASK-023 故障呈现与生命周期闭环的 Git checkpoint，安全进入 TASK-024。

### 回退边界

回退 TASK-023 checkpoint 只移除统一错误界面、WebGL 故障/恢复编排和强化的运行时生命周期集成；TASK-014 的资源释放、TASK-016 的基础状态机及 TASK-022 的正常标签场景保持完整。父级 Git 的 checkpoint 与回退范围仅限 `agv-map-3d` 子目录，不得影响其他目录。
