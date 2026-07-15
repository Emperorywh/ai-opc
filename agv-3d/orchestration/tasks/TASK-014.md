---
id: TASK-014
title: 建立唯一色彩输出与后处理管线
---

## 任务描述

### 可验证结果

最终画面通过唯一、明确的 sRGB 色彩输出和 Bloom→SMAA 后处理链呈现；关键节点与流动高亮按亮度阈值产生可控辉光，基础路径与背景保持清晰，不叠加 MSAA 或第二套色彩转换/抗锯齿。

### 输入

- SPEC §3、§8.2、§8.3、§8.5、§11.1、§13.3、§14.2、§16.2 中的调色板、色彩空间、后处理、依赖和视觉验收要求。
- TASK-001 至 TASK-013 已交付的节点、路径、深色环境、真实反射和固定渲染预算。
- 已确认的全局依赖决策：使用 `@react-three/postprocessing` 3.0.4 的 EffectComposer、Bloom 和 SMAA，不保留 three examples、自研或其他后处理分支。

### 输出

- `SRGBColorSpace` 输出、`ACESFilmicToneMapping` 和曝光 1.0 的唯一色彩管线，着色器与后处理之间不重复执行 tone mapping 或色彩空间转换。
- Canvas 原生抗锯齿关闭、EffectComposer multisampling 为 0、顺序固定为 Bloom→SMAA 的唯一后处理链。
- Bloom 固定参数：`luminanceThreshold = 1.0`、`luminanceSmoothing = 0.2`、`intensity = 1.1`，启用 mipmap blur。
- 视觉亮度分层：普通节点低于阈值、工作节点接近阈值、充电/停车节点高于阈值、基础路径与背景低于阈值、流动高亮明确高于阈值。
- 固定并锁定的后处理依赖图，以及覆盖配置、链路顺序、单一抗锯齿、色彩职责和卸载释放的自动化验证。
- 节点辉光、流光辉光、基础拓扑清晰度、反射/网格/雾保真度和 SMAA 效果的人工视觉验收项。

### 实现约束

- 后处理只允许 SPEC 确认的 Bloom→SMAA 链，不得叠加 Canvas MSAA、Composer multisampling、FXAA、TAA 或替代实现。
- Bloom 只能由亮度阈值触发；不得按对象创建第二套材质、选择性渲染分支或运行时开关来规避亮度配置。
- 节点、路径、背景、材质、曝光和 Bloom 参数按视觉职责集中，组件与着色器内不得散落重复色值或阈值。
- 自定义路径材质必须与 Composer 的输出职责一致，避免 material、renderer 和 composer 重复 tone mapping/颜色空间转换。
- 后处理不得改变 TASK-013 的反射目标预算，也不得通过降低节点/路径数量或关闭效果获得清晰度。
- Composer 及其内部资源必须有明确卸载释放路径；依赖版本由锁文件固定完整依赖图。

### 验证方式

- 执行 `pnpm test`，预期色彩配置、着色器职责、后处理顺序、抗锯齿预算、资源释放及 TASK-001 至 TASK-013 回归测试全部通过。
- 执行 `pnpm lint` 与 `pnpm build`，预期 `@react-three/postprocessing` 依赖被正确锁定，无类型、lint 或生产构建错误。
- 正常路径：创建完整场景；预期 renderer 使用 sRGB/ACES/1.0，原生 antialias 关闭，Composer multisampling 为 0，Bloom 后接 SMAA 且参数与 SPEC 一致。
- 关键异常路径：检查基础背景、基础路径和普通节点的亮度阈值，以及高亮/充电/停车的阈值；预期前者不整体 Bloom，后者按目标触发，不出现重复色彩转换导致的过曝或变色。
- 生命周期路径：重复挂载和卸载后处理链；预期 Composer、pass 和内部目标被释放，不造成资源计数增长。
- 人工验收：由用户在本地浏览器观察辉光层级、轮廓抗锯齿、基础路径清晰度、反射/网格/雾保真度；Coding Agent 不得自动启动浏览器。

### 完成标准

- 唯一色彩管线、Bloom→SMAA、亮度分层和资源释放全部符合固定契约。
- `pnpm test`、`pnpm lint`、`pnpm build` 全部通过，TASK-001 至 TASK-013 的行为没有被破坏。
- 不存在重复抗锯齿、重复 tone mapping、对象选择性 Bloom、替代后处理、散落阈值或运行时降级。
- 与本任务相关的改动可形成单一独立 Git checkpoint，不混入场景创建事务或淡入流程修改。
- 代码库处于一致、可运行、可验证状态，可以安全进入 TASK-015。

### 回退边界

回退本 TASK 的 Git checkpoint 只移除或还原色彩输出、后处理依赖、Bloom/SMAA 链和对应验证；TASK-001 至 TASK-013 的完整未后处理场景、环境与反射能力保持可运行。
