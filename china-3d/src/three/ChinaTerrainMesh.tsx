/**
 * GPU 位移地形网格（渲染层，TASK-006）。
 *
 * 角色与依赖方向：
 * - 本组件属于渲染层（src/three），只负责「把一份已加载的 heightmap 纹理 + 一份受控配置 + 一份
 *   色阶配置 + 一份场景氛围配置装配成 GPU 位移 + 分层设色 + 方向光法线明暗 + 极轻微指数雾的地形
 *   mesh」。它**只**依赖：配置层（TerrainRenderConfig —— 夸张系数 / 分段的唯一权威；
 *   resolveElevationColorConfig / ElevationColorConfig —— 色阶唯一权威；SCENE_ATMOSPHERE_CONFIG ——
 *   照明 / 雾唯一权威，TASK-008 起）、坐标层（TERRAIN_PLANE_LAYOUT —— 米制世界包围盒的渲染派生）、
 *   资产访问层（HeightmapTextureLoadResult）、本层着色器（TERRAIN_VERTEX_SHADER /
 *   TERRAIN_FRAGMENT_SHADER）、three / R3F。**禁止**自行读取 GeoJSON、维护 hover、加载外网或在
 *   组件内复制色阶断点 / 颜色 / 光向 / 雾参数（纹理、元数据、色阶、照明由上层 / 配置注入；hover
 *   由 TASK-009 在拾取层接管）。
 *
 * GPU 位移（SPEC §7.1）：
 * - plane 用 PlaneGeometry，顶点位置恒为平面（local z=0），UV 覆盖 [0,1]²；mesh 绕 X 轴 −90° 旋转使
 *   其落到世界 XZ 平面（+Y 朝上）。vertex shader 按顶点 UV 采样 heightmap、仿射解码到真实米制 h、
 *   令 displaced.z += h·k·uRise；经模型矩阵旋转后 local z → 世界 y，即世界 y = h·k（SPEC §3.2）。
 * - **绝不在 CPU 逐顶点写位置**：分段 2048²（≈4.2M 顶点）甚至 4096² 的位置全由 GPU shader 产出，
 *   CPU 只建一份平面 PlaneGeometry（顶点位置为平面常数 + UV），内存与算力都不爆。
 *
 * 分层设色装配（SPEC §3.1）：
 * - 色阶配置由 resolveElevationColorConfig(meta) 在挂载期解析：复核元数据 minH/maxH 等于 SPEC §5.1
 *   色阶域（否则抛 elevation-color.domain-mismatch，绝不静默偏色），并派生 256×1 ramp 字节序列。
 *   本组件把 ramp 字节经 buildElevationRampTexture 构造成一份 RGBA / UnsignedByteType 的 DataTexture
 *   （ClampToEdge + Linear；RGB→RGBA 的 GPU 上传格式适配见 elevation-ramp-texture.ts）作为
 *   uElevationRamp uniform 注入片元着色器；断点 / 基线色 / ramp 描述全部来自 elevation-color-ramp，
 *   本组件不复制任何色阶常量。
 * - 片元着色器按像素 UV 重采样 heightmap 取真实 h、按 meta 真实上下限归一化后采样 ramp——颜色与
 *   夸张系数 k 解耦（k 只进 uExaggeration，不进色阶 uniform），故改 k 只改起伏不改颜色。
 *
 * 网格预算与配置边界（SPEC §7.2）：
 * - 分段数来自 TerrainRenderConfig.meshSegments，已由 resolveTerrainConfig 校验落在 [1, 4096]。
 *   生产默认 2048²（PRODUCTION_TERRAIN_CONFIG），测试环境 64²（TEST_TERRAIN_CONFIG）；本组件不硬编码
 *   分段，故「生产默认被偷偷改低」在本组件无发生路径——分段由上层配置决定，测试在配置层断言。
 *
 * UV / 方位对齐（与 src/lib/projection MAIN_MAP_WORLD_BOUNDS、src/lib/elevation UV 约定一致）：
 * - MAIN_MAP_WORLD_BOUNDS 给出主图四至的世界米制包围盒：minX/maxX 关于原点对称（墨卡托 x 对经度
 *   线性），minZ（北，负）/ maxZ（南，正）关于原点不对称（墨卡托 y 对纬度非线性，不修形，
 *   SPEC §3.3、§13）。
 * - plane 米制宽 = maxX − minX，高 = maxZ − minZ；mesh 定位在世界 (0, 0, centerZ)，
 *   centerZ = (minZ+maxZ)/2，使 plane 覆盖 [minX, maxX] × [minZ, maxZ]，与统一投影的主图范围
 *   逐米对齐。
 * - PlaneGeometry 的 uv.x=0 落西界、uv.x=1 落东界（与 heightmap u 一致）；uv.y=1 经 −90° X 旋转后
 *   落到世界北（−Z），与 heightmap「v=0 北」相反，故着色器内采样时翻转 v（见 terrain-shaders.ts）。
 *
 * 入场升起（TASK-013，SPEC §4.3「地形从平面升起 ≈1.2s」）：
 * - 注入共享入场帧（entranceFrame）时，本组件 useFrame 每帧把 computeTerrainRise(elapsed)（领域层
 *   纯函数 + ENTRANCE_DURATIONS 冻结时序）写入材质 uniforms 的 uRise.value——顶点位移 = h·k·uRise
 *   随之从 0（平面）smoothstep 升至 1（夸张后真实高度），复用 GPU 位移、零额外几何开销（SPEC §7.1）。
 * - 写入必须经 materialRef.current.uniforms（R3F v9 uniforms 浅拷贝合并陷阱，与 SeaSurface 同解）；
 *   未注入 entranceFrame 时 uRise 恒取 rise prop（默认 1.0），本组件不私设计时器 / 不读 DOM 状态。
 */

