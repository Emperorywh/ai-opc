/**
 * 动态海面渲染层（TASK-007，SPEC §3.5）。
 *
 * 角色与依赖方向：
 * - 本组件属于渲染层（src/three），只负责「把海面配置（src/config/sea-surface 的 SEA_SURFACE_CONFIG）
 *   + 海面着色器（src/three/sea-surface-shaders）装配成一张位于 y=0、半透明、双层流动的 plane mesh」。
 *   约束数值全部来自配置层，本组件不复制任何海平面高度 / 透明度 / 颜色 / 波动常量，也不在组件内
 *   维护隐式海面状态。
 * - 本组件依赖：配置层（SEA_SURFACE_CONFIG —— 海面参数唯一源；SCENE_ATMOSPHERE_CONFIG —— 雾参数
 *   唯一源，TASK-008 起；hexToShaderFloat3 —— 颜色空间转换唯一实现，来自 src/config/scene-atmosphere
 *   的共享约定）、本层着色器（SEA_SURFACE_VERTEX_SHADER / SEA_SURFACE_FRAGMENT_SHADER）、
 *   three / R3F（useFrame）。**不**读取 GeoJSON / heightmap / 行政区数据——海面是独立渲染层，
 *   不承担地表分层设色、相机或边界职责。
 *
 * 海平面 = y=0（同一米制，与地形同源）：
 * - mesh position.y = SEA_LEVEL_Y_METERS = 0。地形真实海拔 h 经 vertex shader 位移到世界 y = h·k，
 *   h=0（海平面）时 y=0，故海面 mesh 恰好落在地形海平面，二者共用同一米制 y=0，无视觉偏移。
 *
 * 半透明混合 + 不写深度（SPEC §3.5「可隐约看到水下地形」「海面不参与分层设色」）：
 * - shaderMaterial transparent=true + depthWrite=false：海面在透明通道绘制、不写深度。
 *   - 水下地形（h<0，world-y<0）是不透明 mesh、先于海面绘制并写深度；海面 world-y=0 更近相机，
 *     海面片元通过深度测试、以 uOpacity 混合在水下地形之上 → 透视看到大陆架近岸浅→远海深层次。
 *   - 陆地（h>0，world-y>0）在海面之上、更近相机；海面片元深度更大、未通过深度测试被丢弃 →
 *     海面只覆盖海域、不遮陆地着色。
 *   - 单张平面海面无自相交 / 无多层透明叠加 → 无透明排序闪烁（depthWrite=false 是其结构性保证）。
 *
 * 统一时钟 + 无分配循环（SPEC §7.4「动画时钟：用统一的 THREE.Clock / R3F useFrame，水面/入场共用，
 * 避免多时钟漂移」「无运行时几何分配循环」）：
 * - 初始 uniforms 由 useMemo 一次构造（唯一时间输入 uTime 初值 0 + 静态 color/opacity/wave 参数）。
 *   useFrame 每帧**只**把 state.clock.getElapsedTime()（R3F 共享 clock）写进材质 uniforms 的
 *   uTime.value——原始数字赋值，不创建新对象 / 新 THREE.Vector3 / 新 uniforms 对象。不
 *   new THREE.Clock()，故不存在独立漂移时钟。其他 uniform 挂载期一次设置、运行循环不再触碰。
 * - **R3F v9 uniforms 语义（关键）**：<shaderMaterial uniforms={...}> 走 R3F 的「稳定目标引用」
 *   合并——传入对象被逐项拷贝（{ ...uniform }）进材质自身的 uniforms 对象，而非替换引用。因此
 *   每帧的时间写入必须落到**材质自身的 uniforms**（materialRef.current.uniforms.uTime.value），
 *   改本组件 useMemo 持有的初始对象不会到达 GPU（海面会静止）。后续 TASK 做「水面入场淡入」
 *   （SPEC §4.3，每帧调 uOpacity）同样必须写 materialRef.current.uniforms。
 *
 * 与入场编排的边界（TASK-013，SPEC §4.3「水面、边界线随后淡入」）：注入共享入场帧时，uOpacity =
 * 配置基线透明度 × computeSceneLayerOpacity(elapsed)（经材质 uniforms 写入，与本文件头的 R3F v9
 * uniforms 语义同一条 materialRef 路径），使海面在省名标签淡入完成后随水面 / 边界阶段平滑淡入；
 * 未注入时 uOpacity 恒为配置基线值。场景轻雾（SPEC §3.4）已由 TASK-008 装配：雾色 / 雾密度经
 * uFogColor / uFogDensity 注入（与地形片元、场景雾同读 SCENE_ATMOSPHERE_CONFIG，见着色器文件头）。
 */

