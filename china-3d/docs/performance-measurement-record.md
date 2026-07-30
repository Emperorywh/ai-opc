# 4K 大屏性能预算与测量记录（TASK-015）

本记录是 TASK-015「长时运行稳定性与性能档位」的显式交付物之一（SPEC §7.2 / §7.3 / §7.4 / §12.9 /
§12.10 / §13：DPR 上限、性能档位 2048² 默认 / 4096² 上限、context lost 恢复、resize 防抖、无运行时
几何分配循环）。

> **状态总览（2026-07-30）**：
> - 性能预算**已固化**为唯一事实源 `src/config/render-budget.ts`（DPR 上限、渲染目标尺寸、显存预算、
>   draw call 预算、4096² 显式可选策略、无运行时流式 / 低清 fallback、逐帧分配禁止），并由
>   `tests/render-budget.test.ts` 在 Node 环境断言全部不变量。页面装配 `src/App.tsx` 的 Canvas `dpr`
>   已改为配置驱动（`[RENDER_BUDGET_CONFIG.dprMin, RENDER_BUDGET_CONFIG.dprMax]` = `[1, 2]`）。
> - 长时运行稳定性（SPEC §7.4）**已交付**：`src/three/RuntimeLifecycleController.tsx`（context 丢失 /
>   恢复 + resize 防抖的唯一集中编排器）、`src/lib/runtime-lifecycle.ts`（确定性状态机 + 防抖纯变换）、
>   `src/three/gpu-resource-restore.ts`（GPU 资源重建遍历）、`src/components/ui/RuntimeStatusOverlay.tsx`
>   （DOM 状态提示），由 `tests/runtime-lifecycle.test.ts` / `tests/gpu-resource-restore.test.ts` 在
>   Node 环境断言状态机 / 防抖 / 重建遍历不变量，并经无头 Chrome（SwiftShader）端到端验证（见 §5）。
> - **目标独显设备上的 1080p / 4K 持续 60fps 验收尚未执行**——真机帧率无法在本执行环境实测
>   （无独显 / 无 4K 屏），由用户在目标环境手动执行后回填本记录。下方三档（1080p 默认 / 4K 默认 /
>   4096² 可选）标记为 `pending`。存在 `pending` 档时，目标设备帧率验收处于未完成状态（非阻塞代码
>   交付，但阻塞「目标设备达 SPEC 持续 ≥60fps」的完成标准）。

---

## 1. 性能预算固化（已完成，自动化验证）

性能预算的唯一事实源是 `src/config/render-budget.ts`（`RENDER_BUDGET_CONFIG`，冻结）。下表逐项对应
SPEC / TASK-015 的预算要求与代码锚点，所有不变量由 `tests/render-budget.test.ts` 在 Node 环境断言。

| 预算项 | 值 | SPEC / TASK-015 锚点 | 代码锚点 |
|---|---|---|---|
| DPR 上限 | 2（含） | §7.3、TASK-015 验收 3 | `RENDER_DPR_MAX` / `RENDER_BUDGET_CONFIG.dprMax` |
| DPR 下限 | 1（含） | §7.3 | `RENDER_DPR_MIN` / `RENDER_BUDGET_CONFIG.dprMin` |
| 1080p 渲染目标 | 1920×1080 | §2、§12.9 | `RENDER_TARGET_1080P` |
| 4K 渲染目标 | 3840×2160 | §2、§12.9 | `RENDER_TARGET_4K` |
| heightmap 纹理源数据 | 4096²·2 ≈ 32MB | §7.2 | `HEIGHTMAP_TEXTURE_BYTES_EXPECTED` |
| 默认档（2048²）顶点 | ≈ 4.19M | §7.2 | `PLANE_VERTEX_COUNT_DEFAULT` |
| 默认档 plane 几何 | ≈ 134MB | §7.2（保守估 100MB） | `PLANE_GEOMETRY_BYTES_DEFAULT` |
| 上限档（4096²）顶点 | ≈ 16.78M | §7.2 | `PLANE_VERTEX_COUNT_UPPER` |
| 上限档 plane 几何 | ≈ 537MB | §7.2（保守估 400MB，临界） | `PLANE_GEOMETRY_BYTES_UPPER` |
| 省界 draw call 预算 | ≤ 34（每行政区一个 drei Line） | §3.6、§7.2 | `PROVINCE_BORDER_DRAW_CALL_BUDGET` |
| 十段线 draw call 预算 | ≤ 12（每段一个 drei Line） | §5.3、§7.2 | `NINE_DASH_LINE_DRAW_CALL_BUDGET` |
| 4096² 自动升级 | **禁止**（`false`） | §7.2「实测帧率后决定」 | `UPPER_TIER_AUTO_UPGRADE_ENABLED` |
| 运行时流式网络 | **禁止**（`false`） | §7.3「无流式加载」 | `RUNTIME_STREAMING_ENABLED` |
| 自动低清 fallback | **禁止**（`false`） | TASK-015 完成标准 | `AUTO_LOW_RES_FALLBACK_ENABLED` |
| 逐帧分配 | **禁止**（`true` 不变量） | §7.4 | `PER_FRAME_ALLOCATION_FORBIDDEN` |
| 遮挡降频帧间隔 | 6（每 6 useFrame 帧判一次） | §7.5、TASK-010 | `LABEL_OCCLUSION_CONFIG.checkFrameInterval` |
| context 恢复超时 | 8000ms | §7.4 | `RUNTIME_LIFECYCLE_CONFIG.contextRestoreTimeoutMs` |
| resize 防抖窗口 | 160ms | §7.4 | `RUNTIME_LIFECYCLE_CONFIG.resizeDebounceMs` |

