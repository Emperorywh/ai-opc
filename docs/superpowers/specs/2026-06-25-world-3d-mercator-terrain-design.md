# 平铺式 3D 世界地图系统设计（world-3d）

- **日期**：2026-06-25
- **项目**：`world-3d`（D:\code\ai-opc\world-3d，全新独立项目）
- **目标**：在浏览器中以 Web 墨卡托投影、平面 quadtree LOD 形式展示接近 Google Earth 自然地貌模式的真实地球。
- **与 `web-3d` 的关系**：完全独立。`web-3d` 是动漫风格 Robinson 投影单张 heightmap；本系统是真实数据 Web Mercator 瓦片流式 LOD。仅共享 React+R3F+Three.js 技术栈与工程经验，不复用代码。

---

## 0. 核心决策汇总

| 维度 | 决策 |
|------|------|
| 投影 | Web Mercator（EPSG:3857），真平面（非球面） |
| 数据来源 | 自建离线 XYZ 瓦片金字塔（全静态文件，无运行时在线服务依赖） |
| 覆盖范围 | 全球低分（Blue Marble，z0-8）+ 中国全境高分（Sentinel-2，z9-15） |
| DEM | Copernicus DEM GLO-30（30m，全球含极区，DSM，WGS84 椭球高） |
| 渲染基底 | 真平面（Chunk 网格在 Web Mercator 平面坐标系） |
| 地形网格 | 65×65 顶点 Chunk + 裙边（skirt）接缝 |
| LOD | 四叉树 + 屏幕空间误差（SSE）判据 + 迟滞 |
| 内容 | 纯影像 + DEM，无矢量叠加（影像本身含海洋/湖泊/河流/冰川/森林/沙漠） |
| 排除 | 城市、建筑、道路、农田、POI、云层、天气系统 |
| 架构方案 | 原生 Three.js + 自写 quadtree（方案 A） |
| 技术栈 | React 19 + @react-three/fiber 9 + three 0.184 + Zustand |

---

## 1. 总体架构

系统分**三层**，各层职责清晰、可独立开发和测试：

```
┌─────────────────────────────────────────────────────────────┐
│  离线数据 Pipeline 层（Node.js + GDAL + Python，离线运行）       │
│  scripts/data-pipeline/                                       │
│  原始卫星/DEM → 预处理 → Web Mercator 重投影 → XYZ 瓦片金字塔   │
│  产出：public/tiles/imagery/{z}/{x}/{y}.webp                    │
│        public/tiles/terrain/{z}/{x}/{y}.png (Terrarium 编码)   │
└─────────────────────────────────────────────────────────────┘
                          ↓ 静态文件
┌─────────────────────────────────────────────────────────────┐
│  运行时渲染层（React + R3F + Three.js，浏览器内）                │
│  src/                                                         │
│  四叉树 LOD 调度 → Chunk 网格生成 → DEM 顶点位移 → 影像纹理     │
│  裙边接缝 · 地形着色器 · 纹理流式加载 · GPU 显存管理            │
└─────────────────────────────────────────────────────────────┘
                          ↓ 用户操作
┌─────────────────────────────────────────────────────────────┐
│  交互/控制层                                                  │
│  相机控制（pan/zoom/tilt）· 拾取 · 加载进度 · 质量分档          │
└─────────────────────────────────────────────────────────────┘
```

### 1.1 核心设计原则

1. **离线烘焙 vs 运行时分离**。所有重计算（云去除、色彩平衡、重投影、瓦片切割）在 pipeline 一次性完成；运行时只做"取瓦片→建网格→上传 GPU→绘制"，绝不运行时下载/重投影原始数据。
2. **数据源无关的瓦片格式**。pipeline 输出标准 Web Mercator XYZ 瓦片，渲染层不关心数据来自 Sentinel-2 还是 Landsat——换数据源只改 pipeline，渲染层零改动。
3. **投影契约单一**。全系统统一 Web Mercator 平面坐标系。

### 1.2 目录结构（world-3d 全新）

```
world-3d/
├── scripts/data-pipeline/        # 离线管线（Node.js + GDAL + Python）
│   ├── 1-download-dem.mjs        # 下载 Copernicus GLO-30
│   ├── 2-download-sentinel.mjs   # 下载 Sentinel-2 / WorldCover 复合
│   ├── 3-reproject-dem.mjs       # DEM → Web Mercator Terrarium 瓦片
│   ├── 4-mosaic-imagery.mjs      # 影像去云/拼接/色彩平衡
│   ├── 5-cut-tiles.mjs           # 切 XYZ 瓦片金字塔
│   └── lib/                      # 共享工具
├── src/
│   ├── config/                   # 投影、相机、瓦片常量
│   ├── data/                     # 瓦片加载、缓存、解码
│   ├── three/
│   │   ├── terrain/              # 四叉树 LOD + Chunk + 裙边
│   │   ├── camera/               # 相机控制
│   │   └── Scene.tsx
│   ├── shaders/                  # GLSL
│   ├── state/                    # Zustand store
│   └── ui/                       # HUD/Loader/Legend
└── public/tiles/                 # 烘焙产物（.gitignore，不入库）
```

