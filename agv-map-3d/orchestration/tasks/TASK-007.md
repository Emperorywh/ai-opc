---
id: TASK-007
title: 生成可合并的 ribbon 几何数据
---

## 任务描述

### 可验证结果

所有最终车道中心线被稳定三角化为一份可直接交给渲染适配层的非索引 ribbon position/color 数据和数值 bounds。直线、曲线、连接处和端点均具有确定的正面绕序，不产生裂缝、越界帽或非有限数。

### 输入

- SPEC 第 7.1、7.2、9.3、9.4、15.2、15.3 和 16 章。
- TASK-006 交付的偏移后中心线、累计弧长、车道分组和边颜色语义。
- TASK-001 交付的几何层、worker 与渲染层依赖边界。

### 输出

- 对偏移中心线先清理连续距离小于 `1e-9m` 重复点，再按每段独立 quad 生成的单一非索引三角形数据。
- 固定半宽 `0.025m`，每段 6 个顶点；从 `+Y` 观察的两个 quad 三角形均为逆时针。
- 内部点使用 bevel join，在外侧补一个方向正确的三角形；内侧同色重叠允许但不得出现裂缝。
- 首尾使用 butt cap，不延长中心线，不增加圆帽或方帽。
- position 与颜色分别形成 Float32 typed array；颜色使用标准 sRGB transfer function 转成线性 `[0,1]` 浮点值。
- 全部业务边的 ribbon 数据合并为一份连续结果，并提供确定的顶点诊断和有限数值 bounds；后续只能创建一个 ribbon Mesh。
- 所有输出有限；少于两个有效点、非有限位置/颜色/bounds 或错误绕序均使构建整体失败。

### 实现约束

- 几何生成必须是纯数值逻辑，不创建 Three BufferGeometry、BufferAttribute、Material、Mesh 或 React 对象。
- 禁止索引几何、固定假设 Uint16 容量、使用不存在的属性类型或为每条边创建单独结果对象供 JSX 遍历。
- quad 顶点顺序固定遵守 SPEC；bevel 外侧点顺序必须根据转向符号调整，不能依赖双面材质掩盖错误绕序。
- ribbon 颜色仅由边的 `isBackEdge` 选择，不改变中心线、车道或顶点顺序。
- 真实样本顶点规模应符合 SPEC 约 48,669 个非索引顶点的预算；确定结果必须由诊断记录和回归保护，不能为压低数量改变几何语义。
- 数值计算保持 JavaScript number，只有最终输出写入 Float32；任何 NaN/Infinity 都必须在跨层前失败。
- 新增或修改的代码必须使用多行简体中文注释说明 winding、bevel、butt cap、合并策略和有限数不变量；不得主动格式化无关代码。
- 自动化验证不得启动浏览器；视觉上的裂缝和闪烁仅记录为后续人工验收，不是本 TASK 的自动完成条件。

### 验证方式

在 `C:\code\ai-opc\agv-map-3d` 中执行：

```powershell
npm run lint
npm test -- --run
npm run build
git -C .. diff --check -- agv-map-3d
```

正常路径：

- 真实样本只生成一份合并 position/color 数据，数组长度分别与顶点诊断满足 `vertexCount × 3`。
- 每个 quad 两个三角形和每个 bevel 补片的叉积法线均指向 `+Y`。
- butt cap 顶点不越过原中心线首尾；成对车道仍保持 `0.06m` 中心间距和 `0.01m` 可见边缘间隔。
- 输出 position、color 和 bounds 全部有限，颜色处于线性 `[0,1]` 范围。

关键异常路径：

- 输入全部清理后少于两个点时，预期 `MAP_GEOMETRY_INVALID`，不得生成空或部分 ribbon。
- 注入非有限坐标、退化段、非有限颜色或 bounds 时，预期构建立即失败。
- 单元几何覆盖左右转弯，证明 bevel 补片会交换外侧点以保持 `+Y` 绕序；失败不能靠双面渲染绕过。

明确预期结果：渲染层无需理解业务边、车道和三角化规则，只需消费一份已验证的数组及 bounds。

### 完成标准

- 合并 ribbon 数值几何、颜色、bounds 和诊断已经交付。
- quad、join、cap、绕序、有限数和真实样本规模验证全部通过。
- TASK-001 至 TASK-006 的行为未被破坏。
- 不存在每边 Mesh/组件模型、索引容量假设、双面材质补救、重复三角化或跨层 Three 对象。
- 代码库处于可由后续渲染适配层直接消费的一致状态，可创建独立 Git checkpoint。
- 代码库可以安全进入 TASK-008。

### 回退边界

回退本 TASK 的 Git checkpoint 时，只移除 ribbon 三角化数组、颜色和 bounds 结果；TASK-006 的方向采样、轨迹分组和双车道中心线仍完整可验证，不影响更早领域能力。
