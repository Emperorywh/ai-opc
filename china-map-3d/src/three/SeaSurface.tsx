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
import type { ReactNode } from 'react'
import * as THREE from 'three'
import { useFrame } from '@react-three/fiber'
import { SEA_SURFACE_CONFIG } from '../config/sea-surface'
import { SCENE_ATMOSPHERE_CONFIG, hexToShaderFloat3 } from '../config/scene-atmosphere'
import { SEA_SURFACE_FRAGMENT_SHADER, SEA_SURFACE_VERTEX_SHADER } from './sea-surface-shaders'

/**
 * 装配并渲染动态半透明海面 mesh。
 *
 * 无 props：海面参数全部来自冻结的 SEA_SURFACE_CONFIG（海面参数唯一源）与 SCENE_ATMOSPHERE_CONFIG
 * （雾参数唯一源），不接收任何运行时状态——这使海面层「只依赖视觉 / 几何配置」，与行政区 / 地点 /
 * hover / 加载状态正交（后续入场 TASK 改的是相机交互启停与升起 uniform，不影响海面装配）。
 */
export function SeaSurface(): ReactNode {
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
      // 基线透明度（0.6）——直接成为片元输出 alpha（半透明混合）。
      uOpacity: { value: opacity },
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
  // 每帧只把经过时间赋给 uTime.value（原始数字赋值，零对象分配）；其余 uniform 运行循环不触碰。
  useFrame((state) => {
    uniforms.uTime.value = state.clock.getElapsedTime()
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