---

## 2. 数据源选择

### 2.1 高程 DEM

| 项 | 选择 | 关键参数 |
|----|------|---------|
| 主 DEM | **Copernicus DEM GLO-30** | 30m，全球含极区，LE90≈2m，WGS84 椭球高，DSM，2021 发布，免费商用 |
| 备选/对比 | SRTM 30m | 仅作交叉验证（极区无数据、2000 年采集，**不采用**） |
| 海洋/水下 | GEBCO（可选） | 若需海底地形（可选），默认海洋走 0 高程 |

**关键注意点**：
- Copernicus 是 **DSM（含建筑/树木）**。在重点区域外（全球低分）DSM 的树冠/建筑在 30m 尺度下已模糊，影像纹理覆盖视觉。**不单独去除建筑**（成本极高），靠影像主导观感。
- 基准是 **WGS84 椭球高**，非正高。海平面按 0m 设定，沿岸略有不一致（geoid 起伏 ±100m），视觉可接受。

### 2.2 卫星影像

| 层级 | 数据源 | 精度 | 用途 |
|------|--------|------|------|
| 全球低分（z0-z8） | **NASA Blue Marble Next Generation** | 500m/像元，月度无云合成 | 全球概览 |
| 重点区域高分（z9-z15） | **ESA WorldCover Sentinel-2 年度无云复合（RGBNIR）** | 10m，B2/B3/B4(+B8) | 中国全境高频细节 |
| 备选高分 | Sentinel-2 L2A 自建复合（Cloud Score+ 去云 + median） | 10m | 完全自主，二期 |

**主推 ESA WorldCover 复合而非从零自建的理由**：已完成全球去云、色彩平衡、年度合成（VITO 生产，AWS 开放数据），省去 TB 级原始数据处理。从零自建可定制（如选夏季以植被最盛），但需 GEE 账号和服务器端配额。**一期用 WorldCover 打通，二期按需自建。**

### 2.3 数据量预估

| 数据 | 范围 | 原始 | 烘焙后瓦片 |
|------|------|------|-----------|
| Copernicus GLO-30（全球） | 全球 | ~数百 GB COG | Terrarium PNG 瓦片 z0-z12 ≈ 30-50 GB |
| Blue Marble（全球） | 全球 | ~2 GB | 切到 z8 ≈ 1-2 GB |
| WorldCover S2 复合（中国） | 中国 | ~0.3-0.5 TB COG | 切到 z15 ≈ 120-200 GB |
| **总计烘焙产物** | | | **~150-250 GB** |

---

## 3. DEM 处理流程

### 3.1 流水线（全部离线）

```
[Copernicus 1° COG ×N]                     AWS S3 匿名下载
        │
        ▼  gdalbuildvrt（虚拟拼接）
[global_glo30.vrt]                         float32，EPSG:4326
        │
        ▼  gdalwarp -t_srs EPSG:3857 -r bilinear
[global_glo30_webmerc.tif]                 float32，Web Mercator
        │
        ▼  gdaladdo -r average（构建 z0..z12 概览金字塔）
[global_glo30_webmerc.tif + overviews]     多 LOD
        │
        ▼  rio-terrarium（float32 → RGB PNG 编码，每瓦片独立）
[terrain/{z}/{x}/{y}.png]                  Terrarium 编码，256×256
```

### 3.2 关键技术点

1. **高程重投影用 bilinear，不用 nearest**。DEM 是连续场，nearest 会在重投影时产生阶梯伪影。bilinear 平滑、保真。
2. **Terrarium 编码（非 Mapbox Terrain-RGB）**：Terrarium `height = (R*256 + G + B/256) − 32768`，蓝通道带小数 → 亚米级精度（~0.004m）；Terrain-RGB 仅 0.1m。中国 DEM 高差 -154m~+8848m，Terrarium 对地形细节更友好。
3. **LOD 概览用 average**：更深层级瓦片代表更大区域的高程平均，避免尖峰跳变。average 会"削峰"——远处看地形轮廓为主（average 合适），近处用 z11/z12 原生精度（峰还在）。
4. **瓦片网格对齐**：Web Mercator XYZ 标准网格，256×256 像素，**z 层级与四叉树 LOD 层级一一对应**。

### 3.3 瓦片元数据（terrain 与 imagery 各一份 metadata.json）

```json
{
  "format": "terrarium",
  "minZoom": 0, "maxZoom": 12,
  "tileSize": 256,
  "encoding": "height = (R*256 + G + B/256) - 32768",
  "verticalDatum": "WGS84-ellipsoid",
  "sourceElevationRange": [-154, 8848],
  "keyRegions": {"CN": {"minZoom": 0, "maxZoom": 12}}
}
```

