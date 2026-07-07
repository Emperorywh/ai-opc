---
id: TASK_008
status: ready
branch: task/008-edges-layer
spec: docs/SPEC_agv-map-phase1.md
plan: docs/PLAN_agv-map-phase1.md
commit: "feat(TASK_008): 实现单一粗线 EdgesLayer"
depends_on:
  - TASK_006
  - TASK_007
agent_allowed_paths:
  - src/scene/EdgesLayer.tsx
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

# TASK_008 · 边几何共享与 EdgesLayer

## 目标
在 MapView 顶层用 `useMemo` 对当前 `edges + isFlipY` 构建唯一一份 `edgeGeometry`，并用**单个** `LineSegments2`（three `LineSegmentsGeometry` + `LineMaterial`）渲染 TASK_006 产出的合并折线 buffer：直线 + 贝塞尔合并、屏幕空间像素线宽（`lineWidthPx`）、按 `isBackEdge` 的 `vertexColors` 双色。全图边 **1 次 draw call**（§4.6）。

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
3. 渲染单一粗线对象（`LineSegments2`，SPEC §4.1/§4.6）：
   - 构造 `LineSegmentsGeometry`：`geometry.setPositions(positions)` + `geometry.setColors(colors)`（`positions`/`colors` 来自 MapView 的 `edgeGeometry`，已是成对 segment 顶点）。
   - `<lineSegments2>` + `<primitive object={lineSegmentsGeometry} attach="geometry"/>` + `<LineMaterial linewidth={lineWidthPx} vertexColors resolution={[w,h]} transparent/>`；`LineMaterial` 属 `three/examples/jsm/lines/LineMaterial`，随 `three` 包提供。
   - `LineMaterial.resolution` 必须设为画布像素尺寸，否则线宽异常；用 `useThree(state => state.size)` 注入，`size` 变化时更新。
   - 不使用 drei `<Line>` / `Line2`（连续折线，多段合并有段间连线问题）；不使用 NaN 分隔。
4. 颜色：`edgeGeometry.colors` 已是每顶点 rgb 数组，直接喂 `setColors`；`LineMaterial.vertexColors=true`。
5. `y = yEdge(0)`（positions 已在 geometry 内置高度，EdgesLayer 不再抬升）。
6. MapView：当 `mapData.edges.length > 0` 时挂载 `<EdgesLayer geometry={edgeGeometry} />`；空地图不挂边层。

## 约束
- 全图仅一个 `LineSegments2` 实例；禁止 per-edge `<Line>` / `<line2>`。
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
- `LineSegments2` 按成对顶点表达多段，单 draw call，无段间连线风险；与 TASK_006 输出格式直接对应，无需 fallback。
- `LineMaterial` 属 `three/examples/jsm`，随 `three` 包提供，无需额外依赖；three 自带类型通常覆盖，若个别类型缺失用 `// @ts-expect-error` 兜底。
