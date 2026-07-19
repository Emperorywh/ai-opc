/**
 * 动态海面渲染层（TASK-013）。
 *
 * 角色与依赖方向：
 * - 本组件属于渲染层（src/three），只负责「把海面配置（src/config/sea-surface 的 SEA_SURFACE_CONFIG）
 *   + 海面着色器（src/three/sea-surface-shaders）+ 场景雾配置（src/config/scene-atmosphere）装配成
 *   一张位于 y=0、半透明、双层流动的 plane mesh」。约束数值全部来自配置层，本组件不复制任何海平面
 *   高度 / 透明度 / 颜色 / 波动常量，也不在组件内维护隐式海面状态（TASK-013 实现约束「海面作为独立
 *   渲染层」「视觉参数集中管理」）。
 * - 本组件依赖：配置层（SEA_SURFACE_CONFIG —— 海面参数唯一源；SCENE_ATMOSPHERE_CONFIG + hexToShaderFloat3
 *   —— 雾参数与颜色转换唯一源）、本层着色器（SEA_SURFACE_VERTEX_SHADER / SEA_SURFACE_FRAGMENT_SHADER）、
 *   three / R3F（useFrame）。**不**读取 GeoJSON / heightmap / 行政区 / hover / 加载状态——海面是独立渲染
 *   层，不承担地表分层设色、相机、边界或加载状态职责（TASK-013 输出约束）。
 *
 * 海平面 = y=0（同一米制，与地形同源，TASK-013 实现约束「海面必须与地形高程使用同一米制 y=0 海平面，
 * 不得用视觉偏移掩盖坐标不一致」）：
 * - mesh position.y = SEA_LEVEL_Y_METERS = 0。地形真实海拔 h 经 vertex shader 位移到世界 y = h·k，
 *   h=0（海平面）时 y=0，故海面 mesh 恰好落在地形海平面，二者共用同一米制 y=0，无视觉偏移。
 *
 * 半透明混合 + 不写深度（SPEC §3.5、TASK-013 验证方式 5「无明显透明排序闪烁、穿插或水面覆盖陆地异常」）：
 * - shaderMaterial transparent=true + depthWrite=false：海面在透明通道绘制、不写深度。
 *   - 水下地形（h<0，world-y<0）是不透明 mesh、先于海面绘制并写深度；海面 world-y=0 更近相机，
 *     海面片元通过深度测试、以 uOpacity 混合在水下地形之上 → 透视看到大陆架深度层次。
 *   - 陆地（h>0，world-y>0）在海面之上、更近相机；海面片元深度更大、未通过深度测试被丢弃 →
 *     海面只覆盖海域、不遮陆地。
 *   - 单张平面海面无自相交 / 无多层透明叠加 → 无透明排序闪烁（depthWrite=false 是其结构性保证）。
 *
 * 统一时钟 + 无分配循环（TASK-013 实现约束「动画必须使用 R3F 统一帧循环 / 时钟」「动画每帧只更新必要
 * uniform，不在运行循环中创建几何、材质或临时大对象」）：
 * - uniforms 对象由 useMemo 空依赖一次构造（含唯一时间输入 uTime + 静态 color/opacity/wave/fog 参数）。
 *   useFrame 每帧**只**把 state.clock.getElapsedTime()（R3F 共享 clock）赋给 uniforms.uTime.value——
 *   这是原始数字赋值，不创建新对象 / 新 THREE.Vector3 / 新 uniforms 对象。不 new THREE.Clock()，
 *   故不存在独立漂移时钟。其他 uniform 挂载期一次设置、运行循环不再触碰。
 */

import { useMemo } from 'react'
import type { ReactNode, RefObject } from 'react'
import * as THREE from 'three'
import { useFrame } from '@react-three/fiber'
import { SEA_SURFACE_CONFIG } from '../config/sea-surface'
import { SCENE_ATMOSPHERE_CONFIG, hexToShaderFloat3 } from '../config/scene-atmosphere'
import { ENTRANCE_DURATIONS } from '../config/entrance'
import { computeSceneLayerOpacity, type EntranceFrame } from '../lib/entrance-state'
import type { RuntimeFrame } from '../lib/runtime-lifecycle'
import { SEA_SURFACE_FRAGMENT_SHADER, SEA_SURFACE_VERTEX_SHADER } from './sea-surface-shaders'

/**
 * SeaSurface 的 props（TASK-020 起接收共享入场帧，驱动水面随后淡入）。
 *
 * 海面参数仍全部来自冻结配置（SEA_SURFACE_CONFIG / SCENE_ATMOSPHERE_CONFIG），entranceFrame 仅用于
 * 入场淡入透明度调制——非视觉 / 几何参数，故不破坏「海面只依赖视觉 / 几何配置」的边界。
 */
export interface SeaSurfaceProps {
  /**
   * 共享入场帧（TASK-020 单一时间源）。注入时每帧由 useFrame 把 uOpacity 设为「配置基线透明度 ×
   * computeSceneLayerOpacity(elapsed)」，使海面在省名标签淡入后随水面 / 边界阶段平滑淡入
   * （SPEC §4.3「水面、边界线随后淡入」）。未注入（回退 TASK-020）时 uOpacity 保持配置基线值，
   * 海面加载完成即直接可见（回退边界）。
   */
  readonly entranceFrame?: RefObject<EntranceFrame> | null
  /**
   * 共享运行时帧（TASK-022 集中编排）。注入时每帧先检查 runtimeFrame.paused：context-lost / restoring 期间
   * 冻结 uTime / uOpacity（不推进波动 / 不改透明度），使水面在 context 异常期间静止、恢复后继续。水面波动为
   * 周期性 sin，恢复时 uTime 直接接续 R3F 共享 clock（相位跳变不可感知，无需偏移追踪）。未注入（回退 TASK-022）
   * 时不检查暂停、水面始终推进（回退边界）。
   */
  readonly runtimeFrame?: RefObject<RuntimeFrame> | null
}

