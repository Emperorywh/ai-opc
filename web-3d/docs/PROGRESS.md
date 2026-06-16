# 项目进度追踪（PROGRESS）

| 项 | 值 |
|---|---|
| 文档版本 | v1.0 |
| 日期 | 2026-06-16 |
| 配套文档 | SPEC（做什么）· ROADMAP（怎么做）· 本文件（做到哪了）|
| 维护者 | Claude Code（每 Task 完成时更新）+ 人工 Review |

> 本文件是「**当前做到哪了**」的**单一可信源**。每次新会话，agent 第一步读本文件定位当前任务。
> 三者关系：**SPEC** = 做什么 / 长什么样；**ROADMAP** = 用什么顺序做 / 每步边界与验收；**PROGRESS** = 做到哪了 / 踩了哪些坑。

---

## 当前指针

- **当前 Milestone**：M1 · 地形沙盘地基
- **当前 Task**：Task 02b · 真实 DEM 接入 GEBCO 2026（🔄 代码+单测就绪，待下载数据跑 `gen:dem:real` 闭环）
- **MVP 进度**：M1–M5 共 5 个 Milestone，已完成 **0 / 5**（M1 进行中 4/6，Task 02b 代码就绪）
- **总体进度**：32 个 Task，已完成 **4 / 32**

---

## Task 状态表

图例：⬜ pending ｜ 🔄 in_progress ｜ ✅ done ｜ ⚠️ blocked

### Phase 1 — MVP（M1–M5）

| Task | MS | 标题 | 状态 | Commit | 备注 |
|---|---|---|:---:|---|---|
| 01 | M1 | 项目基础设施与目录骨架 | ✅ | c1e5558 | 骨架：依赖+config四件套+store+空Scene |
| 02 | M1 | 合成 DEM Pipeline（免 GDAL） | ✅ | c4f1a5a | 自写PNG编解码+合成DEM；大陆可辨认；产出 heightmap/normal/meta |
| 02b | M1 | 真实 DEM 接入（GEBCO 2026） | 🔄 | — | 代码就绪：real-dem-source.mjs(可插拔契约)+CLI(gen:dem:real)+6 单测；**等下载数据跑 gen:dem:real 闭环** |
| 03 | M1 | 投影契约与数据加载层 | ✅ | 6f5cbcf | project()+高度解码契约(R3 同源)+16-bit PNG 加载(R32F)+CPU 高度表+vitest 20 测全绿 |
| 04 | M1 | GPU 顶点位移地形 + 基础着色 | ✅ | ef3f8cf | 自定义 ShaderMaterial：R32F heightmap 顶点位移(照搬 Task03 契约)+基础高度分层+Lambert 光照；PlaneGeometry 512×256；静态倾斜相机；25 测全绿 |
| 05 | M1 | M1 闭环验收 | ⬜ | — | — |
| 06 | M2 | 透明渲染顺序与海洋几何 | ⬜ | — | — |
| 07 | M2 | Gerstner 海洋 shader | ⬜ | — | — |
| 08 | M2 | 地形水彩 shader 完善 | ⬜ | — | — |
| 09 | M3 | SandboxControls（受限 pan/zoom） | ⬜ | — | — |
| 10 | M3 | 输入手势适配 | ⬜ | — | — |
| 11 | M3 | AdaptiveQuality 分档 | ⬜ | — | — |
| 12 | M4 | 字体子集化 pipeline | ⬜ | — | — |
| 13 | M4 | 大洲/大洋标签数据 pipeline | ⬜ | — | — |
| 14 | M4 | LabelLayer（troika SDF） | ⬜ | — | — |
| 15 | M4 | 优先级视口碰撞 + LOD 联动 | ⬜ | — | — |
| 16 | M5 | 大气层辉光（fresnel 弧壳） | ⬜ | — | — |
| 17 | M5 | 加载进度 + WebGL 检测降级 | ⬜ | — | — |
| 18 | M5 | 数据署名 + 许可弹窗 + MVP 验收 | ⬜ | — | — |

### Phase 2 — 国家边界与交互（M6–M9）

