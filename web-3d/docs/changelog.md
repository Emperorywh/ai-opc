# 变更日志（CHANGELOG）

> 每个 Milestone 完成发布后（即工作流的**阶段 5 集成 / Ship**），在此追加一段发布说明。
> 记录「本 Milestone 做了什么 / 破坏性变更 / 已知问题」，对应 `CLAUDE.md §2` 的阶段 5。

---

## 版本号约定

- `v0.1-mvp`：**M1–M5 完成 = Phase 1 MVP**（对应 `docs/ROADMAP_2026-06-16.md` M5 验收 + `docs/SPEC_2026-06-16.md §11` Phase 1）。
- 之后按 Phase 递增：`v0.2`（国家边界与交互，M6–M9）、`v0.3`（河流与增强，M10–M11）、`v0.4+`（可选演进，M12）。

## 发布记录

_（暂无。首个可发布版本为 M5 闭环的 Phase 1 MVP。各 Task 进度见 `docs/PROGRESS.md`。）_

---

## 每条发布说明模板

````md
## [vX.Y] - YYYY-MM-DD · <Milestone 名称>

### 新增
- …

### 破坏性变更
- （数据格式 / 公共接口 / 投影契约 `project()` 等变更；若影响后续 Milestone 必须列明）

### 已知问题 / 技术债
- （指向 `docs/PROGRESS.md`「近期注意事项」）

### 验收
- 对照 `docs/ROADMAP_2026-06-16.md` 对应 Milestone 的「验收标准」逐条 ✓
````

---

*维护者：Claude Code（每个 Milestone 发布时更新）+ 人工 Review。*
