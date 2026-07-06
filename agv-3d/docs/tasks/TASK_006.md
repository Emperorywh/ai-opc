---
id: TASK_006
status: draft
branch: task/006-edge-geometry
spec: docs/SPEC_agv-map-phase1.md
plan: docs/PLAN_agv-map-phase1.md
commit: "feat(TASK_006): 构建统一边折线 buffer 与采样路径"
depends_on:
  - TASK_002
  - TASK_003
  - TASK_004
  - TASK_005
agent_allowed_paths:
  - src/render/geometry.ts
  - src/render/geometry.test.ts
verify:
  - pnpm lint
  - pnpm build
  - pnpm test
allowed_tools:
  - Bash(pnpm test:*)
  - Bash(pnpm build:*)
  - Bash(pnpm lint:*)
---

# TASK_006 · 统一折线 buffer 构建

## 目标
SPEC §4.6 的核心：遍历全部边，把直线（2 点）与贝塞尔（tessellate 多点）**合并进单个折线点序列**，每段叠加双车道法线偏移，输出供单一粗线渲染使用的 `positions` + `colors`（按 `isBackEdge`），并同时产出 `edgeSamplePaths`（每条边偏移后的采样点、切线与边元数据，供 TASK_009 箭头和 TASK_012 路径标签复用，避免重复 tessellate）。

## 前置依赖
TASK_002（loader/类型）、TASK_003（坐标映射）、TASK_004（贝塞尔采样）、TASK_005（配对/偏移）。

## 涉及文件
- `src/render/geometry.ts`（新建）
- `src/render/geometry.test.ts`（新建）

## 实现要点
1. 入参：`buildEdgeGeometry(edges: Edge[], opts: { isFlipY: boolean; laneOffset: number; bezierMaxSegments: number; palette }): EdgeGeometry`。
2. 坐标映射统一调用 `render/coordinates.ts`：**位置点**经 `mapPointToScene`（地图 `(x,y)` → 场景 `(x,z)`，高度 `y=yEdge(0)`）；**切线向量**经 `mapVectorToScene`（地图 `(tx,ty)` → 场景 `(tx,tz)`，受 `isFlipY` 影响）。**先映射位置与切线，再在场景 xz 平面做法线偏移**（法线由场景切线算）。⚠️ 贝塞尔 `sampleCubicBezier` 返回的 `SamplePoint.tx/ty` 是地图坐标切线，必须先 `mapVectorToScene` 再喂 `applyLaneOffset`，否则 `isFlipY=true` 时偏移方向反转。
3. 流程（§4.6 构建 1–4）：
   - 先 `buildPairIndex(edges)` 一次。
   - 遍历每条边：
     - 跳过零长度/自环（loader 已剔除，本处再做防御性跳过）。
     - LINE → 2 端点；切线 = 端点方向归一化。
     - BEZIER → `sampleCubicBezier(P0..P3, bezierMaxSegments)` 得 `SamplePoint[]`（含切线）。
     - **位置与切线均经 `render/coordinates.ts` 映射到场景坐标**（位置 `mapPointToScene`、切线 `mapVectorToScene`，见要点 2）。
     - 查 `getPairKind` 得 sign；paired 边 sign=1，孤儿 sign=0；对每个采样点 `applyLaneOffset`（场景 xz）。禁止使用 `isBackEdge` 决定偏移方向。
     - 把该边**相邻两点拆成成对 segment 顶点**追加到 `positions`（直线 2 顶点 = 1 segment；贝塞尔 N 点 = N−1 segment = 2(N−1) 顶点）。**不使用 NaN 分隔**——这是 `LineSegments2` 的原生多段语义。
     - 每个顶点颜色 = `isBackEdge ? palette.edgeBack : palette.edgeForward`，追加到 `colors`（与 `positions` 顶点一一对应，供 `LineSegmentsGeometry.setColors`）。
     - 该边偏移后的场景采样点 + 切线 + 元数据存入 `edgeSamplePaths[i]`。
4. 返回：`EdgeGeometry = { positions: number[]; colors: number[]; edgeSamplePaths: EdgeSamplePath[] }`。`positions`/`colors` 为**成对 segment 顶点**（每 6 个 float 一段:`x0,y0,z0, x1,y1,z1`），可直接喂 `LineSegmentsGeometry.setPositions/setColors`。
   - `EdgeSamplePath = { edgeId: string; edgeName: string; isBackEdge: boolean; points: { x:number; y:number; z:number; tx:number; tz:number }[]; length: number }`。
   - `points.y` 固定为 `yEdge`，`length` 为偏移后折线弧长，供箭头数量与路径标签中点复用。
5. **geometry.test.ts**：
   - 构造 2 条直线（一对 u↔v，正/反）+ 1 条孤儿直线 + 1 条贝塞尔：
     - `positions` 顶点数正确：直线段各 2 顶点、贝塞尔 `2*(N-1)` 顶点；且 `positions.length % 6 === 0`（成对 segment 编码，每段 6 float）。
     - 双向 paired 边即使 `isBackEdge` 均为 `false`，也会因各自行驶切线相反而落在中心线两侧；孤儿不偏移（用具体坐标断言）。
     - `colors` 按 `isBackEdge` 分色，且与 `positions` 顶点一一对应。
     - `edgeSamplePaths` 长度 = 边数，且包含 `edgeId/edgeName/isBackEdge/length`；贝塞尔边的 sample 数 > 2。
   - 零长度边被跳过（不出现在 positions）。
   - `isFlipY=true` 时 z 取反，且 **paired 边仍对称分布于中心线两侧**（验证切线经 `mapVectorToScene` 映射后偏移方向正确，要点 2）。

## 约束
- 纯函数、无 React、无 three 依赖（返回裸数值）。颜色以数字/hex 数组给出。
- 单一职责：只构建边折线 buffer；节点/箭头 buffer 不在此。
- 遵守 PLAN §3。

## 验证步骤
1. `pnpm test -- src/render/geometry.test.ts` 全绿。
2. `pnpm build`、`pnpm lint` 通过。

## 完成定义 (DoD)
- 合并 buffer 正确（含明确段分隔语义）、双车道偏移方向正确、孤儿不偏移、`edgeSamplePaths` 可供箭头与路径标签复用。

## 风险/备注
- 采用 `LineSegments2` 成对 segment 编码（SPEC §4.6 已定稿），不再考虑 NaN 分隔；`edgeSamplePaths` 语义与编码无关，箭头/标签复用不受影响。
- `colors` 返回 `number[]`（每顶点 rgb 三个 float，与 `positions` 顶点一一对应），供 `LineSegmentsGeometry.setColors` 直接使用。
