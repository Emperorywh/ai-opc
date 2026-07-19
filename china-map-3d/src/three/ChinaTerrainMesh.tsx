/**
 * GPU 位移地形网格（渲染层，TASK-009 位移 / TASK-010 分层设色）。
 *
 * 角色与依赖方向：
 * - 本组件属于渲染层（src/three），只负责「把一份已加载的 heightmap 纹理 + 一份受控配置 + 一份
 *   色阶配置装配成 GPU 位移 + 分层设色地形 mesh」。它**只**依赖：配置层
 *   （resolveTerrainConfigOrThrow / TerrainRenderConfig、resolveElevationColorConfig /
 *   ElevationColorConfig —— 夸张系数 / 分段 / 色阶的唯一权威）、坐标层（TERRAIN_PLANE_LAYOUT ——
 *   米制世界包围盒的渲染派生）、资产访问层（HeightmapTextureLoadResult）、本层着色器
 *   （TERRAIN_VERTEX_SHADER / TERRAIN_FRAGMENT_SHADER）、three / R3F。**禁止**自行读取 GeoJSON、
 *   维护 hover、加载外网或在组件内复制色阶断点 / 颜色（TASK-009/010 实现约束）——纹理、元数据、
 *   色阶由上层注入，颜色事实源来自 elevation-color-ramp，hover 由后续 TASK 在拾取层接管。
 *
 * GPU 位移（SPEC §7.1；TASK-009 实现约束「位移必须发生在 GPU shader」）：
 * - plane 用 PlaneGeometry，顶点位置恒为平面（local z=0），UV 覆盖 [0,1]²；mesh 绕 X 轴 −90° 旋转使其
 *   落到世界 XZ 平面（+Y 朝上）。vertex shader 按顶点 UV 采样 heightmap、仿射解码到真实米制 h、
 *   令 displaced.z += h·k·uRise；经模型矩阵旋转后 local z → 世界 y，即世界 y = h·k（SPEC §3.2）。
 * - **绝不在 CPU 逐顶点写位置**：分段 2048²（≈4.2M 顶点）甚至 4096² 的位置全由 GPU shader 产出，
 *   CPU 只建一份平面 PlaneGeometry（顶点位置为平面常数 + UV），内存与算力都不爆。
 *
 * 分层设色装配（SPEC §3.1；TASK-010 实现约束「色阶事实源唯一」「颜色归一化用元数据真实上下限」）：
 * - 色阶配置由 resolveElevationColorConfig(meta) 在挂载期解析：复核元数据 minH/maxH 等于 SPEC §5.1
 *   色阶域（否则抛 elevation-color.domain-mismatch，绝不静默偏色），并派生 256×1 ramp 字节序列。
 *   本组件把 ramp 字节构造成一份 RGB / UnsignedByteType 的 DataTexture（ClampToEdge + Linear）作为
 *   uElevationRamp uniform 注入片元着色器；断点 / 基线色 / ramp 描述全部来自 elevation-color-ramp，
 *   本组件不复制任何色阶常量。
 * - 片元着色器按像素 UV 重采样 heightmap 取真实 h、按 meta 真实上下限归一化后采样 ramp——颜色与
 *   夸张系数 k 解耦（k 只进 uExaggeration，不进色阶 uniform），故改 k 只改起伏不改颜色。
 *
 * 网格预算与配置边界（SPEC §7.2；TASK-009 实现约束「生产默认 2048²，测试配置边界清楚」）：
 * - 分段数来自 TerrainRenderConfig.meshSegments，已由 resolveTerrainConfigOrThrow 校验落在 [1, 4096]。
 *   生产默认 2048²（PRODUCTION_TERRAIN_CONFIG），测试环境 64²（TEST_TERRAIN_CONFIG）；本组件不硬编码
 *   分段，故「生产默认被偷偷改低」在本组件无发生路径——分段由上层配置决定，测试在配置层断言。
 *
 * UV / 方位对齐（与 src/lib/projection MAIN_MAP_WORLD_BOUNDS、src/lib/elevation UV 约定一致）：
 * - MAIN_MAP_WORLD_BOUNDS 给出主图四至的世界米制包围盒：minX/maxX 关于原点对称（墨卡托 x 对经度线性），
 *   minZ（北，负）/ maxZ（南，正）关于原点不对称（墨卡托 y 对纬度非线性，不修形，SPEC §3.3、§13）。
 * - plane 米制宽 = maxX − minX，高 = maxZ − minZ；mesh 定位在世界 (0, 0, centerZ)，centerZ = (minZ+maxZ)/2，
 *   使 plane 覆盖 [minX, maxX] × [minZ, maxZ]，与统一投影的主图范围逐米对齐。
 * - PlaneGeometry 的 uv.x=0 落西界、uv.x=1 落东界（与 heightmap u 一致）；uv.y=1 经 −90° X 旋转后落到
 *   世界北（−Z），与 heightmap「v=0 北」相反，故着色器内采样时翻转 v（见 terrain-shaders.ts）。
 */

