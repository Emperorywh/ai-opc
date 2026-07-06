---
id: TASK_008
title: 边几何共享与 EdgesLayer
status: draft
phase: 3
depends_on: [TASK_006, TASK_007]
files:
  - src/scene/EdgesLayer.tsx
  - src/scene/MapView.tsx
---

# TASK_008 · 边几何共享与 EdgesLayer

## 目标
在 MapView 顶层用 `useMemo` 对当前 `edges + isFlipY` 构建唯一一份 `edgeGeometry`，并用**单个**粗线对象（drei `<Line>` / `Line2`，或验证后改用 `LineSegments2`）渲染 TASK_006 产出的合并折线 buffer：直线 + 贝塞尔合并、屏幕空间像素线宽（`lineWidthPx`）、按 `isBackEdge` 的 `vertexColors` 双色。全图边 **1 次 draw call**（§4.6）。

## 前置依赖
TASK_006（geometry）、TASK_007（MapView 挂载点）。

## 涉及文件
- `src/scene/EdgesLayer.tsx`（新建）
- `src/scene/MapView.tsx`（改：构建共享 `edgeGeometry` 并挂 `<EdgesLayer geometry={…} />`）

## 实现要点
1. MapView 从 `mapData.edges` 与 Context `isFlipY` 构建唯一 `edgeGeometry`：
   - `useMemo(() => buildEdgeGeometry(mapData.edges, { isFlipY, laneOffset, bezierMaxSegments, palette }), [mapData.edges, isFlipY])`。
   - 该结果保留在 MapView 作用域内，后续 TASK_009/TASK_012 直接复用 `edgeGeometry.edgeSamplePaths`。
2. `EdgesLayer` props：`{ geometry: EdgeGeometry }`，只负责把 `positions/colors` 喂给 three，不重新 tessellate、不读取 `edges`。
3. 渲染单一粗线对象：
   - 优先用 drei `<Line>` 的 `points` + `vertexColors` + `lineWidth={lineWidthPx}`（屏幕像素）。若 `<Line>` 的多段（NaN 分隔）或 `vertexColors` 行为不符，退到裸 `<line2>` + `<LineGeometry positions={...} colors={...}/>` + `<LineMaterial linewidth={lineWidthPx} vertexColors resolution={size}/>`。
   - 若当前 Line2 API 无法稳定表达断开的多段折线，则改用 `LineSegments2/LineSegmentsGeometry` 的成对 segment 顶点编码，但仍保持单 draw call 与同一份 `edgeSamplePaths`。
   - `LineMaterial.resolution` 必须设为画布像素尺寸，否则线宽异常；用 `useThree(state => state.size)` 注入。
4. 颜色：把 `buildEdgeGeometry` 返回的颜色数据转成 `THREE.Color[]`（每顶点一色，或每段一色按 Line2 API）。
5. `y = yEdge(0)`（positions 已在 geometry 内置高度，EdgesLayer 不再抬升）。
6. MapView：当 `mapData.edges.length > 0` 时挂载 `<EdgesLayer geometry={edgeGeometry} />`；空地图不挂边层。

## 约束
- 全图仅一个 Line2 实例；禁止 per-edge `<Line>`。
- `buildEdgeGeometry` 只能在 MapView 顶层调用一次；EdgesLayer、ArrowsLayer、LabelsLayer 不得各自重复构建。
- 遵守 PLAN §3。

## 验证步骤
1. `pnpm dev`：使用 TASK_007 已接入的真实 `public/maps/sample.json`，不得新增临时样例 import。
2. 观感检查：
   - 直线边与贝塞尔曲线边均可见，曲线平滑。
   - 正向（`#00e5a8` 青绿）与反向（`#ff6b6b` 暖红）双色清晰。
   - 成对双向边呈双车道平行偏移、不重叠；孤儿边在中心线。
   - 滚轮缩放时线宽视觉恒定（屏幕像素）。
   - 开 `isFlipY`：整图沿水平轴翻转。
3. `pnpm build`、`pnpm lint` 通过。

## 完成定义 (DoD)
- 单粗线对象渲染全部边，双色 + 双车道偏移 + 恒定像素线宽，draw call 为 1（可用 `gl.info.render.calls` 抽查）；MapView 中 `edgeGeometry` 只构建一次。

## 风险/备注
- NaN 分隔若不被所选 API 支持，改用"每段独立 positions + 单 material"的 Line2 多段写法，但仍保持单 draw call 思路（Line2 支持单 geometry 内多段断开）。
- `LineMaterial` 属 `three/examples/jsm`，随 `three` 包提供，无需额外依赖；类型可能需 `@types` 兜底（three 自带类型通常覆盖）。
