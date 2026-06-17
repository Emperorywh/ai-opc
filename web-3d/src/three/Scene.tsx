/**
 * R3F 场景内容根（SPEC §4.1 / §4.3 渲染管线）。
 *
 * Task 04：挂载 Terrain（GPU 顶点位移 + 基础分层着色）+ 光照。
 * Task 06：挂载 Ocean（透明几何 + §4.3 渲染顺序）。
 * Task 09：静态倾斜相机 → SandboxControls（受限 pan/zoom + 阻尼）。
 * Task 11：挂载 AdaptiveQuality（FPS 探测分档 → dpr/shader 开关，§4.3 管线首项）。
 * Task 14：挂载 LabelLayer（troika SDF 标签，§6.5）。labels.json 独立加载，失败不阻塞地形。
 * Task 16：挂载 AtmosphereRim（§6.7 fresnel 弧壳辉光，§4.3 管线末项最后绘叠加）。
 * 加载链路：loadTerrainAssets()（Task 03）异步 fetch+parse → 渲染 Terrain + Ocean + LabelLayer。
 * 后续：Loader/WebGL 降级(17) → 署名/MVP 验收(18) → ...
 */
import { useEffect, useState } from 'react'
import { loadTerrainAssets, loadLabels } from '../data/assets'
import type { TerrainAssets, Label } from '../data/types'
import { AdaptiveQuality } from './effects/AdaptiveQuality'
import { SandboxControls } from './camera/SandboxControls'
import { Terrain } from './terrain/Terrain'
import { terrainLight } from './terrain/terrainMaterial'
import { Ocean } from './ocean/Ocean'
import { LabelLayer } from './labels/LabelLayer'
import { AtmosphereRim } from './atmosphere/AtmosphereRim'

export function Scene() {
  const [assets, setAssets] = useState<TerrainAssets | null>(null)
  const [labels, setLabels] = useState<Label[] | null>(null)
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

  // Task 14：labels.json 独立加载（与地形资产解耦）；加载失败仅记录，不阻塞 Terrain/Ocean。
  useEffect(() => {
    let cancelled = false
    loadLabels()
      .then((l) => {
        if (!cancelled) setLabels(l)
      })
      .catch((e) => {
        if (!cancelled) console.error('[Scene] labels.json 加载失败：', e)
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
            Task 14：LabelLayer（§4.3 在 Ocean 之后绘制，屏幕空间碰撞后绘制留 Task 15）。
          */}
          <Terrain assets={assets} />
          <Ocean assets={assets} />
          {labels ? <LabelLayer assets={assets} labels={labels} /> : null}
        </>
      ) : null}
      {/*
        SPEC §6.7 + §4.3 渲染管线末项：AtmosphereRim（fresnel 扁椭圆弧壳，additive 辉光）。
        不依赖 assets（装饰层），数据加载前后皆可渲染；renderOrder 高于 Ocean/LabelLayer 最后绘叠加。
        质量联动：订阅 store qualityTier，低档不渲染（§8「低档关辉光」）。
      */}
      <AtmosphereRim />
    </>
  )
}
