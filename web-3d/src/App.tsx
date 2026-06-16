/**
 * 顶层布局（SPEC §4.1）：Canvas + HUD + 加载态。
 *
 * Task 01：Canvas + 空场景。Task 04：Canvas camera 锁 fov（与 cameraConfig 同源）。
 * HUD / Loader 在 M5（Task 17/18）。
 */
import { Canvas } from '@react-three/fiber'
import { cameraConfig } from './config/camera'
import { Scene } from './three/Scene'

export default function App() {
  return (
    <div className="canvas-container">
      <Canvas camera={{ fov: cameraConfig.fov }}>
        <Scene />
      </Canvas>
    </div>
  )
}
