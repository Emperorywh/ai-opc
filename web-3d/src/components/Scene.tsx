/**
 * 场景编排器
 * 组合所有子组件——地球、粒子、星空、相机控制、后处理等
 */

import { EarthLoader } from './earth/EarthLoader'

export default function Scene() {
  return (
    <>
      {/* 环境光（后续阶段会被自定义光照替代） */}
      <ambientLight intensity={0.1} />

      {/* 地球球体 + 纹理 */}
      <EarthLoader />
    </>
  )
}
