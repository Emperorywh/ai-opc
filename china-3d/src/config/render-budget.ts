/**
 * 4K 大屏渲染性能预算——唯一事实源（TASK-015，SPEC §7.2 / §7.3 / §7.4 / §12.9 / §12.10 / §13）。
 *
 * 角色与依赖方向：
 * - 本模块属于运行时配置层（src/config），是「生产 DPR 上限、1080p / 4K 渲染目标尺寸、显存预算、
 *   关键 draw call 预算、4096² 档位启用策略」的**唯一**权威。页面装配（src/App 据 dprMin / dprMax
 *   设置 Canvas dpr）、自动化测试都只能通过本模块取得这些参数——禁止在组件 / 测试里各自复制一份
 *   DPR 上限或尺寸常量。
 * - 单向依赖：本模块只依赖同层 src/config/terrain-config（TERRAIN_MESH_SEGMENTS_DEFAULT / MAX —— 网格
 *   分段生产默认 / 上限的唯一源，避免本层另写一套分段常量）。不依赖 React / R3F / Three.js / DOM，
 *   故自动化测试可在 Node 环境直接断言「DPR 上限 ≤ 2」「渲染目标尺寸为标准档」「显存预算有限」
 *   「draw call 预算为正整数」「4096² 默认不启用」等不变量。
 *
 * DPR 上限（SPEC §7.3「设 DPR 上限（如 Math.min(devicePixelRatio, 2)），避免 4K 屏 × 高 DPR 爆显存」）：
 * - dprMax = 2 是结构性上限：4K（3840×2160）物理像素 × DPR 2 = 7680×4320 绘制缓冲，已是大屏独显的
 *   合理上限；DPR > 2（如 4K 屏 DPR 3）会把绘制缓冲推到 11520×6480，显存与带宽骤增而视觉收益递减
 *   （亚像素细节在大屏观看距离不可辨），故硬性钳制。dprMin = 1 保证最低绘制不模糊。
 * - R3F 的 dpr prop 接受 [min, max] 区间并在区间内取 Math.min(devicePixelRatio, dprMax)——SPEC §7.3
 *   的钳制语义由「App 传 dpr={[dprMin, dprMax]} + R3F 取 min」落地，本模块把这对数值集中为唯一
 *   事实源：任何「偷偷放宽 DPR 上限」的改动都会被迫改本常量并被测试捕获。
 *
 * 渲染目标尺寸（SPEC §2「运行平台：大屏 / 高性能机（1080p/4K + 独显）」）：
 * - 1080p = 1920×1080、4K（UHD-1）= 3840×2160，二者是大屏标准档（SPEC §2 列举的运行平台）。把它们
 *   显式化为常量，使「渲染目标尺寸」成为可读、可测的不变量锚点：性能测量记录
 *   （docs/performance-measurement-record.md）据此填写实测分辨率，避免「自定义分辨率」绕过
 *   1080p / 4K 标准档验收。
 * - 这些尺寸只用于**测量记录与预算推导**（如绘制缓冲像素数 = W×H×DPR²），不是运行时强制——运行时
 *   渲染尺寸由浏览器窗口 / 大屏物理分辨率决定，本模块不介入窗口管理（不引入 resize 强制 / 不写死
 *   renderer.setSize，避免与 RuntimeLifecycleController 的 resize 防抖路径冲突）。
 *
 * 显存预算（SPEC §7.2「heightmap 纹理 4096² R16 ≈ 32MB（GPU 纹理）」「默认 2048² ≈ 4.2M 顶点，
 *   position+uv+normal ≈ 100MB」「上限 4096² ≈ 16.7M 顶点，≈ 400MB」、§7.3「高精资产常驻显存，
 *   预算单次加载；无流式加载」）：
 * - 关键常驻显存项在此显式列账，使「显存预算」可被自动化测试断言为有限、且与 SPEC §7.2 量级一致：
 *   - HEIGHTMAP_TEXTURE_BYTES_EXPECTED = 4096·4096·2 ≈ 33.55 MB（R16 源；GPU 纹理以 float32 归一化上传
 *     ≈ 4 字节 / 像素 ≈ 67 MB，但源数据 32MB 是预算锚点）。
 *   - PLANE_VERTEX_COUNT_DEFAULT = (2048+1)² ≈ 4.19M（默认档顶点数）。
 *   - PLANE_VERTEX_COUNT_UPPER = (4096+1)² ≈ 16.78M（上限档顶点数）。
 *   - 每顶点 position(3) + uv(2) + normal(3) = 8 float = 32 字节，故默认档几何 ≈ 134 MB、上限档 ≈ 537 MB
 *     （SPEC §7.2 的 100MB / 400MB 是「position+uv+normal」的保守估算，本模块按 8 float / 顶点的精确
 *     系数推导，量级一致）。
 * - 这些是**预算推导常量**，不在运行时分配（运行时不持有这些数组——GPU 位移在 shader 内，CPU 不逐顶点
 *   写位置，见 ChinaTerrainMesh / SPEC §7.1）。它们只供测试断言「预算有限」「默认档顶点数 << 上限档」
 *   「4096² 是显式可选档」，以及供测量记录对照。
 *
 * 关键 draw call 预算（SPEC §3.6「合并为尽量少的 draw call」、§7.2「边界线 单 / 少量 draw call」）：
 * - 各渲染层的 draw call 数量在此列账（结构性计数，非运行时实测；运行时实测由人工在测量记录填写）：
 *   - 地形 mesh：1（单 ShaderMaterial plane，GPU 位移）。
 *   - 海面：1（单 ShaderMaterial plane，片元波动）。
 *   - 省级边界：≤ PROVINCE_BORDER_DRAW_CALL_BUDGET（每行政区一个 drei Line = 一个 draw call，
 *     TASK-009 按行政区分组以支持 hover 确定性寻址；34 省级行政区上限）。
 *   - 十段线：≤ NINE_DASH_LINE_DRAW_CALL_BUDGET（每段一个 drei Line，TASK-011 按段独立以支持
 *     台湾东侧段独立审计）。
 *   - 岛礁光点：每岛礁一个 mesh（TASK-011），数量由政治边界契约决定（生产资产 5 个）。
 *   - 省名 / 省会名 Billboard：每标签一个 troika Text（TASK-010 / §3.7），数量由地点契约决定。
 *   - 省会光点：每省会一个球体（TASK-010，生产 34 个）。
 *   - 不可见拾取面：1（TASK-009 ProvinceHoverPicker，opacity 0 + colorWrite false，无可见像素）。
 * - 这些是「结构性预算上限」——若某层 draw call 数超出本预算，说明资产结构异常（如省界未按行政区合并、
 *   十段线被错误拆成过多段）。测试断言预算为正整数，供人工实测对照（实际 draw call 数由浏览器
 *   WebGL Inspector / Spector.js 在目标设备实测，填入测量记录）。
 *
 * 4096² 档位启用策略（SPEC §7.2「默认 2048²；通过配置项暴露，大屏独显可上调到 4096 实测帧率后决定」）：
 * - 生产默认 2048²（PRODUCTION_TERRAIN_CONFIG，见 terrain-config）。4096² 仅在「上层显式以
 *   meshSegments = 4096 注入」（生产路径为 App 的 ?terrainSegments=4096 URL 覆盖，统一走
 *   resolveTerrainConfigOrThrow 校验）时启用——页面装配与配置层均**无**「检测 GPU / 帧率后自动升级
 *   到 4096²」的路径。本模块以常量 UPPER_TIER_MESH_SEGMENTS 显式命名 4096² 上限档，并以
 *   UPPER_TIER_AUTO_UPGRADE_ENABLED = false 作为「不自动升级」的可测不变量锚点：测试断言该常量为
 *   false，任何引入自动升级路径的改动都会被迫改本常量并被捕获。
 * - 自动升级被禁止的根因：4096² 是临界档（§7.2 ≈ 16.7M 顶点 ≈ 400MB 几何），是否启用必须基于目标
 *   设备的**实测帧率 / 显存**（人工测量记录），而非运行时启发式（启发式会在「能运行」与「达 60fps」
 *   之间混淆）。
 *
 * 逐帧分配不变量（SPEC §7.4「无运行时几何分配循环」）：
 * - 全部 useFrame 回调（ChinaTerrainMesh / SeaSurface / ProvinceBorders / PoliticalFeatures / PlaceLabels /
 *   EntranceController）只写既有 uniform / 材质的标量字段（.value / .opacity / .fillOpacity），不 new
 *   THREE.* 对象、不分配大数组、不 new THREE.Clock（视觉时钟统一由 R3F 共享 clock 承载）。这是结构性
 *   不变量，由代码审查 + 测试（本模块导出 PER_FRAME_ALLOCATION_FORBIDDEN 锚点）共同守护；审计结论
 *   记录在 docs/performance-measurement-record.md §2。
 * - 资源所有权：heightmap 纹理 + CPU 高程像素（Uint16Array ≈ 32MB）在 App 的 useHeightmap hook 内
 *   **一次性**加载，经 props 下发给各渲染层共享（同一份 GPU 纹理、同一份 pixels 包装出的
 *   ElevationProvider）——不存在「每层各自 fetch / 各自解码」的重复所有权。context 丢失 / 恢复时，
 *   GPU 资源由 restoreSceneGpuResources 从**同一份 CPU 源**重新上传，绝不重新 fetch / 重新解码。
 *
 * 不引入运行时流式 / 低清 fallback（SPEC §7.3「无流式加载（离线单图方案）」）：
 * - 全部资产（heightmap .r16 / 省界 GeoJSON / 政治边界 / 地点目录 / 字体子集）在构建期打进 public/，
 *   运行时只从同源 fetch 一次（挂载期），无流式分块加载、无「帧率低则切低清纹理」的自动降级路径。
 *   本模块以 RUNTIME_STREAMING_ENABLED / AUTO_LOW_RES_FALLBACK_ENABLED = false 作为可测不变量锚点。
 */