运行时据 `keyRegions` 知道中国 z9-z12 全有、其他区域只到 z8。

---

## 4. Web Mercator 投影实现

### 4.1 坐标系定义

```
经纬度 (lon,lat)  ──Web Mercator──▶  米制 (mx,my)  ──归一化──▶  世界 (x,z)
                                     EPSG:3857              Three.js 平面
```

| 坐标系 | 范围 | 说明 |
|--------|------|------|
| 经纬度 | lon∈[-180,180], lat∈[-85.06,85.06] | 输入；Web Mercator 定义域到 ±85.0511° |
| 米制（EPSG:3857） | mx,my ∈ ±20037508.34 | 投影后；赤道周长/2 |
| 世界坐标（Three.js） | x∈[-1,1], z∈[-1,1] | 归一化米制；Y 轴是高度 |

### 4.2 投影公式（前端纯函数，无 proj4 依赖）

Web Mercator 是单一闭合公式，proj4 是给 Robinson 这种数值投影用的。这里纯函数更轻、零依赖、可移植到 shader（GLSL 内同公式）。

```typescript
const R = 6378137.0                       // WGS84 长半轴（米）
const ORIGIN = Math.PI * R                // 20037508.342789244
const MAX_LAT = 85.05112878               // Web Mercator 纬度极限

// 经纬度 → Web Mercator 米
function lonLatToWebMercator(lon, lat): [mx, my] {
  const mx = R * radians(lon)
  const my = R * Math.log(Math.tan(Math.PI/4 + radians(lat)/2))
  return [mx, my]
}

// Web Mercator 米 → 归一化世界坐标（z 向北为 -z）
function webMercatorToWorld(mx, my): [x, z] {
  return [mx / ORIGIN, -my / ORIGIN]
}

// 复合：经纬度 → 世界坐标
function project(lon, lat): [x, z] {
  const [mx, my] = lonLatToWebMercator(lon, lat)
  return webMercatorToWorld(mx, my)
}
```

### 4.3 瓦片的世界坐标定位

每个 XYZ 瓦片 `(z,x,y)` 的世界坐标包围盒：

```typescript
function tileWorldBounds(z, x, y): {min:[x,z], max:[x,z]} {
  const tileSize = (2 * ORIGIN) / Math.pow(2, z)
  const mxMin = -ORIGIN + x * tileSize
  const mxMax = mxMin + tileSize
  const myMax = ORIGIN - y * tileSize     // y 向南递增
  const myMin = myMax - tileSize
  return {
    min: [mxMin/ORIGIN, -myMin/ORIGIN],
    max: [mxMax/ORIGIN, -myMax/ORIGIN],
  }
}
```

### 4.4 shader 内同源投影

地形 shader 里把瓦片世界 XY → 瓦片 UV（采样 DEM 纹理）→ 顶点位移，全程用上面同一组常数。GPU 与 CPU 共享常量，确保 CPU 拾取/采样与 GPU 渲染一致。

---

## 5. XYZ 瓦片体系

### 5.1 双瓦片层（影像 + 地形，网格严格对齐）

```
public/tiles/
├── imagery/
│   ├── metadata.json          # maxZoom：全球 8 / 中国 15
│   └── {z}/{x}/{y}.webp       # 卫星影像，256×256，WebP（小 30%）
└── terrain/
    ├── metadata.json          # maxZoom：全球 12
    └── {z}/{x}/{y}.png        # Terrarium DEM，256×256
```

影像和地形**同网格同尺寸** → 一个 Chunk 同时取一个影像瓦片 + 一个地形瓦片，UV 完美对齐，shader 不用处理两套采样坐标。

### 5.2 影像瓦片分层

| z 层级 | 数据源 | 覆盖 | 用途 |
|--------|--------|------|------|
| 0-8 | NASA Blue Marble NG | 全球 | 概览，保证全球有数据 |
| 9-15 | ESA WorldCover S2 复合 | **仅中国** | 高频细节 |

**缺瓦片处理**：z9-z15 中国以外的瓦片 → 回退到 z8（Blue Marble）上采样。运行时 LOD 选择层会自动跳到有数据的最高 z。

### 5.3 影像格式 WebP（非 PNG/JPEG）

WebP 有损 ≈ JPEG 画质但小 25-35%，且支持 alpha。浏览器全支持（含 Safari 14+）。地形 PNG **不能有损**（Terrarium 编码靠精确字节）→ 用 PNG 无损。

### 5.4 XYZ 标准（非 TMS）

XYZ：`y` 从北向南递增（y=0 在北）。全系统统一 XYZ，pipeline 输出和运行时索引一致。

### 5.5 静态服务 + 范围索引

运行时不查询"某瓦片存不存在"（HTTP 404 太慢），用 metadata.json 声明的有效范围 + 中国层附 `CN_tiles.json`（列出有效的 `{x,y}` 集合，几 KB）。运行时据相机视锥 + 范围索引算出该请求哪些瓦片，避免 404 风暴。

