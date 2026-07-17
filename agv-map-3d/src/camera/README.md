# camera — 相机 fit、裁剪面与浏览控制层

## 职责
- 消费 TASK-012 在 SceneModel 中汇总的唯一 `contentBounds`（已合并双车道 ribbon、两类箭头与
  节点圆柱真实几何范围，排除标签与 Ground），不再重算几何范围。
- 实现有限地面范围推导（SPEC 12.1）：`computeGroundBounds`。
- 实现标准 3/4 fit（SPEC 12.2）：`computeCameraFit` —— 固定 50° FOV / 60° polar / 45° azimuth，
  先定方向再按受限 FOV 与扩张包围盒八角最大距离求距离。
- 实现动态 near/far 推导（SPEC 12.3）：`computeClipPlanes` —— 从相机空间深度与拟合半径推导，
  不使用任意大常量。
- 实现只读轨道浏览契约（SPEC 12.4，TASK-019）：`orbitControlsContract`（距离 / polar / 阻尼 /
  速度固定参数 + `maxDistance = 8 × R`）、`targetClamp`（target 限制到地面、offset 保持）、
  `navigationState`（`hasUserNavigated` 与 resize / Home 分支纯决策）。OrbitControls 生命周期、
  事件接线与按需渲染 invalidate 归 app-root 的 `MapCameraController`，不在本层依赖 React / R3F。
- 实现统一键盘导航意图（SPEC 12.5，TASK-020）：`keyboardIntent`（键位 → 结构化意图、相机平面
  平移步长、焦点边界消费决策）与 `reducedMotion`（prefers-reduced-motion → enableDamping 纯决策）。
  事件接线、焦点边界判定与 Three 写入归 app-root 的 `MapCameraController`，不在本层依赖 React / R3F
  或浏览器 API。

## 依赖方向（SPEC 3.3）
- 允许依赖：`domain`、`config`、本层自身。
- 允许的外部包：Node 内置、`three`（OrbitControls、Matrix4 等）。
- 禁止依赖 React、R3F 装配、渲染层业务或原始 JSON。
- 本层交付的纯函数不直接依赖 `three` 运行时：裁剪深度用与 Three `Matrix4.lookAt` 同约定的手写基，
  轨道契约通过 `OrbitControlsLike` 接口与真实 OrbitControls 解耦，可在纯对象上单测。

## 关键不变量
- 内容范围所有权归 TASK-012；本层只读 `contentBounds` 的六个数值分量，不回读几何或节点坐标，
  不维护供相机使用的第二套 bounds。
- 地面每侧 padding 固定为 `max(5m, max(contentWidth, contentDepth) × 10%)`；地面参与裁剪推导
  但不参与 fit。
- fit 以 controls target 为球心计算半径 R（Y 固定为 0）；先定 3/4 方向再算距离，禁止先俯视 fit
  再旋转。
- near/far 全部由 camera-space bounds 与当前拟合半径推导，禁止任意大常量、无限地面或无限 far plane。
- 无效输入（非有限范围、min > max、零尺寸画布、相机与目标重合）返回 `null`，调用方保持未提交，
  禁止产生 NaN/Infinity；非正深度属合法分支，near 回落 0.02m。
- 轨道固定参数唯一来自 `orbitControlsContract`：`minDistance=0.50m`、`maxDistance=8×R`、
  polar `15°~85°`、`dampingFactor=0.08`、`rotateSpeed=0.6`、`panSpeed=1.0`、`zoomSpeed=0.8`，
  rotate / pan / zoom 全启用；禁止在控制器或事件回调中复制第二套参数。
- target clamp 把观察目标 X/Z 限制在地面、Y 固定为 0，修正向量同时加到 camera.position 保持
  camera-target offset 不变；polar ∈ [15°, 85°] + target.y = 0 保证相机始终位于地面上方。
- 用户是否浏览由显式 `hasUserNavigated` 唯一标记决定 resize 行为；Home 复位并清零该标志。
  resize 分支：未导航重新 fit，已导航保留 target / 距离 / 朝向、仅更新 aspect / 裁剪面。
- 键盘层只表达意图并调用已有相机用例（commitCameraState / controls.update / applyStandardFit）；
  不复制 target clamp、fit、near/far 或矩阵计算。键位、5% 平移步长、0.9/1.1 缩放比例、5° 旋转
  均由 `keyboardIntent` 纯函数唯一决定。平移方向来自当前相机平面，不写死世界轴。
- 焦点边界：仅当可聚焦地图容器拥有焦点、键位被本系统消费时才 preventDefault；未聚焦 / 可编辑
  控件来源 / 未知键一律放行，不劫持页面全局键盘输入。
- reduced-motion：prefers-reduced-motion: reduce 时关闭 damping（`enableDamping = false`），
  dampingFactor 保持 0.08 不变；只改变离散输入的阻尼过程，不改允许的操作、最终相机位置或视觉内容。