import {
  TERRAIN_MESH_SEGMENTS_DEFAULT,
  TERRAIN_MESH_SEGMENTS_MAX,
} from './terrain-config'

/**
 * 生产渲染 DPR 下限（含）= 1。
 *
 * 保证最低绘制不模糊（DPR < 1 会让大屏物理像素欠采样，文字 / 细线糊）。R3F 的 dpr prop 据此与 dprMax
 * 构成 [dprMin, dprMax] 区间。
 */
export const RENDER_DPR_MIN = 1

/**
 * 生产渲染 DPR 上限（含）= 2（SPEC §7.3）。
 *
 * 4K（3840×2160）× DPR 2 = 7680×4320 绘制缓冲，是大屏独显的合理上限。DPR > 2 会把绘制缓冲与显存带宽
 * 推到边际收益递减的区间（大屏观看距离下亚像素细节不可辨），故硬性钳制。任何放宽（如改 3）都须改本
 * 常量并被测试捕获。
 */
export const RENDER_DPR_MAX = 2

/**
 * 1080p 渲染目标尺寸（像素，SPEC §2 运行平台标准档）。
 *
 * 1920×1080（FHD）。用于测量记录对照与绘制缓冲像素数推导（W×H×DPR²），不强制运行时窗口尺寸。
 */
