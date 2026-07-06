---
id: TASK_007
title: 数据接入与场景骨架 MapView
status: draft
phase: 3
depends_on: [TASK_002, TASK_003]
files:
  - src/scene/MapView.tsx
  - src/App.tsx
---

# TASK_007 · 数据接入与场景骨架 MapView

## 目标
建立正式数据流与 R3F 场景容器：App 层 fetch `public/maps/sample.json` → `loadMapData` → 下传 `MapData`；MapView 渲染 `<Canvas>` + 正交/透视相机（按 Context `cameraMode` 切换 `makeDefault`）+ `<OrbitControls>`（平移/缩放/旋转）+ 深色背景 + **手动包围盒 fit**（不用 `<Bounds>`，见 PLAN §2.B）+ WebGL2 不可用降级文案。

## 前置依赖
TASK_002（loader/类型）、TASK_003（palette/常量 + 坐标映射 + MapConfig）。

## 涉及文件
- `src/scene/MapView.tsx`（新建）
- `src/App.tsx`（改：挂 `<MapConfigProvider><MapView/></MapConfigProvider>`）

## 实现要点
1. **App 数据接入（正式实现，不写临时 import）**：
   - `App.tsx` 在 `useEffect` 中 `fetch("/maps/sample.json")` → `json` → `loadMapData(json)` → `setState({ status: "ready", data })`。
   - 捕获网络/解析异常 → `status: "error"`，控制台 `console.error`，页面显示简短错误提示。
   - `loading` 显示加载提示；空地图（nodes/edges 皆空）仍挂 MapView，但显示空地图提示。
   - `<MapConfigProvider>` 包裹 `<MapView mapData={data}/>`，保证相机和后续 layer 都通过正式 props 消费数据。
2. **降级检测**：`MapView` 顶层用 `try { const gl = document.createElement('canvas').getContext('webgl2'); if (!gl) throw … }` 判定 WebGL2；不可用时渲染降级提示文案（SPEC §9），不挂 Canvas。
3. `<Canvas>`：
   - `gl={{ antialias: true }}`；背景用 `<color attach="background" args={[palette.background]} />`。
   - 内部根据 `cameraMode` 渲染 `<OrthographicCamera makeDefault …/>` 或 `<PerspectiveCamera makeDefault …/>`（drei）。
   - `<OrbitControls makeDefault enablePan enableZoom enableRotate />`，采用**默认键位**（左键旋转、右键平移、滚轮缩放，SPEC §10）。
4. **手动 fit**（核心）：
   - props 接收 `mapData: MapData | null`，从 `mapData.bbox` 取包围盒。
   - 使用 `mapBoxToSceneBox(bbox, { isFlipY, unitScale })` 得到场景 x/z 范围，禁止手写翻转公式。
   - 计算 center `(cx, cz)`、世界尺寸 `w = maxX-minX`、`h = maxZ-minZ`。
   - **正交**：frustum 固定为 drei 默认（`left/right/top/bottom = ±size/2`，随画布 `size` 更新），**仅调 `zoom`**：`zoom = min(size.width / w, size.height / h) * 0.9`（留 10% 边）；`position=[cx, 100, cz]`、`lookAt(cx,0,cz)`（纯俯视）。⚠️ 不要同时改 frustum 与 zoom，否则可视世界范围不可预测。
   - **透视**：根据 FOV 与 w/h 反推相机高度距离 `distance = max(w,h)/2 / tan(fov/2) * 1.1`；`position=[cx, distance, cz]`、`lookAt(cx,0,cz)`（略带俯角或纯俯视）。
   - 用 `useEffect` 在 bbox/`isFlipY`/cameraMode/viewport `size` 变化时更新相机并 `camera.updateProjectionMatrix()`。
5. **占位**：本 task 不挂任何 layer（Edges/Nodes/Arrows/Labels 在后续 task 挂载）。可放一个调试用 `<axesHelper/>` 或留空，但提交前默认不显示调试辅助。
6. App.tsx：包 Provider + MapView；移除 TASK_001 里临时硬编码背景（改由 palette 注入）。

## 约束
- 不引入 `<Bounds>`（PLAN §2.B）。
- 相机模式切换要平滑（切换时重新 fit）。
- 数据获取仅在 App 顶层；MapView 不 fetch、不 import 样例 JSON。
- 遵守 PLAN §3。

## 验证步骤
1. `pnpm dev`：全屏深色 Canvas，无报错。
2. 加载真实 `public/maps/sample.json` 后，MapView 使用 `mapData.bbox` 自动居中、铺满约 90%；切到透视模式仍居中。
3. OrbitControls 默认键位正常：左键旋转、右键平移、滚轮缩放（§10）。
4. 模拟 WebGL2 不可用（临时令检测函数返回 false）→ 显示降级文案。
5. 模拟 fetch / JSON 解析失败 → 显示错误提示；空地图 → 显示空地图提示但不崩溃。
6. `pnpm build`、`pnpm lint` 通过。

## 完成定义 (DoD)
- App 正式数据接入 + Canvas + 双相机切换 + OrbitControls + 手动 fit + 降级文案全部就绪，为后续 layer 提供稳定数据与挂载点。
- 临时调试代码（假 bbox、检测桩、axesHelper）在提交前清理或改为显式可配置 props。

## 风险/备注
- 正交相机 `zoom` 与视口尺寸耦合；窗口 resize 时需重算（监听 `resize` 或用 R3F `useThree(size)`）。务必在 resize 后维持 fit。
- 透视/正交切换时 OrbitControls target 要重置到 center，避免旋转中心漂移。
