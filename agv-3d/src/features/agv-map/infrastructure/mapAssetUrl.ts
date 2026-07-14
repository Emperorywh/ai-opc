/**
 * 地图资产的自托管 URL。
 *
 * 通过 Vite 的 `?url` 资源导入获取根目录 map.json 的 URL：构建时 Vite 将其原样
 * 输出到 dist/assets（字节内容、大小与 SHA-256 指纹保持不变），开发时由 Vite
 * 直接以同源资源形式提供。资产全程从应用同源加载，不请求任何 CDN（SPEC §4.1）。
 */
import mapAssetUrl from '../../../../map.json?url'

/** 地图资产的同源自托管 URL，供加载流程（后续任务）获取并校验。 */
export const MAP_ASSET_URL: string = mapAssetUrl
