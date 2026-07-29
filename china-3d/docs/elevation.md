# 共享运行时高程查询与 GPU 位移解码一致性（TASK-006）

本文档说明 china-3d 的**共享 CPU 高程查询层**（`src/lib/elevation.ts`）与 **GPU 顶点位移解码**
（`src/three/terrain-shaders.ts` + `src/three/load-heightmap-texture.ts`）如何共用同一份 16 位
heightmap 事实源、以同一套解码语义产出真实米制海拔。SPEC §3.6 的「CPU 端 heightmap」与 §7.5 的
「遮挡射线」明确要求边界 densification / 遮挡判定 / 海面以下判定共用同一份高程数据；本模块即该
事实源的运行时入口（省界贴地 TASK-009、标签遮挡 TASK-010、海面 TASK-007 均为其消费者）。

> 适用范围：只读高程查询。不为 4096² 网格在 CPU 逐顶点写入位移或法线（SPEC §7.1 红线），不依赖
> React / Three.js 场景对象、标签或省界渲染。

---

## 1. 分层与依赖方向

```
                  ┌──────────────────────────────────────────┐
   契约层          │ src/geo-contracts                        │  纯 TS，零渲染依赖
  （公共稳定面）   │   decodeUint16ToElevation、              │
                  │   validateTerrainMeta、TerrainMetaContract│
                  │   ↑ 只能单向依赖                          │
                  ├──────────────────────────────────────────┤
   运行时访问层    │ src/lib/projection.ts（TASK-002）        │  世界/经纬度→UV 的投影权威
  （坐标 + 高程）  │ src/lib/elevation.ts（本 TASK）          │  依赖契约层 + 投影层
                  │   ↑ 只能单向依赖                          │
                  ├──────────────────────────────────────────┤
   渲染层          │ src/three/load-heightmap-texture.ts      │  复用 decodeHeightmapBytes
                  │ src/three/terrain-shaders.ts             │  着色器仿射 = 契约层解码
                  │ src/three/ChinaTerrainMesh.tsx           │  GPU 位移 + 分层设色
                  └──────────────────────────────────────────┘
```

**强约束**：
- 高程查询层 `src/lib/elevation.ts` 只依赖契约层（`decodeUint16ToElevation` 是 16 位编解码的唯一源、
  `validateTerrainMeta` 是元数据校验入口）与同层坐标权威 `src/lib/projection`（世界坐标 / 经纬度 → UV
  的唯一投影入口）。**禁止** import React / Three.js / R3F 场景对象、标签或省界渲染。
- GPU 位移纹理是「另一份表示」（RedFormat+FloatType 归一化码纹理，着色器自行采样），但 CPU 与 GPU
  **解码语义必须一致**：二者都用 `h = normalized·(max−min) + min` 这同一仿射（契约层
  `decodeUint16ToElevation` 的 `normalized = code/65535` 形态），且双线性对归一化编码的仿射性保证
  CPU 先解码四角再插值 == GPU 先硬件双线性再解码（见 §3）。本模块是 CPU 侧唯一查询入口，不存在
  第二套 CPU 解码；`decodeNormalizedToElevation`（src/config/terrain-config）是着色器仿射的 CPU 镜像，
  供测试断言一致性。

---

## 2. 16 位解码与内存表示

- 资产是行主序、**行 0 = 北、列 0 = 西**、每像元 2 字节小端 uint16 的 `.r16`（见
  `scripts/dem/build-heightmap.ts` 的 `writeHeightmapAssets`）。运行时经 `decodeHeightmapBytes` 只解码
  一次：小端主机走 `Uint16Array` 零拷贝视图（偶数字节偏移），大端 / 未对齐回退到 `DataView` 逐像元
  小端读取。**全程不经过 8 位浏览器图像解码**——8 位会丢失高程精度（SPEC §5.1、TASK-003 实现约束）。
