# M9 对齐验证报告（Task 27）

> 配套：SPEC §5（坐标系与投影）· ROADMAP M9（Robinson 投影升级）· PROGRESS Task 26/27
>
> 本报告是 ROADMAP Task 27「全矢量对齐验证」的**产出物**，落地 M9 三项高风险验收（#1 极区拉伸消除 /
> #2 所有矢量对齐 / #3 渲染层零改动）的可编程证据 + before/after 客观度量。
>
> 日期：2026-06-18 ｜ 投影：Robinson（proj4 `+proj=robin`）｜ DEM：GEBCO 2026，Robinson 重烘焙 4096×2048

---

## 一、验证范围

Task 26 已证明「**地基对齐**」（投影函数 + 采样函数）：

| 链路环节 | 已由 Task 26 证明 | 测试 |
|---|---|---|
| 前端 `project()` === pipeline `projectRobinson()` 逐点 | ✅ | `robinson.test.ts` |
| `sampleHeight` 走 `project → worldXY → UV`（与 shader `heightUv` 同源） | ✅ | `assets.test.ts` |
| Robinson heightmap 已知点正确（陆地>海 / 海洋<海 / 喜马拉雅>3000m） | ✅ | `robinson.test.ts` |

**Task 27 的增量**：把地基接到「**矢量消费者**」（边界 / 争议线 / 标签 / 卡片）做**端到端闭环**，
用**真实 Robinson 重烘焙产物**（`public/data/{boundaries,disputed,labels,heightmap,meta}`）校验，
并补齐**极区压缩量化**与**切换投影守护**。**河流不在本 Task 范围**（M10 Task 28/29，尚未实现）。

---

## 二、验证矩阵

> 全部断言来自 `test/projection-alignment.test.ts`（16 测，2026-06-18 全绿）。跑 `pnpm test` 复现。

### A. 全矢量锚点落工作平面（真实产物端到端）

> 断言：所有矢量顶点 / 锚点经 `project(lon,lat)` 后落在 `x∈[-1,1] × z∈[-0.5,0.5]`。

| 矢量类别 | 真实产物来源 | 顶点/锚点数 | 结果 |
|---|---|---|---|
| 国家边界顶点 | `boundaries.bin`（6 国轮廓，含 USA MultiPolygon） | >0 | ✅ 全落 PLANE |
| 争议线顶点 | `disputed.bin`（克什米尔/克里米亚/西撒哈拉） | >0 | ✅ 全落 PLANE |
| 标签锚点 | `labels.json`（7 大洲 + 4 大洋 + 6 国家 = 17） | 17 | ✅ 全落 PLANE |

> 区别于 `boundaries-render.test`（合成 fixture）/ `labels.test`（`buildLabels()` 合成）：本 Task 用
> **真实 `public/data/` 产物**端到端，证明 Task 26 重烘焙/重投影后实际落盘数据无超界。

### B. 矢量贴地高度语义（真实 Robinson heightmap · R3 端到端）

> 断言：矢量 `y = max(sampleWorldY, seaLevelWorldY) + ε`，陆地贴地表、海面贴海平面，**不被山埋、不沉海底**。

| 断言 | 结果 |
|---|---|
| 边界顶点 `y ≥ 海面 + BOUNDARY_Y_OFFSET(0.003)` | ✅ |
| 争议线顶点 `y ≥ 海面 + ε` | ✅ |
| 陆地国家标签贴地（中国/巴西/埃及/澳大利亚 `y > 海面`） | ✅ |
| 大洋标签贴海面（太平洋/大西洋/印度洋/北冰洋 `y = 海面`，不沉海底） | ✅ |
| CountryCard 锚点（`countryAnchorLonLat`，含 USA 落海修复）project 落 PLANE | ✅ |
| 矢量消费者 `y` 链路 ≡ shader `heightUv`（`sampleWorldY` → `project` → `worldXY→UV`） | ✅ |

> 关键：大洋锚点取 `max(海底, 海面) = 海面`，避免标签沉入海底被半透明海洋几何遮蔽（Task 06 渲染顺序）；
> 陆地锚点 `max(地面, 海面) = 地面`，标签贴地形。两者经同一 `sampleWorldY` 链路与 Task 04 shader 同源。

### C. 极区压缩量化（M9 核心验收 #1）