import { useMemo, useRef } from 'react'
import type { ReactNode, RefObject } from 'react'
import * as THREE from 'three'
import { useFrame } from '@react-three/fiber'
import type { TerrainRenderConfig } from '../config/terrain-config'
import {
  resolveElevationColorConfig,
  type ElevationColorConfig,
} from '../config/elevation-color-ramp'
import {
  SCENE_ATMOSPHERE_CONFIG,
  hexToShaderFloat3,
} from '../config/scene-atmosphere'
import { ENTRANCE_DURATIONS } from '../config/entrance'
import { computeTerrainRise, type EntranceFrame } from '../lib/entrance-state'
import { TERRAIN_FRAGMENT_SHADER, TERRAIN_VERTEX_SHADER } from './terrain-shaders'
import { TERRAIN_PLANE_LAYOUT } from './terrain-layout'
import { buildElevationRampTexture } from './elevation-ramp-texture'
import type { HeightmapTextureLoadResult } from './load-heightmap-texture'

/** ChinaTerrainMesh 的 props（全部由上层注入，组件不自取资产 / 不自决配置）。 */
export interface ChinaTerrainMeshProps {
  /** 已加载并通过契约校验的 heightmap 纹理与元数据（来自 loadHeightmapTexture）。 */
  readonly heightmap: HeightmapTextureLoadResult
  /** 已解析的渲染配置（夸张系数 k + 网格分段；来自 resolveTerrainConfigOrThrow）。 */
  readonly config: TerrainRenderConfig
  /**
   * 入场升起进度 [0,1]（默认 1.0）。位移量 = h·k·rise；rise=0 时地形为平面。
   * 未注入 entranceFrame 时（无入场编排）uRise 恒取本值；注入后本值仅作挂载期初始值之外的
   * 静态语义保留，逐帧 uRise 由入场状态机接管（见 entranceFrame）。
   */
  readonly rise?: number
  /**
   * 共享入场帧（TASK-013 单一时间源，SPEC §4.3）。注入时每帧由本组件 useFrame 把
   * computeTerrainRise(elapsed) 写入材质 uniforms 的 uRise.value——位移量 = h·k·uRise 随之从 0
   * （平面）升至 h·k（夸张后真实高度），复用 GPU 位移 uniform、零额外几何开销（SPEC §7.1）。
   * 未注入时不接管 uRise（保持 rise prop，地形加载完成即直接呈现夸张后真实高度）。
   */
  readonly entranceFrame?: RefObject<EntranceFrame> | null
}

