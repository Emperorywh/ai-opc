/**
 * R3F 场景内容根（SPEC §4.1 / §4.3 渲染管线）。
 *
 * Task 04：挂载 Terrain（GPU 顶点位移 + 基础分层着色）+ 光照。
 * Task 06：挂载 Ocean（透明几何 + §4.3 渲染顺序）。
 * Task 09：静态倾斜相机 → SandboxControls（受限 pan/zoom + 阻尼）。
 * Task 11：挂载 AdaptiveQuality（FPS 探测分档 → dpr/shader 开关，§4.3 管线首项）。
 * 加载链路：loadTerrainAssets()（Task 03）异步 fetch+parse → 渲染 Terrain + Ocean。
 * 后续：Labels(14) → Atmosphere(16) → ...
 */
import { useEffect, useState } from 'react'
import { loadTerrainAssets } from '../data/assets'
import type { TerrainAssets } from '../data/types'
import { AdaptiveQuality } from './effects/AdaptiveQuality'
import { SandboxControls } from './camera/SandboxControls'
import { Terrain } from './terrain/Terrain'
import { terrainLight } from './terrain/terrainMaterial'
import { Ocean } from './ocean/Ocean'

export function Scene() {
  const [assets, setAssets] = useState<TerrainAssets | null>(null)
  const [error, setError] = useState<unknown>(null)

  useEffect(() => {
    let cancelled = false
    loadTerrainAssets()
      .then((a) => {
        if (!cancelled) setAssets(a)
      })
      .catch((e) => {
        if (!cancelled) setError(e)
      })
    return () => {
      cancelled = true
    }
  }, [])

  if (error) {
    // M1 仅记录；加载进度页 + 降级在 M5（Task 17）
    console.error('[Scene] 地形资产加载失败：', error)
  }

  return (
    <>
      <color attach="background" args={['#0e1014']} />
      {/* SPEC §4.3 管线首项：FPS 探测 → dpr / shader 复杂度开关（写 store qualityTier）。
          须在 Ocean/Terrain 订阅 qualityTier 前挂载；纯副作用组件，渲染 null。 */}
      <AdaptiveQuality />
      <SandboxControls />
      {/*
        光照参数与 terrainMaterial 同源（SPEC §2.3）。
        M1 自定义 ShaderMaterial 自包含光照（不接收 R3F 灯）；
        此处 R3F 灯为 M2 standard 材质复用 + 视觉一致性预留。
      */}
      <hemisphereLight
        color={terrainLight.hemisphere.sky}
        groundColor={terrainLight.hemisphere.ground}
        intensity={terrainLight.hemisphere.intensity}
      />
      <directionalLight
        color={terrainLight.directional.color}
        intensity={terrainLight.directional.intensity}
        position={terrainLight.directional.direction}
      />
      {assets ? (
        <>
          {/*
            SPEC §4.3 渲染顺序：Terrain 先绘（不透明写深度）→ Ocean 后绘（透明 depthWrite=false）。
            Three.js 据 transparent 标志自动后绘透明物体，Ocean renderOrder=1 进一步明确；
            Ocean depthTest 读 Terrain 已写深度 → 陆地遮挡海洋、海床被半透明海洋覆盖（海洋不穿地形）。
          */}
          <Terrain assets={assets} />
          <Ocean assets={assets} />
        </>
      ) : null}
    </>
  )
}