export const RENDER_TARGET_1080P = Object.freeze({ width: 1920, height: 1080 })

/**
 * 4K（UHD-1）渲染目标尺寸（像素，SPEC §2 运行平台标准档）。
 *
 * 3840×2160。用于测量记录对照与绘制缓冲像素数推导，不强制运行时窗口尺寸。
 */
export const RENDER_TARGET_4K = Object.freeze({ width: 3840, height: 2160 })

/**
 * heightmap 纹理每边像元数（= 生产资产 china-heightmap-4096 的分辨率，SPEC §5.1 / §7.2）。
 *
 * 用于推导显存预算（HEIGHTMAP_TEXTURE_BYTES_EXPECTED）。与 src/geo-contracts terrain-meta 的
 * widthPixels / heightPixels 一致（资产层契约保证）。
 */
export const HEIGHTMAP_TEXTURE_TEXELS_PER_SIDE = 4096

/**
 * 每像元素材字节数（R16 = 16 位 = 2 字节，SPEC §5.1 / §7.2）。
 *
 * heightmap 源资产以 16 位小端 uint16 落盘（.r16），每像元 2 字节。GPU 上传时以 float32 归一化（4 字节 /
 * 像元），但源数据预算锚点按 R16 的 2 字节 / 像元（与 SPEC §7.2「R16 ≈ 32MB」一致）。
 */
