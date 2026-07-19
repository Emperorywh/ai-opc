# 4K 大屏性能预算与测量记录（TASK-023）

本记录是 TASK-023「固化 4K 大屏性能预算」的显式交付物之一（SPEC §7.2 / §7.3 / §7.4 / §12.9 / §12.10 /
§13、TASK-023 输出「记录目标设备 GPU、浏览器、分辨率、DPR、网格档位、稳定采样时长、fps 分布、显存
可观测指标和关键 draw call」）。

> **状态总览（2026-07-20）**：性能预算**已固化**为唯一事实源 `src/config/render-budget.ts`（DPR 上限、
> 渲染目标尺寸、显存预算、draw call 预算、4096² 显式可选策略、无运行时流式 / 低清 fallback、逐帧分配
> 禁止），并由 `tests/render-budget.test.ts` 在 Node 环境断言全部不变量（TASK-023 验证方式 1）。场景装配
> `src/scenes/ChinaMapScreen.tsx` 的 Canvas `dpr` 已改为配置驱动（`[RENDER_BUDGET_CONFIG.dprMin,
> RENDER_BUDGET_CONFIG.dprMax]` = `[1, 2]`）。
>
> **目标独显设备上的 1080p / 4K 持续 60fps 验收（TASK-023 验证方式 3、4、5）尚未执行**——本 TASK 不自动
> 启动浏览器，性能测量由用户在目标环境手动执行后回填本记录。下方三档（1080p 默认 / 4K 默认 / 4096² 可选）
> 标记为 `pending`。存在 `pending` 档时，目标设备帧率验收处于未完成状态（非阻塞代码交付，但阻塞
> 「目标设备达 SPEC 持续 ≥60fps」的完成标准）。

---

## 1. 性能预算固化（已完成，自动化验证）

性能预算的唯一事实源是 `src/config/render-budget.ts`（`RENDER_BUDGET_CONFIG`，冻结）。下表逐项对应
SPEC / TASK-023 的预算要求与代码锚点，所有不变量由 `tests/render-budget.test.ts` 在 Node 环境断言。

| 预算项 | 值 | SPEC / TASK-023 锚点 | 代码锚点 |
|---|---|---|---|
| DPR 上限 | 2（含） | §7.3、TASK-023 输出 | `RENDER_DPR_MAX` / `RENDER_BUDGET_CONFIG.dprMax` |
| DPR 下限 | 1（含） | §7.3 | `RENDER_DPR_MIN` / `RENDER_BUDGET_CONFIG.dprMin` |
| 1080p 渲染目标 | 1920×1080 | §2、TASK-023 输出 | `RENDER_TARGET_1080P` |
| 4K 渲染目标 | 3840×2160 | §2、TASK-023 输出 | `RENDER_TARGET_4K` |
| heightmap 纹理源数据 | 4096²·2 ≈ 32MB | §7.2 | `HEIGHTMAP_TEXTURE_BYTES_EXPECTED` |
| 默认档（2048²）顶点 | ≈ 4.19M | §7.2 | `PLANE_VERTEX_COUNT_DEFAULT` |
| 默认档 plane 几何 | ≈ 134MB | §7.2（保守估 100MB） | `PLANE_GEOMETRY_BYTES_DEFAULT` |
| 上限档（4096²）顶点 | ≈ 16.78M | §7.2 | `PLANE_VERTEX_COUNT_UPPER` |
| 上限档 plane 几何 | ≈ 537MB | §7.2（保守估 400MB，临界） | `PLANE_GEOMETRY_BYTES_UPPER` |
| 省界 draw call 预算 | ≤ 34（每行政区一个 LineSegments2） | §3.6、§7.2 | `PROVINCE_BORDER_DRAW_CALL_BUDGET` |
| 十段线 draw call 预算 | ≤ 12（每段一个 LineSegments2） | §5.3、§7.2 | `NINE_DASH_LINE_DRAW_CALL_BUDGET` |
| 4096² 自动升级 | **禁止**（`false`） | TASK-023 输出 | `UPPER_TIER_AUTO_UPGRADE_ENABLED` |
| 运行时流式网络 | **禁止**（`false`） | TASK-023 输出 | `RUNTIME_STREAMING_ENABLED` |
| 自动低清 fallback | **禁止**（`false`） | TASK-023 输出 | `AUTO_LOW_RES_FALLBACK_ENABLED` |
| 逐帧分配 | **禁止**（`true` 不变量） | TASK-023 输出 | `PER_FRAME_ALLOCATION_FORBIDDEN` |
| 遮挡降频帧间隔 | 6（每 6 useFrame 帧判一次） | §7.5、TASK-017 | `LABEL_OCCLUSION_CONFIG.checkFrameInterval` |

