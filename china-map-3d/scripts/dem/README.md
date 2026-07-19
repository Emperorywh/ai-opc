# DEM 高程资产生成流水线（TASK-002）

本目录提供 **可重复** 的 DEM 高程资产生成能力：把 Copernicus DEM GLO-30（或等价输入）
离线转换为满足 `terrain-meta` 契约的 16 位高程图 + 元数据，运行时零外部网络依赖。

> 边界：本 TASK 只交付「生产能力」（脚本 + 测试夹具 + 文档）。真实 4096² 生产资产由
> TASK-003 交付并接入 `pnpm verify:assets -- --scope terrain`。本目录脚本不进浏览器运行时包，
> 不被 `vite build` 打包；`pnpm build` 与 `pnpm lint` 不依赖 Python 环境。

---

## 1. 两条生产路径，同一外部契约

| 路径 | 入口 | 适用场景 | 产出 |
|---|---|---|---|
| **TS 可测试核心** | `tsx scripts/dem/build-heightmap.ts --input <fixture>` | CI / 单测 / 小型确定性夹具（无 Python） | `<name>.r16` + `<name>.meta.json` |
| **Python 生产脚本** | `python scripts/dem/build_heightmap.py --input <tif 或瓦片目录>` | 真实 Copernicus GeoTIFF 拼接 / 重投影 | 同上 |
| **QGIS 人工等价** | 见 §4 参数清单 | 无 Python / rasterio 环境时人工导出一次 | 同上 |

三条路径都必须产出满足 `terrain-meta` 契约（`src/geo-contracts/terrain.ts`）的元数据，以及
**字节布局完全一致** 的 `.r16` 栅格（见 §3）。编码公式的唯一源是
`src/geo-contracts/terrain.ts` 的 `encodeElevationToUint16`：

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
     （X/Y 为 Web 墨卡托米坐标，可用 §5 的公式或 https://epsg.io/3857 换算）。
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

产出后用 `pnpm verify:assets -- --scope terrain` 校验元数据，并用 TS 核心 `readHeightmapRaster`
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

> 生产源数据缓存 / 临时拼接产物 **不得**作为产品资产提交（TASK-002 / TASK-003 回退边界）。
> 仅最终 `.r16` + `.meta.json` 进入 `public/terrain/`。

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

自动化断言见 `tests/dem/build-heightmap.test.ts`，由 `pnpm test` 驱动。

---

## 7. 依赖方向与边界

- 本目录属于**离线资产生产层**，单向依赖 `src/geo-contracts` 契约层；**不得** import React /
  Three.js / 运行时渲染层，也**不得**被运行时访问层或渲染层 import。
- 编码 / 解码逻辑唯一源是 `src/geo-contracts/terrain.ts`；本目录不复制第二套编码公式，
- Python 与 TS 两条生产路径产出的 `.r16` + `.meta.json` 必须互相可替换并通过同一契约校验。
