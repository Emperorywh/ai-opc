/**
 * 场景编排器
 * 组合所有子组件——地球、粒子、星空、相机控制、后处理等
 *
 * 注：地球 Shader 自处理日光（rawShaderMaterial 不接收 Three.js 灯光），
 *     因此场景层不需要 ambientLight / directionalLight。
 */

import { EarthLoader } from './earth/EarthLoader'
import { StarField } from './stars/StarField'

export default function Scene() {
  return (
    <>
      {/* 程序化星空（阶段 5） */}
      <StarField />

      {/* 地球球体 + 纹理 */}
      <EarthLoader />
    </>
  )
}
