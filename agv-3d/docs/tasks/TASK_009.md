---
id: TASK_009
title: 方向箭头层 ArrowsLayer
status: draft
phase: 3
depends_on: [TASK_006, TASK_008]
files:
  - src/render/arrows.ts
  - src/render/arrows.test.ts
  - src/scene/ArrowsLayer.tsx
---

# TASK_009 · 方向箭头层 ArrowsLayer

## 目标
SPEC §4.5：沿每条边标注 `snode→enode` 走向的小箭头。短边中点 1 个；长边（弧长 > `longEdgeThreshold`）按等弧长间隔多个。用**单个 InstancedMesh(cone)** 承载所有箭头，`instanceColor` 随 `isBackEdge`，朝向 = 该参数点切线。复用 TASK_006 的 `edgeSamples` 避免重复 tessellate。

## 前置依赖
TASK_006（`edgeSamples` 含切线）、TASK_008（MapView 已挂 EdgesLayer，本层并列挂载）。

## 涉及文件
- `src/render/arrows.ts`（新建，纯函数）
- `src/render/arrows.test.ts`（新建）
- `src/scene/ArrowsLayer.tsx`（新建）

## 实现要点
1. **arrows.ts**：`buildArrowInstances(edgeSamples, opts: { longEdgeThreshold, arrowSize }): ArrowInstance[]`：
   - 对每条边的 `edgeSamples`（已偏移到双车道、场景 xz 坐标 + 切线 tx,tz）：
     - 估算弧长（采样点折线段长度之和）。
     - `length <= longEdgeThreshold` → 取中点采样点，1 个箭头。
     - `length > longEdgeThreshold` → 按等弧长间隔取多个参数点（间隔可设为 `longEdgeThreshold`，至少 1 个），每点 1 个箭头。
   - 每个 `ArrowInstance = { x, z, tx, tz, isBackEdge }`（位置 + 切线 + 配色标记）。
   - 高度统一 `yArrow(0.02)`（SPEC §3，高于路径、低于节点顶面）。
2. **ArrowsLayer.tsx**：
   - props 接 `edgeSamples`（与 EdgesLayer 共用同一份 `useMemo` 结果，避免重算）或接 `edges`+`isFlipY` 自行调 `buildEdgeGeometry` 取 `edgeSamples`（推荐前者，由父级 MapView 传同一份）。
   - `<instancedMesh args={[undefined, undefined, count]}>` + cone geometry（`<coneGeometry args={[arrowSize, arrowSize*2, 8]}/>`）；cone 默认朝 +Y，需旋转使其朝切线方向（绕 Y 轴：`rotationY = atan2(tx, tz)` 或用 `quaternion.setFromUnitVectors(Y, tangentXZ)`）。
   - 用 `useLayoutEffect` 遍历实例设 `matrix`（位置 + 朝向）与 `instanceColor`（`isBackEdge ? arrowBack : arrowForward`，§6）。
   - 实例数 = `Σ 每条边箭头数`，必须与 `buildArrowInstances` 输出一致。
3. **arrows.test.ts**：
   - 短直线边 → 恰好 1 个箭头，位置≈中点，切线 = 端点方向。
   - 长直线边（> 阈值）→ 多个箭头，等弧长间隔。
   - 贝塞尔边箭头切线随曲线变化。
   - 总实例数 = 预期。
   - `isBackEdge` 标记正确透传。

## 约束
- 单 InstancedMesh；实例数预先确定（§4.6）。
- 切线来自 `edgeSamples`，不重新 tessellate。
- 遵守 PLAN §3。

## 验证步骤
1. `pnpm test -- src/render/arrows.test.ts` 全绿。
2. `pnpm dev` 观感：每条边中点（长边多点）可见朝向小箭头，方向与 `snode→enode` 一致；正向/反向箭头颜色区分（略亮一档，§4.5/§6）；缩放下箭头尺寸为世界单位（与 `arrowSize` 一致）。
3. `pnpm build`、`pnpm lint` 通过。

## 完成定义 (DoD)
- 单 InstancedMesh 渲染全部箭头，数量正确、位置/朝向正确、配色随边。

## 风险/备注
- cone 朝向：先确认 cone 局部轴（three `ConeGeometry` 顶点朝 +Y）；映射到 xz 平面后绕 Y 旋转。本 task 内务必肉眼核对朝向，必要时调整角度公式。
- 箭头世界尺寸固定，极度缩小时会看不清——Phase 1 接受（不随缩放自适应）。