| Task | MS | 标题 | 状态 | Commit | 备注 |
|---|---|---|:---:|---|---|
| 19 | M6 | 边界数据 pipeline | ⬜ | — | — |
| 20 | M6 | CountryMeshes + BorderLines | ⬜ | — | — |
| 21 | M6 | 争议虚线 | ⬜ | — | — |
| 22 | M7 | 拾取 RT + ID 颜色映射 | ⬜ | — | — |
| 23 | M7 | hover/selected 高亮 + hook | ⬜ | — | — |
| 24 | M8 | 数据标注面板 | ⬜ | — | — |
| 25 | M8 | 国家中文标签 + Legend | ⬜ | — | — |
| 26 | M9 | Robinson 投影实现 + 重投影 pipeline | ⬜ | — | — |
| 27 | M9 | 全矢量对齐验证 | ⬜ | — | — |

### Phase 3 — 河流与增强（M10–M11）

| Task | MS | 标题 | 状态 | Commit | 备注 |
|---|---|---|:---:|---|---|
| 28 | M10 | 河流数据 pipeline | ⬜ | — | — |
| 29 | M10 | 流动发光河流 shader | ⬜ | — | — |
| 30 | M11 | 触屏输入接入 | ⬜ | — | — |

### Phase 4 — 可选演进（M12）

| Task | MS | 标题 | 状态 | Commit | 备注 |
|---|---|---|:---:|---|---|
| 31 | M12 | 四叉树流式 LOD | ⬜ | — | — |

---

## Milestone 完成度

| MS | 名称 | Task 完成 | 状态 |
|---|---|---|---|
| M1 | 地形沙盘地基 | 4/6 | 🔄 | +Task 02b 真实 DEM（GEBCO）|
| M2 | 海洋与水彩质感 | 0/3 | ⬜ |
| M3 | 相机交互与自适应质量 | 0/3 | ⬜ |
| M4 | 大洲标签与中文字体 | 0/4 | ⬜ |
| M5 | 大气辉光·加载·署名（MVP 闭环） | 0/3 | ⬜ |
| M6 | 国家边界与描边 | 0/3 | ⬜ |
| M7 | GPU 颜色拾取与交互高亮 | 0/2 | ⬜ |
| M8 | 数据标注面板与国家标签 | 0/2 | ⬜ |
| M9 | 投影升级 Robinson | 0/2 | ⬜ |
| M10 | 河流系统 | 0/2 | ⬜ |
| M11 | 触屏输入与视觉增强 | 0/1 | ⬜ |
| M12 | 四叉树流式 LOD（可选） | 0/1 | ⬜ |

---

## 近期注意事项（Lessons Learned）

> 每个 Task 完成后在此追加 1–2 行踩坑 / 关键决策，供后续会话参考。**倒序**（最新在上）。