---

## 2. 逐帧分配 / 资源复用审计（代码审查结论，TASK-023 输出「对逐帧……审计」）

审计范围：全部 `useFrame` 回调（`ChinaTerrainMesh` / `SeaSurface` / `ProvinceBorders` /
`PoliticalFeatures` / `PlaceLabels` / `EntranceController`）与资产加载 hook（`useHeightmap` 等）。

### 2.1 逐帧分配（`PER_FRAME_ALLOCATION_FORBIDDEN` 守护）

| 渲染层 | useFrame 内操作 | 是否分配 | 审计结论 |
|---|---|---|---|
| `ChinaTerrainMesh` | `uniforms.uRise.value = computeTerrainRise(...)`（标量赋值） | 否 | ✅ 仅写既有 uniform 标量 |
| `SeaSurface` | `uniforms.uTime.value = ...` / `uniforms.uOpacity.value = ...`（标量赋值） | 否 | ✅ 仅写既有 uniform 标量 |
| `ProvinceBorders` | `for (material of materialsRef.current) material.opacity = ...`（标量赋值） | 否 | ✅ 仅写既有材质 opacity |
| `PoliticalFeatures` | 同上（标量赋值） | 否 | ✅ 仅写既有材质 opacity |
| `PlaceLabels` | `handle.fillOpacity = damp(...)`（标量赋值）；遮挡判定每 6 帧一次 | 否 | ✅ 仅写既有 troika fillOpacity；目标 / 当前透明度数组挂载期一次性分配 |
| `EntranceController` | 写共享 `entranceFrameRef.current`（原地写两个标量） | 否 | ✅ 仅原地写既有 ref 字段 |

全部 `new THREE.*` 调用（`Vector2` / `Vector3` / `DataTexture` 等）均在 `useMemo` 内（挂载期一次，
依赖稳定常量 / 引用稳定的 props），**不在任何 `useFrame` 回调内**。视觉时钟统一由 R3F 共享 `clock`
承载（`state.clock.getElapsedTime()`），无任何 `new THREE.Clock()`。

### 2.2 资源复用（无重复所有权）

| 资源 | 加载点 | 所有权 | 共享方式 |
|---|---|---|---|
| heightmap GPU 纹理（float32 DataTexture） | `useHeightmap` → `loadHeightmapTexture`（一次） | `ChinaMapScreen` | 经 props 下发 `TerrainLayer` → `ChinaTerrainMesh`（单份） |
| heightmap CPU pixels（Uint16Array ≈ 32MB） | 同上（构造纹理时已解码） | 同上 | 各层各自 `createElevationProvider(meta, pixels)` 包装，**共享同一份 pixels**（零额外 32MB） |
| ramp DataTexture（256×1 色阶） | `ChinaTerrainMesh` `useMemo` | `ChinaTerrainMesh` | 单份，挂载期一次 |
| 省界 / 十段线 / 岛礁 / 标签几何 | 各 `useMemo`（依赖领域产物） | 各渲染层 | k 切换时确定性重算（一次性，~毫秒级），非每帧 |

context 丢失 / 恢复时（TASK-022），`restoreSceneGpuResources` 遍历场景把全部纹理 / 材质置
`needsUpdate=true`，Three.js 从**同一份 CPU 源**（`.data` / `.image`）重新上传 GPU——**绝不重新
fetch / 重新解码** `.r16`（GPU 资源恢复与 CPU 领域数据生命周期分离）。

