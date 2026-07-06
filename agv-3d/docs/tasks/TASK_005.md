---
id: TASK_005
status: draft
branch: task/005-lane-offset
spec: docs/SPEC_agv-map-phase1.md
plan: docs/PLAN_agv-map-phase1.md
commit: "feat(TASK_005): 实现双车道配对索引与法线偏移"
depends_on:
  - TASK_002
agent_allowed_paths:
  - src/render/laneOffset.ts
  - src/render/laneOffset.test.ts
verify:
  - pnpm lint
  - pnpm build
  - pnpm test
allowed_tools:
  - Bash(pnpm test:*)
  - Bash(pnpm build:*)
  - Bash(pnpm lint:*)
---

# TASK_005 · 双车道偏移工具

## 目标
实现 SPEC §4.4：(1) 用**节点 id** 预建配对索引，判定双向成对边 / 孤儿边；(2) 给定一条边的行驶方向切线，计算其采样点沿统一法线的双车道偏移。`isBackEdge` 只用于颜色，不参与左右偏移。纯函数，可单测。

## 前置依赖
TASK_002（`Edge` 类型）。

## 涉及文件
- `src/render/laneOffset.ts`（新建）
- `src/render/laneOffset.test.ts`（新建）

## 实现要点
1. `buildPairIndex(edges: Edge[]): Map<string, Edge[]>`：
   - `key = min(u,v) + "-" + max(u,v)`，其中 `u = snodeId`、`v = enodeId`（字符串字典序归一化）。
   - 返回 `Map<key, Edge[]>`，但 paired 判定必须继续校验方向互逆，不能只看数量。
2. `getPairKind(edge, index): "paired" | "orphan"`：
   - 同 key 下**恰好 2 条且存在一条 `snodeId/enodeId` 与当前边精确反向**时返回 paired。
   - 同向重复、超过 2 条或只有 1 条均返回 orphan，避免错误偏移。
3. 偏移纯函数（在场景 x/z 平面使用；坐标映射由 `render/coordinates.ts` 先完成）：
   - `normalOf(tx, tz): {nx, nz}` —— 统一约定法线 = 行驶切线**顺时针 90°**（行驶方向右侧）：`(tz, -tx)`（归一化）。
   - `offsetSign(pairKind): 1 | 0` —— paired 边返回 `1`，孤儿边返回 `0`。反向边因自身切线相反，使用同一个 `+N` 约定即可自然落到中心线另一侧。
   - `applyLaneOffset(point, tx, tz, sign, laneOffset): {x,z}` —— 把 `point` 沿 `normalOf(tx,tz) * sign * laneOffset/2` 偏移。
   - 禁止把 `isBackEdge` 传入或用于偏移符号；它只在渲染颜色中使用。
4. **laneOffset.test.ts**：
   - 构造 A`(u→v)` + B`(v→u)`：`buildPairIndex` 两边同 key、`getPairKind` 均为 paired；即使两条边 `isBackEdge=false`，两者也都使用 sign=1。
   - 同向重复边不视为 paired；孤儿边（无反向配对）sign=0。
   - 法线 `(tz,-tx)` 对切线 `(1,0)` 得 `(0,-1)`，模长 1；反向切线 `(-1,0)` 得 `(0,1)`，证明 paired 双向边自然分离。
   - `applyLaneOffset` 对 sign=0 返回原点。

## 约束
- 配对**只用 `snodeId/enodeId`**，不用坐标（SPEC §4.4 明确）。
- 偏移方向全图统一（顺时针法线），不逐边判断。
- 不在此做坐标映射/翻转；调用方必须先通过 `render/coordinates.ts` 得到场景坐标与场景切线。
- `isBackEdge` 不得影响偏移，只能影响颜色。
- 遵守 PLAN §3。

## 验证步骤
1. `pnpm test -- src/render/laneOffset.test.ts` 全绿。
2. `pnpm build`、`pnpm lint` 通过。

## 完成定义 (DoD)
- 配对索引、精确反向判定、孤儿判定、法线/偏移符号、偏移应用五项行为正确且有测试覆盖。

## 风险/备注
- `laneOffset` 幅度由调用方传入；本函数只负责"方向 + 应用偏移"，不直接依赖 `config/constants`。保持函数纯。
- 节点处连续性（裂缝）是已知接受局限（§4.6），本 task 不处理。
