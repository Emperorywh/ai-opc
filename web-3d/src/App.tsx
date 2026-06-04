/**
 * App 根组件
 * R3F Canvas + WebGL2 渲染器配置
 */
import { Canvas } from '@react-three/fiber'
import Scene from './components/Scene'

export default function App() {
  return (
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
      style={{ width: '100%', height: '100%' }}
    >
      <Scene />
    </Canvas>
  )
}