> Robinson 伪圆柱投影：高纬经线收敛，消除 equirect 的极区横向拉伸。压缩率 = `1 − robinson跨度 / equirect跨度(=2.0)`。

| 纬度 | equirect 跨度 | Robinson 跨度 | 压缩率 |
|---:|---:|---:|---:|
| 0°（赤道） | 2.000 | 2.0000 | 0.0% |
| 45° | 2.000 | 1.7924 | 10.4% |
| 60° | 2.000 | 1.5972 | 20.1% |
| 80° | 2.000 | 1.2426 | 37.9% |
| **82°（南极洲锚点）** | 2.000 | **1.2017** | **39.9%** |
| **85°（北冰洋锚点）** | 2.000 | 1.1444 | **42.8%** |

| 关键锚点 | equirect | Robinson | 说明 |
|---|---:|---:|---|
| 南极洲 `lat=-82` 的 `lon=±180` x 跨度 | 2.000 | 1.2017 | 经线收敛，南极洲不再偏宽 |
| 北冰洋 `lat=85` 的 `lon=180` x | 1.000 | 0.5722 | 极区大幅收敛 |
| 南极洲锚点 `(0,-82)` z | +0.456 | **+0.478** | 落极区纵向边缘（向南 +z） |
| 北冰洋锚点 `(0,85)` z | −0.472 | **−0.488** | 落极区纵向边缘（向北 −z） |

> 压缩率随 `|lat|` **单调增强**（赤道 0% → 极区最强 42.8%），符合 Robinson 伪圆柱特性。
> 断言亦验证单调性（`compress(0)=0 < 45 < 60 < 80 < 85`）。

### D. 切换投影验收（渲染层零改动守护 · M9 核心验收 #3）

| 断言 | 结果 |
|---|---|
| `project` 全域密集网格（lon×10°/lat×5°，>600 点）采样全落 PLANE | ✅ 超界点 = 0 |
| `unproject` round-trip 全域无空洞（内部点，误差 < 1e-6） | ✅ 最大误差 ≪ 1e-6 |
| `src/three` 无硬编码 equirect 经纬度坐标映射（去注释扫描，守护 R2 单一契约） | ✅ 无违例 |

> **「渲染层零改动」的本质保证**：渲染层只依赖 `project` **输出范围**（恒定 `[-1,1]×[-0.5,0.5]`），
> 不依赖投影**内部映射**。D 组第 1 条证明范围恒定 → 无论 PROJECTION 切到 equirect 还是 robinson，
> 渲染层零改动。D 组第 3 条是**前瞻守护**：若未来有人在 `src/three` 写 `lon/180` 等硬编码 equirect 映射
> （绕过 `project`），切换投影时该处错位且难排查——扫描断言会立即报红。
>
> 历史佐证：Task 26 切换投影时 `git diff --stat src/three` 为**空**（提交 995b17d）。

---

## 三、全矢量对齐链路（R2 单一投影契约 + R3 CPU/GPU 同源）

```
                    ┌─────────────────────────────────────────────────┐
                    │  config/projection.ts : project(lon,lat)→[x,z]   │  ← R2 单一入口
                    │  归一化到 [-1,1]×[-0.5,0.5]（equirect/robinson 同范围）│
                    └────────────────────┬────────────────────────────┘
                                         │ [x,z] = worldXY
              ┌──────────────────────────┼──────────────────────────┐
              ▼                          ▼                          ▼
   ┌─────────────────────┐  ┌──────────────────────┐  ┌─────────────────────────┐
   │ 地形顶点（Task 04）   │  │ 矢量消费者            │  │ 高度采样（R3 同源）       │
   │ vertex shader        │  │  · 边界 buildBoundary│  │ sampleHeightAtWorld     │
   │ heightUv = worldXY→UV│  │  · 争议 buildDisputed│  │  = worldXY→UV（同 shader）│
   │                      │  │  · 标签 labelWorld   │  │         ▲               │
   │ GPU 位移 y           │  │  · 卡片 anchor       │  │ sampleWorldY            │
   └─────────────────────┘  │   = project(lon,lat) │  │  = heightToWorldY(       │
              ▲              │   → [x,z]            │  │      sampleHeight(lon,lat))
              │              │   → y=max(ground,sea)+ε│ │                          │
              └──────────────┴──────────┬───────────┴───────────────────────────┘
                   worldXY→UV 两侧同源（R3）│
                                           ▼
                          Robinson 重烘焙 heightmap（像素均匀对应 worldXY）
```

