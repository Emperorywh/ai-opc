/**
 * R3F 场景内容根（SPEC §4.1 / §4.3 渲染管线）。
 *
 * Task 04：挂载 Terrain（GPU 顶点位移 + 基础分层着色）+ 光照。
 * Task 06：挂载 Ocean（透明几何 + §4.3 渲染顺序）。
 * Task 09：静态倾斜相机 → SandboxControls（受限 pan/zoom + 阻尼）。
 * Task 11：挂载 AdaptiveQuality（FPS 探测分档 → dpr/shader 开关，§4.3 管线首项）。
 * Task 14：挂载 LabelLayer（troika SDF 标签，§6.5）。labels.json 独立加载，失败不阻塞地形。
 * Task 16：挂载 AtmosphereRim（§6.7 fresnel 弧壳辉光，§4.3 管线末项最后绘叠加）。
 * Task 17：地形资产加载编排上报 store loading 切片（分项进度 + heightmap 字节级进度），
 *   供 Loader（src/ui，Canvas 外 DOM overlay）订阅渲染。资源不走 R3F loader（原生 fetch），
 *   故此处用 data 层细粒度导出函数自行编排 + fetchWithProgress，不改 src/data。
 * 后续：署名/MVP 验收(18) → ...
 */
import { useEffect, useState } from 'react'
import {
  loadMeta,
  loadNormalTexture,
  decodeHeightmap,
  createHeightTexture,
  loadLabels,
} from '../data/assets'
import type { TerrainAssets, Label } from '../data/types'
import { useStore } from '../state/store'
import { fetchWithProgress, byteFraction, stageProgress } from '../ui/loading'
import { AdaptiveQuality } from './effects/AdaptiveQuality'
import { SandboxControls } from './camera/SandboxControls'
import { Terrain } from './terrain/Terrain'
import { terrainLight } from './terrain/terrainMaterial'
import { Ocean } from './ocean/Ocean'
import { LabelLayer } from './labels/LabelLayer'
import { AtmosphereRim } from './atmosphere/AtmosphereRim'

/** heightmap.png 运行时 URL（与 assets.ts dataUrl 同源：BASE_URL + data/）。 */
const HEIGHTMAP_URL = `${import.meta.env.BASE_URL}data/heightmap.png`

/** 把任意错误归一为字符串（写 store.loadingError 给 Loader 展示）。 */
function toErrorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

export function Scene() {
  const [assets, setAssets] = useState<TerrainAssets | null>(null)
  const [labels, setLabels] = useState<Label[] | null>(null)
  const [, setError] = useState<unknown>(null)

  // Task 17：地形资产加载编排（meta → heightmap 字节进度 + normal 并行 → decode → texture），
  // 各阶段上报 store.loading*（Loader 订阅）。heightmap 是最大文件，字节级进度驱动 terrain 阶段。
  useEffect(() => {
    let cancelled = false
    const run = async () => {
      const store = useStore.getState()
      try {
        store.setLoading('init', stageProgress('init', 0))
        const meta = await loadMeta()
        if (cancelled) return
        store.setLoading('meta', stageProgress('meta', 1))
        // 并行：heightmap 流式字节进度（驱动 terrain 阶段 0→1）+ normal（TextureLoader 无字节回调，静默并行）。
        const [heightBytes, normalTexture] = await Promise.all([
          fetchWithProgress(HEIGHTMAP_URL, (loaded, total) => {
            if (!cancelled) {
              store.setLoading('terrain', stageProgress('terrain', byteFraction(loaded, total)))
            }
          }),
          loadNormalTexture(),
        ])
        if (cancelled) return
        const elevation = decodeHeightmap(heightBytes)
        const heightTexture = createHeightTexture(elevation)
        store.setLoading('decode', stageProgress('decode', 1))
        if (cancelled) return
        setAssets({ meta, heightTexture, normalTexture, elevation })
        store.setLoading('ready', stageProgress('ready', 1))
      } catch (e) {
        if (!cancelled) {
          setError(e)
          console.error('[Scene] 地形资产加载失败：', e)
          store.setLoadingError(toErrorMessage(e))
        }
      }
    }
    run()
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