### 2.3 draw call 结构性计数

| 渲染层 | 结构性 draw call 数 | 说明 |
|---|---|---|
| 地形 mesh | 1 | 单 ShaderMaterial plane（GPU 位移） |
| 海面 | 1 | 单 ShaderMaterial plane（片元波动） |
| 省级边界 | ≤ 34 | 每行政区一个 LineSegments2（TASK-014 分组 / TASK-018 hover 寻址） |
| 十段线 | ≤ 12 | 每段一个 LineSegments2（TASK-015 按段独立审计） |
| 岛礁光点 | 每岛礁一个 mesh | 数量由政治边界契约决定（TASK-015） |
| 省名 / 岛礁名 Billboard | 每标签一个 | 数量由地点 / 政治契约决定（TASK-016） |
| 省会光点 | 每省会一个球体 | 34（TASK-016） |
| 不可见拾取面 | 1 | `ProvinceHoverPicker`（opacity 0 + colorWrite false，无可见像素） |

**结论**：draw call 数量结构性受控（省界 / 十段线因 hover 寻址 / 审计需求按组 / 按段独立，是受控权衡，
非冗余）。运行时实测 draw call 数由人工在目标设备用 WebGL Inspector / Spector.js 测量后回填 §4。

---

## 3. 测量环境模板（用户在目标设备手动填写）

> 以下字段由用户在目标独显设备执行 `pnpm build` + `pnpm preview`（或等价生产构建服务）后，按
> TASK-023 验证方式 3、4、5 手动采样并回填。本 TASK 不自动启动浏览器、不自动测量。

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

### 3.2 验收判定标准（SPEC §12.9 / §12.10、TASK-023 完成标准）

- **通过**：稳定 ≥ 60fps（采样期间第 5 百分位 fps ≥ 60，无持续掉帧），且内存 / draw call 无持续增长。
- **未达标**：稳定 < 60fps——必须基于测量记录选择以下决策之一并记录（TASK-023 完成标准）：
  1. 将该场景显式标记为「可选档位 / 未达标」，默认仍保持 1080p 或 2048² 配置；
  2. 在**不**隐藏地图要素 / **不**缩小渲染尺寸的前提下，启用已批准优化（如进一步降低 DPR 上限、提高
     遮挡降频间隔、减少边界 draw call 分组）并重新测量；
  3. 保持本 TASK 阻塞，直至目标硬件或渲染方案调整后再验收。
- **禁止**：以自动降低生产默认网格精度（< 2048²）、隐藏必要地图要素、运行时网络低清 fallback 伪造通过。

---

## 4. 三档测量结果（用户手动执行后回填）

> 每档须按 TASK-023 验证方式 3 / 4 / 5 执行：**不能只测静止空闲帧**——4K 档须同时旋转相机、经过密集
> 标签区（京津沪港澳）和南海区域。

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
| 是否旋转相机 + 经过密集标签区 + 南海区域采样（TASK-023 验证方式 4 强制） | _待填_ |
| 结果 | pending |
| 未决项 / 决策 | _待填_ |

### 4.3 4096² 可选档（显式启用，TASK-023 验证方式 5）

> 默认**不启用**（`UPPER_TIER_AUTO_UPGRADE_ENABLED = false`）。仅在 §4.1 / §4.2 达标后，由上层显式以
> `initialConfig.meshSegments = 4096` 注入 `ChinaMapScreen` 时启用。不满足预算时保持为未启用可选档。

| 字段 | 值 |
|---|---|
| 是否启用（显式注入 4096） | _待填_ |
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

## 5. 回退边界

回退本 TASK（TASK-023）只会移除最终性能预算配置（`src/config/render-budget.ts`）、必要调优
（`ChinaMapScreen.tsx` 的配置驱动 DPR）和本测量记录；TASK-022 的完整功能与恢复能力仍保留，但重新
处于性能目标未验收状态（TASK-023 回退边界）。回退后 Canvas `dpr` 回到硬编码 `[1, 2]`（视觉行为不变，
但 DPR 上限失去唯一事实源与自动化锚点）。
