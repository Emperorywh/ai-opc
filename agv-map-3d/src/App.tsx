/*
 * 应用根组件（app-root 层，SPEC 3.3 装配点）。
 *
 * 当前处于工程基线状态：尚未交付任何地图业务能力（TASK-001 范围）。
 * 后续 TASK 将在此挂载 <Canvas>、scene 层各 R3F 图层、camera 控制器与 ui overlay，
 * 所有地图资源只通过 SceneModel 与 rendering 资源装配，禁止在此解析原始 JSON。
 *
 * 不变量：
 *   - 本组件是 React 树根，可依赖任意业务层，但基线阶段不引入业务占位实现。
 *   - 实际地图渲染由 scene 层图层完成；本组件只负责把 application 状态机结果桥接到 React 树。
 *   - 禁止在此直接读取 data 下源样本或任何边/节点原始字段；运行时入口固定为 /generated/sampleMap.json。
 */
function App() {
  return (
    <div className="app-root">
      <p className="app-root__note">
        Overlook 地图 3D 复刻 — 工程基线已就绪，地图能力待后续 TASK 装配。
      </p>
    </div>
  )
}

export default App