**DPR 上限落地方式（SPEC §7.3「Math.min(devicePixelRatio, 2)」）**：`App.tsx` 的 Canvas
`dpr={[RENDER_BUDGET_CONFIG.dprMin, RENDER_BUDGET_CONFIG.dprMax]}`（= `[1, 2]`），R3F 在区间内取
`Math.min(devicePixelRatio, dprMax)`——4K 屏 DPR 3 时绘制缓冲仍按 2 缩放（无头验证 §5.6 实测
deviceScaleFactor=3 下 canvas = 900×600 CSS → 1800×1200 缓冲，非 2700×1800）。

**性能档位切换（SPEC §7.2「通过配置项暴露」）**：生产默认 2048²（`PRODUCTION_TERRAIN_CONFIG`）；
4096² 上限档经 `?terrainSegments=4096` URL 覆盖启用（统一走 `resolveTerrainConfigOrThrow` 校验，
非法值确定性抛错），无任何「检测 GPU / 帧率后自动升级」路径
（`UPPER_TIER_AUTO_UPGRADE_ENABLED = false`）。

---

## 2. 逐帧分配 / 资源复用审计（无运行时几何分配循环的审计结论，SPEC §7.4、TASK-015 验收 4）

审计范围：全部 `useFrame` 回调（`ChinaTerrainMesh` / `SeaSurface` / `ProvinceBorders` /
`PoliticalFeatures` / `PlaceLabels` / `EntranceController`）、运行时编排器
（`RuntimeLifecycleController`）与资产加载 hook（`useHeightmap` 等）。审计日期 2026-07-30。

### 2.1 逐帧分配（`PER_FRAME_ALLOCATION_FORBIDDEN` 守护）

| 渲染层 | useFrame 内操作 | 是否分配 | 审计结论 |
|---|---|---|---|
| `ChinaTerrainMesh` | `materialRef.current.uniforms.uRise.value = computeTerrainRise(...)`（标量赋值） | 否 | ✅ 仅写既有 uniform 标量 |
| `SeaSurface` | `uniforms.uTime.value = ...` / `uniforms.uOpacity.value = ...`（标量赋值） | 否 | ✅ 仅写既有 uniform 标量 |
| `ProvinceBorders` | `for (material of materialsRef.current) material.opacity = ...`（标量赋值） | 否 | ✅ 仅写既有材质 opacity |
| `PoliticalFeatures` | 同上（标量赋值） | 否 | ✅ 仅写既有材质 opacity |
| `PlaceLabels` | `handle.fillOpacity = damp(...)`（标量赋值）；遮挡判定每 6 帧一次 | 否 | ✅ 仅写既有 troika fillOpacity；目标 / 当前透明度数组挂载期一次性分配 |
| `EntranceController` | 写共享 `entranceFrameRef.current`（原地写两个标量）+ 暂停时长折叠（标量加减） | 否 | ✅ 仅原地写既有 ref 字段 |
| `RuntimeLifecycleController` | 无 useFrame；事件处理器内原地写 `runtimeFrame.current` 两个标量 + 纯状态迁移 | 否 | ✅ 无逐帧路径；stateRef / debouncerRef 挂载期一次创建 |