export const HEIGHTMAP_TEXEL_BYTES = 2

/**
 * heightmap 纹理源数据预算（字节）= 4096²·2 ≈ 33.55 MB（SPEC §7.2「R16 ≈ 32MB」）。
 *
 * 常驻 CPU（Uint16Array）+ GPU（float32 DataTexture）的源数据量级锚点。运行时不复制多份（App 把同一份
 * pixels 包装出的共享 ElevationProvider 下发各层共用，见 src/lib/elevation / App TerrainSceneLayers）。
 */
export const HEIGHTMAP_TEXTURE_BYTES_EXPECTED =
  HEIGHTMAP_TEXTURE_TEXELS_PER_SIDE * HEIGHTMAP_TEXTURE_TEXELS_PER_SIDE * HEIGHTMAP_TEXEL_BYTES

/**
 * 地形 plane 每顶点属性字节数（position 3 + uv 2 + normal 3 = 8 float = 32 字节）。
 *
 * PlaneGeometry 默认带 position / uv / normal 三套 attribute（各 1，非 indexed 几何额外有 index，此处
 * 按非 indexed 保守估算顶点属性，量级与 SPEC §7.2 一致）。用于推导默认 / 上限档几何预算。
 */
export const PLANE_VERTEX_ATTRIBUTE_BYTES = 32

/**
 * 由分段数推导 plane 顶点数（(SEG+1)²，非 indexed）。
 *
 * PlaneGeometry(w, h, SEG, SEG) 产生 (SEG+1)×(SEG+1) 个顶点。SEG=2048 → 4.19M 顶点；SEG=4096 → 16.78M
 * 顶点（SPEC §7.2）。导出供测试断言「默认档顶点数 << 上限档」「预算有限」。
 */
export function planeVertexCount(meshSegments: number): number {
  const n = meshSegments + 1
  return n * n
}

/**
 * 默认档（2048²）plane 顶点数（SPEC §7.2「≈ 4.2M 顶点」）。
 *
 * = (TERRAIN_MESH_SEGMENTS_DEFAULT + 1)²。生产默认档的顶点预算锚点。
 */
export const PLANE_VERTEX_COUNT_DEFAULT = planeVertexCount(TERRAIN_MESH_SEGMENTS_DEFAULT)

/**
 * 上限档（4096²）plane 顶点数（SPEC §7.2「≈ 16.7M 顶点」）。
 *
 * = (TERRAIN_MESH_SEGMENTS_MAX + 1)²。4096² 可选档的顶点预算锚点；默认不启用（见 UPPER_TIER_*）。
 */
export const PLANE_VERTEX_COUNT_UPPER = planeVertexCount(TERRAIN_MESH_SEGMENTS_MAX)

/**
 * 默认档（2048²）plane 几何预算（字节）= 顶点数 · 每顶点属性字节（SPEC §7.2「≈ 100MB」）。
 *
 * 量级锚点：4.19M · 32 B ≈ 134 MB（SPEC §7.2 的 100MB 是保守估算，本模块按精确系数推导，量级一致）。
 */
export const PLANE_GEOMETRY_BYTES_DEFAULT = PLANE_VERTEX_COUNT_DEFAULT * PLANE_VERTEX_ATTRIBUTE_BYTES

/**
 * 上限档（4096²）plane 几何预算（字节）= 顶点数 · 每顶点属性字节（SPEC §7.2「≈ 400MB」）。
 *
 * 量级锚点：16.78M · 32 B ≈ 537 MB（SPEC §7.2 的 400MB 是保守估算，量级一致）。临界档，默认不启用。
 */
export const PLANE_GEOMETRY_BYTES_UPPER = PLANE_VERTEX_COUNT_UPPER * PLANE_VERTEX_ATTRIBUTE_BYTES

/**
 * 省级行政区数量上限（draw call 预算用，SPEC §2「省级 34 个省级行政区」）。
 *
 * 34 省（含港澳台）各一个 drei Line draw call（TASK-009 按行政区分组，hover 据此确定性寻址）。用作
 * PROVINCE_BORDER_DRAW_CALL_BUDGET 的上限锚点。
 */
export const PROVINCE_ADMIN_REGION_COUNT_MAX = 34

