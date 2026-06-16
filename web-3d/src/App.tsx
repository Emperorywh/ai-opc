/**
 * 顶层布局（SPEC §4.1）：Canvas + HUD + 加载态。
 *
 * Task 01：仅 Canvas + 空场景。HUD / Loader 在 M5（Task 17/18）。
 */
import { Canvas } from '@react-three/fiber'
import { Scene } from './three/Scene'

export default function App() {
  return (
    <div className="canvas-container">
      <Canvas>
        <Scene />
      </Canvas>
    </div>
  )
}