- 解码后的 `Uint16Array` 是本层持有的**唯一**高开销表示（4096²×2B ≈ 32MB，SPEC §7.2）。绝不复制成
  多份 JS 数组，也绝不在 CPU 端逐顶点写入位移 / 法线——本层只提供按需查询，不做几何生成
  （SPEC §7.1 红线）。
- `loadHeightmapTexture` 返回的 `pixels` 就是这份已解码数组（构造 GPU 纹理时解码一次），上层用
  `createElevationProvider(meta, pixels)` 包装即得共享 provider——GPU 纹理（float 归一化）与 CPU
  pixels（uint16）是同一源的两种表示，零额外取数 / 解码 / 内存（SPEC §3.6「GPU 位移用的纹理是
  另一份」指表示不同，非各自取数）。

---

## 3. 双线性采样（与 GPU 纹理采样等价）

UV 约定（与 `src/lib/projection.ts` 末段「heightmap 行 0=北、列 0=西；u 随 +X/东增，纹理 v 对应
北→南行序」严格一致）：

| 维度 | 约定 |
|---|---|
| u ∈ [0,1] | 随经度向东递增；u=0 西界列 0、u=1 东界列 width−1 |
| v ∈ [0,1] | 随「北→南」行序递增；v=0 北界行 0、v=1 南界行 height−1（标准纹理原点在西北角） |
| 像元中心 (col,row) | u=(col+0.5)/width、v=(row+0.5)/height |
| 列 / 行分数坐标 | fx=u·width−0.5、fy=v·height−0.5 |

采样步骤：取四角 uint16 编码 → 各自 `decodeUint16ToElevation` 还原成真实米制 → 对四个米值做双线性。
由于 `decode(c) = c/65535·(max−min) + min` 是**仿射**，双线性(米) = decode(双线性(编码)) —— 这与
GPU 在归一化 FloatType 纹理上做硬件双线性、再在着色器里线性解码到米的结果在浮点精度内一致
（自动化测试在生产资产 8 个抽样点上以 0.01m 容差断言，见 `tests/terrain-mesh.test.ts`）。
因此 CPU 与 GPU 共用同一高程事实源且语义相同。

> 与 `scripts/verify-assets/terrain-deep.ts` 的 `bilinearSampleCode` 区别：那是资产统计口径，会把
> 双线性编码 `round` 成整数再 decode；本模块**不** round（保留亚像元精度），以匹配 GPU 片元采样。
> 边缘像元（u=0/1、v=0/1）收敛到边界像元值，不外推。

---

## 4. API 概览（`src/lib/elevation.ts`）

| 导出 | 语义 | 失败 / 抛错条件 |
|---|---|---|
| `decodeHeightmapBytes(bytes, expectedPixelCount)` | 小端字节 → Uint16Array（唯一解码入口） | 字节长度不符 / 期望像元数非正 → 抛 `ElevationProviderError` |
| `createElevationProvider(meta, pixels)` | 包装已解码 Uint16Array 为只读 provider（不介入缓存） | meta 不通过契约 / 像元数与分辨率不符 → 抛 |
| `getSharedElevationProvider(meta, bytes)` | 共享缓存入口：同一 bytes 只解码一次 | 同上 + 字节长度不符 → 抛（不写入缓存） |
| `provider.queryAtUV(u, v)` | 纹理 UV 查询（与 GPU 对齐） | 非有限 / UV 越界 / 已释放 → 返回失败 |
| `provider.queryAtLonLat(lon, lat)` | 经纬度查询（经同一墨卡托映射到 UV） | 非有限 / 越出元数据范围 / 已释放 → 返回失败 |
| `provider.queryAtWorld(x, z)` | 主图世界坐标查询（hover 反查、遮挡落点） | 非有限 / 反投影失败 / 越出范围 / 已释放 → 返回失败 |
| `provider.release()` | 显式释放（清空 32MB 引用、从缓存摘除） | 幂等 |

