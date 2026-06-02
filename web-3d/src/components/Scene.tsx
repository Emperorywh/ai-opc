/**
 * 场景编排器
 * 组合所有子组件——地球、粒子、星空、相机控制、后处理等
 *
 * 注：地球 Shader 自处理日光（rawShaderMaterial 不接收 Three.js 灯光），
 *     因此场景层不需要 ambientLight / directionalLight。
 */

import { EarthLoader } from './earth/EarthLoader'
import { StarField } from './stars/StarField'
import { ParticleField } from './particles/ParticleField'
import { CameraController } from './camera/CameraController'
import { PostProcessing } from './postprocessing/PostProcessing'

export default function Scene() {
  return (
    <>
      {/* 程序化星空（阶段 5） */}
      <StarField />

      {/* 轨道粒子系统（阶段 8：~3000 轨道粒子） */}
      <ParticleField />

      {/* 地球球体 + 纹理 */}
      <EarthLoader />

      {/* 相机控制（阶段 6：鼠标拖拽旋转 + 滚轮缩放） */}
      <CameraController />

      {/* 后处理（阶段 7：Bloom） */}
      <PostProcessing />
    </>
  )
}
