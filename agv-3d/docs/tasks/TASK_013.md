---
id: TASK_013
status: ready
branch: task/013-acceptance
spec: docs/SPEC_agv-map-phase1.md
plan: docs/PLAN_agv-map-phase1.md
commit: "chore(TASK_013): 端到端复核与横切验收"
depends_on:
  - TASK_008
  - TASK_009
  - TASK_010
  - TASK_011
  - TASK_012
agent_allowed_paths:
  - src/scene/MapView.tsx
  - src/App.tsx
verify:
  - pnpm lint
  - pnpm build
  - pnpm test
allow_empty_code_changes: true
allowed_tools:
  - Bash(pnpm test:*)
  - Bash(pnpm build:*)
  - Bash(pnpm lint:*)
---

# TASK_013 · 端到端复核与验收

## 目标
对已经完成的数据接入、各 layer 装配与横切状态做最终复核，并对照 SPEC §12 全量验收。本 task **不重复实现**各 layer，也不迁移数据流；只做清理、缺口修补与验收记录。

## 前置依赖
TASK_008/009/010/011/012（边/箭头/节点/控件/标签全部就绪）。

## 涉及文件
- `src/scene/MapView.tsx`（复核 layer 装配、共享 `edgeGeometry` 与 fit 生命周期）
- `src/App.tsx`（复核数据获取、加载/错误/空地图 UI 态）

## 实现要点
1. **数据接入复核（PLAN §2.D）**：
   - 确认 App 仍是唯一数据获取入口：`fetch("/maps/sample.json")` → `loadMapData(json)` → 下传 `MapData`。
   - 确认 loader 仍为纯函数，MapView/layers 不 fetch、不 import 样例 JSON。
2. **横切状态复核**（SPEC §9）：
   - `loading`：加载中提示。
   - `error` / JSON 解析错：控制台 `console.error` + UI 错误提示。
   - 空地图（nodes/edges 皆空）：空场景 + UI 提示。
   - `mapState !== ENABLED`：loader 已告警；UI 可选提示「地图未启用」。
   - WebGL2 不可用：TASK_007 降级文案（保持）。
3. **MapView 装配**：
   - bbox 有效 → 渲染 `<EdgesLayer/>` + `<ArrowsLayer/>` + `<NodesLayer/>` + `<LabelsLayer/>`。
   - EdgesLayer、ArrowsLayer、LabelsLayer **共用同一份** `buildEdgeGeometry` 的 `useMemo`（`edgeSamplePaths` 复用，避免重复 tessellate）——在 MapView 顶层算一次，下传多处。
   - 各 layer 高度分层由各自常量保证（§3）。
4. 全局搜索确认不存在临时接线（例如 layer 内直接 `import sample`、重复 `fetch`、重复 `buildEdgeGeometry`）。

## 约束
- 不新增 layer 实现；只接线 + 横切。
- 数据获取仅在 App 顶层；loader 保持纯函数；MapView 与各 layer 不得直接获取数据。
- 遵守 PLAN §3。

## 验证步骤（对照 SPEC §12 逐条）
1. 加载样例 → 深色背景居中、自动 fit。✓
2. 直线 + 贝塞尔均正确绘制、曲线符合三次贝塞尔。✓
3. 正/反向双色、双向边双车道不重叠。✓
4. 每条边中点方向箭头、朝向 `snode→enode`。✓
5. 5 类节点配色、有 `angle` 显示三角。✓
6. 正交/透视切换、OrbitControls 平移/缩放/旋转正常。✓
7. 标签开关有效、开启无性能崩溃。✓
8. 真实样例（1806 节点 / 3101 边）保持接近 60fps（肉眼/DevTools Performance 抽样记录）；如做 10k 合成压测，仅记录结果，不作为硬门禁。✓
9. 退化数据（零长度边/null 控制点/空 angle/未知 type）不报错不崩。✓（可构造小 JSON 验证）
10. `pnpm build`、`pnpm lint`、`pnpm test` 全绿。

## 完成定义 (DoD)
- §12 九条验收全部通过；门禁全绿；横切（加载/错误/空地图/WebGL2 降级）齐备；临时接线清理完毕；无重复 tessellate 数据流。

## 风险/备注
- 性能硬验收以真实样例（1.8k/3.1k）为准；若需压测 10k，可临时复制扩样，但不持久化、不阻塞 Phase 1。
- 本 task 完成即 Phase 1 收口；后续 Phase 2 扩展（车辆/实时/交互）按 SPEC §13 另立计划。
