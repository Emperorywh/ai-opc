# AI 软件工程工作流（web-3d 项目宪法）

> 把 agent 当成**有持久记忆、能自主执行 + 自测 + 修复循环**的工程师，而不是一条需要手动切 prompt 的流水线。
> 本文件是 web-3d 项目的工作流**宪法** + **通用工作流术语 ↔ 本项目现状的映射**。Claude Code 每次启动自动加载。
> 本文件与 `docs/` 下的 SPEC / ROADMAP / PROGRESS / CONTEXT_BOOTSTRAP **配合使用**，不替代它们。

---

## 0. 项目身份

**动漫风格 3D 世界地图**（浏览器 SPA，固定倾斜的「沙盘」观感，面向教育可视化）。
技术栈：React 19 · @react-three/fiber 9 · three.js 0.184 · TypeScript 6 · Vite 8（pnpm）。
规模：12 Milestone / 31 Task，跨多会话连续开发。
**当前指针**：M1 · 地形沙盘地基 · Task 01（项目骨架），0/31，从零实施。最新状态见 `docs/PROGRESS.md`。

---

## 1. ⚠️ 文件映射表（最重要 —— 通用术语 ↔ 本项目）

本项目的 `docs/` 用的是**带日期版本号的定制命名**（比通用工作流更细）。**凡是 `phases/` 或本文件中出现的通用路径名，一律按下表换算**，以本项目实际文件为准：

| 通用工作流概念 | 本项目实际文件 | 状态 |
|---|---|---|
| `docs/spec.md` | `docs/SPEC_2026-06-16.md`（v1.1，547 行，含决策日志 D1–D20） | ✅ 已定稿，勿擅自改 |
| `docs/roadmap.md` + `docs/milestones/` | `docs/ROADMAP_2026-06-16.md`（单文件，12 MS 详细设计 + 31 Task + R1–R5） | ✅ 已定稿，勿擅自改 |
| `docs/tasks/backlog.md` + 单 Task 文件 | `docs/ROADMAP_2026-06-16.md §三` Task 清单 + `docs/PROGRESS.md` 状态表 | ✅ 勿擅自改 |
| —（通用版无对应） | `docs/PROGRESS.md`：进度单一可信源，每 Task 更新 | ✅ 在用 |
| —（通用版无对应） | `docs/CONTEXT_BOOTSTRAP.md`：新会话上下文恢复 prompt | ✅ 在用 |
| `docs/decisions/` ADR | `docs/decisions/`（已建索引，登记 D1–D20 / R1–R5） | 🆕 |
| `docs/changelog.md` | `docs/changelog.md`（占位，M5 MVP 起填） | 🆕 |
| `templates/` | 本项目**不使用**（不拆 milestones/tasks，无需模板） | — |

> 遇到 `phases/` 里写「产出 `docs/spec.md`」「读 `docs/tasks/M01-T01-*.md`」等指令 → 按上表换算为本项目对应文件，不要新建带通用名的重复文件。

---

## 2. 五个阶段 + 一条回路

```
[1 理解] → [2 规划] → [3 执行] → [4 验证] → [5 集成]
understand    plan      build      verify     ship
        └── 发现 P0 / 验收 FAIL → 回「执行」修复（不重走全流程）──┘
```

每个阶段在本项目的落点：

| 阶段 | 通用产物 | 本项目落点 | 阶段 prompt |
|---|---|---|---|
| 1 理解 | spec | 维护 `SPEC_2026-06-16.md`（**已定稿**，一般只追加修订记录） | `phases/1_understand.md` |
| 2 规划 | roadmap / milestones / tasks | 维护 `ROADMAP_2026-06-16.md`（已定稿）+ `PROGRESS.md` | `phases/2_plan.md` |
| 3 执行 | 代码 + 测试 | `PROGRESS.md` 定位当前 Task → 按 ROADMAP 该 MS「开发边界」实施 | `phases/3_build.md` |
| 4 验证 | 验证记录 | 按 ROADMAP 该 Task「验收标准」逐条核对，写回 `PROGRESS.md` | `phases/4_verify.md` |
| 5 集成 | PR / changelog | 更新 `changelog.md` + `git tag`（MVP 闭环时） | `phases/5_ship.md` |

**回路规则（关键）**：
- 验证发现 P0 / 回归 / 验收未达成 → 回阶段 3 修复，**不重走全流程**。P0 不留给用户。
- 集成验收 FAIL：实现问题回阶段 3；需求理解错回阶段 1（改 SPEC 前先问我）。
- 任何阶段发现**需求本身有问题** → 回阶段 1，更新 SPEC。

> 注：本项目主流程已由 ROADMAP（规划）+ PROGRESS（执行/验证驱动）+ CONTEXT_BOOTSTRAP（会话恢复）落地。`phases/` 是方法论参考；具体「做什么 Task、开发边界、验收标准」以 ROADMAP + PROGRESS 为准。

