#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
DEM 高程资产生产流水线（Copernicus DEM GLO-30 → 16 位 heightmap + 契约元数据）。

这是 TASK-002 的「生产路径」：处理真实 GeoTIFF DEM 的下载 / 读取本地缓存、拼接、裁剪、
EPSG:4326→EPSG:3857 重投影、双线性重采样、16 位线性编码与元数据导出。

为什么同时存在 TS 可测试核心（scripts/dem/build-heightmap.ts）与本 Python 脚本：
- TS 核心让 pnpm test 在无 Python / rasterio 的 CI 环境也能确定性证明重投影、重采样、
  截断与负高程保留；
- 本脚本负责真实 Copernicus GeoTIFF 的重 IO 与 rasterio 重投影。
两者遵循【同一编码契约】——线性映射 [-1500m, 9000m] → 0..65535，clamp-to-range，
保留浅水负高程、深海截断到下限。编码公式的唯一源是
src/geo-contracts/terrain.ts 的 encodeElevationToUint16；本脚本与 TS 核心产出的 .r16 + .meta.json
满足同一外部契约，可互相替换。QGIS 人工导出路径见同目录 README.md，亦产出同一契约。

字节布局（与 TS 核心严格一致）：
- .r16：行主序、行 0 = 北、列 0 = 西、每像元 2 字节小端 uint16。
- .meta.json：满足 terrain-meta 契约（src/geo-contracts/terrain.ts），可由
  pnpm verify:assets -- --scope terrain 校验。

