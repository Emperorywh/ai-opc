---
id: TASK_008
title: 边渲染层 EdgesLayer
status: draft
phase: 3
depends_on: [TASK_006, TASK_007]
files:
  - src/scene/EdgesLayer.tsx
  - src/scene/MapView.tsx
---

# TASK_008 · 边渲染层 EdgesLayer

## 目标
用**单个** `Line2`（drei `<Line>` 或直接 `LineGeometry`/`LineMaterial`）渲染 TASK_006 产出的合并折线 buffer：直线 + 贝塞尔合并、屏幕空间像素线宽（`lineWidthPx`）、按 `isBackEdge` 的 `vertexColors` 双色。全图边 **1 次 draw call**（§4.6）。

## 前置依赖
TASK_006（geometry）、TASK_007（MapView 挂载点）。

## 涉及文件
- `src/scene/EdgesLayer.tsx`（新建）
- `src/scene/MapView.tsx`（改：在 bbox 有效时挂 `<EdgesLayer edges={…} />`）

## 实现要点
1. props：`{ edges: Edge[]; isFlipY: boolean }`（或直接接 `MapData`，从 Context 取 `isFlipY`）。
2. `useMemo(() => buildEdgeGeometry(edges, { isFlipY, laneOffset, bezierMaxSegments, palette }), [edges, isFlipY])` —— 数据/翻转变化才重建。
3. 渲染单一 Line2：
   - 优先用 drei `<Line>` 的 `points` + `vertexColors` + `lineWidth={lineWidthPx}`（屏幕像素）。若 `<Line>` 的多段（NaN 分隔）或 `vertexColors` 行为不符，退到裸 `<line2>` + `<LineGeometry positions={...} colors={...}/>` + `<LineMaterial linewidth={lineWidthPx} vertexColors resolution={size}/>`。
   - `LineMaterial.resolution` 必须设为画布像素尺寸，否则线宽异常；用 `useThree(state => state.size)` 注入。
4. 颜色：把 `buildEdgeGeometry` 返回的颜色数据转成 `THREE.Color[]`（每顶点一色，或每段一色按 Line2 API）。
5. `y = yEdge(0)`（positions 已在 geometry 内置高度，EdgesLayer 不再抬升）。
6. MapView：当 `bbox` 有效（非空地图）时挂载 `<EdgesLayer>`。

## 约束
- 全图仅一个 Line2 实例；禁止 per-edge `<Line>`。
- 遵守 PLAN §3。

## 验证步骤
1. `pnpm dev`（此时 MapView 需已注入真实 edges，若 TASK_013 尚未接 loader，可临时在 MapView 用 `import sample from "../../src/json/getMapInfo.json"` + `loadMapData` 拿到 edges 传入——验证后该临时接线由 TASK_013 规范化）。
2. 观感检查：
   - 直线边与贝塞尔曲线边均可见，曲线平滑。
   - 正向（`#00e5a8` 青绿）与反向（`#ff6b6b` 暖红）双色清晰。
   - 成对双向边呈双车道平行偏移、不重叠；孤儿边在中心线。
   - 滚轮缩放时线宽视觉恒定（屏幕像素）。
   - 开 `isFlipY`：整图沿水平轴翻转。
3. `pnpm build`、`pnpm lint` 通过。

## 完成定义 (DoD)
- 单 Line2 渲染全部边，双色 + 双车道偏移 + 恒定像素线宽，draw call 为 1（可用 `gl.info.render.calls` 抽查）。

## 风险/备注
- NaN 分隔若不被所选 API 支持，改用"每段独立 positions + 单 material"的 Line2 多段写法，但仍保持单 draw call 思路（Line2 支持单 geometry 内多段断开）。
- `LineMaterial` 属 `three/examples/jsm`，随 `three` 包提供，无需额外依赖；类型可能需 `@types` 兜底（three 自带类型通常覆盖）。