---

## 6. 四叉树 LOD 设计

### 6.1 四叉树结构（与 Web Mercator 瓦片 1:1 映射）

四叉树节点 = 一个 Web Mercator 瓦片。节点 `(z,x,y)` 的 4 个孩子是 `(z+1, 2x, 2y)`、`(z+1, 2x+1, 2y)`、`(z+1, 2x, 2y+1)`、`(z+1, 2x+1, 2y+1)`。比 Cesium 的球面 quadtree 简单得多。

### 6.2 屏幕空间误差（SSE）细分判据

采用 Ulrich / Cesium 的 SSE 模型。每帧对可见节点评估：

```
                  geometricError · screenHeight · 2
   SSE(px) ───────────────────────────────────────────
                          distance · tan(fov/2) · 2
```

- `geometricError`（米）：该瓦片用更粗 LOD 替代真实地形时的最大几何误差。**离线烘焙时每瓦片预计算**（见 6.3）。
- `distance`（米）：相机到瓦片中心的距离。
- 判据：**SSE > τ（maxScreenSpaceError）→ 细分**；否则渲染当前瓦片。
- **τ 取值**：桌面 τ=4px（清晰），移动端 τ=8-16px（Cesium 默认 16 偏松）。由质量分档动态调整。

### 6.3 每瓦片 geometricError 离线计算（关键）

```
geoError(z,x,y) = max_pixel | DEM[z,x,y] - upsample(DEM[z-1,⌊x/2⌋,⌊y/2⌋]) | × WORLD_Y_PER_METER
```

存入 metadata.json 的稀疏索引或 `terrain/{z}/{x}/{y}.meta`。海洋/平原瓦片 geoError ≈ 0（快速合并），山区瓦片 geoError 大（必须细分）——**这是「近景保留高频、远景保持轮廓」的自适应来源**。geoError 烘焙与 DEM 切瓦片同趟完成，零额外下载成本。

### 6.4 可见性剔除 + 细分遍历（每帧）

**重要：地形和影像有各自独立的 maxZoom（地形 12 / 影像中国 15 全球 8）**。四叉树的细分上限取**两者最小值**——即地形先到天花板（z12），影像虽能到 z15 但地形已无新信息。z13-15 的 Chunk 地形走 z12 上采样（§8.3 纹理共享）。这意味着实际四叉树最深只到 z12，z13-15 仅在「影像需要更高分辨率而地形用 z12 复用」时通过影像纹理单独细分——简化为**四叉树统一到 z12**，z13-15 影像细节通过影像纹理上采样（从 z12 Chunk 的影像纹理双线性放大）呈现，避免双 maxZoom 的簿记复杂度。

```
function updateQuadtree(camera):
  visibleNodes = []
  traverse(root, camera, maxScreenSpaceError)

function traverse(node, camera, τ):
  if not inFrustum(node.bounds, camera): return           # 视锥剔除
  if node.lat > MAX_LAT: render(node); return             # 纬度极限
  if node.z >= MAX_TREE_ZOOM: render(node); return        # 四叉树上限（=12，地形原生地板）
  if not hasAvailableChildren(node): render(node); return # 子瓦片无数据（如中国外 z9+）
  sse = computeSSE(node, camera)
  if sse > τ and hasChildren(node):
      for child in children(node): traverse(child, camera, τ)
  else:
      render(node)
```

> 说明：`MAX_TREE_ZOOM = 12`。z12 Chunk 在中国区域采样 z12 原生影像纹理（清晰），在中国外区域采样 z8 Blue Marble 上采样纹理（模糊但够用）。这放弃了 z13-15 影像的额外细节以换取架构简洁——若未来需要 z15 影像细节，再引入「影像独立细分」机制（二期）。

### 6.5 LOD 迟滞（防抖动）

分裂阈值 `sse > τ`，合并阈值 `sse > τ × 0.8`。形成迟滞带，相机微动不触发抖动。

### 6.6 LOD 范围与数据上限

| z 层 | 地形 DEM | 影像 | 说明 |
|------|---------|------|------|
| 0-3 | 有 | 有（Blue Marble） | 全球概览 |
| 4-8 | 有 | 全球 Blue Marble | 中距离 |
| 9-12 | 有（30m 原生） | 中国 WorldCover | DEM 原生精度终点 |
| 13-15 | **上采样**（z12 插值） | 中国 WorldCover | DEM 已无新信息 |

**z12 是 DEM 原生地板**（30m ≈ z12 的 38m/px）。z13-15 DEM 纯双线性插值，不增细节但保证影像 z15 高分时地形网格密度匹配。

---

## 7. Terrain Chunk 管理

### 7.1 Chunk 几何（裙边接缝）

Chunk = 一个四叉树节点的可渲染网格。**65×65 顶点**（=(2^6)+1），64×64 单元，4225 顶点/Chunk。256×256 DEM 瓦片按 4:1 下采样到 65×65（每 4 像素一个顶点）。