---

## 3. 核心原则（6 条）

1. **落盘优先**：产物写文件，文件是 agent 的记忆。对话会压缩/清空，`docs/` 不会。
2. **单一职责**：每个阶段/Task 只做一件事。执行阶段不重新设计架构（架构问题记到 `docs/decisions/` 再回规划）；验证阶段不写新功能。
3. **风险分级决定自主性**：
   - 🟢 低（新文件、纯函数、有测试覆盖的改动、UI、文档）→ **自主完成 + 自测**，不打断我。
   - 🟡 中（改非公共模块、加依赖、改配置）→ 自主做，**完成后明确汇报**改了什么、为什么。
   - 🔴 高（改架构、改公共接口 / 投影契约 `project()`、改数据格式、删数据、破坏性变更）→ **先出方案、等我确认**再动手。判定不清按**高一级**处理。
   - **每个 Task 的具体允许/禁止目录，以 ROADMAP 该 Milestone「Claude Code 开发边界」表为准**（比上面的通用分级更细、更具体）。
4. **测试内建**：写功能的同时写测试。一个改动「完成」= 测试通过。不存在「先写完以后补测试」。改老代码前先给它补 characterization test，再改。
5. **自测循环（agent 最强的能力，必须用）**：写完 → 自己跑 `pnpm build` / `pnpm lint` / 测试 → 失败就修 → 循环到全绿。**实际执行并让测试通过**，不要只甩一句「测试建议」。
6. **不随意改已验收模块 / 已定稿文档**：改 `SPEC/ROADMAP/PROGRESS` 或共享契约（`projection.ts` / `assets.ts` / `store.ts` / 二进制数据格式）前先读、保持向后兼容；要改必须在方案里说明理由 + 更新对应测试。是「留痕」，不是「禁止」。

---

## 4. 新会话如何启动

1. **粘贴** `docs/CONTEXT_BOOTSTRAP.md`「👇 复制这段」框内的全文，作为新会话第一条消息。
2. agent 会读 `docs/PROGRESS.md` 定位当前 Task → 给简报（进度 / 本次做什么 / 边界 / 验收 / 依赖）。
3. 你确认（或说「直接做 / 继续」）→ agent 执行 → 自测 → 更新 PROGRESS → 报告下一个 Task。

> 进度始终落在 `docs/PROGRESS.md`，任意时刻可中断，下次无缝续上。

---

## 5. 版本控制约定

- **分支**：每个 Milestone 一个分支 `feat/M?-<slug>`（如 `feat/M1-terrain-sandbox`）；Task 在该分支上小步提交。
- **commit**：每个 Task 一次 commit，**简体中文**，格式对齐 ROADMAP §0.1 R5 与 CONTEXT_BOOTSTRAP：
  - `feat(M?): Task NN - 简述` · `fix(M?): Task NN - 简述` · `test: 补充 …` · `refactor: 重构 …` · `docs: 更新 …`
- **PR / tag**：Milestone 完成后开 PR，描述对照 ROADMAP 验收标准逐条核对；MVP 闭环打 `git tag v0.1-mvp`。
- ⚠️ **未经我授权，不要 push、不要开 PR、不要打 tag、不要删除文件。**

---

## 6. 全局禁区

- ❌ 不假设需求 —— 不清楚就问（见阶段 1）。
- ❌ 不在 build 阶段重新设计架构 —— 架构问题记到 `docs/decisions/`，回到规划。
- ❌ 不写「后续考虑 / 可以扩展 / 视情况而定」—— SPEC 已定稿无此表述，新增内容同样要明确。
- ❌ 不跳过测试 —— 没有通过的测试，build 就没完成。
- ❌ 不越 Task 开发 —— 单 Task 单会话，不提前实现后续、不跨 Task（见 CONTEXT_BOOTSTRAP「执行铁律」）。
- ❌ 不擅自改已定稿的 SPEC / ROADMAP / PROGRESS —— 要改先问我。
- ⚠️ **争议边界合规**（SPEC §10 / D10）：克什米尔、克里米亚、西撒哈拉、巴勒斯坦等按 Natural Earth 默认 + 虚线表达；**台湾毫无争议是中国的一部分**。涉政与地名翻译类内容必须**人工 Review**，不自行定夺。
- ⚠️ **数据署名 / 许可合规**（SPEC §7 / D3）：Natural Earth（公共域）、Copernicus / REMA（需署名）的署名与许可弹窗必须正确，人工 Review。

---

> 本文件是 web-3d 的工作流宪法。项目演进时优先更新 `docs/PROGRESS.md`（进度）与 `docs/ROADMAP_2026-06-16.md`（规划）；本宪法保持稳定，仅在**流程约定本身**发生变化时更新。
