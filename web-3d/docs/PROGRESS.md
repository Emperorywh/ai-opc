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

- **当前 Milestone**：M2 · 海洋与水彩质感
- **当前 Task**：Task 08 · 地形水彩 shader 完善
- **MVP 进度**：M1–M5 共 5 个 Milestone，已完成 **1 / 5**（✅ M1 地形沙盘地基闭环）
- **总体进度**：32 个 Task，已完成 **8 / 32**

---

## Task 状态表

图例：⬜ pending ｜ 🔄 in_progress ｜ ✅ done ｜ ⚠️ blocked

### Phase 1 — MVP（M1–M5）

| Task | MS | 标题 | 状态 | Commit | 备注 |
|---|---|---|:---:|---|---|
| 01 | M1 | 项目基础设施与目录骨架 | ✅ | c1e5558 | 骨架：依赖+config四件套+store+空Scene |
| 02 | M1 | 合成 DEM Pipeline（免 GDAL） | ✅ | c4f1a5a | 自写PNG编解码+合成DEM；大陆可辨认；产出 heightmap/normal/meta |
| 02b | M1 | 真实 DEM 接入（GEBCO 2026） | ✅ | 94cce3c | 真实 GEBCO 产物已接入(4096×2048/min-10000/max9000)；闭环由人工下载+gen:dem:real 完成并提交(94f8988+f6bf8a6+94cce3c)，Task 05 补测验证 |
| 03 | M1 | 投影契约与数据加载层 | ✅ | 6f5cbcf | project()+高度解码契约(R3 同源)+16-bit PNG 加载(R32F)+CPU 高度表+vitest 20 测全绿 |
| 04 | M1 | GPU 顶点位移地形 + 基础着色 | ✅ | ef3f8cf | 自定义 ShaderMaterial：R32F heightmap 顶点位移(照搬 Task03 契约)+基础高度分层+Lambert 光照；PlaneGeometry 512×256；静态倾斜相机；25 测全绿 |
| 05 | M1 | M1 闭环验收 | ✅ | 4b406cb | 42测全绿(build/lint过)；真实DEM回归断言(11新)；dev视觉/console error 待人工 Review |
| 06 | M2 | 透明渲染顺序与海洋几何 | ✅ | 0d451e2 | Ocean 平面(同地形尺寸)铺海平面 y=metersToWorldY(seaLevel)；MeshBasicMaterial 半透明 oceanShallow(depthWrite=false/DoubleSide)+renderOrder=1；Scene 挂 Ocean(Terrain 先绘写深度→Ocean 后绘关深度写入)；10 新测断言渲染顺序契约/几何/海平面Y；52测全绿 build/lint 过 |
| 07 | M2 | Gerstner 海洋 shader | ✅ | a75b91e | oceanMaterial MeshBasic占位→自定义ShaderMaterial：Gerstner波(≤5,顶点位移+GPU Gems解析法线B/T→cross→N,N.y<0翻转)+菲涅尔pow(1-dot(N,V),3)掠射偏亮青绿(vViewDir vertex算,cameraPosition为three vertex-only内建)+深浅渐变(per-pixel同源heightmap水深-terrainY/uMaxDepth,浅#7FC4C0→深#2E6E73,vHeightUv用位移前世界坐标→海岸线稳定)+uTime驱动波相位流动；波数uWaveCount uniform开关(M2默认高档qualityConfigs[high].oceanWaves=5,≤0降正弦,M3改uniform不动shader)；透明渲染顺序契约(Task06#1)不退化；体积感由波振幅提供(海平面y=0不变,R3不破坏)；react-hooks/immutability禁useFrame mutate useMemo material→useRef+useEffect同步ref; oceanDepthFactor/oceanFresnel纯函数同源单测; 75测全绿(52→75)build(56mod 295ms)/lint过;⚠️dev视觉/GLSL编译待人工Review;M2 2/3 |
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
| M1 | 地形沙盘地基 | 6/6 | ✅ | 含 Task 02b 真实 DEM（GEBCO 2026）|
| M2 | 海洋与水彩质感 | 2/3 | 🔄 |
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

- **Task 07（2026-06-17）**：Gerstner 海洋 shader（M2 第二 Task）。`oceanMaterial.ts` 由 Task 06 `MeshBasicMaterial` 半透明纯色占位升级为**自定义 ShaderMaterial**，落地 SPEC §6.2 / D8 全部四要素：①**Gerstner 波**（≤5 个，顶点位移 + GPU Gems 1 Ch.1 解析法线：累积 Binormal B/Tangent T → `cross(B,T)` → `if(N.y<0)N=-N` 保 +Y 朝上；GLSL1 `const int MAX_WAVES=5` 定长 uniform 数组 + `for+break` 按 `uWaveCount` 截断；水平位移加本地 x/世界 X、本地 y-=offZ/世界 -Z、本地 z+=dispY/世界 Y）；②**菲涅尔** `pow(1-max(dot(N,V),0),3)` 掠射偏亮青绿 `#BFEDE8`（`vViewDir` 在 vertex 算传 fragment——`cameraPosition` 是 three.js **vertex-only** 内建 uniform，fragment 无）；③**深浅渐变** per-pixel：同源 R32F heightmap 采样 → `terrainY=h·scale+offset`（Task 03 契约）→ `depth=clamp(-terrainY/uMaxDepth,0,1)` → `mix(oceanShallow#7FC4C0, oceanDeep#2E6E73)`（`uMaxDepth=metersToWorldY(2500)=0.0625`；`vHeightUv` 用**位移前**世界坐标算 → 海岸线地理固定，不受波浪水平位移影响）；④**流动**：`uTime` uniform 每帧累加驱动波相位 `w·dot(D,p)+speed·uTime`。**波数开关位（SPEC §8/D18，M3 预留）**：`uWaveCount` uniform + `buildGerstnerWaves(count)`，`count<=0` 降级为 1 个 Q=0 正弦波（§6.2.1「低档减为正弦」）；M2 默认高档 `qualityConfigs[defaultQualityTier=high].oceanWaves=5`，**M3 Task 11 AdaptiveQuality 仅改 uniform value 不动 shader**。**透明渲染顺序契约（Task 06 风险验证#1）保持不退化**：`transparent=true/depthWrite=false/depthTest=true(默认)/DoubleSide/renderOrder=1`（ShaderMaterial 接管材质主体但透明属性不变）。**体积感（§6.2.5）由 Gerstner 波峰/波谷振幅自然提供**（海平面 y=seaLevel=0 不变，不破坏 R3 契约；波幅和<0.05、单波<0.01 世界 Y，≪地形起伏±0.16，柔和浪涌不刺穿陆地）。**踩坑（react-hooks/immutability）**：`useFrame` 回调直接 `material.uniforms.uTime.value+=delta` 被 eslint-plugin-react-hooks v7 `react-hooks/immutability` 规则禁止（`material` 是 useMemo 返回值被视为不可变，Task 04 camera 同类）→ 先试 `matRef.current=material`（render 期间更新 ref）又被 `react-hooks/refs` 拦 → 最终 **`useRef(material)`+`useEffect(()=>{matRef.current=material},[material])` 同步 + useFrame 经 `matRef.current` 更新**（refs 是可变容器，规则放行子属性突变）。**纯函数同源单测（项目惯例）**：`oceanDepthFactor`（深浅 clamp）、`oceanFresnel`（pow 同源）导出供 vitest 验证 GLSL 数学；shader 源码正则断言防回归（`uWaveCount`/`dispY`/`pow(1.0 - max(dot`/`clamp(-terrainY`）。`OCEAN_SEGMENTS=256×128`（Task 06 已为 Gerstner 预留，最短波长≈0.12 世界单位→≈15 格/波长平滑）。新增 **23 测**（Gerstner 波参数各档/方向单位化/振幅递减/波幅尺度、深浅渐变 5 点、菲涅尔 4 点、uniform 波数开关/颜色取自 palette/uTime 初始 0/uMaxDepth/heightmap 复用/shader 源码正则），共 **75 测全绿**（52→75），build(56 modules 295ms)/lint 过。⚠️ **dev 视觉（Gerstner 浪涌/菲涅尔微光/深浅渐变实际观感）+ 浏览器 console（GLSL 编译/运行时、uniform 数组上传、解析法线方向）需人工 Review**（agent 无浏览器，Task 04/05/06 惯例）；`docs/screenshots/M2.png` 待 Task 08 水彩完善后归档。**M2：2/3**。
- **Task 06（2026-06-17）**：透明渲染顺序与海洋几何（M2 首个 Task）。新建 `Ocean.tsx`+`oceanMaterial.ts`：与地形同尺寸(PLANE_WIDTH×PLANE_HEIGHT)平面铺海平面 `y=metersToWorldY(seaLevelMeters)`(=0)，`rotation[-90° X]` 同 Terrain。**SPEC §4.3 透明渲染顺序修正点落地**：Terrain 不透明先绘写深度 → Ocean 透明后绘关深度写入；**关键机制 Ocean `depthTest=true`(MeshBasicMaterial 默认)读 Terrain 已写深度 → 陆地(y>0)遮挡海洋、海床(y<0)被半透明海洋覆盖（海洋不穿地形）**；`renderOrder=1` 保险（Three.js 本已按 transparent 标志自动后绘透明物体）。Task 06 范围切割：`MeshBasicMaterial` 半透明纯色(`oceanShallow #7FC4C0` opacity0.7 DoubleSide)占位，半透明叠加在 terrainMaterial 海床占色(y<0 分支)之上；**Gerstner/菲涅尔/深浅渐变/流动 → Task 07 oceanMaterial.ts**；海平面 y=精确 seaLevel(=0)，Task 07 按 §6.2.5 略低调体积感。**模块拆分（踩坑）**：Ocean.tsx 同时导出组件+常量触发 `react-refresh/only-export-components` lint error → 照 terrain 同构(`Terrain.tsx` 组件 + `terrainMaterial.ts` 常量/函数)拆为 `Ocean.tsx`(只导出组件) + `oceanMaterial.ts`(常量/函数，注释标 Task 07 扩展为 Gerstner 自定义 shader)。`OCEAN_SEGMENTS=256×128`(为 Task 07 Gerstner 顶点位移预留密度，Task 06 平面无位移)。10 新测(`ocean.test.ts`)：几何顶点数/尺寸、渲染顺序契约(transparent/depthWrite/renderOrder/opacity/MeshBasicMaterial 落地 depthTest=true/颜色=palette)、海平面 Y(Task03 契约同源 <1e-9)；共 **52 测全绿**(42→52)，build(54 modules 279ms)/lint 过。⚠️ dev 视觉(海洋是否真不穿地形、半透明纵深观感)**需人工 Review**(agent 无浏览器，Task 04/05 惯例)；`docs/screenshots/M2.png` 待 Task 08 水彩完善后归档。**M2 启动：1/3**。
- **Task 05（2026-06-17）**：M1 闭环验收。**修复 Task 02b 遗留**：真实 GEBCO 产物(4096×2048)替换合成 DEM 后，`test/assets.test.ts` 的 meta 解析测试仍硬编码旧合成值(1024×512/-5000/6500) → 改为 **round-trip**（解析值 = 真实 meta 原值，数据源无关，Task 02b 可插拔契约兑现）。**新增「真实 GEBCO DEM 回归」11 测**：6 陆地 + 4 海洋代表点高程符号正确（陆地用明确内陆点避开海岸双线性跨海——纽约 -74,40.7 落 -0.5m 近海已弃用，换北美中部 -98,41）；全图极值断言 `maxM>7000 & minM<-9000`，基于 elevationMin/Max **硬上下界物理严格区分真实 vs 合成**（合成 min-5000/max6500 物理上触不到）。**⚠️ 关键数据发现**：GEBCO 4096×2048 降采样(~9.8km/px)后珠峰区最高点仅 **7628m**（非 8848），是邻域平均的分辨率损失、**非数据错误**；minM=-10000（海沟 clamp 到 elevationMin，raw16=0）。**验收**：42 测全绿(31→42，修1+增11)、`pnpm build` 通过(52 modules, 322ms)、lint 无错。M1 五条验收全覆盖：顶点数/最大高差(terrain.test)、project()(13测)、CPU/GPU 误差<1e-4(实<1e-9)、真实+合成 DEM 大陆轮廓可辨认(多点回归)、dev 无 console error **需人工 Review**(Task 04 已立惯例，agent 环境无浏览器)。palette 完整接入/S 降饱和留 M2 Task 08，相机/光照 Task 04 已定不动。⚠️ `docs/screenshots/M1.png` 截图待人工 `pnpm dev` 归档。**M1 闭环完成 → M1 ✅(6/6)，MVP 1/5**。
- **Task 02b 闭环确认（2026-06-17）**：Task 02b 此前标 🔄「代码就绪待下载」，**实际闭环已由人工完成并提交**（94f8988 代码 + f6bf8a6 版本同步 2024→2026 + 94cce3c 烘焙产物）：`public/data/` heightmap.png 11.7MB / normal.png 12.1MB（合成版 738KB/333KB），meta.json `source:gebco-2026` 4096×2048 min-10000/max9000。Task 05 跑测试时发现 PROGRESS 落后实际进度（产物已替换、测试 fixture 未同步）→ 本次补记 ✅ 并修测试。**渲染层零改动再次验证**：Terrain/terrainMaterial/projection 全从 meta 读 min/max/尺寸，真实 DEM 替换无需改渲染代码（R1/R3 兑现）。
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