import { useMemo, useRef } from 'react'
import type { ReactNode, RefObject } from 'react'
import * as THREE from 'three'
import { useFrame } from '@react-three/fiber'
import { SEA_SURFACE_CONFIG } from '../config/sea-surface'
import { SCENE_ATMOSPHERE_CONFIG, hexToShaderFloat3 } from '../config/scene-atmosphere'
import { ENTRANCE_DURATIONS } from '../config/entrance'
import { computeSceneLayerOpacity, type EntranceFrame } from '../lib/entrance-state'
import { SEA_SURFACE_FRAGMENT_SHADER, SEA_SURFACE_VERTEX_SHADER } from './sea-surface-shaders'

/** SeaSurface 的 props：可选的共享入场帧（不注入时海面加载完成即直接可见）。 */
export interface SeaSurfaceProps {
  /**
   * 共享入场帧（TASK-013 单一时间源，SPEC §4.3「水面…随后淡入」）。注入时每帧由本组件 useFrame 把
   * 「配置基线透明度 × computeSceneLayerOpacity(elapsed)」写入材质 uniforms 的 uOpacity.value——
   * 海面在省名标签淡入完成后随水面 / 边界阶段平滑淡入。未注入时不调制 uOpacity（保持配置基线值，
   * 海面加载完成即直接可见）。
   */
  readonly entranceFrame?: RefObject<EntranceFrame> | null
}

/**
 * 装配并渲染动态半透明海面 mesh。
 *
 * 海面参数全部来自冻结的 SEA_SURFACE_CONFIG（海面参数唯一源）；动画时间来自 R3F 共享 clock
 * （useFrame），不建独立时钟；入场淡入透明度只读共享入场帧派生（同一 elapsed、同一纯函数，与省界 /
 * 十段线同阶段同步淡入），不私设计时器。
 */
