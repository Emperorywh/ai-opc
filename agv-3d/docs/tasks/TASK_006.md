---
id: TASK_006
title: 统一折线 buffer 构建
status: draft
phase: 2
depends_on: [TASK_002, TASK_003, TASK_004, TASK_005]
files:
  - src/render/geometry.ts
  - src/render/geometry.test.ts
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
2. 坐标映射统一调用 `render/coordinates.ts`：地图 `(x,y)` → 场景 `(x, z)`；`y 轴(高度) = yEdge(0)`（SPEC §3）。**先做坐标映射，再做法线偏移**（偏移在场景 xz 平面，法线由场景切线算）。
3. 流程（§4.6 构建 1–4）：
   - 先 `buildPairIndex(edges)` 一次。
   - 遍历每条边：
     - 跳过零长度/自环（loader 已剔除，本处再做防御性跳过）。
     - LINE → 2 端点，切线 = 端点方向归一化。
     - BEZIER → `sampleCubicBezier(P0..P3, bezierMaxSegments)` 得 `SamplePoint[]`（含切线）。
      - 查 `getPairKind` 得 sign；paired 边 sign=1，孤儿 sign=0；对每个采样点 `applyLaneOffset`（场景 xz）。禁止使用 `isBackEdge` 决定偏移方向。
      - 把该边采样点追加到 `positions`；默认用 **NaN 顶点**（`[NaN,NaN,NaN]`）表达段分隔。若 TASK_008 验证当前 Line2 API 不稳定，可保持 `edgeSamplePaths` 不变并把 `positions` 编码切换为 `LineSegments2` 需要的成对 segment 顶点。
      - 每个顶点颜色 = `isBackEdge ? palette.edgeBack : palette.edgeForward`，追加到 `colors`（NaN 顶点颜色随便/重复上一个，Line2 不渲染 NaN）。
      - 该边偏移后的场景采样点 + 切线 + 元数据存入 `edgeSamplePaths[i]`。
4. 返回：`EdgeGeometry = { positions: Float32Array | number[]; colors: number[]; edgeSamplePaths: EdgeSamplePath[] }`。
   - `EdgeSamplePath = { edgeId: string; edgeName: string; isBackEdge: boolean; points: { x:number; y:number; z:number; tx:number; tz:number }[]; length: number }`。
   - `points.y` 固定为 `yEdge`，`length` 为偏移后折线弧长，供箭头数量与路径标签中点复用。
5. **geometry.test.ts**：
   - 构造 2 条直线（一对 u↔v，正/反）+ 1 条孤儿直线 + 1 条贝塞尔：
      - `positions` 段数正确（4 段，3 个段分隔；若采用 NaN 编码则断言 3 个 NaN 分隔）。
      - 双向 paired 边即使 `isBackEdge` 均为 `false`，也会因各自行驶切线相反而落在中心线两侧；孤儿不偏移（用具体坐标断言）。
      - `colors` 按 `isBackEdge` 分色。
      - `edgeSamplePaths` 长度 = 边数，且包含 `edgeId/edgeName/isBackEdge/length`；贝塞尔边的 sample 数 > 2。
   - 零长度边被跳过（不出现在 positions）。
   - `isFlipY=true` 时 z 取反。

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
- NaN 分隔为首选实现；若 EdgesLayer 验证当前 API 不稳定，可改为 `LineSegments2` 所需的 segment-pair 编码，本函数必须保证 `edgeSamplePaths` 语义不变。
- `colors` 的具体承载形式（THREE.Color vs number[]）在 EdgesLayer 对接时确定；本函数优先返回 `number[]`（每顶点 rgb 或每段一个 hex），测试按所选形式断言。
