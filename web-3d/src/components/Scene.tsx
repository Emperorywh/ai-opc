/**
 * 场景编排器
 * 仅包含地球 + 场景灯光 + 鼠标相机控制
 */

import { EarthLoader } from './earth/EarthLoader'
import { CameraController } from './camera/CameraController'

export default function Scene() {
  return (
    <>
      {/* 灯光：MeshStandardMaterial 需要 */}
      <ambientLight intensity={0.1} />
      <directionalLight position={[5, 1.5, 2.5]} intensity={1.5} />

      {/* 地球 */}
      <EarthLoader />

      {/* 相机控制（仅鼠标） */}
      <CameraController />
    </>
  )
}
