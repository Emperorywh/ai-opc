/**
 * 海洋材质与几何配置（SPEC §6.2 / §4.3，Task 06：透明几何占位）。
 *
 * Task 06：MeshBasicMaterial 半透明纯色（oceanShallow）+ SPEC §4.3 透明渲染顺序契约。
 * ⚠️ Task 07 将本文件扩展为自定义 ShaderMaterial（Gerstner 波 + 菲涅尔 + 深浅渐变 + 流动）。
 *
 * 独立非组件模块（导出常量/函数），使 Ocean.tsx 满足 react-refresh「单组件导出」规则
 *（与 terrainMaterial.ts / Terrain.tsx 同构）。
 */
import * as THREE from 'three'
import { metersToWorldY } from '../../config/projection'
import { palette } from '../../config/palette'
import type { TerrainAssets } from '../../data/types'

/**
 * 海洋网格细分密度。Task 06 无顶点位移（平面），细分不影响当前视觉；
 * 为 Task 07 Gerstner 顶点位移预留足够密度（届时按质量档缩放）。
 */
export const OCEAN_SEGMENTS = { x: 256, y: 128 } as const

/**
 * 海洋材质属性（SPEC §4.3 透明渲染顺序契约）。
 *   transparent=true + depthWrite=false → Ocean 后绘且不污染深度缓冲；
 *   depthTest=true（MeshBasicMaterial 默认）→ 与 Terrain 已写深度比较，
 *     陆地遮挡海洋、海床被海洋覆盖，关系正确。
 *   DoubleSide → 倾斜相机掠射角下海洋两面均可见（稳健性，Task 07 波浪亦需）。
 * 导出 plain object 供单测断言渲染顺序契约（Task 07 由自定义 shader 接管材质主体）。
 */
export const OCEAN_MATERIAL_PROPS = {
  color: palette.oceanShallow,
  transparent: true,
  opacity: 0.7,
  depthWrite: false,
  side: THREE.DoubleSide,
} as const

/**
 * 海洋渲染顺序（SPEC §4.3：透明物体后绘）。Terrain 默认 renderOrder=0 先绘（不透明写深度），
 * Ocean=1 后绘。Three.js 本已按 transparent 标志自动后绘透明物体，显式 renderOrder 为保险。
 */
export const OCEAN_RENDER_ORDER = 1

/**
 * 海平面世界 Y（Task 03 契约：seaLevelMeters → 世界 Y，CPU/GPU 同源）。
 * Task 06 海平面即精确 seaLevel（meta.seaLevelMeters=0 → y=0）；
 * Task 07 可按 SPEC §6.2.5「略低于地形 0 高度」微调以增强体积感。
 */
export function seaLevelWorldY(assets: TerrainAssets): number {
  return metersToWorldY(assets.meta.seaLevelMeters)
}
