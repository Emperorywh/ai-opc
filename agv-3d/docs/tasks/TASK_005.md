---
id: TASK_005
title: 双车道偏移工具
status: draft
phase: 2
depends_on: [TASK_002]
files:
  - src/render/laneOffset.ts
  - src/render/laneOffset.test.ts
---

# TASK_005 · 双车道偏移工具

## 目标
实现 SPEC §4.4：(1) 用**节点 id** 预建配对索引，判定双向成对边 / 孤儿边；(2) 给定一条边的切线与 `isBackEdge`，计算其采样点沿统一法线的双车道偏移。纯函数，可单测。

## 前置依赖
TASK_002（`Edge` 类型）。

## 涉及文件
- `src/render/laneOffset.ts`（新建）
- `src/render/laneOffset.test.ts`（新建）

## 实现要点
1. `buildPairIndex(edges: Edge[]): Map<string, Edge[]>`：
   - `key = min(u,v) + "-" + max(u,v)`，其中 `u = snodeId`、`v = enodeId`（字符串字典序归一化）。
   - 同 key 下 0/1/2 条边；返回 `Map<key, Edge[]>`。
2. `getPairKind(edge, index): "paired" | "orphan"`：查表，同 key 有 2 条即 paired。
3. `laneOffsetAt(edge, isFlipY 走 render 层统一处理，本函数只算地图坐标偏移)`：提供两个纯函数：
   - `normalOf(tx, ty): {nx, ny}` —— 统一约定法线 = 切线**顺时针 90°**（全图一致）：`(ty, -tx)`（归一化）。
   - `offsetSign(isBackEdge: boolean): 1 | -1 | 0` —— 仅对 **paired** 边生效：正向 `isBackEdge=false` → `+1`（向 +N 偏 `laneOffset/2`）；反向 `+1` → `-1`（向 -N）。**孤儿边返回 0**（不偏移，画在几何中心线，§4.4）。
   - `applyLaneOffset(point, tx, ty, sign, laneOffset): {x,y}` —— 把 `point` 沿 `normalOf(tx,ty) * sign * laneOffset/2` 偏移。
4. **laneOffset.test.ts**：
   - 构造 A`(u→v)` + B`(v→u)`：`buildPairIndex` 两边同 key、`getPairKind` 均为 paired；A(`isBackEdge=false`) sign=+1，B(`isBackEdge=true`) sign=-1。
   - 孤儿边（无反向配对）sign=0。
   - 法线 `(ty,-tx)` 对切线 `(1,0)` 得 `(0,-1)`，模长 1。
   - `applyLaneOffset` 对 sign=0 返回原点。

## 约束
- 配对**只用 `snodeId/enodeId`**，不用坐标（SPEC §4.4 明确）。
- 偏移方向全图统一（顺时针法线），不逐边判断。
- 不在此做坐标映射/翻转（render 层统一）。
- 遵守 PLAN §3。

## 验证步骤
1. `pnpm test -- src/render/laneOffset.test.ts` 全绿。
2. `pnpm build`、`pnpm lint` 通过。

## 完成定义 (DoD)
- 配对索引、孤儿判定、法线/偏移符号、偏移应用四项行为正确且有测试覆盖。

## 风险/备注
- `laneOffset` 常量从 `config/constants` 引入；本函数只负责"方向"，幅度由调用方乘 `laneOffset/2`。保持函数纯。
- 节点处连续性（裂缝）是已知接受局限（§4.6），本 task 不处理。
