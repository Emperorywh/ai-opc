/**
 * 顶层布局（SPEC §4.1）：Canvas + HUD + 加载态。
 *
 * Task 01：Canvas + 空场景。Task 04：Canvas camera 锁 fov（与 cameraConfig 同源）。
 * Task 17：WebGL 能力检测（SPEC §13.5 / §10）——不支持时降级 WebGLFallback（静态预览 + 提示）；
 * 支持时渲染 Canvas 并叠加 Loader（DOM overlay，订阅 store loading 切片，Task 17）。
 * HUD / Legend 在 M5（Task 18）/ M8。
 */
import { useMemo } from 'react'
import { Canvas } from '@react-three/fiber'
import { cameraConfig } from './config/camera'
import { Scene } from './three/Scene'
import { Loader } from './ui/Loader'
import { WebGLFallback } from './ui/WebGLFallback'
import { detectWebGL } from './ui/webgl'

export default function App() {
  // SPEC §13.5：检测 WebGL2/WebGL1；不支持则降级静态预览图（Task 17）。仅运行一次。
  const support = useMemo(() => detectWebGL(), [])
  if (!support.supported) return <WebGLFallback />

  return (
    <div className="canvas-container">
      <Canvas camera={{ fov: cameraConfig.fov }}>
        <Scene />
      </Canvas>
      {/* SPEC §加载体验：DOM overlay 加载进度（订阅 store loading 切片；ready 后自卸载） */}
      <Loader />
    </div>
  )
}
