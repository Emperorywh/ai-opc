# 静态地理资产契约（TASK-001）

本文档说明 china-map-3d 的**静态地理资产契约层**：它冻结哪些不变量、外部数据如何
离线进入仓库、运行时如何消费，以及契约校验失败时如何定位。

> 适用范围：仅静态地理资产。本契约不承载任何业务指标、实时数据、业务 tooltip 或下钻语义
> （见 SPEC「非目标」与 TASK-001 实现约束）。

---

## 1. 分层与依赖方向

```
                  ┌──────────────────────────────────────────┐
   离线生产层      │ scripts/dem, scripts/verify-assets        │  (Python / tsx)
  （不进浏览器）   │   ↓ 只能单向依赖                          │
                  ├──────────────────────────────────────────┤
   契约层          │ src/geo-contracts                        │  纯 TS，零渲染依赖
  （公共稳定面）   │   codes · errors · geometry-primitives    │
                  │   source · terrain · admin-directory      │
                  │   geometry · places · political · validate│
                  ├──────────────────────────────────────────┤
   运行时访问层    │ src/lib（后续 TASK）                      │  可依赖契约层
   + 渲染层        │ src/components（后续 TASK）               │  Three.js / React
                  └──────────────────────────────────────────┘
```

**强约束**：
- 契约层 `src/geo-contracts` 只依赖 TypeScript 自身，**禁止** import React / Three.js / 渲染层。
- 离线生产层（`scripts/`）与运行时访问/渲染层都可以单向依赖契约层；**反向依赖违规**。
- 测试基线 `tests/` 与 CLI `scripts/verify-assets` 都不进入浏览器运行时包
  （`tsc -b` 只覆盖 `src/`，`vite build` 只打包从 `index.html` 可达的代码）。

---

## 2. 数据类别与契约

| 类别 | kind 字面量 | 表达的不变量 |
|---|---|---|
| 数据来源声明 | `data-source-registry` | 来源 id、名称、类别、版本、许可证、是否官方审图、免责声明 |
| 地形元数据 | `terrain-meta` | CRS（EPSG:3857）、地理范围、分辨率、高程编码上下限与位深、来源 |
| 行政区目录 | `administrative-directory` | 稳定标识（CN- 前缀）、规范名称、行政区类型 |
| 行政区几何 | `administrative-geometry` | CRS（EPSG:4326）、adminId 关联、多边形/多多边形结构、坐标合法性 |
| 地点目录 | `place-directory` | CRS（EPSG:4326）、adminId 关联、角色、坐标、人工校正说明 |
| 政治边界补充 | `political-boundary` | CRS（EPSG:4326）、九段线段、岛礁点、争议区修正、来源 |

每个契约都显式表达：坐标参考系、地理范围（适用项）、分辨率（适用项）、高程编码上下限
（地形）、稳定行政区标识、名称、几何类型、数据版本、数据来源。坐标、高程、标识、来源
**一律显式字段**，禁止用数组位置、文件名推断或魔法默认值承载领域语义。

---

## 3. 离线生产数据流

外部数据（Copernicus DEM、DataV.GeoAtlas、公开标准地图衍生坐标）**必须**先在离线生产层
转为仓库内静态资产，运行时零外部网络依赖。

```
外部源（网络/本地缓存）
   │  离线生产脚本（scripts/，不依赖浏览器/React/Three）
   ▼
仓库内静态资产（public/，后续 TASK 产出）
   │  导出契约要求的元数据 + JSON 资产
   ▼
pnpm verify:assets -- --scope <name>   ← 契约层校验，失败即阻断
   │  通过
   ▼
进入运行时可消费状态
```

- 离线生产层产出的每一份资产都必须能通过对应 scope 的契约校验。
- 非官方审图数据（DataV、项目自补）在来源声明中标记 `isOfficialSurvey: false` 并附带
  非空 `disclaimer`，校验器强制（SPEC §8 红线）。
- 生产源数据缓存、临时拼接产物**不得**作为产品资产提交（见各后续 TASK 的回退边界）。

---

## 4. 运行时消费数据流