**用裙边而非 edge stitching（共享顶点）**：共享顶点要求邻居 LOD 同步，CPU 簿记复杂、瓦片流式加载时难协调。裙边让每个 Chunk **完全独立**，可单独加载/卸载/渲染——对流式系统至关重要。

### 7.2 裙边（Skirt）实现

边缘 65×4 个顶点各复制一份，沿 -Y 下沉 `skirtDepth` 米，与原边缘顶点连成垂直三角带。**`skirtDepth` 动态计算**：`max(geoError × K, MIN_SKIRT)`，K≈2-3。代价：每 Chunk 多 ~256 顶点 + ~512 三角形（裙边三角带），overdraw 在掠射角可见。**接受**——平面 quadtree LOD 的标准代价。

### 7.3 Chunk 生命周期（状态机）

```
           (load 完成，纹理上传 GPU)
   LOADING ──────────────────────▶ READY
     ▲                                │
     │ (优先级队列调度)                │ (在可见列表，每帧渲染)
     │                                ▼
   QUEUED ◀─────────────────────── VISIBLE
     ▲                                │
     │ (新瓦片取代)                    │ (移出视锥 / 被高 LOD 取代)
     │                                ▼
   UNLOAD ◀──────────────────────── HIDDEN
     │ (释放 GPU 纹理 + 几何)
     ▼
   (gone)
```

LRU 缓存：VISIBLE/READY 的 Chunk 进 LRU（容量 256），超出时最久未见的转 UNLOAD 释放显存。

### 7.4 加载优先级队列

每帧遍历四叉树后，对 QUEUED 瓦片排序：
1. 已在屏幕中心（最近）优先
2. 当前可见（视锥内）优先于预加载
3. 高 z（高细节）优先于低 z

限制并发 6-8 个 fetch（HTTP/2 多路复用）。每瓦片 fetch + decode + 上传 GPU 串行。

### 7.5 Chunk 预加载（视锥外略大边距）

视锥外扩 ~1 瓦片 margin 也加载，相机平移时不至于"空白追赶"。margin 大小由质量分档控制（高档 2，低档 0）。

---

## 8. GPU 显存优化

### 8.1 纹理格式与显存占用

| 纹理 | 单瓦片大小 | 显存（无压缩） | 备注 |
|------|-----------|---------------|------|
| 影像（WebP→RGBA8） | 256×256×4 | 256 KB | 浏览器解码后 RGBA8 |
| 地形（PNG→R8，Terrarium 用 RGB） | 256×256×3 | 192 KB | 可压成 R16（见下） |

**保留 Terrarium PNG 作为传输格式，GPU 上转 R16/HalfFloat**。传输用通用 PNG（工具兼容），显存用紧凑格式。两端最优。

### 8.2 地形纹理压缩：Terrarium → R16

运行时解码 Terrarium PNG → float32 高程 → 重编码成 `R16` 或 `HalfFloat` 单通道 DataTexture。256×256×2 = 128 KB（比 192KB 省 33%）。shader 直接采 `texture2D(uDem, uv).r`，无需 `dot()` 解码。

### 8.3 纹理共享（z13-15 上采样 DEM 复用 z12）

z13-15 Chunk 的 DEM 是 z12 上采样，多个子瓦片共享同一个 z12 父 DEM 纹理（UV 偏移采样）。z12 纹理在 LRU 中引用计数，所有子瓦片卸载才释放。

### 8.4 几何共享：单一 PlaneGeometry

所有 Chunk 共用同一个 65×65 PlaneGeometry（顶点位置在 shader 里按瓦片世界坐标 + DEM 位移）。1 份几何常驻，每个 Chunk 只传 uniform。不用 InstancedMesh（每瓦片纹理不同，实例化收益小），用普通 Mesh + 共享 geometry。

### 8.5 纹理上传节流

瓦片 fetch 完成后，解码 + texImage2D 上传放主线程微任务，每帧最多上传 N 个（如 4 个），避免一帧上传 20 个纹理造成 jank。

### 8.6 显存预算与质量分档联动

| 质量档 | LRU 容量 | Chunk margin | τ (SSE) | 预估显存 |
|--------|---------|-------------|---------|---------|
| 高（桌面独显） | 256 | 2 | 4px | ~150 MB |
| 中（集显/笔记本） | 128 | 1 | 8px | ~80 MB |
| 低（移动） | 64 | 0 | 16px | ~40 MB |

运行时据 GPU 信息（WEBGL_debug_renderer_info）+ FPS 探测自动切档（沿用 AdaptiveQuality 思路）。

---

## 9. 纹理流式加载

### 9.1 双队列：影像队列 + 地形队列（并行）

影像瓦片和地形瓦片是两套独立 URL，但网格对齐。两个加载队列并行跑，互不阻塞——地形先到先显示（先有起伏），影像后到补色。

