# DEM 高程资产生成流水线（TASK-003）

本目录提供 **可重复** 的 DEM 高程资产生成能力：把公开 DEM 离线转换为满足 `terrain-meta`
契约的 16 位高程图 + 元数据 + 审计 sidecar，运行时零外部网络依赖。

> 边界：
> - 编码公式的唯一源是 `src/geo-contracts/terrain.ts` 的 `encodeElevationToUint16`（TASK-002 契约层）；
>   本目录（含 Python 路径）不复制第二套编码公式。
> - 本目录脚本不进浏览器运行时包，不被 `vite build` 打包；`pnpm build` / `pnpm lint` / `pnpm test`
>   均不依赖 Python 环境，也**不会**在普通前端构建中重新下载或生成大资产。重建只能由本 README
>   的显式命令触发。

---

## 1. 三条生产路径，同一外部契约

| 路径 | 入口 | 适用场景 | 产出 |
|---|---|---|---|
| **TS 可测试核心** | `tsx scripts/dem/build-heightmap.ts --input <fixture>` | CI / 单测 / 小型确定性夹具（无 Python） | `<name>.r16` + `<name>.meta.json` |
| **ETOPO1 编排（已交付资产的生产路径）** | `tsx scripts/dem/fetch-etopo1-grid.ts`（见 §1A） | 含海洋水深的真实生产资产 | `.r16` + `.meta.json` + `.provenance.json` |
| **Python 生产脚本** | `python scripts/dem/build_heightmap.py --input <tif 或瓦片目录>` | 真实 Copernicus GeoTIFF 拼接 / 重投影（纯陆地） | `<name>.r16` + `<name>.meta.json` |
| **QGIS 人工等价** | 见 §4 参数清单 | 无 Python / rasterio 环境时人工导出一次 | 同上 |

所有路径都必须产出满足 `terrain-meta` 契约（`src/geo-contracts/terrain.ts`）的元数据，以及
**字节布局完全一致** 的 `.r16` 栅格（见 §3）。编码公式：

```
code = round((meters - minValueMeters) / (maxValueMeters - minValueMeters) * 65535)
然后 clip 到 [0, 65535]
```

- 编码区间固定 `[-1500m, 9000m]`。
- 浅水负高程（≥ -1500m）**保留**为合法低位编码。
- 深海（< -1500m）**截断**到 0 码（解码即下限 -1500m）；超高（> 9000m）截断到 65535 码。
- **不得**以 8 位图替代 16 位精度；**不得**把所有负高程钳制为 0。

生产参数（SPEC §3.3 / §5.1）：经度 `72°E–136°E`、纬度 `3°N–54°N`、输出 `4096×4096`、
CRS `EPSG:3857`（栅格平面）/ `EPSG:4326`（地理范围四至）。

---

## 1A. 重建已交付生产资产

TASK-003 已交付一套**可直接消费**的生产高程资产（提交进版本库，运行时零外网）：

```
public/terrain/china-heightmap-4096.r16             # 4096² 16 位小端 heightmap（33.5MB）
public/terrain/china-heightmap-4096.meta.json       # terrain-meta 契约元数据（来源 src-etopo1-noaa）
public/terrain/china-heightmap-4096.provenance.json # 来源/参数/时间/完整性审计 sidecar（含 sha256）
```

**为什么用 NOAA ETOPO1 而非 SPEC 字面提到的 Copernicus DEM GLO-30（可逆决策，已记录于审计 sidecar）**：
SPEC §3.5 / §5.1 与本 TASK 的深度校验要求「海域含负高程 / 浅水负高程保留」，而 Copernicus DEM
GLO-30 是数字表面模型，开阔海域为 0 或无效值、**不含海洋水深**，无法提供负高程海域样本。
NOAA ETOPO1 是公开的全球地形 + 水深一体化栅格（NOAA NCEI，公共领域），同时具备真实陆地高程与
海洋水深，一次性满足「青藏高原高于东部平原 / 四川、塔里木盆地低于周边山地 / 海域含负高程 /
深海截断到下限」全部地势抽样不变量。该决策可逆：流水线对输入 DEM 源中立，将来接入含正式水深的
更高分辨率源时，重跑下述命令即可产出同一外部契约的资产。

