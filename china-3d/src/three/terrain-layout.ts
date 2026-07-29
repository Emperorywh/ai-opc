/**
 * 地形 plane 米制布局（渲染层派生常量，TASK-006）。
 *
 * 角色与依赖方向：本模块只依赖坐标层 src/lib/projection（MAIN_MAP_WORLD_BOUNDS —— 主图世界包围盒的
 * 唯一源），把世界包围盒派生为 plane 的米制尺寸与 mesh 定位。不依赖 three / React / R3F（纯数值常量），
 * 也不依赖任何配置——这是「主图世界范围」的渲染几何映射，与夸张系数、分段预算正交。
 *
 * 单独成文件而非与 ChinaTerrainMesh 合并：既满足 react/only-export-components（组件文件只导出组件），
 * 也使页面装配（src/App 的相机 target）与 ChinaTerrainMesh 的 mesh 定位共用同一份「主图世界中心」
 * 派生，杜绝两处各算一遍 centerZ 产生漂移。
 */

import { MAIN_MAP_WORLD_BOUNDS } from '../lib/projection'

/**
 * 由主图世界包围盒派生的 plane 米制尺寸与定位（模块加载时一次性计算并冻结）。
 *
 * 字段语义（与 src/lib/projection MAIN_MAP_WORLD_BOUNDS 严格一致）：
 * - worldWidthX：plane 在世界 x（东）方向的米制跨度 = maxX − minX（关于原点对称故 = 2·maxX）。
 * - worldHeightZ：plane 在世界 z（南）方向的米制跨度 = maxZ − minZ（local y 跨度，旋转后映射到世界 z）。
 * - centerZ：mesh 在世界 z 方向的定位，使 plane 覆盖 [minZ, maxZ]；x 方向关于原点对称故 mesh x=0。
 */
export const TERRAIN_PLANE_LAYOUT = Object.freeze({
  worldWidthX: MAIN_MAP_WORLD_BOUNDS.maxX - MAIN_MAP_WORLD_BOUNDS.minX,
  worldHeightZ: MAIN_MAP_WORLD_BOUNDS.maxZ - MAIN_MAP_WORLD_BOUNDS.minZ,
  centerZ: (MAIN_MAP_WORLD_BOUNDS.minZ + MAIN_MAP_WORLD_BOUNDS.maxZ) / 2,
})
