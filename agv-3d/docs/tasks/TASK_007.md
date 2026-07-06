---
id: TASK_007
title: 场景骨架 MapView
status: draft
phase: 3
depends_on: [TASK_003]
files:
  - src/scene/MapView.tsx
  - src/App.tsx
---

# TASK_007 · 场景骨架 MapView

## 目标
建立 R3F 场景容器：`<Canvas>` + 正交/透视相机（按 Context `cameraMode` 切换 `makeDefault`）+ `<OrbitControls>`（平移/缩放/旋转）+ 深色背景 + **手动包围盒 fit**（不用 `<Bounds>`，见 PLAN §2.B）+ WebGL2 不可用降级文案。

## 前置依赖
TASK_003（palette/常量 + MapConfig）。

## 涉及文件
- `src/scene/MapView.tsx`（新建）
- `src/App.tsx`（改：挂 `<MapConfigProvider><MapView/></MapConfigProvider>`）

## 实现要点
1. **降级检测**：`MapView` 顶层用 `try { const gl = document.createElement('canvas').getContext('webgl2'); if (!gl) throw … }` 判定 WebGL2；不可用时渲染降级提示文案（SPEC §9），不挂 Canvas。
2. `<Canvas>`：
   - `gl={{ antialias: true }}`；背景用 `<color attach="background" args={[palette.background]} />`。
   - 内部根据 `cameraMode` 渲染 `<OrthographicCamera makeDefault …/>` 或 `<PerspectiveCamera makeDefault …/>`（drei）。
   - `<OrbitControls makeDefault enablePan enableZoom enableRotate />`（左键旋转/右键平移按需调，SPEC §10：拖拽平移、滚轮缩放、右键旋转）。
3. **手动 fit**（核心）：
   - props 接收 `bbox: Box2XY | null`（来自 loader，TASK_013 注入；本 task 可先用常量假 bbox 调试，DoD 不依赖真实数据）。
   - 计算 center `(cx, cz)`、尺寸 `(w, h)`。
   - 正交：`camera.zoom = min(viewW/w, viewH/h) * 0.9`（留边），`position=[cx, 100, cz]`、`lookAt(cx,0,cz)`（纯俯视）。
   - 透视：根据 FOV 与 w/h 反推相机高度距离 `distance = max(w,h)/2 / tan(fov/2) * 1.1`，`position=[cx, distance, cz]`（略带俯角或纯俯视）。
   - 用 `useEffect` 在 bbox/cameraMode 变化时更新相机并 `camera.updateProjectionMatrix()`。
4. **占位**：本 task 不挂任何 layer（Edges/Nodes/Arrows/Labels 在后续 task 挂载）。可放一个调试用 `<axesHelper/>` 或留空。
5. App.tsx：包 Provider + MapView；移除 TASK_001 里临时硬编码背景（改由 palette 注入）。

## 约束
- 不引入 `<Bounds>`（PLAN §2.B）。
- 相机模式切换要平滑（切换时重新 fit）。
- 遵守 PLAN §3。

## 验证步骤
1. `pnpm dev`：全屏深色 Canvas，无报错。
2. 临时传入一个已知 bbox（如 `{minX:-10,maxX:10,minY:-10,maxY:10}`）：正交模式下该区域居中、铺满约 90%；切到透视模式仍居中。
3. OrbitControls：左键拖拽旋转/平移、滚轮缩放、右键平移均正常（按 §10 约定配置）。
4. 模拟 WebGL2 不可用（临时令检测函数返回 false）→ 显示降级文案。
5. `pnpm build`、`pnpm lint` 通过。

## 完成定义 (DoD)
- Canvas + 双相机切换 + OrbitControls + 手动 fit + 降级文案全部就绪，为后续 layer 提供挂载点。
- 临时调试代码（假 bbox、检测桩）在提交前清理或改为可配置 props。

## 风险/备注
- 正交相机 `zoom` 与视口尺寸耦合；窗口 resize 时需重算（监听 `resize` 或用 R3F `useThree(size)`）。务必在 resize 后维持 fit。
- 透视/正交切换时 OrbitControls target 要重置到 center，避免旋转中心漂移。