全部 `new THREE.*` 调用（`Vector2` / `Vector3` / `DataTexture` / `PlaneGeometry` 等）均在 `useMemo`
内（挂载期一次，依赖稳定常量 / 引用稳定的 props），**不在任何 `useFrame` 回调内**。视觉时钟统一由
R3F 共享 `clock` 承载（`state.clock.getElapsedTime()`），全 src 无任何 `new THREE.Clock()`（水面 /
入场共用同一时钟，SPEC §7.4「动画时钟统一」）；`RuntimeLifecycleController` 的 `setTimeout` 仅两条
路径（context 恢复超时 + resize 防抖，生命周期定时，非视觉时钟），由
`tests/runtime-lifecycle.test.ts` 源码扫描锁定。

### 2.2 资源复用（无重复所有权）

| 资源 | 加载点 | 所有权 | 共享方式 |
|---|---|---|---|
| heightmap GPU 纹理（float32 DataTexture） | `useHeightmap` → `loadHeightmapTexture`（一次，模块级 Promise 去重） | `App` | 经 props 下发 `ChinaTerrainMesh`（单份） |
| heightmap CPU pixels（Uint16Array ≈ 32MB） | 同上（构造纹理时已解码） | 同上 | `TerrainSceneLayers` 统一构造**一份**共享 `ElevationProvider`，省界 / 标签 / 政治要素层共用（零额外 32MB） |
| ramp DataTexture（256×1 色阶） | `ChinaTerrainMesh` `useMemo` | `ChinaTerrainMesh` | 单份，挂载期一次 |
| 省界 / 十段线 / 岛礁 / 标签几何 | 各层 `useMemo`（依赖领域产物） | 各渲染层 | k 切换时确定性重算（一次性，~毫秒级），非每帧 |

context 丢失 / 恢复时（TASK-015），`restoreSceneGpuResources` 遍历场景把全部纹理 / 材质置
`needsUpdate=true`，Three.js 从**同一份 CPU 源**（`.data` / `.image`）重新上传 GPU——**绝不重新
fetch / 重新解码** `.r16`（GPU 资源恢复与 CPU 领域数据生命周期分离；
`tests/gpu-resource-restore.test.ts` 锁定「`.image.data` 引用遍历前后不变」）。

### 2.3 draw call 结构性计数

| 渲染层 | 结构性 draw call 数 | 说明 |
|---|---|---|
| 地形 mesh | 1 | 单 ShaderMaterial plane（GPU 位移） |
| 海面 | 1 | 单 ShaderMaterial plane（片元波动） |
| 省级边界 | ≤ 34 | 每行政区一个 drei Line（TASK-009 分组 / hover 寻址） |
| 十段线 | ≤ 12 | 每段一个 drei Line（TASK-011 按段独立审计，生产 10 段） |
| 岛礁光点 | 5 | 每岛礁一个发光球体（TASK-011，数量由政治边界契约决定） |
| 省名 Billboard | 34 | 每省一个 troika Text（TASK-010） |
| 省会光点 | 34 | 每省会一个球体（TASK-010） |
| 省会名小字 | 34 | 每省会一个 troika Text（hover 呈现，TASK-010） |
| 不可见拾取面 | 1 | `ProvinceHoverPicker`（opacity 0 + colorWrite false，无可见像素） |

**结论**：draw call 数量结构性受控（省界 / 十段线因 hover 寻址 / 审计需求按组 / 按段独立，是受控
权衡，非冗余）。运行时实测 draw call 数由人工在目标设备用 WebGL Inspector / Spector.js 测量后
回填 §4。

### 2.4 审计总结论

**无运行时几何分配循环**：全部几何 / 纹理在启动期（挂载期 useMemo / 资产 hook 一次性加载）建好；
全部逐帧路径只写既有标量字段；无逐帧 `new THREE.*`、无逐帧大数组分配、无第二份 Clock。GC 抖动与
泄漏的结构性来源不存在（SPEC §7.4）。

---

## 3. 测量环境模板（用户在目标设备手动填写）

> 以下字段由用户在目标独显设备执行 `pnpm build` + `pnpm preview`（或等价生产构建服务）后，按
> SPEC §12.9 / §12.10 手动采样并回填。本 TASK 不自动启动浏览器、不自动测量。

### 3.1 目标设备与环境

