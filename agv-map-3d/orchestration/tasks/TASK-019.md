---
id: TASK-019
title: 交付受约束且不打断视图的相机浏览
---

## 任务描述

### 可验证结果

用户可以围绕地图进行 orbit、pan 和 zoom；相机与观察目标始终受地面及距离范围约束，resize 不会在用户已导航后重置视图，Home 能确定性恢复标准 3/4 全图。

### 输入

- SPEC §1.2～§1.3、§4.2、§12.2～§12.4、§13、§15.2。
- TASK-017 已交付的标准 fit、拟合半径、地面范围和动态 near/far。
- TASK-018 已交付的静态场景与相机容器。

### 输出

- 符合固定距离、polar 角、阻尼和 rotate/pan/zoom 速度契约的只读轨道浏览能力。
- 观察目标的 X/Z 被限制在有限地面内、Y 固定为 0；限制产生的位移同步作用于相机位置，保持 camera-target offset 不变。
- 显式的用户导航状态：首次 ready 且画布非零时 fit；用户未导航时 resize 重新 fit；用户已导航时 resize 保留 target、距离和方向，仅更新投影、裁剪与标签查询所需状态。
- Home 恢复 SPEC 标准 3/4 fit 并清除用户导航标记；相机始终保持在地面上方。
- 对交互状态转换、边界限制、resize 分支和 Home 复位的非浏览器自动化测试及人工交互验收。

### 实现约束

- 相机浏览状态必须有单一所有者；不得在 controls、React 组件和键盘模块中分别维护第二套 target、距离或导航标记。
- 所有 clamp、fit 和 near/far 更新必须复用 TASK-017 的纯计算能力，不得在事件回调中复制公式或引入样本专用常量。
- controls change/end 和有效 resize 必须在更新同一相机状态后显式请求 demand 帧；不得用常驻帧循环弥补事件遗漏。
- 固定参数为 `minDistance=0.50m`、`maxDistance=8×R`、polar `15°～85°`、`dampingFactor=0.08`、`zoomSpeed=0.8`、`rotateSpeed=0.6`、`panSpeed=1.0`。
- 相机交互属于只读浏览，不得顺带加入对象选择、点击、hover、编辑或 raycaster 业务逻辑。
- controls 事件注册与解除必须成对且可重复；完整的 StrictMode、HMR 和 WebGL 恢复闭环在 TASK-023 验收，本任务不得用全局单例规避生命周期。
- 新增或修改的代码必须使用多行简体中文注释说明单一相机状态、target clamp、resize 分支与 Home 复位不变量；不得主动格式化无关代码。

### 验证方式

1. 执行 `node --version`，预期为 `v24.16.0`；执行 `npm ci`，预期成功。
2. 执行 `npm run lint`、`npm test -- --run` 和 `npm run build`；命令不得启动浏览器，预期全部通过。
3. 正常路径：通过纯状态与相机数学测试模拟 orbit、pan、zoom、首次 resize、用户导航后 resize 和 Home；预期参数受限、offset 保持、用户视图分支稳定，Home 与 TASK-017 的标准结果完全一致。
4. 关键异常路径：模拟越过地面边界、低于最小距离、高于最大距离、越过 polar 范围、零尺寸 resize 和重复 change/end 事件；预期状态被确定性限制或不提交，且不产生重复监听、NaN 或第二份相机状态。
5. 人工交互验收仅由用户执行，Coding Agent 不启动浏览器：用户在本地生产预览中连续 orbit/pan/zoom，越界拖动、导航后 resize、未导航 resize 和按 Home；预期限制平滑、内容可恢复、已导航视图不被 resize 打断、相机不进入地面下方。

### 完成标准

- 轨道浏览、边界限制、resize 分支和 Home 复位形成单一状态闭环。
- 自动化验证通过，人工相机交互验收由用户记录通过。
- TASK-001～TASK-018 的行为、静态视觉基线和自动化测试没有回归。
- 不存在重复相机状态、重复事件公式、对象交互、全局可变 controls 或临时 resize patch。
- 可以创建仅包含 TASK-019 相机浏览结果的 Git checkpoint，代码库可安全进入 TASK-020。

### 回退边界

回退 TASK-019 checkpoint 只移除 orbit/pan/zoom、浏览状态、resize 分支与 Home 复位；TASK-018 的标准静态初始场景仍可显示，TASK-017 的相机数学能力保持完整。父级 Git 的 checkpoint 与回退范围仅限 `agv-map-3d` 子目录，不得影响其他目录。