/**
 * 省级边界 draw call 预算上限（每行政区一个 drei Line）。
 *
 * = PROVINCE_ADMIN_REGION_COUNT_MAX = 34。结构性预算：若实测省界 draw call > 34，说明省界未按行政区
 * 合并或资产异常。hover 确定性寻址要求按行政区分组（TASK-009），故不合并为单条 LineSegments——这是
 * 「hover 可寻址」与「draw call 最少化」之间的受控权衡，预算显式记录。
 */
export const PROVINCE_BORDER_DRAW_CALL_BUDGET = PROVINCE_ADMIN_REGION_COUNT_MAX

/**
 * 十段线 draw call 预算上限（每段一个 drei Line，TASK-011 按段独立）。
 *
 * 取 12：标准十段线画法（含台湾东侧段）为 10 段，留 2 段余量容纳可能的附属线段。每段独立以支持
 * 台湾东侧段（segmentIndex=10）独立审计（TASK-011「不把十段线合并为不可核查的单条连续折线」）。
 */
export const NINE_DASH_LINE_DRAW_CALL_BUDGET = 12

/**
 * 4096² 上限档的网格分段数（= TERRAIN_MESH_SEGMENTS_MAX，命名锚点）。
 *
 * 显式命名 4096² 上限档，使「上限档 = 4096」成为可读、可测的不变量。生产默认仍是 2048²
 * （PRODUCTION_TERRAIN_CONFIG.meshSegments，见 terrain-config），本常量只在「上层显式注入 4096」时
 * 与实际分段相等。
 */
export const UPPER_TIER_MESH_SEGMENTS = TERRAIN_MESH_SEGMENTS_MAX

/**
 * 是否允许运行时自动升级到 4096² 档（结构性 false）。
 *
 * 显式 false 锚点：页面装配与配置层均无「检测 GPU / 帧率后自动升级」的路径。4096² 是否启用只由
 * 「上层显式以 meshSegments = 4096 注入」（生产路径为 ?terrainSegments=4096 URL 覆盖）决定，且必须
 * 基于人工实测帧率 / 显存（docs/performance-measurement-record.md）。任何引入自动升级的改动都会被迫
 * 改本常量并被测试捕获。
 */
export const UPPER_TIER_AUTO_UPGRADE_ENABLED = false

/**
 * 是否启用运行时流式网络加载（结构性 false，SPEC §7.3「无流式加载」）。
 *
 * 全部资产在构建期打进 public/，运行时只从同源 fetch 一次（挂载期），无流式分块。显式 false 锚点，
 * 任何引入流式的改动都会被迫改本常量并被测试捕获。
 */
export const RUNTIME_STREAMING_ENABLED = false

/**
 * 是否启用「帧率低则自动切低清纹理 / 几何」的 fallback（结构性 false）。
 *
 * 显式 false 锚点：性能不达标时由人工基于测量记录选择「标记 4K 为未达标 / 启用已批准优化 / 保持阻塞」，
 * 绝不自动降清伪造通过。任何引入自动低清 fallback 的改动都会被迫改本常量并被测试捕获。
 */
export const AUTO_LOW_RES_FALLBACK_ENABLED = false

/**
 * 是否禁止逐帧分配（结构性 true 不变量，SPEC §7.4「无运行时几何分配循环」）。
 *
 * 显式 true 锚点：全部 useFrame 回调只写既有 uniform / 材质标量字段，不 new THREE.* / 不分配大数组 /
 * 不 new THREE.Clock（视觉时钟统一由 R3F 共享 clock 承载）。由代码审查守护（审计结论见
 * docs/performance-measurement-record.md §2），本常量作为可测不变量锚点。
 */
export const PER_FRAME_ALLOCATION_FORBIDDEN = true

/**
 * 计算给定渲染目标在指定 DPR 下的绘制缓冲像素数（= W·H·DPR²）。
 *
 * 用于在测试与测量记录中评估「绘制缓冲规模」——4K @ DPR 2 = 3840·2160·4 ≈ 33.2M 像素，是大屏独显的
 * 合理上限。本函数是 W·H·DPR² 的纯算术镜像，供测试断言「DPR 上限内绘制缓冲有限」。
 */