/**
 * 装配并渲染动态半透明海面 mesh。
 *
 * 海面参数全部来自冻结的 SEA_SURFACE_CONFIG（海面参数唯一源）与 SCENE_ATMOSPHERE_CONFIG
 * （雾参数唯一源）；entranceFrame 仅调制入场淡入透明度（单一显式状态流驱动，非组件私设计时器）。
 */
export function SeaSurface({ entranceFrame = null, runtimeFrame = null }: SeaSurfaceProps = {}): ReactNode {
  const { colorHex, opacity, planeLayout, segments, waves } = SEA_SURFACE_CONFIG

  // uniforms 挂载期一次构造（useMemo 空依赖）：唯一时间输入 uTime + 静态 color/opacity/wave/fog 参数。
  // SEA_SURFACE_CONFIG / SCENE_ATMOSPHERE_CONFIG 是模块级冻结常量（引用永不变化），故不进依赖数组。
  // 运行循环只改 uTime.value（见 useFrame），不在循环里重建本对象——无分配循环。
  const uniforms = useMemo(() => {
    const { fog } = SCENE_ATMOSPHERE_CONFIG
    return {
      // 统一时间输入：唯一的时间 uniform，初值 0，由 useFrame 用 R3F 共享 clock 每帧赋值。
      uTime: { value: 0 },
      // 深蓝青基线色（[0,1]³，字节 / 255）。
      uColor: { value: new THREE.Vector3(...hexToShaderFloat3(colorHex)) },
      // 基线透明度（0.6）——直接成为片元输出 alpha（半透明混合）。显式标注 number 使入场淡入 useFrame
      // 可写入「基线 × 入场场景层透明度」（配置常量为字面量 0.6，不标注会被推断为字面量类型而拒绝赋值）。
      uOpacity: { value: opacity as number },
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
      // 雾色 / 密度（来自场景氛围配置，与地形同源）。
      uFogColor: { value: new THREE.Vector3(...hexToShaderFloat3(fog.hex)) },
      uFogDensity: { value: fog.enabled ? fog.density : 0 },
    }
  }, [colorHex, opacity, waves])

  // 统一时钟 + 无分配循环：用 R3F 共享 clock 的 getElapsedTime()，不 new THREE.Clock() 建独立漂移时钟。
  // 每帧只把经过时间赋给 uTime.value（原始数字赋值，零对象分配）；其余静态 uniform 运行循环不触碰。
  // 入场淡入（TASK-020）：注入共享入场帧时，每帧把 uOpacity 设为「配置基线透明度 × 入场场景层透明度」，
  // 使海面在省名标签淡入后随水面 / 边界阶段平滑淡入（SPEC §4.3「水面、边界线随后淡入」）。该透明度由
  // 单一显式状态流（共享入场帧）派生，非本组件私设计时器——与 uTime 同一 useFrame、同一共享 clock。
  // entranceFrame 未注入时 uOpacity 保持配置基线值（回退 TASK-020：海面加载完成即直接可见）。
  useFrame((state) => {
    // 运行时暂停（TASK-022 集中编排）：context-lost / restoring 期间冻结 uTime / uOpacity——不推进波动、
    // 不改透明度，水面静止。paused 由 RuntimeLifecycleController 单点写入 runtimeFrame，本组件只读消费
    // （不监听 context 事件）。恢复后下一帧直接接续 R3F 共享 clock（sin 周期相位跳变不可感知）。
    if (runtimeFrame !== null && runtimeFrame !== undefined && runtimeFrame.current.paused) {
      return
    }
    uniforms.uTime.value = state.clock.getElapsedTime()
    if (entranceFrame !== null && entranceFrame !== undefined) {
      const frame = entranceFrame.current
      if (frame !== null && frame !== undefined) {
        // 入场场景层透明度（loading / terrain-rise / labels-fade-in 期间为 0 → 海面不可见；
        // scene-layers-fade-in 期间 0→1 → 海面随水面 / 边界淡入；其后恒 1）。
        uniforms.uOpacity.value = opacity * computeSceneLayerOpacity(frame.elapsedSeconds, ENTRANCE_DURATIONS)
      }
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
      <planeGeometry args={[planeLayout.widthX, planeLayout.heightZ, segments, segments]} />
      {/*
        半透明 + 不写深度：transparent=true 使片元按 uOpacity 混合；depthWrite=false 使海面不写深度，
        水下地形（已写深度、在海面之下）透过海面可见，陆地（在海面之上）通过深度测试遮挡海面 → 海面
        只覆盖海域、不遮陆地，且单张平面无透明排序闪烁（TASK-013 验证方式 5）。
      */}
      <shaderMaterial
        vertexShader={SEA_SURFACE_VERTEX_SHADER}
        fragmentShader={SEA_SURFACE_FRAGMENT_SHADER}
        uniforms={uniforms}
        transparent
        depthWrite={false}
      />
    </mesh>
  )
}
