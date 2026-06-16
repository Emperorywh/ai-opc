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

/** 国家（M6 边界数据 pipeline 填充完整字段）。 */
export type Country = {
  id: number
  isoA3: string
  continent: string
}

/** 河流（M10 河流数据 pipeline 填充完整字段）。 */
export type River = {
  id: number
  name: string
}

/** 标签（M4 标签数据 pipeline 填充完整字段）。 */
export type Label = {
  id: string
  zhName: string
  kind: 'continent' | 'ocean' | 'country' | 'city'
  lon: number
  lat: number
  priority: number
}