- **Task 02b（2026-06-16）**：真实 DEM 接入（GEBCO 2026，替换 Task 02 合成噪声为真实地理）。**关键：Task 02 当初设计的「DemSource 可插拔契约」让本次接入极轻量** —— `lib/heightmap.mjs:generateDem()` 数据源无关、**零改动**；只需新增 `lib/real-dem-source.mjs`（同契约）+ CLI `1-gebco-dem.mjs`（`pnpm gen:dem:real`，保留 `gen:dem` 合成版作离线 fallback）。下游 `src/data/assets.ts` 的 `parseMeta()` 只校验 elevationMin/Max 是有限数、`heightToWorldY(h,meta)` 用 meta 的 scale/offset 算世界 Y → **渲染层（Task 03 加载器 / Task 04 shader）零改动**，meta.json 写入新 bounds 即自动适配。**数据源**：GEBCO_2026（公共域，15″ 海洋陆地一体，equirectangular 原生投影，含 bathymetry → 喂 M2 海洋深浅渐变）；Data GeoTiff（8 tiles 各 90°×90° 或单个全球文件，压缩 ~4GB）放 `scripts/data-pipeline/raw/gebco/`（`.gitignore`，不进 git/构建）。**解析**：纯 JS `geotiff@3.0.5`（免 GDAL）`fromFile→getImage→readRasters({width,height,pool:null})` 降采样 + `getBoundingBox()` 读 tile 经纬范围（**不硬编码切分**）→ 逐 tile 降采样写入全局 Float32 栅格；`pool:null` 主线程解码规避 Node web-worker 兼容问题。**输出**：4096×2048 heightmap；elevationMin/Max 固定 **-10000/9000**（覆盖马里亚纳 -10916 轻微 clamp / 珠峰 8848 完整；16-bit 步长 ≈0.29m；固定值→产物确定可复现，优于实测 min/max）。**采样约定 R3 同源**：`getElevation` 抽 `bilinearSampleElev` 纯函数，逐行对齐 `assets.ts:sampleHeight`（像素中心 `floor(sx-0.5)`/经度环绕/纬度钳制）；6 新单测（含经度环绕、纬度钳制、二维中点），共 **31 测全绿**，lint/build 通过。⚠️ **代码就绪，闭环验证需人工**：① 下载数据→② `pnpm gen:dem:real`（验陆地占比回归 ~29%、KNOWN_POINTS 真实绿、ASCII 预览辨认真实七大洲）→③ `pnpm dev` 看真实大陆/山脉。署名：GEBCO 公共域但 best-practice 署名（Task 18 弹窗含入）。SPEC D2/§12.1 已注明实际数据源。
- **Task 04（2026-06-16）**：GPU 顶点位移地形落地。**PlaneGeometry 对齐（关键）**：`rotation[-90° X]` 后本地 `(x,y,0)`→世界 `(x,0,-y)`；**vertex shader 用 `modelMatrix` 反算 worldPos→经纬度→heightmap UV**（`heightUv = (worldX/PLANE_WIDTH + 0.5, 0.5 + worldZ/PLANE_HEIGHT)`，与 `project()`/`sampleHeight` 同源），**刻意绕开 PlaneGeometry 默认 UV**——其 v 方向与 heightmap（row0=北极）相反，直接用会南北颠倒；**位移加在本地 `position.z`**（旋转后 = 世界 Y）。**DataTexture `flipY=false`**（默认，不翻转），`v=0`→row0=北极，与 CPU `sampleHeight` 一致（已核验无颠倒）。**高度解码照搬 Task 03 契约** `worldY = h·uHeightScale + uHeightOffset`；导出纯函数 `shaderWorldY(h, scale, offset)` 供单测验证 R3 同源 <1e-9。**法线用片元导数** `normalize(cross(dFdx(vWorldPos), dFdy(vWorldPos)))` + `if(N.y<0)N=-N` 保 +Y 朝上（`normal.png` 细节增强留 Task 05/08）。**SPEC §2.2 禁 MeshStandardMaterial** → 自定义 ShaderMaterial 自包含 Lambert 光照（`uLightDir` 暖白俯角 50° + 半球光，无 shadow/无镜面），**raw material 不自动 sRGB encode → 末尾手动 `pow(linear, 1/2.2)`**；`THREE.Color`（ColorManagement enabled）传线性值给 uniform。⚠️ **`react-hooks/immutability` 规则禁止对 `useThree` 返回的 camera 做属性赋值**（`cam.fov=` 报错）→ fov 移至 `<Canvas camera={{fov}}>`，StaticCamera 只用方法（`position.set`/`lookAt`/`updateProjectionMatrix`）。**M1 范围切割**：基础高度分层（海岸→平原→丘陵→山脉→雪线，smoothstep 软过渡）已完成；水彩噪声/坡度强调/软描边/海岸线 fwidth 等高线**留 M2 Task 08**。网格 `TERRAIN_SEGMENTS=512×256`（≈13.2 万顶点，M3 接质量档缩放）；静态相机 pitch 45°/距离 2.5/lookAt 中心（M3 换 SandboxControls）；`camera.ts` 加 `fov:45`+`initialDistance:2.5`。5 新单测，共 25 测全绿，build/lint 通过。**⚠️ dev 视觉 + 浏览器 console error 需人工 Review**（无法在此环境启动浏览器验证 WebGL shader 编译/运行时；已用 build 编译 + GLSL 语法/契约审查 + 逻辑断言最大化保证）。
- **Task 03（2026-06-16）**：投影契约 `project(lon,lat)→[x,z]` 锁定（SPEC §5.1）：`x=lon/180×(PLANE_WIDTH/2)`、`z=−lat/90×(PLANE_HEIGHT/2)`（向北 −z），含反函数 `unproject`。**高度解码契约（R3 CPU/GPU 同源，Task 04 shader 必须照搬）**：`worldY = h·uHeightScale + uHeightOffset`，其中 `uHeightScale=(elevationMax−elevationMin)×HEIGHT_EXAGGERATION×WORLD_Y_PER_METER`、`uHeightOffset=elevationMin×HEIGHT_EXAGGERATION×WORLD_Y_PER_METER`，经 `computeHeightUniforms(meta)→{scale,offset}` 暴露；新增艺术常量 `WORLD_Y_PER_METER=1e-5`（峰值 6500m→+0.1625、海沟 −5000m→−0.125；`HEIGHT_EXAGGERATION=2.5` 是 Task 04 视觉旋钮）。解码 `elev=min+h·(max−min)` 与 Task 02 烘焙公式严格互逆。**16-bit heightmap 加载（M1 最高风险点，已正面解决）**：浏览器原生 Image/canvas 会把 16-bit PNG 降为 8-bit（256 级≈45m/步，破坏精度）→ 用 **fast-png 8.0.0** 在浏览器侧逐字节解码 16-bit 灰度→`Uint16Array`（与 Task 02 大端烘焙一致，fast-png 已转本机序）；**three 0.184 不支持 R16_UNORM**（半浮点损精度破坏 <1e-4；整数纹理 R16UI 仅 NEAREST 会阶梯）→ 上传为 **R32F**（`FloatType+RedFormat`，LINEAR，`RepeatWrapping`/`ClampToEdgeWrapping`，`NoColorSpace`），float32 完整保留 16-bit 精度。**CPU 高度查询表**=对同一 Uint16 缓冲双线性采样（经度环绕/纬度钳制/像素中心约定同 Task 02）再 `heightToWorldY`，与 shader 同源。⚠️ 踩坑：**three 0.184 不自带类型且项目未装 `@types/three`**（Task 01/02 仅用 R3F 未暴露）→ 加 `@types/three@0.184.1`；**fast-png 8.0.0 无类型定义**→ 加 `src/types/fast-png.d.ts` ambient shim。引入 **vitest 4.1.9**，测试置于 `test/`（src 外，不进 `tsc -b` 构建，vitest 经 esbuild 转译）；20 单测全绿（project 边界/采样、高度解码与 uniform 一致性 <1e-9、双线性采样器、真实 16-bit PNG 无损解码 + 海洋<海平面<喜马拉雅、R32F 纹理属性）。
- **Task 02（2026-06-16）**：pngjs 的 16-bit 写入路径不可靠（data buffer 未按 16-bit 分配）→ 改**手写 PNG 编解码器**（`scripts/data-pipeline/lib/png-writer.mjs` / `png-reader.mjs`，纯 node `zlib`+`fs`，已移除 pngjs），并用自解码做**整图 16-bit 往返校验**（零像素不一致）。**输出接口（下游 Task 03 加载器 / Task 04 shader 解码须用同公式）**：`raw16 = round((elevMeters − elevationMin)/(elevationMax − elevationMin) × 65535)`；`meta.json` = `{elevationMin:-5000, elevationMax:6500, seaLevelMeters:0, heightExaggeration:2.5, width:1024, height:512, projection:"equirectangular", source:"synthetic"}`。合成 DEM = 手写大陆多边形 mask（`lib/continents.mjs`，6 大洲+格陵兰+主要岛屿；南极洲按纬度特判）裁剪 simplex 噪声（3D 圆柱映射消除经度接缝，固定种子可复现）。陆地占比 ~37%（高于实际 29%，多边形略膨胀，MVP 可接受）。运行 `pnpm gen:dem`（可 `--width/--height`）；heightmap 720KB / normal 326KB，2.3s 完成。⚠️ 顺带修正：Task 01 PROGRESS 原「MVP 进度 1/5」实为 0/5（尚无 Milestone 完成），已校正。
- **Task 01（2026-06-16）**：`@types/proj4` 已废弃（proj4 自带类型），安装后已移除；其余地理库按需装 `@types/{earcut,topojson-client}`。Vite 模板残留已清理（`App.css` / `src/assets` / `public/icons.svg`），`index.html` 改为中文。`Scene.tsx` 暂为背景色占位（Task 04 起填 Terrain）；config 四件套仅骨架，`project()` 实现留 Task 03。
- _（更早：无）_

---

## 维护规则（给 agent）

1. **每完成一个 Task**：把该行状态改为 ✅，填 commit 短 hash 与备注；更新「当前指针」到下一个 Task；在「近期注意事项」追加经验。
2. **开始一个 Task**：把该行状态改为 🔄（in_progress）；开始前用 `git log` 校验与本表一致。
3. **遇阻**：状态改 ⚠️ blocked，备注写阻塞原因与需要的输入，**停下并问我**。
4. **绝不**跳过未 ✅ 的前置 Task；**绝不**修改本文件来"绕过"依赖。
