# 政治边界完整性人工核对记录（TASK-004）

本记录是 TASK-004「行政边界/九段线/岛礁/省会数据资产」的配套交付物（SPEC §6、§8、§13）。
它显式声明：哪些政治红线已由**自动化管线**闭环，哪些仍属**人工核对**与**官方审图**范畴——
三层验证不得互相替代，本 TASK 不产生虚假合规结论。

> **状态总览（2026-07-30）**：自动化完整性管线已就位并在生产资产上全部通过
> （`scripts/verify-assets/political-deep.ts` + `src/lib/political-red-line.ts` +
> `src/geo-contracts/political-catalog.ts` + `pnpm verify:assets` + `tests/assets/` 篡改测试基线）。
> 生产政治边界资产 `public/geo/china-political-boundary.json` 已交付（十段线 + 点名岛礁 +
> 争议区修正，坐标为公开标准地图衍生数据的 representative 精度）。但**人工对照公开标准地图的
> 逐点核对**与**自然资源主管部门审图号**仍未完成——全部数据为**非官方审图数据，仅供内部展示**，
> 公开发布前必须取得审图号（SPEC §8 免责声明已随资产与来源注册表落盘）。

---

## 1. 三层验证边界（不得互相替代）

| 层次 | 负责对象 | 能证明什么 | 不能证明什么 |
|---|---|---|---|
| **自动化完整性检查**（本 TASK 交付） | 机器 | SPEC §6 点名必备项**在**（10 段含台湾东侧段、钓鱼岛/赤尾屿/曾母暗沙、藏南/阿克赛钦）、台湾省与台北/港澳在省级目录与地点目录中、坐标落中国主图、来源标记非官方审图、资产未被篡改（SHA-256 锚点） | 南海诸岛完整岛礁名录已穷尽；九段线/争议区几何顶点与国标逐点重合；数据已过官方审图 |
| **人工地图核对**（本记录 §2 清单） | 核对人 | 自动化清单的点名项与当前公开标准地图**逐项一致**；完整岛礁名录闭包；几何顶点级合理性 | 取得自然资源主管部门审图号；法律层面的边界主张效力 |
| **官方审图**（发布前） | 自然资源主管部门 | 取得具名审图号，公开发布合法 | —（审图结果是公开发布的前置条件，非本 TASK 可自证） |

三层缺一不可：自动化清单不能替代人工核对，人工核对不能替代正式审图。

---

## 2. SPEC §6 红线逐项核对清单

每项核对须由**具名核对人**对照一份**可识别基准**（公开标准地图的审图号 / 版本 / 获取地址）
逐项完成。`pending` = 尚未人工核对；`pass(自动)` = 自动化锚点已在生产资产上闭环。

### 2.1 南海九段线（含台湾东侧段 = 标准十段画法）

| 红线项 | 自动化锚点 | 状态 | 人工核对未决项 |
|---|---|---|---|
| 恰好 10 段 | `political-asset.nine-dash-segment-count`（EXPECTED_NINE_DASH_SEGMENT_COUNT=10） | pass(自动) | 各段几何顶点需与公开标准地图逐点核对 |
| 段序号 1..10 全在 | `political-asset.nine-dash-segment-missing` | pass(自动) | 同上 |
| **台湾东侧段**（segmentIndex=10） | `political-asset.taiwan-east-segment-missing`（独立硬编码锚点 TAIWAN_EAST_SEGMENT_INDEX=10） | pass(自动) | 该段是「九段 vs 十段」画法差异标志，须重点核对位置与走向 |

### 2.2 南海诸岛 / 附属岛屿点位

| 红线项 | 自动化锚点 | 状态 | 人工核对未决项 |
|---|---|---|---|
| 钓鱼岛点位 | `political-asset.island-missing`（REQUIRED_ISLAND_NAMES） | pass(自动) | 坐标需与权威地名录逐点核对 |
| 赤尾屿点位 | `political-asset.island-missing` | pass(自动) | 同上 |
| 曾母暗沙点位（领土最南标志） | `political-asset.island-missing` | pass(自动) | SPEC §3.3 标注 ≈ 3.58°N |
| **完整南海诸岛岛礁名录闭包**（西沙/中沙/南沙全部岛、礁、沙、滩及规范名称） | **无自动化锚点**（人工核对项） | pending | 自动化只覆盖 SPEC §6 点名少数项 + 黄岩岛/永兴岛代表点位；完整名录闭包须人工对照公开标准地图确立，本 TASK 不声称穷尽 |

### 2.3 争议区按中国主张画法修正

