// ============================================================================
// 地图坐标 → 场景坐标的唯一映射入口（SPEC §3，PLAN §3-E）
// ----------------------------------------------------------------------------
// 设计要点：
// 1. 纯函数，不依赖 React / three，便于在 node 端单测与 CPU 端几何工具复用。
// 2. 轴映射：地图 (x, y) → 场景 (x, z)，平铺到 y=0 水平面；
//    isFlipY 置 true 时对 z 取反（即对源 y 取反），用于运行时校正上下镜像。
// 3. 唯一入口：geometry / NodesLayer / LabelsLayer / MapView fit 等所有
//    坐标映射必须复用本文件函数，scene 层不得手写映射公式，避免翻转不一致。
// ============================================================================

import type { Box2XY } from '../data/types.ts'

// ----------------------------------------------------------------------------
// 输出类型：场景水平面（xz）上的点 / 向量 / 包围盒
// 与 three 的 Vector3 用法解耦——这里只产出 {x, z} 二元组，由调用方决定 y。
// ----------------------------------------------------------------------------

// 场景点：地图的 (x, y) 映射后落到 y=0 平面的 (x, z)
export interface ScenePoint2 {
  x: number
  z: number
}

// 场景方向向量（切线 / 法线 / 行驶方向）
export interface SceneVector2 {
  x: number
  z: number
}

// 场景 xz 平面包围盒：相机 fit 时按此范围计算 zoom（正交）/ 距离（透视）
export interface SceneBox2 {
  minX: number
  maxX: number
  minZ: number
  maxZ: number
}

// ----------------------------------------------------------------------------
// 映射选项：是否翻转 Y（作用于 z）、单位比例
// 均可选，缺省时取安全默认（isFlipY=false、unitScale=1），保证无参也安全。
// ----------------------------------------------------------------------------
export interface MapToSceneOptions {
  isFlipY?: boolean
  unitScale?: number
}

// ----------------------------------------------------------------------------
// 工具：规范化映射选项，缺省 / 非法值统一退化为安全默认
// 避免下游几何计算被 NaN 或异常缩放因子污染。
// ----------------------------------------------------------------------------
function resolveOptions(opts: MapToSceneOptions | undefined): {
  isFlipY: boolean
  unitScale: number
} {
  return {
    // 仅显式 true 才翻转，避免任何 truthy 误判
    isFlipY: opts?.isFlipY === true,
    // 非有限数值（NaN/Infinity/undefined）退化为 1，保证 1:1 兜底
    unitScale:
      typeof opts?.unitScale === 'number' && Number.isFinite(opts.unitScale)
        ? opts.unitScale
        : 1,
  }
}

// ----------------------------------------------------------------------------
// 地图点 → 场景点
// 地图 {x, y} → 场景 {x, z}：
//   x = point.x * unitScale
//   z = (isFlipY ? -point.y : point.y) * unitScale
// unitScale 为 1 时即 1:1 直用（SPEC §3）。
// ----------------------------------------------------------------------------
export function mapPointToScene(
  point: { x: number; y: number },
  opts?: MapToSceneOptions,
): ScenePoint2 {
  const { isFlipY, unitScale } = resolveOptions(opts)
  return {
    x: point.x * unitScale,
    z: (isFlipY ? -point.y : point.y) * unitScale,
  }
}

// ----------------------------------------------------------------------------
// 地图向量（切线 / 方向）→ 场景方向向量，并归一化为单位向量
// 方向只关心朝向不关心长度，因此归一化；翻转作用于 z 分量。
// 说明：单位比例 unitScale 在归一化后会被抵消，故此处不施加，
//       避免引入无关缩放干扰「方向」语义。
// 零向量无法归一化时，原样返回映射结果（通常为 0,0），
// 避免产生 NaN 污染下游箭头朝向 / 法线偏移计算。
// ----------------------------------------------------------------------------
export function mapVectorToScene(
  vector: { x: number; y: number },
  opts?: MapToSceneOptions,
): SceneVector2 {
  // 方向向量只取翻转开关，不取 unitScale（见上方说明）
  const { isFlipY } = resolveOptions(opts)
  const x = vector.x
  const z = isFlipY ? -vector.y : vector.y
  const len = Math.hypot(x, z)
  // 零向量：返回未归一化结果，杜绝 NaN
  if (len === 0) {
    return { x, z }
  }
  return { x: x / len, z: z / len }
}

// ----------------------------------------------------------------------------
// 地图包围盒（Box2XY，xy）→ 场景包围盒（SceneBox2，xz）
// 用于相机 fit。Y 翻转会让 z 的 min/max 关系互换，
// 故必须把四个角点逐个映射后再重新取 min/max，而非简单字段搬运。
// ----------------------------------------------------------------------------
export function mapBoxToSceneBox(bbox: Box2XY, opts?: MapToSceneOptions): SceneBox2 {
  const { isFlipY, unitScale } = resolveOptions(opts)
  // 映射四个角点，覆盖翻转后所有边界组合
  const corners: ScenePoint2[] = [
    mapPointToScene({ x: bbox.minX, y: bbox.minY }, { isFlipY, unitScale }),
    mapPointToScene({ x: bbox.minX, y: bbox.maxY }, { isFlipY, unitScale }),
    mapPointToScene({ x: bbox.maxX, y: bbox.minY }, { isFlipY, unitScale }),
    mapPointToScene({ x: bbox.maxX, y: bbox.maxY }, { isFlipY, unitScale }),
  ]
  // 重新取 min/max，正确处理翻转导致的 min/max 互换
  let minX = Infinity
  let maxX = -Infinity
  let minZ = Infinity
  let maxZ = -Infinity
  for (const c of corners) {
    if (c.x < minX) minX = c.x
    if (c.x > maxX) maxX = c.x
    if (c.z < minZ) minZ = c.z
    if (c.z > maxZ) maxZ = c.z
  }
  return { minX, maxX, minZ, maxZ }
}
