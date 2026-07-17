/*
 * 应用根组件（app-root 层，SPEC 3.3 / 4.2 / 12.5 / 13 / 14.1 / 任务约束）。
 *
 * 定位（TASK-018）：
 *   - 本组件是 React 树根，唯一负责把 application 加载状态机结果桥接到 R3F 场景与 UI 覆盖层。
 *   - 装配 LoadOrchestrator（注入浏览器端口）、按状态投影 OverlayView、ready 时渲染 Canvas +
 *     StaticSceneContent（只读装配 TASK-014 资源）+ MapCameraController（TASK-019 相机浏览）+ MapLegend。
 *
 * 生命周期不变量（SPEC 4.3 / 任务“20 次挂载/卸载计数不增长”）：
 *   - useMapLoad 在 effect 内 new 出全新 LoadOrchestrator，卸载时 dispose（幂等）。
 *   - StrictMode setup→cleanup→setup 产生两个独立编排器实例：cleanup dispose 第一个，第二次 setup 持有全新实例。
 *
 * 按需渲染不变量（SPEC 13 / 任务约束）：
 *   - <Canvas frameloop="demand">：静止时不常驻 60 FPS 空转；资源首次提交、resize、controls change 与
 *     Home 的 invalidate 由 MapCameraController 发出。flat 关闭 tone mapping（SPEC 7.3 NoToneMapping）；dpr 夹在 [1,1.5]（SPEC 7.3）。
 *   - gl 固定 antialias + high-performance（SPEC 7.3 renderer）；不创建阴影资源。
 *
 * 不变量：禁止在本组件解析原始 JSON、重算几何、决定业务色或第二套加载状态（SPEC 3.3 / 任务约束）。
 */
import { useEffect, useRef, useState, useCallback } from 'react'
import { Canvas } from '@react-three/fiber'
import { LoadOrchestrator } from './application/loadOrchestrator'
import type { LoadState } from './application/loadState'
import type { MapResources } from './rendering/mapResources'
import { MapDataError, MapErrorCode } from './domain/mapDataError'
import { computeGroundBounds } from './camera/groundBounds'
import { RENDERER_DPR_RANGE } from './config/mapVisualConfig'
import { SCENE_BUILD_PHASE } from './workers/sceneBuildProtocol'
import { createMapLoadConfig } from './mapRuntimePorts'
import { StaticSceneContent } from './scene/StaticSceneContent'
import { MapCameraController } from './MapCameraController'
import { LoadOrErrorOverlay } from './ui/LoadOrErrorOverlay'
import type { OverlayView } from './ui/LoadOrErrorOverlay'
import { MapLegend } from './ui/MapLegend'

/*
 * preparing 子阶段名 → 简体中文阶段标签。
 */
const PREPARING_STAGE_LABEL: Readonly<Record<string, string>> = {
  parsing: '解析样本',
  validating: '校验与归一化',
  building: '构建几何',
}

/*
 * 把 application LoadState 投影为 UI 覆盖层只读视图（SPEC 4.2 / 14.1）。
 * ui 层禁止依赖 application，故在本 app-root 边界完成 LoadState → OverlayView 的字符串投影。
 * ready 投影为 hidden（不渲染覆盖层，画面交给 Canvas）。
 */
function projectOverlayView(state: LoadState<MapResources>): OverlayView {
  switch (state.kind) {
    case 'idle':
      return { kind: 'loading', stageLabel: '初始化' }
    case 'loading':
      return { kind: 'loading', stageLabel: '请求样本中' }
    case 'preparing': {
      const base = state.stage ? PREPARING_STAGE_LABEL[state.stage] : '准备场景'
      return { kind: 'loading', stageLabel: `${base}中` }
    }
    case 'ready':
      return { kind: 'hidden' }
    case 'error':
      return {
        kind: 'error',
        code: state.error.code,
        message: state.error.message,
        phaseLabel: state.phase === SCENE_BUILD_PHASE.LOADING ? '加载' : '准备',
        jsonPath: state.error.jsonPath,
        entityId: state.error.entityId,
      }
  }
}

/*
 * useMapLoad：装配并启动 LoadOrchestrator，返回当前加载状态（SPEC 4.2 / 4.3）。
 *
 * 生命周期：effect 内异步装配端口（含 glyphs.json 清单加载）→ new 编排器 → subscribe → start；
 *   cleanup 时 dispose（幂等）。清单装配失败直接置 error 状态（FONT_ASSET_FAILED），不启动 worker。
 * StrictMode 安全：每次挂载 new 全新编排器；cleanup dispose 旧实例，二者独立 requestId。
 */