```
public/ 静态资产（fetch 本地文件，无外网）
   │
   ▼
运行时数据访问层（src/lib，后续 TASK）
   │  按 kind 解析为契约类型，复用同一校验入口做加载期自检
   ▼
渲染层（src/components，后续 TASK：地形 / 海面 / 边界 / 标签 / 附图 / 场景）
```

- 运行时数据访问层依赖契约层（类型 + 校验），渲染层依赖数据访问层；都不得反向依赖。
- 主 3D 图与右下 2D 南海附图必须消费**同一份**政治边界补充事实源，不维护两套坐标
  （SPEC §3.8、§6）。

---

## 5. 契约错误的定位方式

校验失败一律以**确定性、可定位**的方式给出，不静默修正。每条错误含三段：

- `code`：机器可读的稳定错误码，便于测试断言与 CI 判定（如 `crs.missing`、
  `terrain-meta.elevation-range-inverted`、`admin-directory.duplicate-id`）。
- `path`：JSON 路径或条目位置（如 `$.entries[2].id`、`$.crs`）。
- `message`：简体中文说明，描述被违反的不变量。

定位步骤：
1. 运行 `pnpm verify:assets -- --scope <name>`（或 `pnpm test`）。
2. 读输出中的 `code` + `path`，定位到具体文件与字段。
3. 在离线生产层修正源数据后**重新生成资产**——不要在运行时打补丁、不要在契约里加 fallback。
4. 若错误来自契约本身需要演进（新增 CRS / 版本 / 类别），先在 `src/geo-contracts/codes.ts`
   登记，再更新资产。

错误码命名约定：`<契约短名>.<具体原因>`，跨契约引用核对用 `bundle.*` 前缀。

---

## 6. 验证入口

| 命令 | 作用 |
|---|---|
| `pnpm test` | 运行 vitest 测试基线（合法夹具通过 + 各类确定性失败） |
| `pnpm verify:assets` | 运行资产校验 CLI，等价于 `--scope all` |
| `pnpm verify:assets -- --scope provinces` | 只校验某 scope（terrain / provinces / places / political / sources） |
| `pnpm lint` | oxlint 静态检查 |
| `pnpm build` | `tsc -b && vite build`，确认契约层类型正确且测试/脚本不进浏览器包 |

后续 TASK 复用同一 CLI：新增生产资产时，把对应 scope 的 probes 路径替换/扩展为真实
`public/` 资产路径，并在需要时追加 scope 专属更深层不变量（如「恰好 34 个省级行政区」）。
不要新建第二条校验管线。

---

## 7. 当前状态

- 已交付：契约层、验证入口、测试基线、代表夹具（legal + broken）、本文档。
- 已交付生产资产（TASK-003）：`public/terrain/china-heightmap-4096.{r16,meta.json,provenance.json}`
  + `public/geo/data-sources.json`（来源 `src-etopo1-noaa`）。terrain scope 已接入**资产级深度校验**
  （位深/尺寸/编码/地势抽样/来源审计，见 `scripts/verify-assets/terrain-deep.ts`）；`provenance.integrity`
  的六项摘要（rasterBytes / sha256 / distinctCodes / observedMinMeters / observedMaxMeters /
  clampedToMinCount）由校验侧逐项复算比对，SHA-256 防篡改锚点闭环。重建命令与**分辨率决策**
  （0.5° ETOPO1 被接受为 TASK-003 契约产物，视觉升级推迟到 TASK-004 依据 GPU 渲染判定）见
  `scripts/dem/README.md` §1A / §1B。
- 已交付生产资产（TASK-004）：`public/geo/china-provinces-{directory,geometry}.json`
  + `public/geo/china-provinces.provenance.json`，来源 `src-datav-provinces`（阿里 DataV.GeoAtlas
  `100000_full.json`，已登记入 `public/geo/data-sources.json`）。provinces scope 接入**资产级深度校验**
  （恰好 34 省 / 港澳台必在 / 目录-几何双射 / 与 34 省目录真值一致 / 所有环闭合 / 坐标落中国主图 /
  来源审计，见 `scripts/verify-assets/provinces-deep.ts`）；34 省领域真值单一定义于
  `scripts/provinces/province-catalog.ts`，标识方案为 `CN-<GB/T 2260 adcode>`。港 / 澳 / 台三者的
  存在性在深度校验中另有**独立硬编码锚点**（不依赖目录），九段线 / 南海岛礁 / 争议区国标完整性仍由
  TASK-006 独立闭环——本 TASK 只交付 DataV 基础 34 省，**不**声称已完成政治红线。重建命令见
  `scripts/provinces/fetch-datav-provinces.ts`（离线取数，运行时零外网）。
