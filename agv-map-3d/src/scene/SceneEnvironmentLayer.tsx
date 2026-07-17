/*
 * 场景环境灯光 R3F 装配（scene 装配层，SPEC 7.3 / 13 / 4.3 / 任务约束）。
 *
 * 定位（TASK-018）：
 *   - 把 createSceneEnvironment 产出的灯光 Group 通过 <primitive> 挂入场景；
 *     不在 JSX 内联灯光参数、不重算光照、不创建第二套灯光对象。
 *
 * 资源所有权不变量（SPEC 4.3 / 任务“卸载只调用既有所有者的幂等释放边界”）：
 *   - 与 GroundLayer 同构：灯光 Handle 在 effect 内创建并在同一 effect 的 cleanup 内 dispose，
 *     使“每次创建必有一次释放”成立，StrictMode 的 setup→cleanup→setup 下每份 Handle 各自释放。
 *   - 半球光 / 方向光本身不持有 GPU 资源（dispose 为幂等空操作），但 Handle 的生命周期与 GroundLayer
 *     保持同一模式，避免 scene 层出现两种不同的资源所有权写法（SPEC 4.3 幂等 / 一致性）。
 *   - 不得在渲染阶段（useMemo / 组件体）创建灯光对象：StrictMode 二次调用渲染阶段函数会丢弃首次
 *     结果，虽灯光无 GPU 资源，仍会留下悬挂引用与不一致的生命周期语义。
 *
 * 按需渲染不变量（SPEC 13 / 任务约束）：
 *   - 灯光首次挂载即写入场；demand 帧模式下由 app-root 在资源首次提交时统一 invalidate。
 *   - 本组件不注册 useFrame、不发起常驻帧请求；静止场景保持按需渲染。
 *
 * 依赖方向（SPEC 3.3）：本层（sceneEnvironment 工厂）+ react；外部仅 react。
 *   不直接依赖 three / r3f 的运行时对象创建（工厂负责），只做 <primitive> 装配。
 */
import { useLayoutEffect, useState } from 'react'
import { createSceneEnvironment } from './sceneEnvironment'
import type { SceneEnvironmentHandle } from './sceneEnvironment'

/*
 * 场景环境灯光图层：在 layout effect 内创建一次灯光 Group，挂载并在卸载时幂等释放。
 *
 * 无 props：灯光参数全部来自 config，不随数据或相机变化（SPEC 7.3 静态环境）。
 * 资源经 state 暴露给渲染：首次渲染时尚未创建（返回空片段），layout effect 创建后 setState 同步触发
 *   重渲染挂入 <primitive>，使灯光在浏览器首次绘制前进入场景（与 GroundLayer / 相机 fit 同处
 *   layout effect 阶段）。与 GroundLayer 共用同一资源所有权模式。
 */
export function SceneEnvironmentLayer(): React.JSX.Element {
  // 灯光 Handle 经 state 暴露；初值为 null（首帧不装配 primitive，layout effect 创建后挂入）。
  const [handle, setHandle] = useState<SceneEnvironmentHandle | null>(null)
  // 资源创建唯一在 layout effect 内发生：StrictMode 下每份 Handle 都被自身 cleanup dispose（SPEC 4.3）。
  useLayoutEffect(() => {
    const created = createSceneEnvironment()
    setHandle(created)
    // cleanup 与创建一一配对：灯光无 GPU 资源，dispose 为幂等空操作，但生命周期与 GroundLayer 一致。
    return () => {
      created.dispose()
    }
  }, [])
  // 资源尚未创建时（首帧 / StrictMode 重建间隙）渲染空片段；创建完成后挂入灯光 Group。
  return <>{handle === null ? null : <primitive object={handle.group} />}</>
}
