---
id: TASK_013
title: 端到端整合与验收
status: draft
phase: 4
depends_on: [TASK_008, TASK_009, TASK_010, TASK_011, TASK_012]
files:
  - src/scene/MapView.tsx
  - src/App.tsx
---

# TASK_013 · 端到端整合与验收

## 目标
把数据接入（fetch `public/maps/sample.json` → `loadMapData`）与各 layer 在 MapView 内正确装配，补齐横切（加载态/错误/空地图提示），并对照 SPEC §12 全量验收。本 task **不重复实现**各 layer，只做接线、横切与验收。

## 前置依赖
TASK_008/009/010/011/012（全部 layer + 控件就绪）。

## 涉及文件
- `src/scene/MapView.tsx`（改：装配 layers、接 bbox/lifecycle）
- `src/App.tsx`（改：fetch 数据、加载/错误/空地图 UI 态）

## 实现要点
1. **数据接入（PLAN §2.D）**：
   - App 用 `useEffect` 内 `fetch("/maps/sample.json")` → `json` → `loadMapData(json)` → `setState({ status: "ready", data })`；捕获异常 → `status: "error"`。
   - 把 `MapData`（含 `bbox`、`nodes`、`edges`）下传 MapView。
2. **横切状态**（SPEC §9）：
   - `loading`：加载中提示。
   - `error` / JSON 解析错：控制台 `console.error` + UI 错误提示。
   - 空地图（nodes/edges 皆空）：空场景 + UI 提示。
   - `mapState !== ENABLED`：loader 已告警；UI 可选提示「地图未启用」。
   - WebGL2 不可用：TASK_007 降级文案（保持）。
3. **MapView 装配**：
   - bbox 有效 → 渲染 `<EdgesLayer/>` + `<ArrowsLayer/>` + `<NodesLayer/>` + `<LabelsLayer/>`。
   - EdgesLayer 与 ArrowsLayer **共用同一份** `buildEdgeGeometry` 的 `useMemo`（edgeSamples 复用，避免重复 tessellate）——在 MapView 顶层算一次，下传两处。
   - 各 layer 高度分层由各自常量保证（§3）。
4. 清理前置 task 的临时接线（如 TASK_008 临时 `import sample`）。

## 约束
- 不新增 layer 实现；只接线 + 横切。
- 数据获取仅在 App 顶层；loader 保持纯函数。
- 遵守 PLAN §3。

## 验证步骤（对照 SPEC §12 逐条）
1. 加载样例 → 深色背景居中、自动 fit。✓
2. 直线 + 贝塞尔均正确绘制、曲线符合三次贝塞尔。✓
3. 正/反向双色、双向边双车道不重叠。✓
4. 每条边中点方向箭头、朝向 `snode→enode`。✓
5. 5 类节点配色、有 `angle` 显示三角。✓
6. 正交/透视切换、OrbitControls 平移/缩放/旋转正常。✓
7. 标签开关有效、开启无性能崩溃。✓
8. 10k 规模（样例 1806/3101 已接近）保持接近 60fps（肉眼/DevTools Performance 抽样记录）。✓
9. 退化数据（零长度边/null 控制点/空 angle/未知 type）不报错不崩。✓（可构造小 JSON 验证）
10. `pnpm build`、`pnpm lint`、`pnpm test` 全绿。

## 完成定义 (DoD)
- §12 九条验收全部通过；门禁全绿；横切（加载/错误/空地图/WebGL2 降级）齐备；临时接线清理完毕。

## 风险/备注
- 性能验收以真实样例（1.8k/3.1k）为准；若需压测 10k，可临时复制扩样，但不持久化。
- 本 task 完成即 Phase 1 收口；后续 Phase 2 扩展（车辆/实时/交互）按 SPEC §13 另立计划。