| 字段 | 值 |
|---|---|
| GPU 型号（独显） | _待填_ |
| GPU 驱动版本 | _待填_ |
| 显存（GB） | _待填_ |
| CPU 型号 | _待填_ |
| 内存（GB） | _待填_ |
| 浏览器（名称 + 版本） | _待填_ |
| 操作系统 | _待填_ |
| 屏幕物理分辨率 | _待填_ |
| 浏览器窗口 / Canvas 尺寸 | _待填_ |
| 实际 DPR（`devicePixelRatio`） | _待填_ |
| 应用 DPR 上限（钳制后） | 2（`RENDER_DPR_MAX`） |
| 生产网格档位 | 2048²（`PRODUCTION_TERRAIN_CONFIG`） |
| 垂直夸张 k | 2.0（默认） |
| 采样工具 | _待填（如浏览器 DevTools Performance / Spector.js / stats.js）_ |
| 采样时长（秒） | _待填_ |
| 采样日期 | _待填_ |
| 采样人 | _待填_ |

### 3.2 验收判定标准（SPEC §12.9 / §12.10）

- **通过**：稳定 ≥ 60fps（采样期间第 5 百分位 fps ≥ 60，无持续掉帧），且内存 / draw call 无持续增长。
- **未达标**：稳定 < 60fps——必须基于测量记录选择以下决策之一并记录：
  1. 将该场景显式标记为「可选档位 / 未达标」，默认仍保持 1080p 或 2048² 配置；
  2. 在**不**隐藏地图要素 / **不**缩小渲染尺寸的前提下，启用已批准优化（如进一步降低 DPR 上限、
     提高遮挡降频间隔、减少边界 draw call 分组）并重新测量；
  3. 保持本 TASK 阻塞，直至目标硬件或渲染方案调整后再验收。
- **禁止**：以自动降低生产默认网格精度（< 2048²）、隐藏必要地图要素、运行时网络低清 fallback
  伪造通过（`AUTO_LOW_RES_FALLBACK_ENABLED = false` 结构性锁定）。

---

## 4. 三档测量结果（用户手动执行后回填）

> 每档须按以下方法执行：**不能只测静止空闲帧**——4K 档须同时旋转相机、经过密集标签区（京津沪港澳）
> 和南海区域。采样方法：打开页面 → 等入场完成（interactive）→ 开始采样 ≥ 60 秒（含主动旋转 /
> 缩放 / 经过密集标签区）→ 记录平均 / 第 5 百分位 / 最低 fps 与显存可观测值 → 再静置 ≥ 30 分钟
> 记录内存趋势（长时运行稳定性）。

### 4.1 1080p 默认档（2048²）

| 字段 | 值 |
|---|---|
| 分辨率 | 1920×1080 |
| DPR | _待填（≤ 2）_ |
| 网格档位 | 2048² |
| 采样时长（秒） | _待填_ |
| 平均 fps | _待填_ |
| 第 5 百分位 fps | _待填_ |
| 最低 fps | _待填_ |
| 显存占用（可观测，MB） | _待填_ |
| 关键 draw call 实测数（地形 / 海面 / 省界 / 十段线 / 标签） | _待填_ |
| 长时间运行（≥ 30 分钟）内存趋势 | _待填（无持续增长 / 有增长）_ |
| 是否旋转相机 + 经过密集标签区 + 南海区域采样 | _待填_ |
| 结果 | pending |
| 未决项 / 决策 | _待填_ |

### 4.2 4K 默认档（2048²）

| 字段 | 值 |
|---|---|
| 分辨率 | 3840×2160 |
| DPR | _待填（≤ 2）_ |
| 网格档位 | 2048² |
| 采样时长（秒） | _待填_ |
| 平均 fps | _待填_ |
| 第 5 百分位 fps | _待填_ |
| 最低 fps | _待填_ |
| 显存占用（可观测，MB） | _待填_ |
| 关键 draw call 实测数 | _待填_ |
| 长时间运行（≥ 30 分钟）内存趋势 | _待填_ |
| 是否旋转相机 + 经过密集标签区 + 南海区域采样（4K 档强制） | _待填_ |
| 结果 | pending |
| 未决项 / 决策 | _待填_ |

### 4.3 4096² 可选档（显式启用）

> 默认**不启用**（`UPPER_TIER_AUTO_UPGRADE_ENABLED = false`）。仅在 §4.1 / §4.2 达标后，以
> `?terrainSegments=4096` URL 覆盖（或上层显式注入 `meshSegments = 4096`）启用。不满足预算时保持
> 为未启用可选档。

