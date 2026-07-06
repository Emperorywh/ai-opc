---
id: TASK_003
status: draft
branch: task/003-config-coordinates
spec: docs/SPEC_agv-map-phase1.md
plan: docs/PLAN_agv-map-phase1.md
commit: "feat(TASK_003): 落地调色板常量坐标映射与全局状态"
depends_on:
  - TASK_001
agent_allowed_paths:
  - src/config
  - src/render/coordinates.ts
  - src/state
verify:
  - pnpm lint
  - pnpm build
  - pnpm test
allowed_tools:
  - Bash(pnpm test:*)
  - Bash(pnpm build:*)
  - Bash(pnpm lint:*)
---

# TASK_003 · 配置层、坐标映射与全局状态

## 目标
集中落地 SPEC §6 调色板与 §7 常量，提供唯一的地图坐标 → 场景坐标映射入口，并提供 React Context 承载运行时开关（`isFlipY` / `cameraMode` / `showNodeLabels` / `showEdgeLabels`），供 Controls（TASK_011）与各渲染层消费。

## 前置依赖
TASK_001（React 环境）。不依赖 TASK_002（纯配置）。

## 涉及文件
- `src/config/palette.ts`（新建）
- `src/config/constants.ts`（新建）
- `src/render/coordinates.ts`（新建）
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
   颜色统一存 `string`（drei/`LineSegments2` 需要时各自解析）。
2. **constants.ts**（`as const`）—— SPEC §7 全部常量：`isFlipY=false`、`unitScale=1.0`、`lineWidthPx=3`、`laneOffset=0.15`、`nodeRadius=0.18`、`nodeHeight=0.04`、`bezierMaxSegments=64`、`arrowSize=0.12`、`longEdgeThreshold=3.0`、`labelMaxVisible=200`、`yLabel=0.08`。并导出 y 分层常量：`yEdge=0`、`yArrow=0.02`、`yNodeTop=0.04`、`yWedge=0.05`、`yLabel=0.08`（SPEC §3，单调递增规避 z-fighting）。
3. **coordinates.ts**（纯函数，无 React / three 依赖）：
   - `mapPointToScene(point, opts)`：地图 `{x, y}` → 场景 `{x, z}`，其中 `z = opts.isFlipY ? -y : y`，并应用 `unitScale`。
   - `mapVectorToScene(vector, opts)`：地图切线/方向 `{x, y}` → 场景方向 `{x, z}`，同样应用 `isFlipY`，并返回归一化结果。
   - `mapBoxToSceneBox(bbox, opts)`：把 `Box2XY` 转成 fit 相机需要的场景 x/z 范围，内部处理 Y 翻转后的 min/max 归一化。
   - 后续 `geometry`、`NodesLayer`、`LabelsLayer`、`MapView` fit 均必须复用这些函数，不得手写坐标映射公式。
4. **MapConfig.tsx**：
   - `CameraMode = "orthographic" | "perspective"`。
   - `MapConfigValue = { isFlipY: boolean; cameraMode: CameraMode; showNodeLabels: boolean; showEdgeLabels: boolean; setIsFlipY, setCameraMode, setShowNodeLabels, setShowEdgeLabels }`。
   - `MapConfigProvider` 用 `useState` 持有，默认值取自 `constants`（`isFlipY` 默认 `false`、`cameraMode` 默认 `"orthographic"`、两个 label 开关默认 `false`）。
   - `useMapConfig()` 钩子（须遵守 react `rules-of-hooks`）。
   - 不引入 zustand。

## 约束
- `palette`/`constants` 全部只导出数据，无副作用；`coordinates` 只导出纯函数。
- 坐标映射唯一入口为 `render/coordinates.ts`，scene 组件不得重复实现映射逻辑。
- 遵守 PLAN §3。

## 验证步骤
1. `pnpm build`：tsc 通过。
2. `pnpm lint`：通过（`only-export-components` 对 Provider 文件允许导出钩子/常量）。
3. smoke（可选）：在 `App.tsx` 临时包一层 `<MapConfigProvider>` 并 `console.log(useMapConfig())`，dev 打开看到默认值；验证后撤掉临时代码（不在本 task 持久化 App 改动，避免与 TASK_007 冲突）。

## 完成定义 (DoD)
- 四文件就位，类型/常量/调色板与 SPEC §6/§7 完全一致，坐标映射函数覆盖点、向量、包围盒三类用法。
- Provider 可挂载、钩子可读默认值。

## 风险/备注
- y 分层常量务必满足 `yEdge(0) < yArrow(0.02) < yNodeTop(0.04) < yWedge(0.05) < yLabel(0.08)`，z-fighting 规避（SPEC §3）。
- 颜色一律字符串；three 的 `Color` 解析在各使用点做。