**核心**：地形（GPU shader `heightUv`）与矢量（CPU `sampleWorldY → project → worldXY → UV`）走**同一**
`worldXY → UV` 映射（R3 CPU/GPU 同源），经**同一** `project()`（R2 单一契约）从经纬度进入 worldXY。
Robinson 重烘焙后 heightmap 像素均匀对应 worldXY（非经纬度），故矢量采样必须走 `worldXY → UV`
（Task 26 的 `sampleHeight` 修复）——此即「全矢量对齐」的咽喉，本报告 B 组第 6 条断言守护。

---

## 四、M9 before/after 度量

> M9 DoD 要求「对比截图 `M9-before/after`」。agent 无浏览器无法生成 PNG 截图，以下**客观度量**
> 作为 before/after 的可验证代理；PNG 视觉截图归档留人工 Review（见 §五）。

| 度量 | before（equirect） | after（robinson） | 结论 |
|---|---|---|---|
| 南极洲 `lat=-82` 横向跨度 | 2.000（PLANE 满宽，偏宽） | 1.202（收敛 39.9%） | ✅ 极区拉伸消除 |
| 北冰洋 `lat=85` 横向跨度 | 2.000 | 1.144（收敛 42.8%） | ✅ 极区拉伸消除 |
| 投影输出范围 | `[-1,1]×[-0.5,0.5]` | `[-1,1]×[-0.5,0.5]`（同） | ✅ 渲染层零改动基础 |
| 全矢量锚点落 PLANE | — | 17 标签 + 边界 + 争议 全落 | ✅ 对齐无错位 |
| 矢量贴地（陆地>海/大洋=海） | — | 真实 heightmap 端到端 | ✅ 不被埋/不沉底 |
| DEM 重采样峰值 | 珠峰 7628m（equirect） | 6917m（双线性重采样，−7%） | ⚠️ 固有效应（Task 26 注），>合成上限 6500 |

---

## 五、已知局限 · 留人工 Review

| 项 | 说明 | 归属 |
|---|---|---|
| **M9 before/after PNG 截图** | agent 无浏览器，本报告用客观度量代理；视觉截图（南极洲偏宽消除观感）需人工在 dev 跑 `pnpm dev` 截 equirect vs robinson 对照 | 🔴 人工 Review |
| **真实 NE 边界对齐** | 当前 `boundaries.bin` 为合成 6 国（粗略矩形）；真实 NE ~200 国接入后需复跑本报告 A/B 组验证（`pnpm gen:boundaries` 重生成后 `pnpm test`） | 🔴 人工 Review（真实数据） |
| **河流对齐** | M10 Task 28/29 未实现；河流贴地采样走同一 `sampleWorldY` 链路（§三），届时 B 组扩展覆盖 | M10 |
| **Robinson 1.44% 横向拉伸** | Robinson 真实比例 1.9717:1，拉伸到 PLANE 2:1 横向 +1.44%，美学可忽略 | ℹ️ 已知（SPEC §5.2） |
| **DEM 重采样峰值平滑** | Robinson 双线性反投影把珠峰 7628m 平滑到 6917m（−7%），重采样固有效应非数据错误 | ⚠️ Task 26 注 |

---

## 六、结论

| M9 验收项 | 状态 | 证据 |
|---|---|---|
| #1 极区拉伸消除（南极洲比例正常） | ✅ | §四（南极洲跨度 2.000→1.202，压缩 39.9%） |
| #2 所有矢量与地形对齐无错位 | ✅ | §二 A+B（真实产物端到端 + 贴地语义 + R3 同源链路） |
| #3 切换投影渲染层零改动 | ✅ | §二 D（范围恒定 + round-trip 无空洞 + 无硬编码守护）+ Task 26 `git diff src/three` 空 |
| DoD：对比截图 before/after | ⚠️ 客观度量 ✅ / PNG 截图 🔴 留 Review | §四 + §五 |

**Task 27 验证结论**：Robinson 投影下，全矢量（边界/争议/标签/卡片）经单一 `project()` 契约与地形
严丝合缝对齐，极区拉伸消除（最大压缩 42.8%），切换投影对渲染层透明。编程断言（16 测）全绿，
对齐链路（R2/R3）端到端闭环。视觉观感与真实 NE 数据对齐留人工 Review。