import { useMemo } from 'react'
import type { ReactNode } from 'react'
import * as THREE from 'three'
import type { TerrainRenderConfig } from '../config/terrain-config'
import {
  resolveElevationColorConfig,
  type ElevationColorConfig,
} from '../config/elevation-color-ramp'
import { TERRAIN_FRAGMENT_SHADER, TERRAIN_VERTEX_SHADER } from './terrain-shaders'
import { TERRAIN_PLANE_LAYOUT } from './terrain-layout'
import type { HeightmapTextureLoadResult } from './load-heightmap-texture'

/** ChinaTerrainMesh 的 props（全部由上层注入，组件不自取资产 / 不自决配置）。 */
export interface ChinaTerrainMeshProps {
  /** 已加载并通过契约校验的 heightmap 纹理与元数据（来自 loadHeightmapTexture）。 */
  readonly heightmap: HeightmapTextureLoadResult
  /** 已解析的渲染配置（夸张系数 k + 网格分段；来自 resolveTerrainConfigOrThrow）。 */
  readonly config: TerrainRenderConfig
  /**
   * 入场升起进度 [0,1]（默认 1.0）。位移量 = h·k·rise；rise=0 时地形为平面。
   * 本 TASK 默认 1.0（升起动画由后续 TASK 驱动）；暴露为 prop 使后续 TASK 无需改本组件即可接管入场。
   */
  readonly rise?: number
}

/**
 * 装配并渲染 GPU 位移 + 分层设色地形 mesh。
 *
 * 渲染层只在组件挂载 / props 变化时重建几何与 uniform——分段变化（如生产档↔测试档切换）会重建
 * PlaneGeometry，夸张系数变化只更新 uniform（无需重建几何），二者都走受控的 R3F 声明式路径。
 */
export function ChinaTerrainMesh({ heightmap, config, rise = 1.0 }: ChinaTerrainMeshProps): ReactNode {
  const { texture, meta } = heightmap
  const segments = config.meshSegments

  // 色阶配置（TASK-010）：由元数据 minH/maxH 派生，并在挂载期复核与 SPEC §5.1 色阶域一致——
  // 不一致即抛 elevation-color.domain-mismatch（确定性拒绝，绝不静默偏色）。meta 引用不变时复用同一份。
  const colorConfig: ElevationColorConfig = useMemo(
    () => resolveElevationColorConfig(meta),
    [meta],
  )

  // 256×1 ramp DataTexture：RGB / UnsignedByteType，ClampToEdge + Linear（与 CPU 色阶事实源的 256 纹素
  // 量化匹配）。colorConfig 不变时复用同一份纹理，避免每帧重建。ramp 字节来自 elevation-color-ramp，
  // 本组件不复制断点 / 颜色。
  const rampTexture = useMemo(() => {
    const tex = new THREE.DataTexture(
      colorConfig.rampRgbData,
      colorConfig.rampWidth,
      1,
      THREE.RGBFormat,
      THREE.UnsignedByteType,
    )
    tex.magFilter = THREE.LinearFilter
    tex.minFilter = THREE.LinearFilter
    tex.wrapS = THREE.ClampToEdgeWrapping
    tex.wrapT = THREE.ClampToEdgeWrapping
    tex.generateMipmaps = false
    tex.needsUpdate = true
    return tex
  }, [colorConfig])

  // uniform 对象：依赖 meta / texture / config / rise / plane 尺寸 / ramp；相关值变化时重建（R3F 会把
  // 新对象赋给 shaderMaterial.uniforms，渲染器每帧按引用上传，无需重编译着色器）。
  // 注意：夸张系数 k 只进 uExaggeration，不进任何色阶 uniform——故改 k 只改起伏，颜色不变（TASK-010）。
  const uniforms = useMemo(() => {
    return {
      uHeightmap: { value: texture },
      uHeightmapSize: {
        value: new THREE.Vector2(meta.resolution.widthPixels, meta.resolution.heightPixels),
      },
      uMinElevationMeters: { value: meta.elevationEncoding.minValueMeters },
      uMaxElevationMeters: { value: meta.elevationEncoding.maxValueMeters },
      uElevationRamp: { value: rampTexture },
      uExaggeration: { value: config.exaggeration },
      uRise: { value: rise },
      uPlaneWorldWidth: { value: TERRAIN_PLANE_LAYOUT.worldWidthX },
      uPlaneWorldHeight: { value: TERRAIN_PLANE_LAYOUT.worldHeightZ },
    }
  }, [texture, meta, rampTexture, config.exaggeration, rise])

  return (
    <mesh
      // 绕 X 轴 −90°：plane 由 XY 平面转到 XZ 平面，local +z 朝世界 +y（高程方向）。
      rotation-x={-Math.PI / 2}
      // 定位于世界 (0, 0, centerZ)，使 plane 覆盖主图米制包围盒（x 关于原点对称故 x=0）。
      position={[0, 0, TERRAIN_PLANE_LAYOUT.centerZ]}
    >
      {/* 米制宽高 = 主图世界包围盒跨度；分段 = 配置值（生产默认 2048²，GPU 位移，CPU 不逐顶点写位置）。 */}
      <planeGeometry args={[TERRAIN_PLANE_LAYOUT.worldWidthX, TERRAIN_PLANE_LAYOUT.worldHeightZ, segments, segments]} />
      <shaderMaterial
        vertexShader={TERRAIN_VERTEX_SHADER}
        fragmentShader={TERRAIN_FRAGMENT_SHADER}
        uniforms={uniforms}
      />
    </mesh>
  )
}
