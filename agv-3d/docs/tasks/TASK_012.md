---
id: TASK_012
title: 标签层 LabelsLayer
status: draft
phase: 4
depends_on: [TASK_002, TASK_003, TASK_007]
files:
  - src/scene/LabelsLayer.tsx
---

# TASK_012 · 标签层 LabelsLayer

## 目标
SPEC §5.4：用 drei `<Text>`（troika-three-text）渲染节点 `name` 与路径 `name` 标签，默认关闭、由 `showNodeLabels`/`showEdgeLabels` 开关控制。**Phase 1 降级实现**（PLAN §2.C）：数量上限（`labelMaxVisible`）+ 视口剔除 + 缩放阈值；碰撞剔除为可选增强，本 task 不做。

## 前置依赖
TASK_002（nodes/edges）、TASK_003（开关/常量/palette）、TASK_007（挂载点）。

## 涉及文件
- `src/scene/LabelsLayer.tsx`（新建）
- `src/scene/MapView.tsx`（改：挂 `<LabelsLayer/>`）

## 实现要点
1. 从 Context 读 `showNodeLabels`/`showEdgeLabels`；任一开启才渲染对应子层。
2. **视口剔除**：用 `useThree(state => state.camera)` + 每帧（或节流）把候选标签世界坐标投影到屏幕，保留在视锥 + 屏幕内的。
3. **缩放阈值**：相机距离/zoom 过远（屏幕密度过低）时整体不显示（如正交 `zoom < threshold` 或透视 `distance > threshold`）。
4. **数量上限**：`labelMaxVisible`（默认 200）——候选按优先级（如距视口中心近优先，或节点 type 优先级）截断；超出不渲染。
5. 渲染：对保留的标签用 `<Text fontSize=… color={palette.labelText} outlineColor outlineWidth position={[x, yLabel, z]}>`；`yLabel` 高于三角（如 `0.08`），文字朝上（俯视可读，必要时 `rotation-x=-Math.PI/2` 平躺）。
6. 节点名空（§9）不显示；边名同理。
7. **字体**：drei `<Text>` 默认从 CDN 拉 Roboto；若内网不可用，需本地化字体文件并通过 `font` prop 指定。本 task 先用默认，若加载失败在控制台告警并在风险项记录。

## 约束
- 严禁 1k–10k 标签全量渲染（§5.4）；上限/剔除必须真实生效。
- 标签状态走 Context（不引 zustand）。
- 碰撞剔除（屏幕互斥）**不在本 task**；若观感不足后续单列增强 task。
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