**为什么独立队列而非成对加载**：地形 PNG 通常更小，先到 → 用户先看到地形起伏。影像 WebP 更大、网络慢 → 慢到。独立队列实现「先起伏后着色」（类似 Google Earth）。

### 9.2 瓦片加载流水线（单瓦片）

```
fetch(url)                      # HTTP GET，带 Range/缓存
  → arrayBuffer
decode(png/webp)                # 浏览器 createImageBitmap（off-main 解码）
  → ImageBitmap
terrain: 编码转换 Terrarium→HalfFloat  # 仅地形
  → Float32Array / HalfFloat
texImage2D 上传 GPU              # 每帧限 N 个，节流
  → WebGLTexture
通知 Chunk 状态 READY → VISIBLE
```

**用 createImageBitmap 而非 Image**：前者在主线程外解码，不阻塞渲染。

### 9.3 取消与去重

- 相机快速移动产生大量 QUEUED，很多在 fetch 完成前已移出视锥 → AbortController 取消。
- 同一瓦片被多个 Chunk 引用（z13-15 共享 z12）→ 引用计数 + 去重缓存 `Map<tileKey, Promise<Texture>>`。

### 9.4 多级 LOD 渐进显示（无闪烁）

加载高 z 时，先用父瓦片纹理上采样显示，高 z 到位后用 shader 在 1-2 帧内 alpha 混合淡入（`mix(texParent, texChild, uBlend)`）。消除「砰」的切换。

### 9.5 离屏 Worker 解码

PNG/WebP 解码虽 createImageBitmap off-main，但 Terrarium→HalfFloat 转换（逐像素）放主线程会卡。**放 Web Worker**：主线程 fetch → transfer ArrayBuffer 给 worker → worker 解码 + Terrarium 转换 → transferable 回主线程 → 主线程仅 texImage2D。影像（WebP）不经 worker，直接 createImageBitmap。

---

## 10. Three.js 渲染架构

### 10.1 技术栈

```
React 19 + @react-three/fiber 9 + three 0.184  (与 web-3d 同栈)
状态：Zustand store（瓦片缓存、质量档、相机、加载进度）
```

### 10.2 组件树

```
<App>
  <Canvas>                       # R3F，透视相机
    <Scene>
      <TerrainSystem>            # 核心：四叉树 + Chunk 管理
        - useFrame 内每帧 updateQuadtree
        - 维护 visibleChunks: Set<Mesh>
      <Lighting/>                # 太阳光（直射）+ 天穹
      <SkyGradient/>             # 天空背景（可选）
      <CameraControls/>          # pan/zoom/tilt
    </Scene>
  </Canvas>
  <Loader/>                      # DOM overlay，加载进度
  <Hud/>                         # 数据署名
</App>
```

### 10.3 TerrainSystem 核心循环（useFrame）

```typescript
function TerrainSystem() {
  const quadtree = useRef(new Quadtree())
  const chunkCache = useRef(new LRUCache(256))
  const [, force] = useReducer(x => x+1, 0)

  useFrame((state) => {
    const cam = state.camera
    const visible = quadtree.current.update(cam, quality.tau)
    chunkCache.current.requestMissing(visible)
    chunkCache.current.evict()
    if (visible.changed) force()
  })

  return <group>{[...chunkCache.current.visibleMeshes()].map(m => <ChunkMesh .../>)}</group>
}
```

四叉树遍历在 useFrame 内每帧跑，但成本可控（视锥剔除 + SSE 是 O(可见节点数)，通常 < 几百）。Chunk 的 React 渲染只在可见集变化时触发，不每帧 diff。

### 10.4 渲染顺序与深度

所有 Chunk 不透明（影像全覆盖，海洋是影像的一部分），depthWrite=true。无透明排序问题。比 web-3d（Ocean 透明 depthWrite=false）简单。

### 10.5 相机模式

统一用透视相机，大距离俯视近似正交。避免正交/透视切换的状态管理复杂度。

---

## 11. Shader 设计

### 11.1 Chunk 顶点着色器（DEM 顶点位移）

```glsl
uniform mat4 uModelView; uniform mat4 uProjection;
uniform sampler2D uDem;            // HalfFloat 单通道高程
uniform vec3 uTileOrigin;          // 瓦片世界坐标原点
uniform vec2 uTileSize;            // 瓦片世界坐标尺寸
uniform float uHeightScale;        // 高程米→世界 Y
uniform float uHeightOffset;
uniform float uSkirtDepth;         // 裙边深度

attribute vec2 aUv;
attribute float aIsSkirt;          // 裙边标志

varying vec2 vUv;
varying float vElevation;

void main() {
  vUv = aUv;
  float h = texture2D(uDem, aUv).r;
  float yWorld = h * uHeightScale + uHeightOffset;
  if (aIsSkirt > 0.5) yWorld -= uSkirtDepth;
  vec3 worldPos = vec3(
    uTileOrigin.x + aUv.x * uTileSize.x,
    yWorld,
    uTileOrigin.z + aUv.y * uTileSize.y
  );
  vElevation = h;
  gl_Position = uProjection * uModelView * vec4(worldPos, 1.0);
}
```