export function SeaSurface({ entranceFrame = null }: SeaSurfaceProps = {}): ReactNode {
  const { colorHex, opacity, planeLayout, segments, waves } = SEA_SURFACE_CONFIG
  const { fog } = SCENE_ATMOSPHERE_CONFIG
  // 入场接管判定：注入共享入场帧即由入场状态机调制 uOpacity（初始 0 = 不可见，淡入阶段 0→1×基线）；
  // 未注入时 uOpacity 恒取配置基线值。初始 0 使首个绘制帧即不可见，不依赖帧订阅时序。
  const entranceActive = entranceFrame !== null && entranceFrame !== undefined

  // 初始 uniforms 挂载期一次构造：唯一时间输入 uTime 初值 0 + 静态 color/opacity/wave/fog 参数。
  // SEA_SURFACE_CONFIG 与 SCENE_ATMOSPHERE_CONFIG 都是模块级冻结常量（colorHex / opacity / waves / fog
  // 引用永不变化），故依赖数组虽列出它们也永不触发重建。注意：R3F v9 会把本对象逐项拷贝进材质自身的
  // uniforms（稳定目标引用合并），本对象只承担「初始值」角色；运行循环的 uTime 写入走 materialRef（见下）。
  const initialUniforms = useMemo(
    () => ({
      // 统一时间输入：唯一的时间 uniform，初值 0；每帧由 useFrame 经 materialRef 写入材质 uniforms。
      uTime: { value: 0 },
      // 深蓝青基线色（[0,1]³，字节 / 255；与地形照明同一颜色空间约定）。
      uColor: { value: new THREE.Vector3(...hexToShaderFloat3(colorHex)) },
      // 基线透明度（0.6）——片元输出 alpha 的基线。入场接管时初始 0（不可见），逐帧由 useFrame 写入
      // 「基线 × computeSceneLayerOpacity(elapsed)」（SPEC §4.3 水面随后淡入）；未接管时恒为基线值。
      uOpacity: { value: entranceActive ? 0 : opacity },
      // 第一层流动波动参数（静态，挂载期一次设置）。
      uLayer1FrequencyU: { value: waves.layer1.frequencyU },
      uLayer1FrequencyV: { value: waves.layer1.frequencyV },
      uLayer1Speed: { value: waves.layer1.speed },
      uLayer1Amplitude: { value: waves.layer1.amplitude },
      uLayer1Phase: { value: waves.layer1.phase },
      // 第二层流动波动参数（静态，挂载期一次设置）。
      uLayer2FrequencyU: { value: waves.layer2.frequencyU },
      uLayer2FrequencyV: { value: waves.layer2.frequencyV },
      uLayer2Speed: { value: waves.layer2.speed },
      uLayer2Amplitude: { value: waves.layer2.amplitude },
      uLayer2Phase: { value: waves.layer2.phase },
      // 极轻微指数雾（SPEC §3.4，TASK-008）：雾色 = 背景色（远缘无接缝）；雾关闭时密度取 0（片元零开销）。
      uFogColor: { value: new THREE.Vector3(...hexToShaderFloat3(fog.hex)) },
      uFogDensity: { value: fog.enabled ? fog.density : 0 },
    }),
    [colorHex, opacity, waves, fog, entranceActive],
  )

  // 材质实例 ref：R3F v9 对 <shaderMaterial uniforms={...}> 做「稳定目标引用」合并（拷贝而非替换
  // 引用，见文件头），材质自身的 uniforms 才是渲染器每帧读取的对象——每帧 uTime / uOpacity 写入
  // 必须落在这里。
  const materialRef = useRef<THREE.ShaderMaterial>(null)

  // 统一时钟 + 无分配循环：用 R3F 共享 clock 的 getElapsedTime()，不 new THREE.Clock() 建独立漂移
  // 时钟。每帧只把经过时间写进材质 uniforms 的 uTime.value（原始数字赋值，零对象分配）；其余静态
  // uniform 运行循环不触碰。
  // 入场淡入（TASK-013，SPEC §4.3「水面、边界线随后淡入」）：注入共享入场帧时，同帧再把
  // 「配置基线透明度 × computeSceneLayerOpacity(elapsed)」写进 uOpacity.value——与省界 / 十段线
  // 共用同一 elapsed（共享入场帧）与同一纯函数，故水面 / 省界 / 十段线 / 岛礁光点同阶段同步淡入，
  // 不存在逐层私设计时器。entranceFrame 未注入时不触碰 uOpacity（保持配置基线值，回退边界）。
  useFrame((state) => {
    const material = materialRef.current
    if (material === null) return
    material.uniforms.uTime.value = state.clock.getElapsedTime()
    if (entranceFrame !== null && entranceFrame !== undefined) {
      material.uniforms.uOpacity.value =
        opacity * computeSceneLayerOpacity(entranceFrame.current.elapsedSeconds, ENTRANCE_DURATIONS)
    }
  })

  return (
    <mesh
      // 绕 X 轴 −90°：plane 由 XY 平面转到 XZ 平面，落在世界 y=0（海平面）。
      rotation-x={-Math.PI / 2}
      // position.y = SEA_SURFACE_CONFIG.levelYMeters = 0：海面落在地形海平面（同一米制 y=0），无视觉偏移。
      position={[0, SEA_SURFACE_CONFIG.levelYMeters, planeLayout.centerZ]}
    >
      {/* 米制宽高 = 主图世界包围盒跨度（与地形 plane 同范围）；分段 1（波动在片元，无需顶点位移）。 */}
      <planeGeometry args={[planeLayout.worldWidthX, planeLayout.worldHeightZ, segments, segments]} />
      {/*
        半透明 + 不写深度：transparent=true 使片元按 uOpacity 混合；depthWrite=false 使海面不写深度，
        水下地形（已写深度、在海面之下）透过海面可见，陆地（在海面之上）通过深度测试遮挡海面 → 海面
        只覆盖海域、不遮陆地，且单张平面无透明排序闪烁。
      */}
      <shaderMaterial
        ref={materialRef}
        vertexShader={SEA_SURFACE_VERTEX_SHADER}
        fragmentShader={SEA_SURFACE_FRAGMENT_SHADER}
        uniforms={initialUniforms}
        transparent
        depthWrite={false}
      />
    </mesh>
  )
}
