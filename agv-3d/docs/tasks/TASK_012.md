---
id: TASK_012
status: draft
branch: task/012-labels-layer
spec: docs/SPEC_agv-map-phase1.md
plan: docs/PLAN_agv-map-phase1.md
commit: "feat(TASK_012): 实现标签层与剔除策略"
depends_on:
  - TASK_002
  - TASK_003
  - TASK_008
agent_allowed_paths:
  - src/scene/LabelsLayer.tsx
  - src/scene/MapView.tsx
verify:
  - pnpm lint
  - pnpm build
  - pnpm test
allowed_tools:
  - Bash(pnpm test:*)
  - Bash(pnpm build:*)
  - Bash(pnpm lint:*)
---

# TASK_012 · 标签层 LabelsLayer

## 目标
SPEC §5.4：用 drei `<Text>`（troika-three-text）渲染节点 `name` 与路径 `name` 标签，默认关闭、由 `showNodeLabels`/`showEdgeLabels` 开关控制。**Phase 1 降级实现**（PLAN §2.C）：数量上限（`labelMaxVisible`）+ 视口剔除 + 缩放阈值；碰撞剔除为可选增强，本 task 不做。

## 前置依赖
TASK_002（nodes/类型）、TASK_003（开关/常量/palette/坐标映射）、TASK_008（MapView 已统一构建 `edgeGeometry.edgeSamplePaths`）。

## 涉及文件
- `src/scene/LabelsLayer.tsx`（新建）
- `src/scene/MapView.tsx`（改：挂 `<LabelsLayer/>`）

## 实现要点
1. props：`{ nodes: Node[]; edgeSamplePaths: EdgeSamplePath[] }`；从 Context 读 `showNodeLabels`/`showEdgeLabels`。
2. 候选生成：
   - 节点标签：节点 `name` 非空时，使用 `mapPointToScene` 得到位置。
   - 路径标签：`edgeName` 非空时，使用 `edgeSamplePaths` 按 `length / 2` 找弧长中点作为位置，切线仅用于未来增强；Phase 1 标签不沿路径旋转，保持俯视可读。
3. **视口剔除**：用 `useThree(state => state.camera)` + 每帧（或节流）把候选标签世界坐标投影到屏幕，保留在视锥 + 屏幕内的。
4. **缩放阈值**：相机距离/zoom 过远（屏幕密度过低）时整体不显示（如正交 `zoom < threshold` 或透视 `distance > threshold`）。
5. **数量上限**：`labelMaxVisible`（默认 200）为节点 + 路径标签的全局总上限。候选按优先级截断：非普通节点优先，其次距视口中心近的节点，再其次距视口中心近的路径标签；超出不渲染。
6. 渲染：对保留的标签用 `<Text fontSize=… color={palette.labelText} outlineColor outlineWidth position={[x, yLabel, z]}>`；`yLabel` 引用 `constants.yLabel`（=0.08，高于三角 `yWedge=0.05`，SPEC §3），文字平铺在 xz 平面并保持俯视可读（必要时 `rotation-x=-Math.PI/2`）。
7. 节点名空（§9）不显示；边名同理。
8. **字体**：drei `<Text>` 默认从 CDN 拉 Roboto；若内网不可用，需本地化字体文件并通过 `font` prop 指定。本 task 先用默认，若加载失败在控制台告警并在风险项记录。

## 约束
- 严禁 1k–10k 标签全量渲染（§5.4）；上限/剔除必须真实生效。
- 标签状态走 Context（不引 zustand）。
- 碰撞剔除（屏幕互斥）**不在本 task**；若观感不足后续单列增强 task。
- 路径标签必须复用 `edgeSamplePaths`，不得重新 tessellate 边。
- 节点标签坐标必须复用 `render/coordinates.ts`，不得手写翻转公式。
- 遵守 PLAN §3。

## 验证步骤
1. `pnpm dev`：默认（两开关关）无标签。
2. 开 `showNodeLabels`：可见范围内节点显示 `name`，数量不超过 `labelMaxVisible`（可临时把上限设很小如 20 验证截断）。
3. 缩放到很远 → 标签消失（缩放阈值生效）。
4. 平移相机 → 视口外标签剔除、视口内出现（视口剔除生效）。
5. 开/关 `showEdgeLabels` 同理。
6. 开启标签后帧率无明显崩溃（剔除生效，§12.7）。
7. `pnpm build`、`pnpm lint` 通过。

## 完成定义 (DoD)
- 三项剔除（数量上限/视口/缩放）真实生效，标签开关正确，开启后无性能崩溃。

## 风险/备注
- 字体 CDN 是已知风险（PLAN §7）；若实际环境离线，需追加本地字体文件（可能衍生小 task）。
- troika `<Text>` 每个实例有开销，即便剔除后仍应控制同帧实例数在上限内（只为可见集合创建 `<Text>`，而非隐藏全部）。