function useMapLoad(): LoadState<MapResources> {
  const [state, setState] = useState<LoadState<MapResources>>({ kind: 'idle' })
  // 用 ref 持有当前编排器，cleanup 时释放；初值为 null，异步装配后赋值。
  const orchestratorRef = useRef<LoadOrchestrator<MapResources> | null>(null)

  useEffect(() => {
    let cancelled = false
    createMapLoadConfig()
      .then((config) => {
        if (cancelled) return
        const orchestrator = new LoadOrchestrator<MapResources>(config)
        orchestratorRef.current = orchestrator
        orchestrator.subscribe(setState)
        orchestrator.start()
      })
      .catch((err: unknown) => {
        if (cancelled) return
        // 清单 / 端口装配失败（FONT_ASSET_FAILED 等）：直接置 error，不启动 worker。
        const error =
          err instanceof MapDataError
            ? err
            : new MapDataError({
                code: MapErrorCode.FONT_ASSET_FAILED,
                message: err instanceof Error ? err.message : String(err),
                jsonPath: 'app.runtime',
              })
        setState({
          kind: 'error',
          requestId: 0,
          error,
          phase: SCENE_BUILD_PHASE.PREPARING,
          failureStage: 'font',
        })
      })
    return () => {
      cancelled = true
      // 卸载 / HMR / StrictMode cleanup：幂等释放编排器（终止 worker、释放资源、清空订阅）。
      orchestratorRef.current?.dispose()
      orchestratorRef.current = null
    }
  }, [])

  return state
}

/*
 * 应用根组件：按加载状态渲染覆盖层或 Canvas + 静态场景 + 图例。
 */
function App(): React.JSX.Element {
  const state = useMapLoad()
  const overlayView = projectOverlayView(state)

  // 可聚焦容器以回调 ref → state 注入 MapCameraController（SPEC §12.5）：div 挂载时 setContainerEl
  // 触发一次重渲染，把 DOM 元素作为只读 prop 传入 Canvas 内的控制器，使其键盘焦点边界可判定
  // document.activeElement。Hooks 必须在任何条件 return 之前调用，保证调用顺序稳定。
  const [containerEl, setContainerEl] = useState<HTMLElement | null>(null)
  const containerCallbackRef = useCallback((node: HTMLDivElement | null) => {
    setContainerEl(node)
  }, [])

  // 未 ready：渲染加载 / 错误覆盖层，不挂载 Canvas（不显示部分地图，SPEC 14.1 / 任务异常路径）。
  if (state.kind !== 'ready') {
    return (
      <div className="app-root">
        <LoadOrErrorOverlay view={overlayView} />
      </div>
    )
  }

  const { model, resources } = state
  // 有限地面范围：由 TASK-017 computeGroundBounds 从唯一内容范围推导（contentBounds 已自校验，
  // 理论不返回 null；若不可达地返回 null，回落为不渲染地图的错误视图，禁止画退化地面）。
  const groundBounds = computeGroundBounds(model.contentBounds)
  if (groundBounds === null) {
    return (
      <div className="app-root">
        <LoadOrErrorOverlay
          view={{
            kind: 'error',
            code: MapErrorCode.MAP_GEOMETRY_INVALID,
            message: '内容范围非法，无法推导有限地面范围。',
            phaseLabel: '准备',
          }}
        />
      </div>
    )
  }

  // a11y（SPEC §12.5）：外层容器可聚焦，aria-label 至少含地图名、节点数、边数与完整操作提示。
  // role="application" 告知辅助技术本区域有自定义键盘交互，应把按键直通应用而非劫持为浏览命令。
  const ariaLabel = `${model.metadata.mapName}：${model.diagnostics.nodeCount} 个节点、${model.diagnostics.edgeArrowCount} 条边。只读三维地图查看器。键盘操作：方向键平移、加号减号缩放、Q E 旋转、Home 复位。`

  return (
    <div
      ref={containerCallbackRef}
      className="app-root app-root--map"
      tabIndex={0}
      role="application"
      aria-label={ariaLabel}
    >
      {/*
        Canvas（SPEC 13 / 7.3）：
          - frameloop="demand"：静止时按需渲染，不常驻帧循环（任务“静态画布使用 demand 帧模式”）。
          - flat：toneMapping = NoToneMapping（SPEC 7.3）。
          - dpr=[1,1.5]：DPR 夹取（SPEC 7.3 / config RENDERER_DPR_RANGE）。
          - gl：antialias + high-performance（SPEC 7.3 renderer）；不创建阴影资源。
          - camera：初始透视相机；位置 / 朝向 / 裁剪面由 MapCameraController 按 fit 覆盖。
      */}
      <Canvas
        frameloop="demand"
        flat
        dpr={[RENDERER_DPR_RANGE[0], RENDERER_DPR_RANGE[1]]}
        gl={{ antialias: true, powerPreference: 'high-performance' }}
        camera={{ fov: 50, near: 0.02, far: 1000, position: [0, 120, 120] }}
      >
        <StaticSceneContent resources={resources} groundBounds={groundBounds} />
        <MapCameraController
          contentBounds={model.contentBounds}
          groundBounds={groundBounds}
          containerEl={containerEl}
        />
      </Canvas>
      <MapLegend />
    </div>
  )
}

export default App