**重建命令**（仅在需要重新生产时执行；普通前端构建 `pnpm build` / `pnpm test` / `pnpm lint` 不会触发）：

```bash
pnpm exec tsx scripts/dem/fetch-etopo1-grid.ts \
  --out public/terrain \
  --name china-heightmap-4096 \
  --source-id src-etopo1-noaa \
  --resolution-degrees 0.5 \
  --cache-grid scripts/dem/.cache/etopo1-grid-0.5deg.json
```

`fetch-etopo1-grid.ts` 在规则经纬度网格（默认 0.5°）上向公开的 Open Topo Data `etopo1` 端点抽样
ETOPO1，组装成 `dem-tile-fixture-v1`（TS 核心的既定输入），再调用 `buildHeightmap` 完成
EPSG:4326→EPSG:3857 重投影、双线性重采样到 4096²、16 位线性编码、元数据导出与完整性审计。
约 131 次请求（每次 100 点、节流 ~1 RPS），全程 2–3 分钟。

**参数清单**（`fetch-etopo1-grid.ts`）：

| 参数 | 缺省 | 说明 |
|---|---|---|
| `--out` | `.` | 资产输出目录（生产用 `public/terrain`） |
| `--name` | `china-heightmap-4096` | 输出基名（`.r16` / `.meta.json` / `.provenance.json` 共用） |
| `--source-id` | `src-etopo1-noaa` | 元数据 `source.sourceId`，与 provenance `source.sourceId` 互相印证 |
| `--resolution-degrees` | `0.5` | ETOPO1 抽样网格分辨率（度）；0.25 可提质（约 4× 请求数） |
| `--width` / `--height` | `4096` / `4096` | 目标栅格分辨率（SPEC §5.1 固定 4096²） |
| `--cache-grid` | 无 | 源栅格缓存路径（gitignored `scripts/dem/.cache/`），仅用于断点续跑，**不作为产品资产提交** |

- 产物校验：`pnpm verify:assets`（位深/尺寸/编码/地势抽样/审计完整性，见 §6）。
- 目标范围 / 编码区间是 SPEC 冻结值，不走 CLI 参数；改动须先改契约层并同步 SPEC。

> 仍可用 §5 的 Copernicus（Python）/ QGIS 路径生产**纯陆地** heightmap（无水深）；但其海域为 0，
> 无法通过「海域含负高程」抽样。如需 Copernicus 路径产出可消费资产，须额外融合水深源——
> 本 TASK 不引入该双轨。

---

## 1B. 分辨率决策（透明披露）

> **决策**：已交付资产以 0.5° ETOPO1 源栅格（128×102 ≈ 1.3 万独立样本，双线性重采样到 4096²）
> 作为契约产物。视觉分辨率升级推迟到 GPU 地形渲染（后续 TASK）依据真实渲染结果判定后再决定；
> 重产命令见 §1A（仅改 `--resolution-degrees`），资产外部契约不变，运行时无感切换。

**已知落差（透明披露）**：

- 源分辨率约 55km（0.5°），远粗于 SPEC §5.1 字面提到的 Copernicus GLO-30（30m）。4096² 栅格中
  仅约 1.3 万个独立源样本被双线性上采样到 1670 万像元，**山脊/高峰被系统性抹平**。
- 实测最高解码 `observedMaxMeters ≈ 6180m`（珠峰 8848m），`provenance.integrity` 已如实记录该值。
- 地势抽样不变量全部通过且余量充足（区域均值对源分辨率稳定）；但中短尺度山脊锐利度有限
  （SPEC §7.2「视觉差异主要在山脊锐利度」所指的细节会偏柔）。

**升级路径（可逆）**：GPU 地形渲染落地后对照 SPEC §7.2 / §12.1 目视判定；若不足，重跑
`--resolution-degrees 0.25`（≈27km，约 523 次请求 ≈ 10 分钟），`pnpm verify:assets` 自动复算并
比对 `provenance.integrity` 全部六项摘要（含 SHA-256），确保新资产自洽。

