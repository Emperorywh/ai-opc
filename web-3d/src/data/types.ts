/**
 * 领域类型（SPEC §4.1）。
 *
 * Country/River/Label 的完整字段在对应 Task（M4 标签 / M6 边界 / M10 河流）随二进制数据格式确定；
 * MetaJson / ElevationData / TerrainAssets 由 Task 03 数据加载层落地。
 */
import type { DataTexture, Texture } from 'three'

/** `public/data/meta.json` 原始结构（Task 02 烘焙产出；结构兼容 `ElevationMeta`）。 */
export type MetaJson = {
  version: number
  source: string
  projection: 'equirectangular' | 'robinson'
  width: number
  height: number
  elevationMin: number
  elevationMax: number
  seaLevelMeters: number
  heightExaggeration: number
}

/**
 * CPU 侧高程数据：16-bit Uint16 像素缓冲 + 尺寸（R3 同源）。
 * 布局与 Task 02 烘焙一致：行主序，row 0 = +90°N（北），col 0 = −180°；值域 [0,65535]。
 */
export type ElevationData = {
  width: number
  height: number
  data: Uint16Array
}

/** 加载完成的地形资产（供 Task 04 Terrain/Ocean 消费）。 */
export type TerrainAssets = {
  meta: MetaJson
  /** 16-bit 高程上传为 R32F（float，LINEAR 可采样），供顶点位移。 */
  heightTexture: DataTexture
  /** 8-bit RGB 法线贴图（细节增强）。 */
  normalTexture: Texture
  /** CPU 高程缓冲（双线性查询 / 河流采样 / 标签锚点 y / 拾取深度偏移，R3）。 */
  elevation: ElevationData
}

/**
 * 国家（M6 边界数据 pipeline 填充完整字段）。
 * `id` 为拾取稳定 id（= boundaries.bin 国家记录序号）；`isoA3` 为 join key；`continent` 为大洲名。
 */
export type Country = {
  id: number
  isoA3: string
  continent: string
}

/**
 * 解码后的国家边界数据（Task 19 pipeline 产物 `boundaries.bin`，Task 20 渲染层消费）。
 *
 * 二进制存**地理 lon,lat**（顶点交错 [lon0,lat0,lon1,lat1,...]）；MVP equirect 线性投影由前端
 * `project()` 在几何构建时完成（与地形/标签同源对齐 R2）。三角化在 lon,lat 2D 空间烘焙，
 * equirect 线性投影保持三角化有效（无自交/翻转）。
 */
export type BoundaryData = {
  /** 顶点 [lon0,lat0,lon1,lat1,...]（全局共享池，Task 20 project→BufferAttribute position）。 */
  vertices: Float32Array
  /** 填充三角形全局顶点索引（Task 20 → BufferGeometry index，拾取/填充面）。 */
  fillIndices: Uint32Array
  /** 边界线段全局顶点索引（成对，Task 20 → LineSegments index）。 */
  borderIndices: Uint32Array
  /** 大洲名表（country.continentIndex 索引）。 */
  continents: string[]
  /** 国家记录（属性 + 每国家顶点/索引范围）。 */
  countries: BoundaryCountry[]
}

/** 国家边界记录（BoundaryData.countries 元素）。属性部分同 `Country`。 */
export type BoundaryCountry = Country & {
  /** 大洲在 continents 表中的下标。 */
  continentIndex: number
  /** 该国家顶点在 vertices 中的起始（顶点单位）。 */
  vertexOffset: number
  vertexCount: number
  /** 该国家三角形索引在 fillIndices 中的起始（index 单位）。 */
  fillIndexOffset: number
  fillIndexCount: number
  /** 该国家边界索引在 borderIndices 中的起始（index 单位）。 */
  borderIndexOffset: number
  borderIndexCount: number
}

/**
 * 解码后的争议边界数据（Task 19 pipeline 产物 `disputed.bin`，Task 21 渲染层消费）。
 * 每条折线为一条 line strip（争议区虚线），顶点 [lon,lat,...] 地理坐标。
 */
export type DisputedData = {
  vertices: Float32Array
  lines: DisputedLine[]
}

/** 争议折线记录（DisputedData.lines 元素）。 */
export type DisputedLine = {
  /** 折线顶点在 vertices 中的起始（顶点单位）。 */
  vertexOffset: number
  vertexCount: number
  /** 折线名（克什米尔/克里米亚等；合成数据粗略占位）。 */
  id: string
}

/** 河流（M10 河流数据 pipeline 填充完整字段）。 */
export type River = {
  id: number
  name: string
}

/**
 * 标签（Task 13 M4 标签数据 pipeline 落地完整字段）。
 * 结构对齐 SPEC §6.5：`{id, zhName, kind, continent, lon, lat, priority}`。
 */
export type Label = {
  id: string
  zhName: string
  kind: 'continent' | 'ocean' | 'country' | 'city'
  /** 所属大洲英文 id（大洲标签 = 自身；大洋标签 = null，大洋不属任何大洲）。 */
  continent: string | null
  lon: number
  lat: number
  priority: number
}
