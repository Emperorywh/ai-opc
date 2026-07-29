/**
 * 大屏页面骨架（SPEC §3.4 / §11）。
 *
 * 当前仅提供全视口深蓝黑容器与标题区；R3F Canvas、海拔色阶图例、
 * 合规角标等由后续任务按 SPEC §11 目录结构挂载到 stage 区域。
 * 标题区文案来自页面静态文案唯一事实源（src/lib/static-copy.ts），
 * 字体子集覆盖校验以同一事实源断言所需汉字无缺失（SPEC §3.7）。
 */
import { PAGE_SUBTITLE, PAGE_TITLE } from './lib/static-copy'

function App() {
  return (
    <main className="screen">
      <header className="screen-header">
        <h1 className="screen-title">{PAGE_TITLE}</h1>
        <p className="screen-subtitle">{PAGE_SUBTITLE}</p>
      </header>
      <section className="screen-stage" aria-label="3D 地形画布挂载区" />
    </main>
  )
}

export default App
