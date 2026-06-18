/**
 * 河流渲染层（SPEC §6.4，Task 29：流动发光河流 shader）。
 *
 * 消费 Task 28 `rivers.bin`（pipeline 已烘焙带状几何：position / uv / index + 每河 level / 范围）。
 * 单合并 mesh（全局顶点池 + index 直接 setIndex，一次 draw call，同 CountryMeshes GPU-ready 模式）。
 *
 * - 几何：position / uv / index 来自 RiverData（pipeline 烘焙，前端零几何逻辑）+ level 顶点属性
 *   （buildRiverLevelAttribute，shader 据此调大河亮度）。
 * - 流动：uTime 每帧累加驱动光带脉冲（同 Ocean useFrame uTime 模式；matRef 持有材质避开
 *   react-hooks/immutability 对 useMemo 返回值 mutate 的误报）。
 * - 质量联动：订阅 store qualityTier，低档 uPulseStrength=0（静态青蓝带省片元开销），
 *   中/高档满脉冲——兑现 SPEC §8「低档最简」，不动 GLSL（同 ocean uniform-value 模式）。
 * - 抗 z-fighting：pipeline 已 +ε（贴地）+ 材质 polygonOffset 双保险（riverMaterial）。
 *
 * 渲染顺序（§4.3）：transparent + depthWrite=false 读 Terrain 深度（山遮挡后方河流），
 *   renderOrder=RIVER_RENDER_ORDER（边界层之上，发光带可见）。几何 / 材质卸载 dispose 防泄漏。
 */
import { useMemo, useEffect, useRef } from 'react'
import * as THREE from 'three'
import { useFrame } from '@react-three/fiber'
import { useStore } from '../../state/store'
import type { RiverData } from '../../data/types'
import {
  buildRiverLevelAttribute,
  createRiverMaterial,
  RIVER_RENDER_ORDER,
} from './riverMaterial'

export function Rivers({ rivers }: { rivers: RiverData }) {
  // Task 11 质量联动：低档关流动脉冲（静态青蓝带，省片元 smoothstep）；中/高档满脉冲。
  // （未改 quality.ts：河流特效自包含，低档判断内联，与全局分档策略一致。）
  const qualityTier = useStore((s) => s.qualityTier)
  const pulseStrength = qualityTier === 'low' ? 0 : 1
  const material = useMemo(
    () => createRiverMaterial({ pulseStrength }),
    [pulseStrength],
  )
  // 经 ref 持有 material 供 useFrame 每帧更新 uTime uniform（避开 react-hooks/immutability
  // 对 useMemo 返回值直接 mutate 的误报，同 Ocean / CountryMeshes matRef 模式）。
  const matRef = useRef(material)
  useEffect(() => {
    matRef.current = material
  }, [material])
  // SPEC §6.4.3：时间驱动流动（光带脉冲沿河流向滚动）
  useFrame((_, delta) => {
    matRef.current.uniforms.uTime.value += delta
  })

  // BufferGeometry：position / uv / index 来自 rivers.bin（pipeline 烘焙）+ level 顶点属性。
  const geometry = useMemo(() => {
    const g = new THREE.BufferGeometry()
    g.setAttribute('position', new THREE.BufferAttribute(rivers.vertices, 3))
    g.setAttribute('uv', new THREE.BufferAttribute(rivers.uvs, 2))
    g.setAttribute('level', new THREE.BufferAttribute(buildRiverLevelAttribute(rivers), 1))
    g.setIndex(new THREE.BufferAttribute(rivers.indices, 1))
    g.computeBoundingSphere()
    return g
  }, [rivers])

  // 清理：geometry / material 重建或卸载时 dispose（防 GPU 泄漏，同 CountryMeshes）。
  useEffect(() => {
    return () => {
      geometry.dispose()
    }
  }, [geometry])
  useEffect(() => {
    return () => {
      material.dispose()
    }
  }, [material])

  if (rivers.indices.length === 0) return null

  return <mesh geometry={geometry} material={material} renderOrder={RIVER_RENDER_ORDER} />
}