共享 65×65 PlaneGeometry 额外加 `aIsSkirt` attribute 标记边缘顶点。裙边顶点的 aUv 仍是边缘值（采样同一 DEM），但 Y 下沉 `uSkirtDepth`。

### 11.2 Chunk 片元着色器（影像 + 地形着色）

```glsl
uniform sampler2D uImagery;
uniform sampler2D uDem;
uniform vec3 uLightDir;
uniform float uHillshadeStrength;  // 由质量档控制
uniform vec3 uFogColor;
varying vec2 vUv;
varying float vElevation;
varying vec3 vWorldPos;

void main() {
  vec3 color = texture2D(uImagery, vUv).rgb;

  // hillshade（地形阴影增强立体感）—— 只在中高质量档开
  vec3 normal = computeNormalFromDem(vUv);
  float shade = max(dot(normal, normalize(uLightDir)), 0.0);
  shade = mix(0.7, 1.0, shade);
  color *= mix(1.0, shade, uHillshadeStrength);

  // 距离雾（远处淡入地平线，避免瓦片边界硬切）
  float fogF = computeFog(vWorldPos, cameraPos);
  color = mix(color, uFogColor, fogF);

  gl_FragColor = vec4(color, 1.0);
}
```

**关键设计**：
- **影像为主，hillshade 为辅**。卫星影像已含真实地貌色彩，hillshade（~30% 强度）只增强立体感。
- **坡度法线从 DEM 算**（不预烘焙法线贴图），省一份纹理，且与 LOD 自适应。
- **雾**处理远距离瓦片消失。

### 11.3 法线计算（从 DEM 梯度）

```glsl
vec3 computeNormalFromDem(vec2 uv) {
  vec2 texel = vec2(1.0/65.0);   // Chunk 是 65×65
  float hl = texture2D(uDem, uv - vec2(texel.x, 0)).r;
  float hr = texture2D(uDem, uv + vec2(texel.x, 0)).r;
  float hd = texture2D(uDem, uv - vec2(0, texel.y)).r;
  float hu = texture2D(uDem, uv + vec2(0, texel.y)).r;
  vec3 normal = normalize(vec3(hl - hr, 2.0 * uHeightScale, hd - hu));
  return normal;
}
```

### 11.4 Shader 质量分档

| 档 | hillshade | 雾 | 法线精度 |
|----|-----------|-----|---------|
| 高 | 强度 0.3 | 开 | 5 tap |
| 中 | 强度 0.2 | 开 | 4 tap |
| 低 | 关 | 开 | 无（flat） |

---

## 12. 预计数据规模

### 12.1 烘焙产物总量

| 数据集 | 范围 | z 层 | 瓦片数（估算） | 烘焙后大小 |
|--------|------|------|--------------|-----------|
| Blue Marble 影像 | 全球 | 0-8 | ~87,000 | ~1.5 GB |
| WorldCover 影像（中国） | 中国 | 9-15 | ~6.4M | ~120-200 GB |
| Copernicus DEM Terrarium | 全球 | 0-12 | ~1.1M | ~30-50 GB |
| **总计** | | | | **~150-250 GB** |

瓦片数估算依据（Web Mercator 瓦片总数 = 4^z）：
- z8 全球：65,536 瓦片
- z12 全球：16.8M（但 DEM 瓦片只陆地有效，实际 ~1.1M）
- z15 中国：中国约占全球陆地 6.4%，4^15×6.4% ≈ 6.4M

### 12.2 单次会话运行时数据

| 项 | 量 | 说明 |
|----|-----|------|
| 可见 Chunk | ~50-200 | 由视锥 + τ 决定 |
| 显存占用 | ~30-150 MB | LRU 容量 × 单瓦片纹理 |
| 网络下载（首屏） | ~5-20 MB | 初始可见瓦片 |
| 网络下载（漫游） | 持续 ~1-3 MB/s | 边走边加载 |

### 12.3 烘焙时间预估（单机）

| 步骤 | 耗时 | 瓶颈 |
|------|------|------|
| 下载 Copernicus GLO-30（全球） | 数小时 | 网络带宽（AWS S3 匿名） |
| DEM 重投影 + 切瓦片 | 2-6 小时 | CPU（GDAL） |
| WorldCover 中国影像切瓦片 | 4-12 小时 | CPU（z15 切割是大头） |
| **总计** | **~半天到一天** | 可分批/可断点续跑 |

---

## 13. 性能瓶颈分析

### 13.1 瓶颈矩阵

