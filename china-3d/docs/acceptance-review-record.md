# SPEC §12 验收核对记录（TASK-016）

本记录是 TASK-016「整体集成与最终验收」的配套交付物：对 SPEC §12 验收标准 1–11 **逐条给出结论**，
并对 SPEC §6 政治红线逐项确认（自动锚点 + 渲染实测 + 未决项三层分离，不产生虚假合规结论）。

> **状态总览（2026-07-30）**：
> - 工程基线全绿：`pnpm build` / `pnpm lint` / `pnpm test`（43 文件 883 用例）/ `pnpm verify:assets`
>   全部通过（见 §4）。
> - 生产构建（`pnpm preview`、2048² 默认档、1920×1080）经无头 Chrome（puppeteer-core + 系统
>   Chrome + SwiftShader）整体冒烟 **16/16 通过**：入场到达 interactive 后截图非黑屏，地形起伏 /
>   海面 / 省界 / 标签 / 附图 / 图例 / 角标全部可见（见 §3）。
> - SPEC §12 十一项：**九项通过**；**§12.9 性能为有条件通过**（预算 / 档位 / DPR 上限 / 逐帧分配
>   审计全部固化并验证，目标独显 1080p/4K ≥60fps 真机实测 `pending`，见
>   `performance-measurement-record.md` §4 待用户回填）；**§12.3 / §6 红线的「逐点人工核对 +
>   官方审图号」`pending`**（发布前阻断项，见 `political-review-record.md` §4 与本文 §5）。
> - 页面最终态：`index.html` 标题 / 标题区文案为最终态，Vite 模板 favicon 残留已由项目原创
>   地形图标替换（见 §6）。

---

## 1. SPEC §12 验收标准逐条核对