export function computeDrawBufferPixels(
  target: { readonly width: number; readonly height: number },
  dpr: number,
): number {
  return target.width * target.height * dpr * dpr
}

/**
 * 4K 大屏渲染性能预算的全部参数（冻结）。
 *
 * 这是页面装配（App 据 dprMin / dprMax 设 Canvas dpr）、自动化测试与测量记录共享的同一份事实源：
 * DPR 区间 / 渲染目标尺寸 / 显存预算 / draw call 预算 / 4096² 与流式 / fallback 策略全部在此，不存在
 * 第二套渲染预算常量。冻结防止运行时被偷偷放宽（如把 dprMax 改 3 会爆显存、把
 * UPPER_TIER_AUTO_UPGRADE_ENABLED 改 true 会伪造 4K 验收），任何调整都必须改本模块并同步测试。
 */
export const RENDER_BUDGET_CONFIG = Object.freeze({
  /** 生产渲染 DPR 下限（含）= 1。 */
  dprMin: RENDER_DPR_MIN,
  /** 生产渲染 DPR 上限（含）= 2（SPEC §7.3）。 */
  dprMax: RENDER_DPR_MAX,
  /** 1080p 渲染目标尺寸（像素）。 */
  target1080p: RENDER_TARGET_1080P,
  /** 4K 渲染目标尺寸（像素）。 */
  target4k: RENDER_TARGET_4K,
  /** heightmap 纹理每边像元数（= 4096）。 */
  heightmapTexelsPerSide: HEIGHTMAP_TEXTURE_TEXELS_PER_SIDE,
  /** heightmap 每像元素材字节数（R16 = 2）。 */
  heightmapTexelBytes: HEIGHTMAP_TEXEL_BYTES,
  /** heightmap 纹理源数据预算（字节，≈ 32MB）。 */
  heightmapTextureBytesExpected: HEIGHTMAP_TEXTURE_BYTES_EXPECTED,
  /** plane 每顶点属性字节数（position+uv+normal = 32）。 */
  planeVertexAttributeBytes: PLANE_VERTEX_ATTRIBUTE_BYTES,
  /** 默认档（2048²）plane 顶点数（≈ 4.2M）。 */
  planeVertexCountDefault: PLANE_VERTEX_COUNT_DEFAULT,
  /** 上限档（4096²）plane 顶点数（≈ 16.7M）。 */
  planeVertexCountUpper: PLANE_VERTEX_COUNT_UPPER,
  /** 默认档 plane 几何预算（字节，≈ 134MB）。 */
  planeGeometryBytesDefault: PLANE_GEOMETRY_BYTES_DEFAULT,
  /** 上限档 plane 几何预算（字节，≈ 537MB）。 */
  planeGeometryBytesUpper: PLANE_GEOMETRY_BYTES_UPPER,
  /** 省级行政区数量上限（= 34）。 */
  provinceAdminRegionCountMax: PROVINCE_ADMIN_REGION_COUNT_MAX,
  /** 省级边界 draw call 预算上限（= 34，每行政区一个 drei Line）。 */
  provinceBorderDrawCallBudget: PROVINCE_BORDER_DRAW_CALL_BUDGET,
  /** 十段线 draw call 预算上限（= 12，每段一个 drei Line）。 */
  nineDashLineDrawCallBudget: NINE_DASH_LINE_DRAW_CALL_BUDGET,
  /** 4096² 上限档网格分段数（= 4096，命名锚点；默认不启用）。 */
  upperTierMeshSegments: UPPER_TIER_MESH_SEGMENTS,
  /** 是否允许自动升级到 4096²（结构性 false）。 */
  upperTierAutoUpgradeEnabled: UPPER_TIER_AUTO_UPGRADE_ENABLED,
  /** 是否启用运行时流式网络（结构性 false）。 */
  runtimeStreamingEnabled: RUNTIME_STREAMING_ENABLED,
  /** 是否启用自动低清 fallback（结构性 false）。 */
  autoLowResFallbackEnabled: AUTO_LOW_RES_FALLBACK_ENABLED,
  /** 是否禁止逐帧分配（结构性 true 不变量）。 */
  perFrameAllocationForbidden: PER_FRAME_ALLOCATION_FORBIDDEN,
})
