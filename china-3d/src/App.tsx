/**
 * 大屏页面骨架（SPEC §3.4 / §11）。
 *
 * 当前仅提供全视口深蓝黑容器与标题区；R3F Canvas、海拔色阶图例、
 * 合规角标等由后续任务按 SPEC §11 目录结构挂载到 stage 区域。
 */
function App() {
  return (
    <main className="screen">
      <header className="screen-header">
        <h1 className="screen-title">中国 3D 地势图</h1>
        <p className="screen-subtitle">真实地形版图大屏</p>
      </header>
      <section className="screen-stage" aria-label="3D 地形画布挂载区" />
    </main>
  )
}

export default App