依赖：Python 3.9+，pip install rasterio numpy。Windows 安装说明见同目录 README.md。
"""

from __future__ import annotations

import argparse
import glob
import json
import math
import os
import sys
import urllib.request

import numpy as np
import rasterio
from rasterio import transform as rio_transform
from rasterio.enums import Resampling
from rasterio.merge import merge
from rasterio.warp import reproject

# ── 生产参数（SPEC §3.3 / §5.1）──────────────────────────────────────────────
# 与 TS 核心 build-heightmap.ts 的 PRODUCTION_* 常量保持一致；改动须双向同步。
PRODUCTION_EXTENT = {"west": 72.0, "south": 3.0, "east": 136.0, "north": 54.0}
PRODUCTION_RESOLUTION = {"width": 4096, "height": 4096}
ELEVATION_MIN_METERS = -1500.0  # 保留浅水负高程，故下限为负
ELEVATION_MAX_METERS = 9000.0
PRODUCTION_SOURCE_ID = "src-copernicus-dem"

# Web 墨卡托（EPSG:3857）球面半长轴，与 TS 核心 mercator.ts 一致。
WEB_MERCATOR_RADIUS = 6378137.0


def project_lonlat_to_web_mercator(lon_deg: float, lat_deg: float) -> tuple[float, float]:
    """EPSG:4326 经纬度（度）→ EPSG:3857 平面米坐标。闭式公式，与 TS 核心互为参照。"""
    lon_rad = math.radians(lon_deg)
    lat_clamped = max(-85.05112878, min(85.05112878, lat_deg))
    lat_rad = math.radians(lat_clamped)
    x = WEB_MERCATOR_RADIUS * lon_rad
    y = WEB_MERCATOR_RADIUS * math.log(math.tan(math.pi / 4 + lat_rad / 2))
    return x, y


# Copernicus DEM GLO-30 在 AWS Open Data 的 HTTPS 根（公开、免登录）。仅用于离线生产期下载，
# 运行时零外网依赖——下载产物作为本地缓存传入流水线，不随产品提交。
COPERNICUS_DEM_HTTPS_ROOT = "https://copernicus-dem-30m.s3.eu-central-1.amazonaws.com"


def enumerate_copernicus_tiles(extent: dict) -> list[str]:
    """
    按目标经纬度范围枚举所需的 1°×1° Copernicus GLO-30 瓦片名。
    瓦片命名：Copernicus_DSM_COG_10_<N|S><lat:02d>_00_<E|W><lon:03d>_00_DEM。
    本项目范围 [72°E–136°E, 3°N–54°N] 全部落在北纬东经，故 NS=N、WE=E。
    """
    lat_lo = int(math.floor(extent["south"]))
    lat_hi = int(math.ceil(extent["north"]))
    lon_lo = int(math.floor(extent["west"]))
    lon_hi = int(math.ceil(extent["east"]))
    tiles: list[str] = []
    for lat in range(lat_lo, lat_hi):
        ns = "N" if lat >= 0 else "S"
        for lon in range(lon_lo, lon_hi):
            we = "E" if lon >= 0 else "W"
            tiles.append(f"Copernicus_DSM_COG_10_{ns}{abs(lat):02d}_00_{we}{abs(lon):03d}_00_DEM")
    return tiles


def download_copernicus_tiles(extent: dict, cache_dir: str) -> str:
    """
    下载目标范围所需的 Copernicus GLO-30 瓦片到 cache_dir，返回 cache_dir 供流水线读取。
    已存在的瓦片跳过（断点续传语义）。失败瓦片记录后继续，最终若全部失败则退出码非 0。
    生产范围约 3264 个瓦片、数十 GB，建议在带宽充足的环境执行或先缩小范围验证。
    """
    os.makedirs(cache_dir, exist_ok=True)
    tiles = enumerate_copernicus_tiles(extent)
    failures: list[str] = []
    for index, tile in enumerate(tiles, start=1):
        url = f"{COPERNICUS_DEM_HTTPS_ROOT}/{tile}/{tile}.tif"
        dest = os.path.join(cache_dir, tile + ".tif")
        if os.path.exists(dest):
            continue
        try:
            print(f"  [{index}/{len(tiles)}] 下载 {tile} ...", file=sys.stderr)
            urllib.request.urlretrieve(url, dest)
        except Exception as cause:  # noqa: BLE001 — 下载容错，记录后继续而非整体中断
            failures.append(tile)
            print(f"    警告：下载失败 {tile}：{cause}", file=sys.stderr)
    if len(failures) == len(tiles):
        raise SystemExit(f"[dem-input.coverage] 全部 {len(tiles)} 个瓦片下载失败，请检查网络与端点。")
    if failures:
        print(f"  注意：{len(failures)} 个瓦片下载失败（已跳过），可能影响覆盖范围。", file=sys.stderr)
    return cache_dir


def encode_elevation_to_uint16(meters: np.ndarray) -> np.ndarray:
    """
    真实米制海拔 → 16 位无符号整数编码（唯一编码源的同语言实现）。

    公式（与 src/geo-contracts/terrain.ts encodeElevationToUint16 完全一致）：
        code = round((meters - min) / (max - min) * 65535)，再 clip 到 [0, 65535]。
    - 浅水负高程（>= -1500m）保留为合法低位编码；
    - 深海（< -1500m）截断到 0 码（= 下限 -1500m）；
    - 超高（> 9000m）截断到 65535 码（= 上限 9000m）。
    不得在此另写一套公式或把所有负高程钳制为 0。
    """
    span = ELEVATION_MAX_METERS - ELEVATION_MIN_METERS
    normalized = (meters - ELEVATION_MIN_METERS) / span
    clamped = np.clip(normalized, 0.0, 1.0)
    return np.round(clamped * 65535.0).astype(np.uint16)


def load_source_array(input_path: str):
    """
    读取输入 DEM：单文件直接打开；目录则合并其下全部 GeoTIFF 为一幅拼接影像。
    Copernicus DEM GLO-30 原始瓦片为 EPSG:4326；此处不假设，由 rasterio 自带的 CRS 驱动重投影。
    """
    if os.path.isdir(input_path):
        tiles = sorted(glob.glob(os.path.join(input_path, "*.tif")) + glob.glob(os.path.join(input_path, "*.tiff")))
        if not tiles:
            raise SystemExit(f"[dem-input.coverage] 输入目录未找到 GeoTIFF 瓦片：{input_path}")
        datasets = [rasterio.open(t) for t in tiles]
        try:
            mosaic, mosaic_transform = merge(datasets)
        finally:
            for ds in datasets:
                ds.close()
        # merge 返回 (bands, rows, cols)；取第一波段。
        return mosaic[0], mosaic_transform, datasets[0].crs, datasets[0].nodatavals[0]
    elif os.path.isfile(input_path):
        with rasterio.open(input_path) as ds:
            band = ds.read(1)
            return band, ds.transform, ds.crs, ds.nodata
    else:
        raise SystemExit(f"[dem-input.format] 输入既非文件也非目录：{input_path}")


def assert_coverage(src_bounds: tuple[float, float, float, float], target: dict) -> None:
    """源 DEM 必须完整覆盖目标范围，否则确定性失败（不得默认平面兜底）。"""
    s_west, s_south, s_east, s_north = src_bounds
    if (s_west > target["west"] or s_east < target["east"]
            or s_south > target["south"] or s_north < target["north"]):
        raise SystemExit(
            f"[dem-input.coverage] 源范围 {src_bounds} 未完整覆盖目标范围 "
            f"({target['west']},{target['south']},{target['east']},{target['north']})"
        )


def build_heightmap(input_path: str, extent: dict, resolution: dict, source_id: str) -> tuple[np.ndarray, dict]:
    """
    构建目标 EPSG:3857 栅格并 16 位编码。
    返回 (uint16 像素数组 row-major row0=北, meta 字典)。
    """
    source_band, src_transform, src_crs, src_nodata = load_source_array(input_path)

    if src_crs is None:
        raise SystemExit("[dem-input.crs] 源 DEM 缺失 CRS，无法重投影到 EPSG:3857。")

    # 源四至用于覆盖范围核对。array_bounds(rows, cols, transform) 返回 BoundingBox，
    # 位置语义为 (west, south, east, north)，与 assert_coverage 的入参 (west,south,east,north) 一致。
    west_b, south_b, east_b, north_b = rio_transform.array_bounds(
        source_band.shape[0], source_band.shape[1], src_transform
    )
    assert_coverage((west_b, south_b, east_b, north_b), extent)

    # 目标 EPSG:3857 平面四至（米）。
    x_min, y_min = project_lonlat_to_web_mercator(extent["west"], extent["south"])
    x_max, y_max = project_lonlat_to_web_mercator(extent["east"], extent["north"])
    width, height = resolution["width"], resolution["height"]

    # 目标仿射变换：左上角 (x_min, y_max)、像元向西/南增长。from_bounds(west, south, east, north)。
    dst_transform = rio_transform.from_bounds(x_min, y_min, x_max, y_max, width, height)
    dst = np.zeros((height, width), dtype=np.float32)

    # 双线性重投影 EPSG:4326（或源 CRS）→ EPSG:3857。nodata 用源 nodata；无则用 NaN。
    reproject(
        source=source_band,
        destination=dst,
        src_transform=src_transform,
        src_crs=src_crs,
        src_nodata=src_nodata if src_nodata is not None else float("nan"),
        dst_transform=dst_transform,
        dst_crs="EPSG:3857",
        dst_nodata=float("nan"),
        resampling=Resampling.bilinear,
    )

    # nodata / NaN 视为海平面 0m（Copernicus 在开放海域常为 0 或 NaN）；不静默丢弃，落到合法编码。
    # 保留真实浅水负高程；后续 encode 对 < -1500m 的深海值统一截断到下限。
    dst = np.where(np.isfinite(dst), dst, 0.0)

    pixels = encode_elevation_to_uint16(dst)

    meta = {
        "kind": "terrain-meta",
        "version": "1.0.0",
        "crs": "EPSG:3857",
        "geographicExtent": {
            "crs": "EPSG:4326",
            "west": extent["west"],
            "south": extent["south"],
            "east": extent["east"],
            "north": extent["north"],
        },
        "resolution": {"widthPixels": width, "heightPixels": height},
        "elevationEncoding": {
            "minValueMeters": ELEVATION_MIN_METERS,
            "maxValueMeters": ELEVATION_MAX_METERS,
            "bitDepth": 16,
            "encoding": "linear-unsigned-integer",
            "outOfRangePolicy": "clamp-to-range",
        },
        "source": {"sourceId": source_id},
    }
    return pixels, meta


def write_assets(pixels: np.ndarray, meta: dict, out_dir: str, base_name: str) -> tuple[str, str]:
    """写 .r16（小端 uint16 行主序）+ .meta.json。先构造全部字节再落盘，避免半成品。"""
    os.makedirs(out_dir, exist_ok=True)
    raster_path = os.path.join(out_dir, base_name + ".r16")
    meta_path = os.path.join(out_dir, base_name + ".meta.json")
    # 显式小端 '<u2' 保证跨平台与 TS 核心 readHeightmapRaster 互逆。
    pixels.astype("<u2").tofile(raster_path)
    with open(meta_path, "w", encoding="utf-8") as f:
        json.dump(meta, f, ensure_ascii=False, indent=2)
        f.write("\n")
    return raster_path, meta_path


def parse_args(argv: list[str]) -> argparse.Namespace:
    p = argparse.ArgumentParser(
        description="Copernicus DEM GLO-30 → 16 位 heightmap + terrain-meta 元数据（离线生产路径）。"
    )
    p.add_argument("--input",
                   help="输入 GeoTIFF 文件或含若干 1°×1° 瓦片的目录（本地缓存）。"
                        "与 --download-to 二选一。")
    p.add_argument("--download-to", dest="download_to", metavar="CACHE_DIR",
                   help="先按目标范围从 AWS Open Data 下载 Copernicus GLO-30 瓦片到该缓存目录，"
                        "再以该目录作为输入。与 --input 二选一。")
    p.add_argument("--out", required=True, help="输出目录。")
    p.add_argument("--name", default="china-heightmap-4096", help="输出基名（默认 china-heightmap-4096）。")
    p.add_argument("--width", type=int, default=PRODUCTION_RESOLUTION["width"])
    p.add_argument("--height", type=int, default=PRODUCTION_RESOLUTION["height"])
    p.add_argument("--source-id", default=PRODUCTION_SOURCE_ID,
                   help="元数据 sourceId，须能在数据来源注册表中解析（默认 src-copernicus-dem）。")
    return p.parse_args(argv)


def main(argv: list[str]) -> int:
    args = parse_args(argv)
    if bool(args.input) == bool(args.download_to):
        raise SystemExit("必须且只能指定 --input 或 --download-to 其中之一。")
    if args.download_to:
        # 先下载瓦片到缓存目录，再以该目录作为流水线输入（读取本地缓存）。
        input_path = download_copernicus_tiles(PRODUCTION_EXTENT, args.download_to)
    else:
        input_path = args.input
    pixels, meta = build_heightmap(
        input_path, PRODUCTION_EXTENT,
        {"width": args.width, "height": args.height},
        args.source_id,
    )
    raster_path, meta_path = write_assets(pixels, meta, args.out, args.name)

    decode_min = float(pixels.min()) / 65535.0 * (ELEVATION_MAX_METERS - ELEVATION_MIN_METERS) + ELEVATION_MIN_METERS
    decode_max = float(pixels.max()) / 65535.0 * (ELEVATION_MAX_METERS - ELEVATION_MIN_METERS) + ELEVATION_MIN_METERS
    clamped_count = int(np.count_nonzero(pixels == 0))
    print("DEM heightmap 生成完成：")
    print(f"  栅格：{raster_path}（{args.width}x{args.height}，16 位小端）")
    print(f"  元数据：{meta_path}")
    print(f"  观测高程：最低 {decode_min:.1f}m / 最高 {decode_max:.1f}m / 截断像元 {clamped_count}")
    print(f"  来源：{args.source_id}（详见数据来源注册表）")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
