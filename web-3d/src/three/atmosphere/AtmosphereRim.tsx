/**
 * 大气层辉光弧壳（SPEC §6.7 + §4.3 渲染管线末项，Task 16）。
 *
 * 贴合 2:1 倾斜平面沙盘边缘的扁椭圆上半球弧壳，fresnel 边缘光晕 + additive 发光，
 * 增强科技感与纵深（SPEC §6.7「背面弧壳 / 平面边缘 fresnel 边框」取前者）。
 *
 * 不依赖 heightmap / assets（辉光是装饰层），故 Scene 可在数据加载前/后任意时机挂载；
 * 渲染顺序 ATMOSPHERE_RENDER_ORDER 高于 Ocean/Terrain/LabelLayer，最后绘叠加（§4.3 末项）。
 *
 * 质量联动（SPEC §8）：订阅 store qualityTier，低档 enabled=false → return null 不渲染。
 * 材质/几何/分档常量见 ./atmosphereMaterial（非组件模块，满足 react-refresh 规则）。
 */
import { useMemo } from 'react'
import { useStore } from '../../state/store'
import {
  SHELL_RADIUS,
  SHELL_SCALE_X,
  SHELL_SCALE_Z,
  SHELL_FLATTEN,
  SHELL_SEGMENTS,
  SHELL_THETA_LENGTH,
  ATMOSPHERE_RENDER_ORDER,
  ATMOSPHERE_BY_TIER,
  createAtmosphereMaterial,
} from './atmosphereMaterial'

export function AtmosphereRim() {
  const qualityTier = useStore((s) => s.qualityTier)
  const cfg = ATMOSPHERE_BY_TIER[qualityTier]
  // 强度随质量档（AdaptiveQuality 写 store qualityTier）；材质重建同源 shader、
  // 仅 uniform 值变（与 Ocean waveCount 同模式）。hooks 须在 early return 前调用。
  const material = useMemo(
    () => createAtmosphereMaterial(cfg.intensity),
    [cfg.intensity],
  )
  // SPEC §8「低档关闭辉光」：不渲染省片元开销。
  if (!cfg.enabled) return null
  return (
    <mesh
      scale={[SHELL_SCALE_X, SHELL_FLATTEN, SHELL_SCALE_Z]}
      material={material}
      renderOrder={ATMOSPHERE_RENDER_ORDER}
    >
      {/* 上半球壳（thetaStart=0, thetaLength=π/2 → y∈[0,R]），scale 压扁成贴合平面的扁椭圆弧壳 */}
      <sphereGeometry
        args={[
          SHELL_RADIUS,
          SHELL_SEGMENTS.width,
          SHELL_SEGMENTS.height,
          0,
          Math.PI * 2,
          0,
          SHELL_THETA_LENGTH,
        ]}
      />
    </mesh>
  )
}
