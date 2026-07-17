# camera — 相机 fit、裁剪面与浏览控制层

## 职责
- 消费 TASK-012 在 SceneModel 中汇总的唯一 `contentBounds`（已合并双车道 ribbon、两类箭头与
  节点圆柱真实几何范围，排除标签与 Ground），不再重算几何范围。
- 实现有限地面范围推导（SPEC 12.1）：`computeGroundBounds`。
- 实现标准 3/4 fit（SPEC 12.2）：`computeCameraFit` —— 固定 50° FOV / 60° polar / 45° azimuth，
  先定方向再按受限 FOV 与扩张包围盒八角最大距离求距离。
- 实现动态 near/far 推导（SPEC 12.3）：`computeClipPlanes` —— 从相机空间深度与拟合半径推导，
  不使用任意大常量。
- 后续落地：OrbitControls 配置、target clamp 与键盘导航（SPEC 12.4 / 12.5）。

## 依赖方向（SPEC 3.3）
- 允许依赖：`domain`、`config`、本层自身。
- 允许的外部包：Node 内置、`three`（OrbitControls、Matrix4 等）。
- 禁止依赖 React、R3F 装配、渲染层业务或原始 JSON。
- 本任务交付的纯函数暂不依赖 `three`（裁剪深度用与 Three `Matrix4.lookAt` 同约定的手写基），
  后续控制器模块引入 OrbitControls 时再按需 import `three`。

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
- 用户是否浏览由显式 `hasUserNavigated` 决定 resize 行为；Home 键复位并清零该标志（后续控制器）。
