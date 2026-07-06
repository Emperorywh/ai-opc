# AGV 地图 3D 渲染 · Phase 1 开发计划

> 关联规格：[`docs/SPEC_agv-map-phase1.md`](./SPEC_agv-map-phase1.md)
> 计划范围：Phase 1（仅静态地图渲染，无业务交互）
> 任务状态：本计划下所有 `docs/tasks/TASK_*.md` 初始均为 **draft**，待逐个 review 后再置 `ready` 交由 AI Task Runner 执行。
> 编写日期：2026-07-06

---

## 1. 概述

把 SPEC 描述的 AGV 地图（1806 节点 / 3101 边，真实样例 `src/json/getMapInfo.json`）用 react-three/fiber 渲染为深色工业风 3D 场景：直线/贝塞尔边、正反向双车道偏移与配色、方向箭头、5 类节点 + 朝向三角、相机操控与极简 UI 开关。

本计划将工作拆为 **13 个可独立实现、可独立验证的 task**，每个 task 控制在 1–4 个核心文件、可在一次自动执行内闭环。

## 2. SPEC 执行前的确认与裁剪（必须先读）

下列 6 点在制定本计划前已识别。A 用前置 task 解决；B/C/D/E/F 为实现层调整与裁剪，已贯穿进各 task：

| 编号 | 问题 | 处理方式 |
| --- | --- | --- |
| **A** | `@react-three/drei` 未在 `package.json` 声明，SPEC 多处依赖它 | TASK_001 安装 `@react-three/drei@^10`（对齐 fiber 9 / three 0.185 / react 19） |
| **B** | drei `<Bounds>` 对正交相机 fit 不可靠，易多轮试验 | **不使用 `<Bounds>`**，改用 loader 包围盒手动 fit（正交调 `zoom`、透视调距离）。MapView 不再含 `<Bounds>`，属对 SPEC §8 字面写法的实现层偏离，已确认接受 |
| **C** | §5.4 标签碰撞剔除/屏幕互斥在 1k–10k 规模需多轮调参 | Phase 1 只做 **数量上限 + 视口剔除 + 缩放阈值**；碰撞剔除标为可选增强（TASK_012） |
| **D** | §2.1 数据接入方式（fetch / import）未定 | loader 定为**纯函数** `loadMapData(raw): MapData`；获取（fetch `public/maps/sample.json`）放 App 层，并在 TASK_007 正式接入，后续渲染 task 不写临时样例 import |
| **E** | 坐标映射若散落在 geometry、nodes、labels 中，容易出现翻转不一致 | 新增唯一入口 `src/render/coordinates.ts`，所有地图 `(x,y)` → 场景 `(x,z)` 与 `isFlipY` 均通过该纯函数处理 |
| **F** | EdgesLayer 与 ArrowsLayer 都需要边 tessellate 结果，若各自计算会重复逻辑 | `edgeGeometry` 由 MapView 顶层 `useMemo` 构建一次；EdgesLayer 只消费 `positions/colors`，ArrowsLayer 与 LabelsLayer 复用 `edgeSamplePaths` |

> 若对 B/C/D/E/F 调整有异议，应先修订 SPEC 再执行；本计划默认按上表执行。

## 3. 全局实现约束（所有 task 共享，源自 `tsconfig.app.json`）

- `verbatimModuleSyntax: true` → 类型导入用 `import type`。
- `erasableSyntaxOnly: true` → **禁止 `enum`/`namespace`/参数属性**；常量用 `export const X = {...} as const`，类型用字面量联合（`edgeType: "LINE" \| "BEZIER"`）。
- `noUnusedLocals` + `noUnusedParameters: true` → 不得留未用的变量/参数/解构。
- 模块解析 `bundler` + `allowImportingTsExtensions` → import 路径可带 `.ts`/`.tsx`。
- 包管理器固定 **pnpm**；lint 用 **oxlint**（`.oxlintrc.json` 已启用 react/typescript 插件）。
- 颜色/常量一律走 `src/config/`，不在组件内写魔法值（SPEC §6/§7）。
- 坐标映射 `(地图x, 地图y) → 场景(x, z)`，`isFlipY` 只通过 **`render/coordinates.ts`** 应用（翻转 z），scene 层不得自行手写映射公式。