| 瓶颈点 | 严重度 | 原因 | 缓解措施 |
|--------|--------|------|---------|
| 首屏加载延迟 | 🔴 高 | 高 z 瓦片未到，空白 | 父瓦片先显 + tile blend 淡入（§9.4） |
| 四叉树每帧遍历 | 🟡 中 | 每帧遍历可见节点 | 视锥剔除先裁、节点数 < 几百 |
| 纹理上传 jank | 🟡 中 | 一帧上传多纹理卡顿 | 每帧限 N 个 texImage2D（§8.5） |
| 裙边 overdraw | 🟢 低 | 掠射角可见裙边 | skirtDepth 适度、质量档降 |
| 高 z 漫游 fetch 风暴 | 🟡 中 | 快速平移触发大量请求 | AbortController 取消 + 并发限流（§9.3） |
| WebGL 纹理数上限 | 🟢 低 | 单 Context 纹理数有限 | LRU 驱逐，不超 ~256 |
| Terrarium→HalfFloat 转换 | 🟡 中 | 主线程逐像素 | 放 Worker（§9.5） |
| 远距离瓦片边界 | 🟢 低 | 地平线突然无瓦片 | 距离雾（§11.2） |
| DEM 上采样（z13-15） | 🟢 低 | 双线性插值 | GPU shader 内插值，零成本 |

### 13.2 帧率目标

| 设备档 | 目标 FPS | 策略 |
|--------|---------|------|
| 桌面独显 | 60 FPS | 高档：τ=4, LRU 256, hillshade 0.3 |
| 笔记本集显 | 30-60 FPS | 中档：τ=8, LRU 128, hillshade 0.2 |
| 移动端 | 30 FPS | 低档：τ=16, LRU 64, hillshade 关 |

### 13.3 主要风险与备选

| 风险 | 备选方案 |
|------|---------|
| WorldCover 中国 z15 烘焙时间/空间过大 | 降级到 z14（数据量减 75%），或分省烘焙、按需挂载 |
| Copernicus DSM 含建筑影响视觉 | 重点城市区影像主导可掩盖；极端情况叠加 OSM 建筑去除掩膜（二期） |
| 裙边掠射可见 | 改用 MARTINI RTIN mesh（自适应当三角形，无裙边），但实现复杂度↑（二期） |
| 瓦片传输慢 | 改用 quantized-mesh 格式（地形+影像合一，体积小），但需自写编码器（二期） |

### 13.4 验收指标（明确「成功」标准）

- [ ] 全球任意位置缩放，30s 内可见地形起伏 + 影像
- [ ] 漫游无白屏追赶（父瓦片先显）
- [ ] 无可见瓦片接缝（裙边 + blend）
- [ ] 近景（z12+）保留山脊/峡谷细节
- [ ] 远景（z0-6）大洲轮廓清晰
- [ ] 桌面档稳定 60 FPS，移动档 30 FPS

---

## 14. 数据源参考

### Copernicus DEM GLO-30
- AWS Open Data（匿名下载）：`s3://copernicus-dem-30m/`，`aws s3 sync s3://copernicus-dem-30m/ ./glo30 --no-sign-request`
- Registry：https://registry.opendata.aws/copernicus-dem/
- Tile readme：https://copernicus-dem-30m.s3.amazonaws.com/readme.html
- Microsoft Planetary Computer：https://planetarycomputer.microsoft.com/dataset/cop-dem-glo-30
- Product Handbook：https://dataspace.copernicus.eu/sites/default/files/media/files/2024-06/geo1988-copernicusdem-spe-002_producthandbook_i5.0.pdf
- 规格：30m，全球含极区，LE90≈2.03m，WGS84 椭球高，DSM，免费商用

### ESA WorldCover Sentinel-2 复合
- AWS Open Data：https://registry.opendata.aws/esa-worldcover-vito-composites/
- 数据访问：https://esa-worldcover.org/en/data-access
- 规格：10m RGBNIR（B02/B03/B04/B08）年度无云中位数复合，COG 3°×3° 瓦片

### NASA Blue Marble Next Generation
- NASA SVS：https://visibleearth.nasa.gov/collection/1484/blue-marble
- 规格：500m/像元，月度无云合成

### Sentinel-2 L2A（二期自建复合用）
- Copernicus Data Space：https://dataspace.copernicus.eu/
- STAC API：https://documentation.dataspace.copernicus.eu/APIs/STAC.html
- GEE s2cloudless/Cloud Score+ 去云：https://developers.google.com/earth-engine/tutorials/community/sentinel-2-s2cloudless

### Terrarium 编码
- Tilezen joerd spec：https://github.com/tilezen/joerd/blob/master/docs/formats.md
- rio-terrarium：https://github.com/mapbox/rio-terrarium

### Chunked LOD / SSE 理论
- Ulrich "Rendering Massive Terrains using Chunked LOD"：https://tulrich.com/geekstuff/chunklod.html
- Cesium 3D Tiles（SSE 模型）：https://cesium.com/learn/cesiumjs/ref-doc/Cesium3DTileset.html
- three.js Issue #507（chunked LOD terrain）：https://github.com/mrdoob/three.js/issues/507