| # | 验收标准 | 结论 | 证据（自动化锚点 + 无头实测 + 文档） |
|---|---|---|---|
| 1 | **地形真实**（高原隆起 / 盆地凹陷 / 平原舒缓，k 可调） | **通过** | 资产不变量：`pnpm verify:assets` terrain scope——青藏 4976m > 东部 98m、四川盆地 463m < 周边 1612m、塔里木盆地 987m < 天山 2592m / 昆仑 1783m、东海陆架 -228m、南海深海 -1486m（TASK-003）。渲染：TASK-006 无头两档实测高原隆起 / 塔里木·四川盆地凹陷 / 西高东低正确；本次无头雪顶像素 17276 检出 + 截图目视（§3）。k∈[1.5,3.0] 经 `resolveTerrainConfigOrThrow` 校验 + `?terrainK=` URL 覆盖（`tests/terrain-config.test.ts`） |
| 2 | **分层设色**（高程→颜色正确，图例与地表一一对应） | **通过** | 色阶断点与 §3.1 表逐项一致（`src/lib/elevation-color-ramp.ts` 唯一事实源 + 分段线性唯一策略 + 域不匹配确定性拒绝，`tests/elevation-color-ramp.test.ts`）；fragment 按像素 UV 重采样真实 h 查 ramp（k 结构性不进入片元）。图例颜色 / 位置 = 与地表片元同一采样器与归一化（`tests/elevation-legend.test.ts` 逐 stop / 刻度 = `sampleElevationColor` ± GPU ramp 量化容差，TASK-014）；本次无头图例 6 刻度 DOM 检出 + 截图目视色带与地表一致 |
| 3 | **边界完整（红线）** | **通过（自动锚点 + 渲染实测）；人工逐点核对 / 审图号 pending** | 见 §2 政治红线逐项确认表 |
| 4 | **贴地描边 + 标签**（省界贴地、Billboard 可读、省会光点正确） | **通过** | 贴地：弧长 densify（间距=主图宽/4096）+ 逐点 `queryAtWorld` y=h·k+epsilon，绝不产出平地边界（`tests/province-borders.test.ts` + TASK-009 无头 8/8）。标签：Billboard 四元数与相机一致（\|dot\|=1.0）、34 文本 + 34 光点挂载、hover 放大置顶、遮挡透明度阻尼（TASK-010 无头 17/17）。本次无头：省界浅青白像素 10080、近白亮标签 / 光点像素 10759 检出 |
| 5 | **海面**（半透明流动，可透见大陆架） | **通过** | TASK-007 无头两档：海面像素随时间流动、陆地采样点逐字节不变（无盖色）、近岸采样点亮于远海（大陆架明→暗梯度透见）。本次无头：南部海域深青像素 15822/27072 检出 + 截图目视梯度 |
| 6 | **相机**（东南斜俯视默认；受限不飞出 / 不穿地） | **通过** | TASK-008 无头 18/18：默认机位 / 距离 / 极角精确命中，缩放 / 极角 / 平移钳制全部停住，88° 不到地底，动态 near 跟随相机高度 |
| 7 | **hover**（边界加亮加粗、标签放大置顶、移出还原） | **通过** | TASK-009 无头 8/8：hover 四川差分掩码精确呈现「川界加亮加粗 + 其余压暗」、切换北京焦点跟随、移出 / 海域差分为零、click 无行为；TASK-010 无头：焦点省标签 ×1.6 放大提亮 + 成都小字呈现、移出还原 |
| 8 | **入场**（进度条→地形升起→标签淡入，过程顺滑） | **通过** | TASK-013 无头多轮：节流下进度真实停 3/4 ≥5s 不伪造爬升；临时 10× 时序下阶段时长精确跟踪配置（1.2/1.6/0.8s）；升起逐段推进且位移集中于高山；省名变亮自西向东错峰（西部 +1.7s 先起、东部 +11.8s 后追）；labels 阶段拖拽锁定、interactive 后释放。本次无头观察 Loader 状态序列：`0/4→3/4→4/4（100%）→地形升起中→水面与边界淡入中→interactive（卸载）` |
| 9 | **性能**（大屏独显 1080p/4K ≥ 60fps，2048² 默认档） | **有条件通过**：代码侧就绪，真机实测 `pending` | 已固化并验证：性能预算唯一事实源（`src/config/render-budget.ts` + `tests/render-budget.test.ts`）、逐帧分配审计结论「无运行时几何分配循环」（`performance-measurement-record.md` §2）、DPR 上限 2 无头实测（dsf=3 下绘制缓冲按 2 钳制）、4096² 上限档可渲染（TASK-015 无头 11/11）。**未决**：目标独显 1080p/4K 三档真机帧率由用户按 `performance-measurement-record.md` §3–§4 模板实测回填——本执行环境无独显 / 无 4K 屏，不伪造真机数字 |
| 10 | **稳定**（长时运行无崩溃；context lost 可恢复；resize 正常） | **通过** | TASK-015 无头 11/11：`lose_context` 真实触发丢失→状态提示出现→恢复→海面继续流动且两轮循环稳定；resize 后缓冲尺寸正确且高原质心左移证相机 aspect 更新。恢复从同一 CPU 源重建 GPU（绝不重新 fetch / 解码 .r16）。本次无头全程零 console error / 零 pageerror |
| 11 | **合规**（审图号占位 + 数据源署名角标 + 免责声明） | **通过（占位与免责常驻）；取得真实审图号 pending** | TASK-014 无头 19/19 + 本次无头 DOM 断言：审图号占位字面 `GS(202x)xxxx 号（待取得）`（不伪造已批复号码）、4 条来源署名逐字取自生产注册表（ETOPO1 / DataV / 项目自补政治边界 / 项目维护地名目录）各附「非官方」标注、SPEC §8 免责声明逐字常驻（`tests/compliance-badge.test.ts` 保护，取得审图号前不得删除） |

---

## 2. SPEC §6 政治红线逐项确认

> 三层验证不得互相替代（`political-review-record.md` §1）：自动化锚点证明「点名必备项**在**且资产
> 未被篡改」，渲染实测证明「确实画到了屏幕上」，人工逐点核对与官方审图是发布前阻断项（§5）。