## 4. 阶段划分与任务总览

| Task | 阶段 | 标题 | 核心文件数 | 依赖 |
| --- | --- | --- | --- | --- |
| TASK_001 | P0 基础 | 项目脚手架：依赖、清理模板、空 Canvas、样例数据、测试框架 | 5 | — |
| TASK_002 | P1 数据 | `data/types.ts` + `data/loader.ts`（解析/校验/包围盒/告警）+ 单测 | 3 | 001 |
| TASK_003 | P1 配置 | `config/palette.ts` + `config/constants.ts` + `state/MapConfig.tsx` + `render/coordinates.ts` | 4 | 001 |
| TASK_004 | P2 几何 | `render/bezier.ts`（贝塞尔采样+切线+退化）+ 单测 | 2 | 001 |
| TASK_005 | P2 几何 | `render/laneOffset.ts`（配对索引+法线偏移）+ 单测 | 2 | 002 |
| TASK_006 | P2 几何 | `render/geometry.ts`（统一 LineSegments2 buffer + edgeSamplePaths）+ 单测 | 2 | 002, 003, 004, 005 |
| TASK_007 | P3 场景 | `scene/MapView.tsx` + `App.tsx`（正式数据接入、Canvas、相机切换、手动 fit、WebGL2 降级） | 2 | 002, 003 |
| TASK_008 | P3 场景 | `scene/EdgesLayer.tsx` + `MapView` 统一构建 `edgeGeometry`（单一粗线几何） | 2 | 006, 007 |
| TASK_009 | P3 场景 | `render/arrows.ts` + `scene/ArrowsLayer.tsx`（InstancedMesh 方向箭头） | 3 | 006, 008 |
| TASK_010 | P3 场景 | `scene/NodesLayer.tsx`（节点 InstancedMesh + 朝向三角） | 2 | 002, 003, 007 |
| TASK_011 | P4 UI | `ui/Controls.tsx`（相机/标签/Y 翻转开关） | 2 | 003, 007, 008, 010 |
| TASK_012 | P4 UI | `scene/LabelsLayer.tsx`（troika `<Text>` + 节点/路径标签 + 上限/视口/缩放剔除） | 2 | 002, 003, 008 |
| TASK_013 | P4 收尾 | 端到端验收 + 横切状态复核（加载/错误/空地图/降级）+ 对照 §12 验收 | 2 | 008–012 |

**依赖图（DAG，无环）：**

```
001
├─ 002, 003, 004
├─ 005 依赖 002
├─ 006 依赖 002, 003, 004, 005
├─ 007 依赖 002, 003
├─ 008 依赖 006, 007
├─ 009 依赖 008
├─ 010 依赖 002, 003, 007
├─ 011 依赖 003, 007, 008, 010
├─ 012 依赖 002, 003, 008
└─ 013 依赖 008, 009, 010, 011, 012
```

> 可并行点（若 runner 支持）：002 / 003 / 004 仅依赖 001 可并行；007 与 005/006 在依赖满足后可并行；008 后 009/010/012 可并行；011 在 008 与 010 后执行，便于相机和 Y 翻转都可视验收。默认按编号顺序串行执行亦成立。

## 5. 分支策略

- 每个 task 一个分支：`task/NNN-<slug>`（如 `task/002-data-loader`），从最新 `main` 切出。
- 完成并自验通过后，squash merge 回 `main`（commit message 用简体中文，遵守全局规则）。
- **`main` 始终可构建**：每合并一个 task，`pnpm build && pnpm lint && pnpm test` 必须通过；`main` 上不存在半成品（未完成的 layer 不挂载即可）。
- task 分支不长期存活，合并后删除。

## 6. 验证策略

分三层，每个 task 的 `## 验证步骤` 会明确归属：

