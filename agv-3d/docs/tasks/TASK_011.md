---
id: TASK_011
title: 极简控制条 Controls
status: draft
phase: 4
depends_on: [TASK_003, TASK_007]
files:
  - src/ui/Controls.tsx
  - src/App.tsx
---

# TASK_011 · 极简控制条 Controls

## 目标
SPEC §10 的 UI 全集：相机模式（正交/透视）、节点标签开关、路径标签开关、（可选）Y 翻转开关。读写 TASK_003 的 `MapConfig` Context，浮于 Canvas 之上。

## 前置依赖
TASK_003（Context）、TASK_007（相机模式已被 MapView 消费 → 切换即时生效）。

## 涉及文件
- `src/ui/Controls.tsx`（新建）
- `src/App.tsx`（改：在 Canvas 之上叠加 `<Controls/>`，定位绝对/固定）

## 实现要点
1. `Controls` 内 `useMapConfig()` 取值与 setter。
2. 极简控件（原生 `<button>`/`<label><input type="checkbox">`，不引 UI 库）：
   - 相机模式：两个按钮或一个 toggle（正交 ↔ 透视），高亮当前。
   - 节点标签：复选框（`showNodeLabels`）。
   - 路径标签：复选框（`showEdgeLabels`）。
   - Y 翻转：复选框（`isFlipY`，可选，便于运行时核对方向，§10）。
3. 容器样式：绝对定位左上/右上角，半透明深色背景，文字浅色（与 palette 协调），不遮挡核心地图区域。
4. App.tsx：`<MapConfigProvider>` 内放一个相对定位 wrapper，`<MapView/>` 占满 + `<Controls/>` `position: absolute` 浮层。

## 约束
- 不引第三方 UI 库；样式可用内联或追加到 index.css（保持轻量）。
- 仅操作 Context state；不直接命令相机/layer（解耦，由各消费者自行响应）。
- 遵守 PLAN §3。

## 验证步骤
1. `pnpm dev`：
   - 点正交/透视 → 相机立即切换并重新 fit（验证 TASK_007 响应）。
   - 勾选 Y 翻转 → 地图翻转（验证 EdgesLayer/NodesLayer 消费 `isFlipY`）。
   - 勾选节点/路径标签 → Context state 变化（此时 LabelsLayer 尚未实现，state 变化可用 React DevTools 或临时 `console.log` 确认；TASK_012 接入后即见文字）。
2. 控件不遮挡地图核心区，深色工业风格一致。
3. `pnpm build`、`pnpm lint` 通过。

## 完成定义 (DoD)
- 四个开关全部生效；相机/Y 翻转即时可视；标签开关 state 正确流转（待 TASK_012 消费）。

## 风险/备注
- 本 task 不实现标签文字本身（TASK_012）；若 review 时希望连调，可将 TASK_011/012 合并执行，但保持文件分离。
