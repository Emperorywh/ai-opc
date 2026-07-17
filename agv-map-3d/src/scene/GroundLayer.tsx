/*
 * 有限地面 R3F 装配（scene 装配层，SPEC 7.1 / 7.2 / 7.3 / 7.4 / 12.1 / 13 / 4.3 / 任务约束）。
 *
 * 定位（TASK-018）：
 *   - 把 createGroundMesh 产出的有限地面 Mesh 通过 <primitive> 挂入场景；
 *     地面范围来自 TASK-017 的 computeGroundBounds（app-root 计算后作为只读数值传入），
 *     本组件不重算 padding、不回读 contentBounds、不解析数据。
 *
 * 资源所有权不变量（SPEC 4.3 / 任务“卸载只调用既有所有者的幂等释放边界”）：
 *   - 有限地面的 PlaneGeometry / MeshStandardMaterial 是 GPU 资源，必须在 effect 内创建并在
 *     同一 effect 的 cleanup 内 dispose，使“每次创建必有一次释放”成立。
 *   - 不得在渲染阶段（useMemo / 组件体）创建 GPU 资源：React StrictMode 会二次调用渲染阶段函数
 *     并丢弃首次结果，被丢弃的那份 geometry / material 永不 dispose，构成泄漏
 *     （SPEC 4.3“StrictMode 下初始化与清理必须幂等，禁止泄漏 GPU 资源”；SPEC 15.3
 *      “反复挂载/卸载 20 次后 GPU memory 计数不得单调增长”）。
 *   - effect 内创建的 Handle 与其 cleanup 一一配对：StrictMode 的 setup→cleanup→setup 产生两份
 *     Handle，cleanup 各自 dispose，卸载时再 dispose 第二份，全程无悬挂资源（SPEC 4.3 幂等）。
 *
 * 资源消费不变量（任务约束）：
 *   - groundBounds 是只读数值范围；本组件只把它转交工厂，不修改、不缓存第二套范围。
 *   - <primitive> 不被 R3F 自动释放（fiber 源码 primitive 分支），释放责任唯一归 Handle.dispose，
 *     不在 scene 层形成第二套创建 / 释放逻辑、不回读原始 JSON。
 *
 * 按需渲染不变量（SPEC 13 / 任务约束）：
 *   - 地面在 effect 内首次创建并挂入；demand 帧模式下由 app-root 在资源首次提交时统一 invalidate。
 *   - 本组件不注册 useFrame、不发起常驻帧请求；静止场景保持按需渲染。
 *
 * 依赖方向（SPEC 3.3）：domain（NumericBox3）+ 本层（groundMesh 工厂）+ react；外部仅 react。
 */
import { useLayoutEffect, useState } from 'react'
import type { NumericBox3 } from '../domain/sceneMap'
import { createGroundMesh } from './groundMesh'
import type { GroundMeshHandle } from './groundMesh'

/*
 * 有限地面图层入参。
 *   - groundBounds：TASK-017 computeGroundBounds 交付的只读数值范围（Y 恒为 [0, 0]）。
 */
export interface GroundLayerProps {
  readonly groundBounds: NumericBox3
}

/*
 * 有限地面图层：在 layout effect 内按 groundBounds 创建一次地面 Mesh，挂载并在卸载 / 范围变化时幂等释放。
 *
 * 资源经 state 暴露给渲染：首次渲染时尚未创建（返回空片段），layout effect 创建后 setState 同步触发
 *   重渲染挂入 <primitive>，使地面在浏览器首次绘制前就已进入场景（与相机 fit 同处 layout effect 阶段，
 *   避免出现“相机已就位但地面缺失”的首帧）。这同时保证 GPU 资源的生命周期完全由 effect 驱动，不进入渲染阶段。
 */
export function GroundLayer({ groundBounds }: GroundLayerProps): React.JSX.Element {
  // GPU 资源经 state 暴露；初值为 null（首帧不装配 primitive，layout effect 创建后挂入）。
  const [handle, setHandle] = useState<GroundMeshHandle | null>(null)
  // 资源创建唯一在 layout effect 内发生：StrictMode 下 setup→cleanup→setup 的每份 Handle 都被自身 cleanup
  // dispose，杜绝“渲染阶段创建被丢弃、永不释放”的泄漏（SPEC 4.3 / 15.3）。
  useLayoutEffect(() => {
    const created = createGroundMesh(groundBounds)
    setHandle(created)
    // cleanup 与创建一一配对：释放本次创建的 geometry / material，幂等且不触碰其他所有者的资源。
    return () => {
      created.dispose()
    }
  }, [groundBounds])
  // 资源尚未创建时（首帧 / StrictMode 重建间隙）渲染空片段；创建完成后挂入有限地面 Mesh。
  return <>{handle === null ? null : <primitive object={handle.mesh} />}</>
}
