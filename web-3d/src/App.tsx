/**
 * App 根组件
 * R3F Canvas + WebGL2 渲染器配置 + 手势识别管理
 */
import { Canvas } from '@react-three/fiber'
import * as THREE from 'three'
import Scene from './components/Scene'
import { useHandGesture } from './hooks/useHandGesture'

/** 手势识别管理器（空渲染组件，仅运行 useHandGesture hook） */
function HandGestureTracker() {
  useHandGesture()
  return null
}

export default function App() {
  return (
    <>
      {/*
        手势识别（阶段 12）
        放在 Canvas 外部，因为它管理 DOM（摄像头 video）而非 Three.js 对象
      */}
      <HandGestureTracker />

      <Canvas
        gl={{
          antialias: true,
          alpha: false,
          powerPreference: 'high-performance',
        }}
        camera={{
          fov: 45,
          near: 0.1,
          far: 1000,
          position: [0, 0, 3.5],
        }}
        onCreated={({ gl }) => {
          gl.toneMapping = THREE.ACESFilmicToneMapping
          gl.toneMappingExposure = 1.0
        }}
        style={{ width: '100%', height: '100%' }}
      >
        <Scene />
      </Canvas>
    </>
  )
}