| 红线项 | 自动化锚点 | 状态 | 人工核对未决项 |
|---|---|---|---|
| 藏南（阿鲁纳恰尔）修正 | `political-asset.disputed-region-missing`（REQUIRED_DISPUTED_REGIONS） | pass(自动) | 边界几何需与国标画法逐点核对；DataV 基础省界画法非国标（SPEC §5.2 已知缺陷），本资产以修正要素按中国主张补充 |
| 阿克赛钦修正 | `political-asset.disputed-region-missing` | pass(自动) | 同上 |

### 2.4 台湾省 / 港澳（由省级目录与地点目录资产承载）

| 红线项 | 自动化锚点 | 状态 |
|---|---|---|
| 台湾省作为省级行政区在目录与几何中 | `provinces-asset.missing-political-id`（CN-710000） | pass(自动) |
| 香港特别行政区在目录与几何中 | `provinces-asset.missing-political-id`（CN-810000） | pass(自动) |
| 澳门特别行政区在目录与几何中 | `provinces-asset.missing-political-id`（CN-820000） | pass(自动) |
| 台湾省行政中心（台北）与港澳行政中心在地点目录中 | `places-asset.missing-political-id` + `tests/assets/red-line.test.ts`（台北坐标断言） | pass(自动) |

### 2.5 南海诸岛右下 2D 附图 / 审图号

| 红线项 | 责任 TASK | 状态 | 说明 |
|---|---|---|---|
| 主 3D 图按真实位置呈现南海诸岛 / 九段线 | 后续渲染 TASK（消费本 TASK 资产） | 未开始 | 主图与附图须复用本 TASK 的同一份政治边界事实源（SPEC §3.8、§6） |
| 右下 2D 南海附图 | 后续渲染 TASK | 未开始 | 同上 |
| 审图号占位 | 后续合规角标 TASK | pending | 发布前必须取得自然资源主管部门审图号并填入预留位；程序生成/拼装的地图公开发布前依法须送审 |

---

## 3. 数据资产与来源登记（可追溯性）

| 资产 | 管线 | 来源 id | 关键审计锚点 |
|---|---|---|---|
| `china-provinces-directory.json` / `china-provinces-geometry.json` | `scripts/provinces/fetch-datav-provinces.ts`（DataV areas_v3 快照） | `src-datav-provinces` | 源快照 SHA-256 + 目录/几何 SHA-256 + 数量统计，见 `china-provinces.provenance.json` |
| `china-places.json` | `scripts/places/build-places.ts`（项目维护目录，零网络） | `src-project-capitals` | 载荷 SHA-256 + 条目统计，见 `china-places.provenance.json` |
| `china-political-boundary.json` | `scripts/political/build-political.ts`（项目维护坐标目录，零网络） | `src-project-political` | 载荷 SHA-256 + 要素统计，见 `china-political-boundary.provenance.json` |
| 来源注册表 | `public/geo/data-sources.json` | — | 全部来源 `isOfficialSurvey=false` + 非空免责声明（SPEC §8） |

红线领域真值单一定义点：
- 「哪些项是 SPEC §6 点名必备」→ `src/geo-contracts/political-catalog.ts`
  （REQUIRED_NINE_DASH_SEGMENT_INDICES / TAIWAN_EAST_SEGMENT_INDEX / REQUIRED_ISLAND_NAMES /
  REQUIRED_DISPUTED_REGIONS）。
- 「如何在契约里扫描缺项」→ `src/lib/political-red-line.ts`（collectPoliticalRedLineGaps，
  唯一扫描实现，资产深度校验与未来运行时消费共用）。
- 「点名项的实际坐标」→ `scripts/political/political-boundary-catalog.ts`（项目维护，
  更正须先改目录并重产资产，不得在运行时打补丁）。

## 4. 待办（闭环前不得公开发布）

1. **九段线各段几何顶点的逐点人工核对**：以自然资源部标准地图服务（bzdt.ch.mnr.gov.cn）
   公开标准地图为基准，具名核对人逐段核对并在本记录 §2 填入基准标识 / 核对人 / 日期。
2. **争议区边界（藏南 / 阿克赛钦）几何的国标画法逐点核对**：同上。
3. **完整南海诸岛岛礁名录闭包**：人工对照公开标准地图确立后扩充
   `scripts/political/political-boundary-catalog.ts` 并重产资产。
4. **官方审图号**：发布前由自然资源主管部门审图流程取得，填入页面审图号占位（SPEC §8）。

## 5. 变更日志

| 日期 | 变更 | 操作人 |
|---|---|---|
| 2026-07-30 | 初始交付：生产政治边界资产 + 自动化红线管线（political-catalog / political-red-line / political-deep + CLI + 篡改测试）+ 本核对记录。自动锚点全部 pass(自动)；人工逐点核对与审图号 pending。 | TASK-004 worker |
