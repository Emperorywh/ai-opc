# 新会话上下文恢复提示词（Context Bootstrap Prompt）

> **用途**：每次开启全新 Claude Code 会话时，把下面「👇 复制这段」框内的全部内容粘贴为**第一条消息**。它会让 agent 在 30 秒内恢复"项目要做什么 / 之前完成了什么 / 现在要做什么"。
>
> **配套**：本提示词依赖 `docs/PROGRESS.md`（进度）+ `docs/ROADMAP_2026-06-16.md`（规划）+ `docs/SPEC_2026-06-16.md`（规格）三份文件，缺一不可。

---

## 👇 复制这段（粘贴为新会话第一条消息）

```
你是「动漫风格 3D 世界地图」项目的实施 agent（React 19 · R3F 9 · Three.js · TypeScript）。本项目按 Vertical Slice 拆成 12 个 Milestone / 31 个 Task，跨多个会话连续开发。本指令让你在新上下文中快速恢复全部必要认知——严格按下面的步骤执行，不要跳步。

## 一、加载上下文（每次新会话必做，按序）
1. 读 `docs/PROGRESS.md` → 看「当前指针」与 Task 状态表，定位「本次任务 = 第一个非 ✅ 的 Task」。
2. 读 `docs/ROADMAP_2026-06-16.md` → 「§一 总体路线图」+「§三 Task 清单」中本 Task 那一行，以及该 Task 所属 Milestone 的「详细设计」（范围 / 不包含 / 边界 / 风险验证 / 验收标准 / DoD / 开发边界）。
3. 跑 `git log --oneline -15` → 校验 PROGRESS 中 ✅ 的 Task 都有对应 commit；若不一致，以 PROGRESS 为准，但先告诉我。
4. 读 `docs/SPEC_2026-06-16.md` 中本 Task 涉及的章节（ROADMAP 每个 Milestone/Task 注明了 SPEC 依据）。

## 二、汇报后再动手
动手前用以下格式简报（除非我说「直接做 / 继续」则可略过等待）：
  【进度】M? · Task NN · 状态
  【本次】Task NN 标题
  【做什么】（依据 ROADMAP Task NN）
  【边界】允许改：… ｜ 禁止改：…
  【验收】1) … 2) … 3) …
  【依赖】前置均已 ✅（或 ⚠️ 需先做 Task ??）
涉及「架构 / 数据格式 / 投影契约 project() / shader 接口 / 跨边界改动」时，必须等我确认再动手。

## 三、执行铁律
- 单 Task 单会话：一次只做一个 Task，不提前实现后续、不跨 Task。
- 严守边界：只改 ROADMAP 该 Task「Claude Code 开发边界」允许的目录；越界前必须问我。
- 验收驱动：以该 Task「验收标准」为完成判据，可编程断言优先（无 console error / 顶点数 / 单测 / pnpm build 通过）。
- 不破坏既有：改共享契约（projection.ts / assets.ts / store.ts / 二进制格式）前先读、保持向后兼容。
- commit：完成即提交，message 用简体中文，格式 `feat(M?): Task NN - 简述`。
- 不确定就问：宁可问，不要猜改架构。

## 四、收尾（每个 Task 必做）
1. 跑该 Task 验收 + `pnpm build`。
2. 更新 `docs/PROGRESS.md`：该行 → ✅ + commit 短 hash + 备注；「当前指针」→ 下一个 Task；「近期注意事项」追加踩坑/决策。
3. commit（含 PROGRESS 更新）。
4. 报告：做了什么 / 验收结果 / 下一个 Task 是什么。

## 关键约束
- 看不到的视觉效果（美学）做到可验证点即停，「好不好看」交我 Review。
- 与 SPEC 冲突时 SPEC 为准；要改 SPEC 必须先问我。
- MVP（M1–M5）全程不依赖 GDAL、不下载真实 DEM，用合成数据。

现在开始执行第一步（加载上下文），然后给我简报。
```

---

## 使用方式

1. **开新会话** → 粘贴上面框内全文作为第一条消息。
2. agent 会读 PROGRESS → 定位当前 Task → 给你简报。
3. 你确认（或说"直接做"）→ agent 执行 → 完成后更新 PROGRESS 并 commit → 报告下一个 Task。
4. 想中断/换方向，直接说即可；进度已落在 `docs/PROGRESS.md`，下次无缝续上。

> 提示词本身几乎不需要改动——它只指向三份文档。项目演进时更新 PROGRESS/ROADMAP/SPEC 即可，提示词保持稳定。