/**
 * 装配并渲染 GPU 位移 + 分层设色地形 mesh。
 *
 * 渲染层只在组件挂载 / props 变化时重建几何与 uniform——分段变化（如生产档↔测试档切换）会重建
 * PlaneGeometry，夸张系数变化只更新 uniform（无需重建几何），二者都走受控的 R3F 声明式路径。
 */
export function ChinaTerrainMesh({ heightmap, config, rise = 1.0, entranceFrame = null }: ChinaTerrainMeshProps): ReactNode {
  const { texture, meta } = heightmap
  const segments = config.meshSegments
  // 入场接管判定：注入共享入场帧即由入场状态机驱动 uRise（初始 0 = 平面，逐帧 smoothstep 0→1）；
  // 未注入时 uRise 恒取 rise prop（默认 1.0，直接呈现真实高度）。
  const entranceActive = entranceFrame !== null && entranceFrame !== undefined

  // 色阶配置：由元数据 minH/maxH 派生，并在挂载期复核与 SPEC §5.1 色阶域一致——不一致即抛
  // elevation-color.domain-mismatch（确定性拒绝，绝不静默偏色）。meta 引用不变时复用同一份。
  const colorConfig: ElevationColorConfig = useMemo(
    () => resolveElevationColorConfig(meta),
    [meta],
  )

  // 256×1 ramp DataTexture：RGBA / UnsignedByteType（three r185 WebGL2 约束，见 elevation-ramp-texture.ts），
  // ClampToEdge + Linear（与 CPU 色阶事实源的 256 纹素量化匹配）。colorConfig 不变时复用同一份纹理，
  // 避免每帧重建。ramp 字节来自 elevation-color-ramp，本组件不复制断点 / 颜色。
  const rampTexture = useMemo(() => buildElevationRampTexture(colorConfig), [colorConfig])

  // uniform 对象：依赖 meta / texture / config / rise / ramp；相关值变化时重建（R3F 会把新对象赋给
  // shaderMaterial.uniforms，渲染器每帧按引用上传，无需重编译着色器）。注意：夸张系数 k 只进
  // uExaggeration，不进任何色阶 uniform——故改 k 只改起伏，颜色不变。
  // 照明 / 雾 uniform 取自冻结的 SCENE_ATMOSPHERE_CONFIG（单一事实源）——与场景灯 / 场景雾
  // （SceneAtmosphere）同读一份配置，地形着色器只是该配置作用到自定义 ShaderMaterial 的必要通道。
  // SCENE_ATMOSPHERE_CONFIG 是模块级冻结常量（引用永不变化），故氛围 uniform 不进 useMemo 依赖数组，
  // 随 texture / colorConfig 重建周期复用。
  const uniforms = useMemo(() => {
    const { mainLight, hemisphereAmbient, fog } = SCENE_ATMOSPHERE_CONFIG
    return {
      uHeightmap: { value: texture },
      uHeightmapSize: {
        value: new THREE.Vector2(meta.resolution.widthPixels, meta.resolution.heightPixels),
      },
      uMinElevationMeters: { value: meta.elevationEncoding.minValueMeters },
      uMaxElevationMeters: { value: meta.elevationEncoding.maxValueMeters },
      uElevationRamp: { value: rampTexture },
      uExaggeration: { value: config.exaggeration },
      // 入场接管时初始 0（平面），逐帧由 useFrame 经 materialRef 写入 computeTerrainRise(elapsed)；
      // 未接管时取 rise prop（默认 1.0）。初始 0 使首个绘制帧即为平面，不依赖帧订阅时序。
      uRise: { value: entranceActive ? 0 : rise },
      uPlaneWorldWidth: { value: TERRAIN_PLANE_LAYOUT.worldWidthX },
      uPlaneWorldHeight: { value: TERRAIN_PLANE_LAYOUT.worldHeightZ },
      // 主光（西北偏高方向光）：方向 / 光色 / 光强来自照明配置。
      uMainLightDirection: {
        value: new THREE.Vector3(mainLight.direction.x, mainLight.direction.y, mainLight.direction.z),
      },
      uMainLightColor: { value: new THREE.Vector3(...hexToShaderFloat3(mainLight.hex)) },
      uMainLightIntensity: { value: mainLight.intensity },
      // 半球环境光：天 / 地色 + 低强度，背光面不死黑又不冲淡色阶。
      uHemisphereSkyColor: { value: new THREE.Vector3(...hexToShaderFloat3(hemisphereAmbient.skyHex)) },
      uHemisphereGroundColor: { value: new THREE.Vector3(...hexToShaderFloat3(hemisphereAmbient.groundHex)) },
      uHemisphereIntensity: { value: hemisphereAmbient.intensity },
      // 极轻微指数雾（SPEC §3.4）：雾色 = 背景色（远缘无接缝）；雾关闭时密度取 0（片元零开销）。
      uFogColor: { value: new THREE.Vector3(...hexToShaderFloat3(fog.hex)) },
      uFogDensity: { value: fog.enabled ? fog.density : 0 },
    }
  }, [texture, meta, rampTexture, config.exaggeration, rise, entranceActive])

  // 材质实例 ref（R3F v9 uniforms 语义——与 SeaSurface 同一陷阱与同一正确路径）：R3F v9 对
  // <shaderMaterial uniforms={...}> 做「稳定目标引用」合并（把传入对象逐项拷贝进材质自身的
  // uniforms，而非替换引用），故每帧的 uRise 写入必须落到**材质自身的 uniforms**
  // （materialRef.current.uniforms.uRise.value）；改上方 useMemo 持有的初始对象不会到达 GPU
  // （地形会静默停在初始 rise，参考实现在同版本下即因此静默失效——SeaSurface 文件头有完整记录）。
  const materialRef = useRef<THREE.ShaderMaterial>(null)

  // 入场升起驱动（TASK-013，SPEC §4.3）：注入共享入场帧时，每帧由 R3F 统一帧循环把
  // computeTerrainRise(elapsed) 写入材质 uniforms 的 uRise.value——位移量 = h·k·uRise 随之从 0
  // （平面）升至 h·k（夸张后真实高度）。复用 GPU 位移 uniform、不建第二套几何（SPEC §7.1「入场动画
  // 通过一个 uniform uRise（0→1）插值位移量实现，零额外几何开销」）。useFrame 闭包每帧由 R3F 刷新
  // 为最新渲染的 entranceFrame / uniforms 引用，memo 重建（k 切换 / 资产重载）后仍指向最新对象。
  // entranceFrame 未注入时本回调直接 return（uRise 保持 rise prop，回退边界）。每帧只写一个标量到
  // 既有 uniform 对象——零对象分配（SPEC §7.4）。
  useFrame(() => {
    if (entranceFrame === null || entranceFrame === undefined) return
    const material = materialRef.current
    if (material === null) return
    material.uniforms.uRise.value = computeTerrainRise(
      entranceFrame.current.elapsedSeconds,
      ENTRANCE_DURATIONS,
    )
  })

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
        ref={materialRef}
        vertexShader={TERRAIN_VERTEX_SHADER}
        fragmentShader={TERRAIN_FRAGMENT_SHADER}
        uniforms={uniforms}
      />
    </mesh>
  )
}