| 红线项 | 自动化锚点（`pnpm verify:assets` + 运行时断言 + 测试） | 渲染实测 | 结论 |
|---|---|---|---|
| **南海九段线恰好十段** | `political-asset.nine-dash-segment-count` / `nine-dash-segment-missing`（EXPECTED=10，段序号 1..10 全在）；主图 `preparePoliticalFeatures` 与附图 `prepareSouthChinaSeaInset` 运行时经同一共享扫描 `collectPoliticalRedLineGaps` 断言，缺段抛稳定 code 阻断（绝不产出残缺地图）；`tests/assets/red-line.test.ts` | TASK-011 无头 16/16：主图 10 段暖琥珀虚线在真实经纬度对应屏幕位置全部检出；本次无头：附图 `.scs-inset-svg polyline` = **10** | 通过（自动 + 渲染）；逐点人工核对 pending |
| **台湾东侧段（第 10 段）** | 独立硬编码锚点 `TAIWAN_EAST_SEGMENT_INDEX=10`（`political-asset.taiwan-east-segment-missing`） | TASK-011 无头：台湾东侧段屏幕位置 26/26 采样命中 | 通过（自动 + 渲染） |
| **南海诸岛点位与名称** | `political-asset.island-missing`（REQUIRED_ISLAND_NAMES：钓鱼岛 / 赤尾屿 / 曾母暗沙）+ 黄岩岛 / 永兴岛代表点位 | TASK-011 无头：主图 5 岛礁光点全部检出；本次无头：附图 `circle`=5、`text`=[钓鱼岛, 赤尾屿, 曾母暗沙, 黄岩岛, 永兴岛] | 通过（点名项，自动 + 渲染）；**完整岛礁名录闭包人工核对 pending**（自动清单不声称穷尽） |
| **台湾省**（省级呈现 + 台北标注） | `provinces-asset.missing-political-id`（CN-710000 目录 + 几何）+ `places-asset.missing-political-id` + 台北坐标断言（`red-line.test.ts`）；字体子集覆盖「台湾省 / 台北」（fonts scope 逐字核验） | TASK-010 无头：34 省名标签（含台湾省）+ 34 省会光点（含台北）挂载并绘制 | 通过（自动 + 渲染） |
| **钓鱼岛、赤尾屿** | `political-asset.island-missing` 点名锚点 | 本次无头：附图标注 [钓鱼岛, 赤尾屿] 在列（TASK-012 修复二者同纬度相邻标注互叠，getBBox 实测不互叠） | 通过（自动 + 渲染） |
| **藏南（阿鲁纳恰尔）** | `political-asset.disputed-region-missing`（REQUIRED_DISPUTED_REGIONS；生产资产含 2 争议区修正要素，按中国主张画法） | 修正要素随主图政治要素层渲染（TASK-011 同一管线） | 通过（自动）；几何逐点人工核对 pending |
| **阿克赛钦** | 同上 | 同上 | 通过（自动）；几何逐点人工核对 pending |
| **香港 / 澳门特别行政区** | `provinces-asset.missing-political-id`（CN-810000 / CN-820000 目录 + 几何）+ 香港 / 澳门行政中心在地点目录（`places-asset.missing-political-id`） | TASK-010 无头：34 省名标签（含香港 / 澳门）挂载并绘制 | 通过（自动 + 渲染） |
| **右下 2D 南海附图** | 与主图复用同一份 `PoliticalBoundaryContract`（模块级单例去重，SPEC §5.4）；准备失败经整页错误通道阻断（不静默显示残缺附图） | 本次无头：`.scs-inset` bbox=(1630, 703, 266×353) 位于右下角，图名「南海诸岛」+ 十段虚线 + 5 岛礁点 + 5 标注齐全 | 通过（自动 + 渲染） |
| **审图号** | 占位文案逐字受测试保护（`tests/compliance-badge.test.ts`） | 本次无头：角标 `GS(202x)xxxx 号（待取得）` DOM 检出 | 占位已落地；**取得真实审图号 pending（发布前阻断项）** |

---

## 3. 本次无头整体验收实测记录（2026-07-30，TASK-016）

**方法**（单一有界验证入口，临时脚本跑完即删）：
`node` 直接子进程拉起 `vite preview`（生产构建，`--strictPort`，端口 4517）→ HTTP 就绪探测
（截止 30s）→ puppeteer-core 驱动系统 Chrome（`--use-gl=angle --use-angle=swiftshader
--ignore-gpu-blocklist --enable-unsafe-swiftshader`，1920×1080、DPR 1）→ 打开页面后以 500ms
间隔**带截止时间的条件轮询** Loader 卸载（= 入场到达 interactive，截止 300s）→ 等待最终态帧
充分渲染后整页截图 → 像素级断言（DOM overlay 区域屏蔽后检测 3D 图层）+ DOM 级断言 →
`finally` 路径关闭浏览器、kill preview 子进程并确认端口释放（已确认释放）。**未使用**
`--virtual-time-budget`（会黑屏）。验证产物（脚本 / 截图 / results.json）按仓库验证边界在返回前
删除，本文记录全部数值结论。

**环境**：生产档 2048² 网格、4096² heightmap、DPR 1、SwiftShader 软件 WebGL（低帧率仅影响墙钟
时间，不影响渲染结果正确性；真机帧率验收见 §1.9 未决项）。

**结果：16/16 通过**