---

## 2. Windows 脚本环境依赖

Python 生产脚本依赖 **Python 3.9+** 与 `rasterio`、`numpy`：

```powershell
python -m pip install -U pip
python -m pip install rasterio numpy
```

- `rasterio` 在 Windows 提供预编译 wheel（含 GDAL 运行时），通常 `pip install rasterio` 即可；
  若遇 wheel 缺失 / GDAL 报错，优先升级 pip 后重试，或改用 [conda-forge](https://anaconda.org/conda-forge/rasterio)：
  `conda install -c conda-forge rasterio numpy`。
- 验证安装：`python -c "import rasterio, numpy; print(rasterio.__version__, numpy.__version__)"`。

若反复安装受阻，**直接走 §4 的 QGIS 人工路径**——它与 Python 路径产出同一外部契约，无需
本机 Python 环境。前端构建（`pnpm build` / `pnpm lint` / `pnpm test`）**完全不依赖** Python。

---

## 3. `.r16` 字节布局（跨路径一致）

```
长度 = width * height * 2 字节
顺序 = 行主序（C order）
行 0 = 北（max lat），行 height-1 = 南（min lat）
列 0 = 西（min lon），列 width-1 = 东（max lon）
每像元 = 2 字节小端 uint16（little-endian）
```

解码回真实米制海拔（与 `decodeUint16ToElevation` 一致）：

```
meters = code / 65535 * (maxValueMeters - minValueMeters) + minValueMeters
```

TS 核心提供互逆读写：`writeHeightmapAssets` / `readHeightmapRaster`
（见 `scripts/dem/build-heightmap.ts`）。

---

## 4. QGIS 人工等价参数清单（无 Python 时的备选路径）

当无法安装 Python / rasterio 时，用 QGIS 一次性手工导出，参数须与 Python 路径等价：

1. **加载源 DEM**：加载本地缓存的 Copernicus GLO-30 瓦片（Layer → Add Raster Layer，多选瓦片）。
2. **拼接（如多瓦片）**：Raster → Miscellaneous → Merge，输入全部瓦片，输出浮点 GeoTIFF
   （`Float32`），勾选「加载到画布」。
3. **重投影到 EPSG:3857**：Raster → Projections → Warp (Reproject)：
   - Target CRS = `EPSG:3857`。
   - Resampling method = `Bilinear`。
   - Output file resolution：用目标范围计算——
     X 分辨率 = `(X(136°) - X(72°)) / 4096`，Y 分辨率 = `(Y(54°) - Y(3°)) / 4096`
     （X/Y 为 Web 墨卡托米坐标，可用 §1 的公式或 https://epsg.io/3857 换算）。
   - 或直接设 Target extent = `X(72°), X(136°), Y(3°), Y(54°)`（米），尺寸 4096×4096。
4. **16 位线性编码**：Raster → Raster Calculator 或
   Raster → Conversion → Translate：
   - 把高程按 `code = round((meters + 1500) / 10500 * 65535)` 线性映射，
     再 clip 到 `[0, 65535]`（可用计算表达式 `(A + 1500) / 10500 * 65535` 后以
     `UInt16` 输出并钳制）。
   - 输出数据类型 = `UInt16`（16 位无符号），波段数 = 1。
5. **导出原始字节**：用 GDAL 工具（QGIS 自带 `gdal_translate`）把单波段 UInt16 栅格
   转为原始小端字节：
   ```
   gdal_translate -ot UInt16 -of EHDR <reprojected.tif> <name>.bil
   # 取 <name>.bil 的裸字节（小端 uint16、行主序、北→南）重命名为 <name>.r16
   ```
   或更直接：`gdal_translate -ot UInt16 -of RAW <reprojected.tif> <name>.r16`
   （RAW 驱动按行主序输出裸字节，需确认机器小端序；x86/Windows 为小端）。
6. **手写 `<name>.meta.json`**：内容与 Python 路径产出的元数据一致（见 §1 的字段与取值）。

产出后用 `pnpm verify:assets` 校验元数据，并用 TS 核心 `readHeightmapRaster`
抽查若干像元解码值是否符合预期地势（青藏高、东部低、海域负高程）。

---

## 5. 获取 Copernicus DEM GLO-30 源数据（离线缓存）

Copernicus DEM GLO-30 托管在 AWS Open Data（HTTPS 公开，无需账号）：

- 注册页：https://registry.opendata.aws/copernicus-dem/
- S3 / HTTPS 根：`https://copernicus-dem-30m.s3.eu-central-1.amazonaws.com/`
- 瓦片命名：`Copernicus_DSM_COG_10_<NS><lat>_<WE><lon>_00_DEM/Copernicus_DSM_COG_10_<NS><lat>_<WE><lon>_00_DEM.tif`
  （1°×1° 瓦片，EPSG:4326）。例如 `Copernicus_DSM_COG_10_N39_00_E116_00_DEM.tif` 覆盖北京周边。

覆盖目标范围 `[72°E–136°E, 3°N–54°N]` 需要约 `64×51 = 3264` 个 1° 瓦片。两种取数方式：

**方式 A — 脚本内置下载（推荐）**：Python 脚本内置按范围枚举 + 下载，断点续传（已存在瓦片跳过）：

```bash
python scripts/dem/build_heightmap.py \
  --download-to dem-cache \
  --out public/terrain --name china-heightmap-4096
```

`--download-to <dir>` 会先把目标范围的 Copernicus GLO-30 瓦片下载到 `<dir>`，再以该目录作为
流水线输入（读取本地缓存）。生产范围约数十 GB，建议在带宽充足的环境执行。

**方式 B — 手工 prefetch**：

1. 按经纬度枚举所需瓦片名（脚本 `enumerate_copernicus_tiles` 或电子表格生成 URL 列表）。
2. 批量下载到本地缓存目录（如 `dem-cache/`）。
3. 把缓存目录传给 Python 脚本：`python scripts/dem/build_heightmap.py --input dem-cache --out public/terrain --name china-heightmap-4096`。

> 生产源数据缓存 / 临时拼接产物 **不得**作为产品资产提交。
> 仅最终 `.r16` + `.meta.json` + `.provenance.json` 进入 `public/terrain/`。

---

## 6. 用 TS 可测试核心验证（无需 Python）

TS 核心以小型确定性夹具（`tests/fixtures/dem/`）驱动，用于 CI 证明重投影 / 重采样 / 截断 /
负高程保留 / 元数据一致性：

```bash
# 任意 dem-tile-fixture-v1 夹具 → 临时目录产出 .r16 + .meta.json
pnpm exec tsx scripts/dem/build-heightmap.ts \
  --input tests/fixtures/dem/legal-ramp-tile.json \
  --out /tmp/dem-out --name sample --width 16 --height 4
```

**参数清单**（`build-heightmap.ts`）：

| 参数 | 缺省 | 说明 |
|---|---|---|
| `--input` | （必填） | `dem-tile-fixture-v1` 夹具 JSON 路径 |
| `--out` | `.` | 输出目录（不存在时自动创建） |
| `--name` | `china-heightmap` | 输出基名 |
| `--width` / `--height` | `4096` / `4096` | 目标分辨率（测试用小尺寸） |
| `--source-id` | `src-copernicus-dem` | 元数据 `source.sourceId` |

自动化断言见 `tests/dem/build-heightmap.test.ts`（流水线）与 `tests/dem/terrain-asset.test.ts`
（生产资产深度校验 + 篡改发现），均由 `pnpm test` 驱动。生产资产校验入口：

```bash
pnpm verify:assets                  # 等价于 --scope all（当前仅 terrain）
pnpm verify:assets -- --scope terrain
```

---

## 7. 依赖方向与边界

- 本目录属于**离线资产生产层**，单向依赖 `src/geo-contracts` 契约层；**不得** import React /
  Three.js / 运行时渲染层，也**不得**被运行时访问层或渲染层 import。
- 编码 / 解码逻辑唯一源是 `src/geo-contracts/terrain.ts`；本目录不复制第二套编码公式。
- Python 与 TS 两条生产路径产出的 `.r16` + `.meta.json` 必须互相可替换并通过同一契约校验。