1. **单元测试（vitest）** —— 纯逻辑模块：`data/loader`、`render/bezier`、`render/laneOffset`、`render/geometry`、`render/arrows`。断言基于真实样例的统计量（1806 节点 / 3101 边 / 包围盒 / 退化计数）与构造用例。
2. **构建/类型/ lint 门禁** —— 所有 task 完成需 `pnpm lint` 与 `tsc -b`（含于 `pnpm build`）通过。
3. **运行时观感（dev）** —— 渲染层 task：`pnpm dev` 打开浏览器，按 task 的"观感检查项"逐条肉眼确认；TASK_013 对照 SPEC §12 全量验收。
4. **（可选）无头截图** —— 若需自动化观感回归，可后续引入 puppeteer-core + 系统 Chrome + SwiftShader（参考 world-3d 经验），Phase 1 不作为硬门禁。
5. **性能记录** —— 真实样例（1806 节点 / 3101 边）为 Phase 1 硬验收数据；10k 合成压测仅记录结果，不阻塞 Phase 1。
6. **退化用例** —— 真实样例不含零长度边 / 自环 / null 控制点 / 未知 type（实测均为 0），SPEC §12.9 的退化验收依赖**构造小 JSON**，不由真实样例覆盖；loader 的退化分支仍须由构造用例单测覆盖（TASK_002）。

## 7. 风险控制

| 风险 | 概率 | 影响 | 缓解 |
| --- | --- | --- | --- |
| drei 版本与 fiber 9 / three 0.185 / react 19 不兼容 | 中 | 阻塞 | TASK_001 锁 `@react-three/drei@^10`，安装后立即跑 dev/build 验证 |
| 粗线几何合并后段间连成一条线 | — | 视觉错误 | **已规避**：SPEC §4.6 改用 `LineSegments2`（成对 segment 顶点天然断开多段），不依赖 NaN 分隔；TASK_006 输出 `positions` 为成对顶点，TASK_008 直接喂 `LineSegmentsGeometry.setPositions`，无需 fallback |
| 正交相机 fit 不居中/缩放异常 | 中 | 取景错 | 已规避 `<Bounds>`（B 点），手动用包围盒算 zoom/距离；TASK_007 给兜底公式 |
| troika `<Text>` 字体走 CDN 在内网失败 | 中 | 标签乱码/空白 | TASK_012 本地化字体或回退到 drei 默认；标注为风险 |
| 10k 规模 fps 不达标 | 低 | 性能 | 10k 为性能预算记录项，不作为 Phase 1 硬门禁；真实样例必须流畅 |
| 双车道节点处裂缝（§4.6 已声明接受） | 高 | 观感 | Phase 1 接受，不做法线对齐；PLAN 显式记录为已知局限 |
| `noUnusedParameters` 导致 React props 解构报错 | 低 | lint 失败 | 全局约束已声明，只解构用到的字段 |

## 8. 回滚与恢复

- **粒度**：以单个 task 的 squash commit 为最小回滚单元。`git revert <commit>` 即可撤销某 task，不影响其它。
- **安全网**：`main` 每 task 后都通过 build/lint/test，任何 task 出问题可 `git reset` 到上一个 task 的合并点，项目仍可运行。
- **数据**：`public/maps/sample.json` 为只读样例，不参与回滚逻辑；源文件 `src/json/getMapInfo.json` 全程不动。
- **恢复执行**：回滚某 task 后，新开 `task/NNN-*` 分支重做；其下游未合并的 task 需基于重做后的 main 重切。

## 9. 任务文件索引

| 文件 | 标题 |
| --- | --- |
| [TASK_001](./tasks/TASK_001.md) | 项目脚手架与依赖 |
| [TASK_002](./tasks/TASK_002.md) | 数据层 types + loader |
| [TASK_003](./tasks/TASK_003.md) | 配置层、坐标映射与全局状态 |
| [TASK_004](./tasks/TASK_004.md) | 贝塞尔几何工具 |
| [TASK_005](./tasks/TASK_005.md) | 双车道偏移工具 |
| [TASK_006](./tasks/TASK_006.md) | 统一折线 buffer 构建 |
| [TASK_007](./tasks/TASK_007.md) | 数据接入与场景骨架 MapView |
| [TASK_008](./tasks/TASK_008.md) | 边几何共享与 EdgesLayer |
| [TASK_009](./tasks/TASK_009.md) | 方向箭头层 ArrowsLayer |
| [TASK_010](./tasks/TASK_010.md) | 节点渲染层 NodesLayer |
| [TASK_011](./tasks/TASK_011.md) | 极简控制条 Controls |
| [TASK_012](./tasks/TASK_012.md) | 标签层 LabelsLayer |
| [TASK_013](./tasks/TASK_013.md) | 端到端复核与验收 |
