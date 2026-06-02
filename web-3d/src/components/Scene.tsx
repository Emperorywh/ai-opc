/**
 * 场景编排器
 * 组合所有子组件——地球、粒子、星空、相机控制、后处理等
 *
 * 注：地球 Shader 自处理日光（rawShaderMaterial 不接收 Three.js 灯光），
 *     因此场景层不需要 ambientLight / directionalLight。
 *
 * 帧序（阶段 14 新增 InputPriority）：
 * 1. InputPriority  — 模式切换（在 IdleOrbit 之前执行，确保模式正确）
 * 2. IdleOrbit      — 空闲公转动画（读取模式）
 * 3. CameraController — 输入控制（读取模式）
 * 4. useCameraState 的帧循环 — 写入 Three.js camera
 */

import { EarthLoader } from './earth/EarthLoader'
import { StarField } from './stars/StarField'
import { ParticleField, AmbientDust } from './particles/ParticleField'
import { PulsePoints } from './particles/PulsePoints'
import { InputPriority } from '../hooks/useInputPriority'
import { CameraController } from './camera/CameraController'
import { IdleOrbit } from './camera/IdleOrbit'
import { GestureCursor } from './camera/GestureCursor'
import { PostProcessing } from './postprocessing/PostProcessing'

export default function Scene() {
  return (
    <>
      {/* 程序化星空（阶段 5） */}
      <StarField />

      {/* 轨道粒子系统（阶段 8：~3000 轨道粒子） */}
      <ParticleField />

      {/* 漂浮尘埃（阶段 9：~3000 布朗运动尘埃） */}
      <AmbientDust />

      {/* 地表脉冲点（阶段 9：~200 冰蓝色闪烁点） */}
      <PulsePoints />

      {/* 地球球体 + 纹理 */}
      <EarthLoader />

      {/*
        输入优先级管理（阶段 14）
        必须在 IdleOrbit 之前，确保模式切换先于公转动画执行
      */}
      <InputPriority />

      {/*
        空闲自动公转（阶段 11）
        必须在 CameraController 之前，确保 IdleOrbit 的 useFrame
        先于 useCameraState 的帧循环执行（theta 先改，后更新相机）
      */}
      <IdleOrbit />

      {/* 相机控制（阶段 6：鼠标拖拽旋转 + 滚轮缩放；阶段 13：手势模式） */}
      <CameraController />

      {/* 手势 3D 光标（阶段 14：光束 + 涟漪） */}
      <GestureCursor />

      {/* 后处理（阶段 7：Bloom；阶段 10：Vignette + Noise） */}
      <PostProcessing />
    </>
  )
}
