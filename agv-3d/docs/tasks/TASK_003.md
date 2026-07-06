---
id: TASK_003
title: 配置层与全局状态
status: draft
phase: 1
depends_on: [TASK_001]
files:
  - src/config/palette.ts
  - src/config/constants.ts
  - src/state/MapConfig.tsx
---

# TASK_003 · 配置层与全局状态

## 目标
集中落地 SPEC §6 调色板与 §7 常量，并提供 React Context 承载运行时开关（`isFlipY` / `cameraMode` / `showNodeLabels` / `showEdgeLabels`），供 Controls（TASK_011）与各渲染层消费。

## 前置依赖
TASK_001（React 环境）。不依赖 TASK_002（纯配置）。

## 涉及文件
- `src/config/palette.ts`（新建）
- `src/config/constants.ts`（新建）
- `src/state/MapConfig.tsx`（新建）

## 实现要点
1. **palette.ts**（`as const` 对象，禁 enum）—— SPEC §6：
   ```
   background #0a0e1a
   edgeForward #00e5a8   edgeBack #ff6b6b
   arrowForward #38ffc1  arrowBack #ff8e8e
   nodeWork #4dabf7  nodeCharge #ffd43b  nodePark #868e96
   nodeWarehouse #b197fc  nodeNode #ced4da
   labelText #e9ecef   labelStroke rgba(0,0,0,0.6)
   ```
   颜色统一存 `string`（drei/Line2 需要时各自解析）。
2. **constants.ts**（`as const`）—— SPEC §7 全部常量：`isFlipY=false`、`unitScale=1.0`、`lineWidthPx=3`、`laneOffset=0.15`、`nodeRadius=0.18`、`nodeHeight=0.04`、`bezierMaxSegments=64`、`arrowSize=0.12`、`longEdgeThreshold=3.0`、`labelMaxVisible=200`。并导出 y 分层常量：`yEdge=0`、`yArrow=0.02`、`yNodeTop=0.04`、`yWedge=0.05`（SPEC §3）。
3. **MapConfig.tsx**：
   - `CameraMode = "orthographic" | "perspective"`。
   - `MapConfigValue = { isFlipY: boolean; cameraMode: CameraMode; showNodeLabels: boolean; showEdgeLabels: boolean; setIsFlipY, setCameraMode, setShowNodeLabels, setShowEdgeLabels }`。
   - `MapConfigProvider` 用 `useState` 持有，默认值取自 `constants`（`isFlipY` 默认 `false`、`cameraMode` 默认 `"orthographic"`、两个 label 开关默认 `false`）。
   - `useMapConfig()` 钩子（须遵守 react `rules-of-hooks`）。
   - 不引入 zustand。

## 约束
- `palette`/`constants` 全部只导出数据，无副作用。
- 遵守 PLAN §3。

## 验证步骤
1. `pnpm build`：tsc 通过。
2. `pnpm lint`：通过（`only-export-components` 对 Provider 文件允许导出钩子/常量）。
3. smoke（可选）：在 `App.tsx` 临时包一层 `<MapConfigProvider>` 并 `console.log(useMapConfig())`，dev 打开看到默认值；验证后撤掉临时代码（不在本 task 持久化 App 改动，避免与 TASK_007 冲突）。

## 完成定义 (DoD)
- 三文件就位，类型/常量/调色板与 SPEC §6/§7 完全一致。
- Provider 可挂载、钩子可读默认值。

## 风险/备注
- y 分层常量务必满足 `yEdge(0) < yArrow(0.02) < yNodeTop(0.04) < yWedge(0.05)`，z-fighting 规避（SPEC §3）。
- 颜色一律字符串；three 的 `Color` 解析在各使用点做。