- 已交付生产资产（TASK-005）：`public/geo/china-places.json` + `public/geo/china-places.provenance.json`，
  来源 `src-project-capitals`（项目维护省名锚点与省级行政中心目录，已登记入 `public/geo/data-sources.json`）。
  places scope 接入**资产级深度校验**（恰好 34 省 × (1 锚点 + 1 行政中心) = 68 条 / 港澳台必在 /
  adminId 与 34 省真值一致 / name 与真值一致 / 坐标落中国主图 / point-in-polygon 点落入对应省域 /
  来源审计，见 `scripts/verify-assets/places-deep.ts`）；34 省 × 2 角色领域真值单一定义于
  `scripts/places/place-catalog.ts`，地点 id 由 `${adminId}-anchor` / `${adminId}-capital` 确定性派生。
  锚点缺省 = 省会坐标；狭长省份（内蒙古 / 黑龙江 / 甘肃 / 西藏）的人工校正锚点附 `anchorAdjustmentNote`
  记录依据，**不**用组件内魔法偏移承载。重建命令见 `scripts/places/build-places.ts`（项目内维护，零外网）。
- **TASK-006（管线 + 模板 + 核对记录 — 生产政治资产阻塞中，非已就绪）**：
  ⚠ **生产可追溯政治资产尚未交付**，当前 `political` scope 暂指向
  `tests/fixtures/legal/political-boundary.json` 增强夹具（10 段 + 全点名项的 representative 坐标，
  仅用于驱动深度校验管线）。故 `pnpm verify:assets -- --scope political` 与 `--scope all` 均以
  **退出码 3（BLOCKED）**结束（非 0）并打印 BLOCKED 横幅，明确区分「管线健康 + 夹具自洽」与
  「生产政治边界已校验」——避免红线政治任务被 CI / grep 类消费方误读为已通过。直接消费政治补充数据的
  渲染 TASK（**TASK-015 / TASK-019 仍阻塞**）；通用领域能力 TASK（TASK-007+）不阻塞。九段线几何数字化
  与争议区边界几何需可追溯核对基准（自然资源部标准地图），人工核对未完成（见核对记录 §3 来源调查、
  §4 阻塞收窄）。已交付的**可复用能力**（生产资产到位后即解锁，无需重建管线）：political scope
  **资产级深度校验**（恰好 10 段九段线含台湾东侧段 / 点名岛礁钓鱼岛·赤尾屿·曾母暗沙均在 / 点名争议区
  藏南·阿克赛钦均在 / 坐标落中国主图 / 来源强制非官方审图 isOfficialSurvey=false + 非空 disclaimer，见
  `scripts/verify-assets/political-deep.ts`）；SPEC §6 点名必备项领域真值单一定义于
  `scripts/political/political-catalog.ts`（REQUIRED_NINE_DASH_SEGMENT_INDICES 1..10、
  TAIWAN_EAST_SEGMENT_INDEX=10 独立硬编码锚点、REQUIRED_ISLAND_NAMES、REQUIRED_DISPUTED_REGIONS）；
  篡改测试基线见 `tests/assets/political-asset.test.ts`（删台湾东侧段 / 删钓鱼岛 / 删赤尾屿 /
  删南海岛礁名 / 删争议区修正等确定性失败）。政治来源 `src-project-political` 已登记入
  `public/geo/data-sources.json`（isOfficialSurvey=false + 非空 disclaimer + 可追溯 originUrl）。
  人工核对记录模板见 `docs/political-review-record.md`（SPEC §6 红线逐项清单，全部 pending）。
- 当前 `version` 仅有 `1.0.0`；后续如更换 DEM 源或修正边界，在
  `src/geo-contracts/codes.ts` 的 `KNOWN_DATA_VERSIONS` 登记新版本。
