---
id: TASK_004
status: ready
branch: task/004-bezier
spec: docs/SPEC_agv-map-phase1.md
plan: docs/PLAN_agv-map-phase1.md
commit: "feat(TASK_004): 实现三次贝塞尔弧长自适应采样"
depends_on:
  - TASK_001
agent_allowed_paths:
  - src/render/bezier.ts
  - src/render/bezier.test.ts
verify:
  - pnpm lint
  - pnpm build
  - pnpm test
allowed_tools:
  - Bash(pnpm test:*)
  - Bash(pnpm build:*)
  - Bash(pnpm lint:*)
---

# TASK_004 · 贝塞尔几何工具

## 目标
实现纯函数：三次贝塞尔（P0,P1,P2,P3）按弧长自适应 tessellate 为折线点，并给出每个采样点的切线方向（供双车道法线偏移与箭头朝向复用）。直线作为退化解在 `geometry.ts` 处理，本 task 只管贝塞尔。

## 前置依赖
TASK_001（vitest）。

## 涉及文件
- `src/render/bezier.ts`（新建）
- `src/render/bezier.test.ts`（新建）

## 实现要点
1. 数据结构：`export interface SamplePoint { x: number; y: number; tx: number; ty: number }`（地图坐标 + 单位切线）。
2. `export function sampleCubicBezier(p0,p1,p2,p3: {x,y}, maxSegments: number): SamplePoint[]`：
   - 三次贝塞尔 `B(t)` 与导数 `B'(t)` 标准公式。
   - **弧长自适应**：先用若干参数采样估算总弧长，按"短边少分段、大曲率多分段"决定段数，**封顶 `maxSegments`**（来自 constants，默认 64）；段数下限保证至少首尾两点。
   - 首点 = P0、末点 = P3（数值精度内）。
   - 切线 = `B'(t)` 归一化；端点处若退化（零导数）用相邻段切线回退。
3. 退化与边界：
   - 控制点缺失不是本函数职责（loader 已把 BEZIER 缺控制点降级为 LINE），本函数假定 P0–P3 全部有效数值。
   - 极短曲线（P0≈P3）仍返回至少 2 点，不抛异常。
4. **bezier.test.ts**：
   - 直线型贝塞尔（P1,P2 在 P0–P3 连线上）→ 采样点共线，切线恒等于直线方向。
   - 已知曲线上一点（如 t=0.5）数值近似正确。
   - 段数 ≤ `maxSegments`；首尾点严格命中 P0/P3。
   - 切线模长 ≈ 1。
   - 大曲率样本段数多于平直样本。

## 约束
- 纯函数、无 React、无 three 依赖（返回裸数值），便于 node 单测。
- 遵守 PLAN §3。

## 验证步骤
1. `pnpm test -- src/render/bezier.test.ts` 全绿。
2. `pnpm build`、`pnpm lint` 通过。

## 完成定义 (DoD)
- 自适应采样 + 切线输出正确，段数有封顶，端点命中，退化不崩。

## 风险/备注
- 弧长自适应不必追求精确等弧长，"曲率大处分段密"的启发式即可，关键是段数封顶避免极端曲线爆炸。
- 切线方向约定：沿 t 增大方向（P0→P3），后续 arrow 朝向以此为准。