**结果类型**：查询返回 `ElevationQueryResult` 判别联合——成功带 `meters`（真实海拔，米）与按符号
划分的 `kind`（`below-sea-level` / `sea-level` / `above-sea-level`），失败带稳定 `code` 与简体中文
`message`。**失败绝不伪装成 `meters:0` 的成功**——海平面 0m 是合法读数，异常 / 越界 / 已释放必须
显式区分。

**加载期错误**：`ElevationProviderError`（带稳定 code：`elevation.meta-invalid` /
`elevation.raster-size-mismatch` / `elevation.decode-byte-length-mismatch`），调用方在取得 provider
之前即可确定性地发现坏元数据 / 坏栅格；加载失败时**绝不**静默落到平地 fallback（SPEC 红线）。

---

## 5. 共享生命周期（单份事实源）

- `getSharedElevationProvider(meta, bytes)` 以「源字节 `Uint8Array` 引用」为弱键（`WeakMap`）缓存
  provider：同一份 bytes 多次传入只解码一次、返回 `===` 同一 provider 实例；不同 bytes 引用各自独立
  （重新取数即重新解码，符合引用语义）。
- `WeakMap` 键控源字节：调用方释放源字节引用后，provider 及其 32MB 数组随之可被 GC，不遗留大数组
  （SPEC §7.4 长时运行内存稳定）。
- `provider.release()` 显式释放：清空内部 `Uint16Array` 引用、从缓存摘除自身；此后任何查询返回
  `elevation.released` 失败（绝不返回伪造海拔）。`createElevationProvider` 不介入缓存，供已自行解码
  （测试 / `loadHeightmapTexture` 已解码 pixels）的调用方直接包装。

---

## 6. 经纬度 / 世界坐标 → UV 的映射

- `queryAtLonLat`：把经纬度与元数据 `geographicExtent` 四角都经 `projectToMercator`（统一墨卡托），
  再在墨卡托平面归一化为 UV：`u = (Mx − Mx_sw)/(Mx_ne − Mx_sw)`、`v = (My_ne − My)/(My_ne − My_sw)`
  （v=0 在北，因行 0=北）。这与离线生产布局（mercator 均匀网格）、与
  `scripts/verify-assets/terrain-deep.ts` 的 `lonLatToRasterFraction` 严格一致。范围检查含端点；
  越出 `geographicExtent` 的点返回 `lonlat-out-of-extent`，不静默夹到边界。
- `queryAtWorld`：先 `invertWorld`（TASK-002）反算经纬度，再走 `queryAtLonLat`。反投影失败透传为
  `projection-failed`；反算落点越出元数据范围由 `queryAtLonLat` 兜底。世界坐标路径只对主图资产
  有意义（世界以 `MAIN_MAP_CENTER` 为原点）。

> 墨卡托纬度非线性：地理纬度中点不映射到 v=0.5（高纬被拉伸）。消费者若需要「范围中心」的高程，
> 应直接传入中心经纬度，而非假定 v=0.5。

---

## 7. GPU 位移链路与本层的分工（SPEC §7.1）

- **GPU 位移**（`ChinaTerrainMesh` + `terrain-shaders`）：PlaneGeometry（顶点为平面 + UV）→ vertex
  shader 按 UV 采样归一化码纹理 → 仿射解码 h → `displaced.z += h·k·uRise`（经模型旋转即世界
  y = h·k，k 来自 src/config/terrain-config，默认 2.0、可配 1.5–3.0）→ 有限差分现场估法线。
  分段默认 2048²、上限 4096²（配置项暴露），位移恒在 GPU，CPU 只建一份平面几何。
- **分层设色**：fragment shader 按像素 UV 重采样同一纹理得真实 h（**不用 world-y**，它会偏色 k 倍），
  按 meta minH/maxH 归一化查 256×1 ramp（src/config/elevation-color-ramp 唯一事实源），叠加方向光
  法线明暗（src/config/scene-atmosphere 唯一事实源，TASK-008 起）。
- **CPU 查询**（本模块）：贴地 / 遮挡 / 海面以下判定共用同一份 uint16 pixels 的双线性米值查询，
  与 GPU 同源同解码（§3）。