| 检查项 | 实测值 |
|---|---|
| 入场到达 interactive（Loader 卸载） | 观察状态序列 `0/4(0%)→3/4(75%)→4/4(100%)→地形升起中→水面与边界淡入中`（SwiftShader 低帧率下 React 提交合并，labels 短阶段被跳过属已知现象，TASK-013 已用 256² 档证明错峰存在） |
| document.title / 标题区 | `中国 3D 地势图` / h1 `中国 3D 地势图` + 副标题 `真实地形版图大屏` |
| canvas 绘制缓冲 | 1920×1080（DPR 1） |
| 无 `role="alert"`（无整页错误 / 无运行时错误） | 0 |
| 附图 | bbox 右下（x=1630, y=703）；`polyline`=10、`circle`=5、标注=[钓鱼岛, 赤尾屿, 曾母暗沙, 黄岩岛, 永兴岛]、图名=南海诸岛 |
| 图例 | bbox 左侧贴边（x=24）；6 刻度=[0m, 1000m, 2000m, 3500m, 5000m, 8848m] |
| 角标 | bbox 左下（x=24, y=804）；审图号=`GS(202x)xxxx 号（待取得）`；署名 4 条（ETOPO1 / DataV / 项目自补政治边界 / 项目维护地名目录）+ 4 个「非官方」标注 + SPEC §8 免责声明逐字一致 |
| 非黑屏 | 非背景像素占比 **33.7%**（> 25% 阈值） |
| 青藏高原隆起 | 上中偏左区域蓝白雪顶像素 **17276**/186345（检测器按实测雪顶色 ≈(146,162,183) 标定） |
| 海面 | 南部海域深青像素 **15822**/27072 |
| 省界 | 浅青白发光像素 **10080** |
| 标签 / 光点 | 近白低色度亮像素 **10759** |
| console error / pageerror | **0 / 0** |

截图目视复核：青藏高原雪顶隆起、塔里木 / 四川盆地凹陷、东部平原舒缓，分层设色与图例色带
一致；省界贴地清晰；省名标签与省会光点可读；南海十段线与岛礁光点可见；右下附图、左侧图例、
左下角标、顶部标题区齐全。

## 4. 工程基线全绿记录（2026-07-30）

| 命令 | 结果 |
|---|---|
| `pnpm build` | 通过（`tsc -b` + `vite build`，764 模块；产物 dist ≈ 1.34MB JS + 5.4KB CSS） |
| `pnpm lint` | 通过（oxlint，0 问题） |
| `pnpm test` | 通过（43 测试文件、**883 用例全部通过**） |
| `pnpm verify:assets` | 通过（terrain / provinces / places / political / sources / fonts / bundle 全 scope 深度校验，退出码 0） |

## 5. 未决项（公开发布前阻断，非本 TASK 可自证）

1. **官方审图号**：发布前由自然资源主管部门审图流程取得，替换页面占位 `GS(202x)xxxx 号（待取得）`；
   取得前 SPEC §8 免责声明常驻页面不得删除。
2. **九段线 / 争议区几何逐点人工核对 + 完整南海诸岛岛礁名录闭包**：以自然资源部标准地图服务公开
   标准地图为基准，具名核对人逐项完成并回填 `political-review-record.md` §2 / §4。
3. **目标独显 1080p / 4K ≥60fps 真机帧率实测**：用户按 `performance-measurement-record.md` §3–§4
   模板采样回填三档结果（本执行环境无独显 / 无 4K 屏，不伪造真机数字）。

## 6. 页面最终态与脚手架残留核对

| 核对项 | 结果 |
|---|---|
| `index.html` `<title>` | `中国 3D 地势图`（与 `PAGE_TITLE` 一致，无头实测 document.title 命中） |
| 标题区文案 | h1 `中国 3D 地势图` + 副标题 `真实地形版图大屏`（`src/lib/static-copy.ts` 唯一事实源） |
| favicon | 原为 Vite 模板 logo（脚手架残留），本 TASK 替换为项目原创地形图标（深蓝黑底 + 分层设色山峦 + 雪顶，`public/favicon.svg`） |
| 其余模板残留 | 全仓 grep（`vite` / `react logo` / `learn more` / `template` / `脚手架` 于 index.html / src）仅命中注释中对 Vite / vitest 的正当引用，无模板文案 / 模板资源残留 |

## 7. 变更日志

| 日期 | 变更 | 操作人 |
|---|---|---|
| 2026-07-30 | 初始交付：SPEC §12 逐条核对（§1）+ 政治红线逐项确认（§2）+ 无头整体验收 16/16（§3）+ 工程基线全绿（§4）+ 未决项登记（§5）+ favicon 脚手架残留清除（§6）。 | TASK-016 worker |
