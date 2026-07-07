// 引入 R3F 的 Canvas：它是 react-three/fiber 渲染 3D 场景的根容器，
// 内部会自动创建 WebGLRenderer 并挂载到其父 DOM 节点（即 #root）。
import { Canvas } from '@react-three/fiber'

// 临时背景色常量（深色工业风，对应 SPEC §3 的 #0a0e1a）。
// 本 task 仅需「可运行的空场景」，颜色就地硬编码；
// TASK_003 会把它抽到 src/config/palette.ts 与其余配色一起集中管理。
const BACKGROUND_COLOR = '#0a0e1a'

function App() {
  return (
    // Canvas 占满父容器 #root
    // （#root 已在 index.css 中设为 100vw / 100vh，避免模板居中布局残留）。
    // 场景内只放一个背景色图元作为最小可见反馈，
    // Phase 1 的后续渲染 task 会在此 Canvas 内逐层叠加
    // 相机、地图、节点、箭头、标签等内容。
    <Canvas>
      <color attach="background" args={[BACKGROUND_COLOR]} />
    </Canvas>
  )
}

export default App