| 字段 | 值 |
|---|---|
| 是否启用（显式覆盖 4096） | _待填_ |
| 分辨率 | _待填_ |
| DPR | _待填（≤ 2）_ |
| 网格档位 | 4096² |
| 采样时长（秒） | _待填_ |
| 平均 fps | _待填_ |
| 第 5 百分位 fps | _待填_ |
| 显存占用（可观测，MB） | _待填_ |
| 长时间运行内存趋势 | _待填（无持续增长 / 有增长）_ |
| 结果 | pending（未启用 / 已测达标 / 已测未达标） |
| 决策（未达标时） | _待填_ |

---

## 5. 无头环境验证记录（TASK-015 交付时执行，2026-07-30）

真机 4K 帧率无法在本执行环境实测（无独显 / 无 4K 屏），以下验证在**无头 Chrome（SwiftShader 软件
渲染）+ 生产构建（`pnpm build` + `vite preview`）**下完成，作为「稳定性逻辑与档位切换」的端到端
证据（不作为帧率证据——SwiftShader 是软件渲染，帧率无意义）。方法：puppeteer-core 驱动系统
Chrome，页面内以 `WEBGL_lose_context` 扩展真实触发 `webglcontextlost` / `webglcontextrestored`
事件，DOM 断言状态提示、rAF 内 `readPixels` 断言渲染继续 / 冻结、视口变更断言防抖后尺寸与相机
aspect（高原亮区质心做相机探针）、`deviceScaleFactor=3` 断言 DPR 钳制。全部 11 项通过：

| # | 验证项 | 结果 |
|---|---|---|
| 5.1 | running 态无运行时 overlay（正常渲染不干扰画布） | ✅ overlay 不存在 |
| 5.2 | 基线渲染有效（海面区域非背景像素 lit=19240） | ✅ |
| 5.3 | `loseContext()` → context-lost 状态提示 overlay 出现（「图形上下文丢失」） | ✅ 标题逐字命中 |
| 5.4 | `restoreContext()` → overlay 消失（回到 running），海面区域像素随时间继续变化（渲染恢复，校验和 36035251→36046856） | ✅ |
| 5.5 | 第二轮丢失 / 恢复循环同样成立（重复循环稳定，无累加状态） | ✅ |
| 5.6 | resize 1920×1080 → 1440×1080（16:9→4:3）：防抖后绘制缓冲 = 1440×1080（DPR=1）；高原质心归一化 x 0.4354→0.4139 左移、y 不变（0.4436→0.4436）——相机 aspect 已随提交尺寸更新（滞留旧 aspect 则 x 不变） | ✅ |
| 5.7 | DPR 上限：`deviceScaleFactor=3` 下绘制缓冲 = 900×600 CSS ×2 = 1800×1200（非 ×3 = 2700×1800） | ✅ |
| 5.8 | `?terrainSegments=4096` 上限档经配置切换可渲染（小视口非背景像素 lit=43685，无 pageerror） | ✅ |
| 5.9 | 全程无 pageerror / 无整页错误 | ✅ |

> 注：context-lost 期间各渲染层冻结视觉推进（EntranceController 冻结入场 elapsed 并折叠暂停时长、
> SeaSurface 冻结 uTime）的数值断言由 `tests/runtime-lifecycle.test.ts` 在 Node 环境锁定（状态机
> `isRuntimePaused` + 源码扫描消费接线）；恢复后截图目视确认地形 / 省界 / 标签 / 图例 / 合规角标 /
> 南海附图全部完好（GPU 资源从同一份 CPU 源重建）。

---

## 6. 回退边界

回退本 TASK（TASK-015）只会移除：运行时生命周期层（`src/three/RuntimeLifecycleController.tsx`、
`src/three/gpu-resource-restore.ts`、`src/lib/runtime-lifecycle.ts`、`src/config/runtime-lifecycle.ts`、
`src/components/ui/RuntimeStatusOverlay.tsx`）、性能预算配置（`src/config/render-budget.ts`）、
`App.tsx` 的配置驱动 DPR（回到硬编码 `[1, 2]`，视觉行为不变但失去唯一事实源与自动化锚点）、
EntranceController / SeaSurface 的 runtimeFrame 暂停消费，以及本测量记录。TASK-001～TASK-014 的
完整功能保留，但重新处于「长时运行稳定性与性能目标未验收」状态。
