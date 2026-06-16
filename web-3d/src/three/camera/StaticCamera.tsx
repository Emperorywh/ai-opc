/**
 * M1 静态倾斜相机（SPEC §6.6：pitch~45° 固定，无交互）。
 *
 * 朝南(z+)后方抬高(y+)俯视地图中心，lookAt(0,0,0)，距离落在 zoom.min/max 内。
 * M3 Task 09 替换为 SandboxControls（受限 pan/zoom + 阻尼）。
 */
import { useEffect } from 'react'
import { useThree } from '@react-three/fiber'
import type { PerspectiveCamera } from 'three'
import { cameraConfig } from '../../config/camera'

export function StaticCamera() {
  const camera = useThree((s) => s.camera)
  useEffect(() => {
    const cam = camera as PerspectiveCamera
    const pitch = (cameraConfig.pitchDeg * Math.PI) / 180
    const d = cameraConfig.initialDistance
    cam.position.set(0, Math.sin(pitch) * d, Math.cos(pitch) * d)
    cam.lookAt(0, 0, 0)
    cam.updateProjectionMatrix()
  }, [camera])
  return null
}
