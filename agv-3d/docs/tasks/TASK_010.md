---
id: TASK_010
status: ready
branch: task/010-nodes-layer
spec: docs/SPEC_agv-map-phase1.md
plan: docs/PLAN_agv-map-phase1.md
commit: "feat(TASK_010): 实现节点与朝向三角 InstancedMesh"
depends_on:
  - TASK_002
  - TASK_003
  - TASK_007
agent_allowed_paths:
  - src/scene/NodesLayer.tsx
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

# TASK_010 · 节点渲染层 NodesLayer

## 目标
SPEC §5：用**单个 InstancedMesh（圆柱）** 承载全部节点，`instanceColor` 按 `type` 5 色区分；`angle` 非 null 的节点叠加朝向三角（另一个小 InstancedMesh），三角底面 `yWedge=0.05` 严格高于节点圆柱顶面 `yNodeTop=0.04`，俯视不被遮挡。

## 前置依赖
TASK_002（`Node`/类型）、TASK_003（palette/常量）、TASK_007（MapView）。

## 涉及文件
- `src/scene/NodesLayer.tsx`（新建）
- `src/scene/MapView.tsx`（改：挂 `<NodesLayer nodes={…} />`）

## 实现要点
1. props：`{ nodes: Node[] }`；从 Context 取 `isFlipY`，但坐标转换必须调用 `mapPointToScene`。
2. 坐标映射：`mapPointToScene({ x: node.x, y: node.y }, { isFlipY, unitScale })`；圆柱底面 `y=0`、高 `nodeHeight=0.04`（§5/§3）。
3. **节点 InstancedMesh**：
   - `<instancedMesh args={[undefined, undefined, nodes.length]}>` + `<cylinderGeometry args={[nodeRadius, nodeRadius, nodeHeight, 16]}/>`（cylinder 默认轴 +Y，中心在原点 → 实例 matrix 平移 `y = nodeHeight/2` 使底面贴 y=0）。
   - `useLayoutEffect` 设每个实例 `matrix`（位置）+ `instanceColor`（`type → palette.nodeXxx`，未知 type 归 `nodeNode`，§5.2）。
4. **朝向三角 InstancedMesh**：
   - 仅对 `angle != null` 的节点（真实约 460/1806）创建实例；实例数 = 这些节点数。
   - 几何统一为**贴地扁三角片**（`ShapeGeometry` 画等腰三角形，腰长 ≈ `nodeRadius*1.2`，底边在 `yWedge=0.05` 平面）。**不用三棱锥**（SPEC §5.3 已收敛形状）。
   - 朝向：三角尖端指向 `angle`（弧度）方向（绕 Y 轴旋转）；可从节点圆心沿 `angle` 方向偏移 `nodeRadius*0.6`，使三角"探出"圆盘边缘。
5. MapView：`bbox` 有效时挂 `<NodesLayer>`。

## 约束
- 节点 1 个 InstancedMesh、三角 1 个 InstancedMesh；禁止 per-node mesh。
- y 分层严格遵守 `0 < 0.02 < 0.04 < 0.05`（与 TASK_003 常量一致）。
- 禁止在组件内手写 `isFlipY ? -node.y : node.y`；所有点位映射走 `render/coordinates.ts`。
- 遵守 PLAN §3。

## 验证步骤
1. `pnpm dev` 观感：
   - 5 类节点按配色区分（work 蓝/charge 黄/park 灰/warehouse 紫/node 浅灰）。
   - 有 `angle` 的节点可见朝向小三角，且俯视下三角在圆盘上方不被遮挡。
   - 圆柱自然遮挡穿过的路径（z-fighting 正常）。
   - 开 `isFlipY`：节点整体翻转。
2. `pnpm build`、`pnpm lint` 通过。

## 完成定义 (DoD)
- 节点 + 朝向三角两个 InstancedMesh 正确渲染，配色/分层/朝向无误。

## 风险/备注
- SPEC §5.3 已定形状为贴地扁三角片；若 `ShapeGeometry` 朝向调试成本高，可用 `<coneGeometry args={[wedgeSize, wedgeSize*0.02, 3]}>` 极扁三棱锥近似（俯视等效三角片），但底面仍在 `yWedge=0.05`。
- `instanceColor` 需 material `vertexColors`/`toneMapped` 配合；若颜色偏暗，检查 `material.toneMapped=false` 或换 `meshBasicMaterial`。
