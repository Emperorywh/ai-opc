/**
 * 大屏长时运行生命周期的单一集中编排器（渲染层，TASK-015，SPEC §7.4）。
 *
 * 角色与依赖方向：
 * - 本组件属于渲染层（src/three），挂在 Canvas 内，是「WebGL context 丢失 / 恢复 + resize」的**唯一**监听点
 *   与生命周期状态机的**唯一**驱动器。它把浏览器 context 事件 + GPU 重建结果翻译为领域层纯事件
 *   （src/lib/runtime-lifecycle 的 RuntimeLifecycleEvent），喂给 reduceRuntimeLifecycle 得当前阶段，把
 *   「阶段 + paused」原地写入共享 runtimeFrame（供各渲染层 useFrame 只读消费决定是否冻结视觉推进），
 *   并在阶段切换时回调上层（App）以驱动 DOM 诊断。
 * - 本组件**只**依赖：领域层（runtime-lifecycle 的纯函数 / 类型）、配置层（RUNTIME_LIFECYCLE_CONFIG）、
 *   GPU 恢复遍历（restoreSceneGpuResources）、R3F useThree。**不**持有资产数据、不复制配置常量、不维护
 *   第二份 clock / 计时器用于动画（定时器仅用于 context 恢复超时与 resize 防抖，非视觉时钟）。
 *
 * 集中编排（生命周期状态集中编排，场景层和 UI 只消费状态；禁止每个组件各自监听 context 或 resize）：
 * - 整个 Canvas 内只有本组件注册 webglcontextlost / webglcontextrestored 监听器（挂载时注册一次、卸载时
 *   移除一次，见下 useEffect）。其余渲染层（EntranceController / SeaSurface / ChinaTerrainMesh / ...）
 *   **不**监听 context 事件——它们只读共享 runtimeFrame 决定是否冻结视觉推进。resize 同理：只有本组件
 *   观察尺寸变化并防抖提交，overlay 只消费提交后的尺寸。
 * - 阶段是集中信号源：runtimeFrame（phase + paused）由本组件单点写入，各消费者只读。DOM 诊断由上层据
 *   onPhaseChange 回调驱动。不存在「每个组件各自判 context 是否丢失 / 各自 resize」的并行路径。
 *
 * context 丢失 / 恢复语义（SPEC §7.4「WebGL context lost：监听 webglcontextlost / webglcontextrestored，
 *   丢失时暂停渲染、恢复时重建」）：
 * - webglcontextlost：调用 event.preventDefault() 阻止默认不可恢复行为（不 preventDefault 则浏览器把 context
 *   标记为永久丢失，无法恢复）；迁移到 context-lost；启动恢复超时定时器（contextRestoreTimeoutMs）。
 *   context-lost 期间 runtimeFrame.paused=true，各渲染层冻结视觉推进。
 * - webglcontextrestored：清除恢复超时定时器；迁移到 restoring；调 restoreSceneGpuResources（遍历场景把全部
 *   纹理 / 材质置 needsUpdate=true，使 Three.js 从**同一份 CPU 源数据**重新上传 GPU——绝不重新 fetch /
 *   重新解码 .r16，GPU 资源恢复与 CPU 领域数据生命周期分离）；重建成功 → running、
 *   重建抛错 → restore-failed（显式终态 + 诊断）。
 * - context 恢复超时：context-lost 期间若浏览器未在 contextRestoreTimeoutMs 内触发 restored，迁移到
 *   restore-failed（附「context 恢复超时」诊断），避免 context-lost 无限空白等待（不进入空白死循环）。
 *
 * resize 防抖（SPEC §7.4「窗口变化 debounce 后再更新 camera/renderer 尺寸」；防抖不得吞掉最终尺寸）：
 * - 观察 R3F size 变化（useThree(s => s.size)，R3F 由 ResizeObserver 维护，本身已非「风暴」——每变化一次触发
 *   一次）。每次变化把尺寸记入防抖状态（recordResizeInput，连续输入只保留最后一次）并重置防抖定时器；定时器
 *   到期（无新变化满 resizeDebounceMs）才提交（commitPendingResize）。提交时同步渲染器 setSize、相机 aspect /
 *   updateProjectionMatrix、overlay 尺寸（onCommittedSize 回调）——这是单一防抖路径，最终尺寸 = 最后一次输入。
 * - 卸载时清理防抖定时器与监听器，事件不再生效。
 *
 * 无重复监听 / 无重复 Clock / 无运行时几何分配（SPEC §7.4「动画时钟统一」「无运行时几何分配循环」）：
 * - 监听器：context lost / restored 各注册一次（useEffect 依赖 [gl] 等稳定对象，gl 稳定故挂载期一次）；回调经
 *   applyEventRef 间接调用，applyEvent 身份变化不重新注册监听器（只刷新 ref）。
 * - Clock：本组件**不**新建 THREE.Clock / 不新建用于动画的计时器——视觉时钟仍是 R3F 共享 clock（各渲染层
 *   useFrame 读 state.clock）。本组件的 setTimeout 仅用于 context 恢复超时与 resize 防抖（生命周期定时，非动画）。
 * - 分配：stateRef / debouncerRef / runtimeFrame 均挂载期一次性创建，运行循环只读写标量 / 原地变换纯状态，
 *   不 new THREE 对象、不重建几何。
 */

import { useCallback, useEffect, useRef } from 'react'
import type { ReactNode, RefObject } from 'react'
import { useThree } from '@react-three/fiber'
import * as THREE from 'three'
import { RUNTIME_LIFECYCLE_CONFIG } from '../config/runtime-lifecycle'
import {
  INITIAL_RESIZE_DEBOUNCER_STATE,
  INITIAL_RUNTIME_LIFECYCLE_STATE,
  commitPendingResize,
  isRuntimePaused,
  recordResizeInput,
  reduceRuntimeLifecycle,
  type RuntimeFrame,
  type RuntimeLifecycleEvent,
  type RuntimeLifecyclePhase,
  type RuntimeLifecycleState,
  type ResizeDebouncerState,
} from '../lib/runtime-lifecycle'
import { restoreSceneGpuResources } from './gpu-resource-restore'

/** RuntimeLifecycleController 的 props：阶段切换回调 + 共享运行时帧 + 提交尺寸回调（上层创建并下发）。 */
export interface RuntimeLifecycleControllerProps {
  /**
   * 阶段切换回调（仅切换时调用，驱动 DOM 诊断）。携带阶段 + 失败诊断信息（restore-failed 时非空）。
   * 上层应 memoize 以避免不必要的下游重渲染。
   */
  readonly onPhaseChange: (
    phase: RuntimeLifecyclePhase,
    failureMessage: string | null,
  ) => void
  /**
   * 共享运行时帧（上层 useRef 创建并下发）：本组件在阶段切换时原地写入 phase + paused，各渲染层 useFrame
   * 只读消费决定是否冻结视觉推进。
   */
  readonly runtimeFrame: RefObject<RuntimeFrame>
  /**
   * resize 提交回调（防抖窗口结束后调用，携带最终尺寸 = 最后一次输入）。上层据此更新 overlay 所需尺寸。
   */
  readonly onCommittedSize: (width: number, height: number) => void
}

/**
 * 运行时生命周期的单一集中编排器（Canvas 内，无可见输出）。
 *
 * 挂载时注册 context 丢失 / 恢复监听器；观察 size 变化并防抖提交；在阶段切换时写共享 runtimeFrame 并回调上层。
 * 无几何 / 无材质 / 无 DOM 输出（return null）。
 */
export function RuntimeLifecycleController({
  onPhaseChange,
  runtimeFrame,
  onCommittedSize,
}: RuntimeLifecycleControllerProps): ReactNode {
  const gl = useThree((state) => state.gl)
  const camera = useThree((state) => state.camera)
  const scene = useThree((state) => state.scene)
  const size = useThree((state) => state.size)
  const invalidate = useThree((state) => state.invalidate)

  // 当前生命周期状态（ref——事件处理器内同步读取 / 写入，无需 React 重渲染参与）。
  const stateRef = useRef<RuntimeLifecycleState>(INITIAL_RUNTIME_LIFECYCLE_STATE)
  // context 恢复超时定时器句柄（context-lost 时启动、restored 时清除、卸载时清除）。
  const restoreTimeoutRef = useRef<number | null>(null)
  // resize 防抖状态（纯变换的载体；定时器到期时 commit）。
  const debouncerRef = useRef<ResizeDebouncerState>(INITIAL_RESIZE_DEBOUNCER_STATE)
  // resize 防抖定时器句柄（每次 size 变化重置、到期时提交、卸载时清除）。
  const resizeTimerRef = useRef<number | null>(null)
  // 最新 R3F size 的 ref（context 恢复时读取兜底尺寸）。用 ref 而非把 size 进 context 监听 effect 的依赖
  // 数组——否则每次 resize 都会重注册 context 监听器（虽 cleanup 不致重复，但产生不必要 churn 与短暂窗口）。
  // ref 保持「监听器只注册一次（依赖仅 [gl] 等稳定对象）」的不变量。
  const sizeRef = useRef(size)
  useEffect(() => {
    sizeRef.current = size
  }, [size])

  // 回调间接层：监听器经 ref 调用 applyEvent，使 applyEvent / onPhaseChange 身份变化不重新注册监听器。
  // 这保证「监听器只注册一次」——重渲染只刷新 ref，不移除 / 重加 DOM 监听器（无重复监听）。
  const applyEventRef = useRef<(event: RuntimeLifecycleEvent) => void>(() => {})

  /**
   * 应用一个生命周期事件：纯函数迁移得新状态；若状态真的改变（引用变化）则同步写 runtimeFrame + 回调上层。
   *
   * 监听器经 applyEventRef.current 调用本函数，使本函数的依赖（onPhaseChange / runtimeFrame）身份变化
   * 不触发监听器重注册。
   */
  const applyEvent = useCallback(
    (event: RuntimeLifecycleEvent) => {
      const next = reduceRuntimeLifecycle(stateRef.current, event)
      // 纯函数对「被忽略的事件」返回同一引用（state）——引用相等即未迁移，跳过下游通知。
      if (next === stateRef.current) return
      stateRef.current = next
      // 同步写共享运行时帧（原地改写两个标量，零分配）：各渲染层下一帧 useFrame 即见新 phase / paused。
      runtimeFrame.current.phase = next.phase
      runtimeFrame.current.paused = isRuntimePaused(next.phase)
      // 回调上层驱动 DOM 诊断（仅切换时调用——非每帧 setState）。
      onPhaseChange(next.phase, next.failureMessage)
    },
    [onPhaseChange, runtimeFrame],
  )

  // 刷新 applyEvent 间接层（不重注册监听器）。
  useEffect(() => {
    applyEventRef.current = applyEvent
  }, [applyEvent])

  // onCommittedSize 同样走 ref，避免 resize effect 因回调身份变化重置防抖定时器。
  const onCommittedSizeRef = useRef(onCommittedSize)
  useEffect(() => {
    onCommittedSizeRef.current = onCommittedSize
  }, [onCommittedSize])

  // context 丢失 / 恢复监听：挂载时注册一次（[gl] 稳定），卸载时移除一次（无重复监听）。
  useEffect(() => {
    const canvas = gl.domElement
    // webglcontextlost：preventDefault 阻止默认不可恢复行为；迁移到 context-lost；启动恢复超时。
    const onContextLost = (event: Event): void => {
      event.preventDefault()
      applyEventRef.current({ type: 'context-lost' })
      // 启动恢复超时：context-lost 期间浏览器未在窗口内触发 restored 即判恢复失败（显式终态 + 诊断）。
      if (restoreTimeoutRef.current !== null) {
        window.clearTimeout(restoreTimeoutRef.current)
      }
      restoreTimeoutRef.current = window.setTimeout(() => {
        restoreTimeoutRef.current = null
        applyEventRef.current({
          type: 'restore-failed',
          message: `WebGL context 恢复超时（${RUNTIME_LIFECYCLE_CONFIG.contextRestoreTimeoutMs / 1000} 秒内未恢复），请检查 GPU 资源后刷新。`,
        })
      }, RUNTIME_LIFECYCLE_CONFIG.contextRestoreTimeoutMs)
    }
    // webglcontextrestored：清除超时；迁移到 restoring；重建 GPU 资源（复用 CPU 源数据）；成功 → running / 抛错 → failed。
    const onContextRestored = (): void => {
      // 清除恢复超时（context 已恢复，不再判超时）。
      if (restoreTimeoutRef.current !== null) {
        window.clearTimeout(restoreTimeoutRef.current)
        restoreTimeoutRef.current = null
      }
      applyEventRef.current({ type: 'context-restored' })
      // 重建 GPU 资源：遍历场景把全部纹理 / 材质置 needsUpdate=true。Three.js 据各纹理的 .data（CPU 源，
      // 跨 context 丢失保持同一引用）重新上传 GPU——绝不重新 fetch / 重新解码 .r16（CPU 领域数据生命周期
      // 与 GPU 资源分离）。重建抛错 → restore-failed（显式终态 + 诊断，不退化为低清 / 平面 / 远程 fallback）。
      try {
        restoreSceneGpuResources(scene)
        // 同步渲染器尺寸 + 相机投影（context 恢复后 GPU 状态已重置，显式刷新确保一致画面）。
        // 使用当前已提交尺寸（debouncerRef.committed）或 R3F size（sizeRef）兜底——保证恢复后画面尺寸一致。
        const committed = debouncerRef.current.committed
        const current = sizeRef.current
        const width = committed !== null ? committed.width : current.width
        const height = committed !== null ? committed.height : current.height
        gl.setSize(width, height, false)
        updateCameraAspect(camera, width, height)
        camera.updateProjectionMatrix()
        invalidate()
        applyEventRef.current({ type: 'restore-succeeded' })
      } catch (cause) {
        const message = cause instanceof Error ? cause.message : String(cause)
        // eslint-disable-next-line no-console
        console.error(`[RuntimeLifecycle] GPU 资源重建失败：${message}`)
        applyEventRef.current({
          type: 'restore-failed',
          message: `GPU 资源重建失败：${message}`,
        })
      }
    }
    canvas.addEventListener('webglcontextlost', onContextLost)
    canvas.addEventListener('webglcontextrestored', onContextRestored)
    return () => {
      // 卸载清理：移除监听器 + 清除定时器（事件不再生效，无僵尸定时器）。
      canvas.removeEventListener('webglcontextlost', onContextLost)
      canvas.removeEventListener('webglcontextrestored', onContextRestored)
      if (restoreTimeoutRef.current !== null) {
        window.clearTimeout(restoreTimeoutRef.current)
        restoreTimeoutRef.current = null
      }
    }
  }, [gl, scene, camera, invalidate])

  // resize 防抖：观察 size 变化，记入防抖状态 + 重置定时器；定时器到期提交最终尺寸（= 最后一次输入）。
  useEffect(() => {
    // 记录最新尺寸（连续输入只保留最后一次——防抖核心不变量）。
    debouncerRef.current = recordResizeInput(debouncerRef.current, size.width, size.height)
    // 重置防抖定时器：每次 size 变化都重新计时，只有「安静」满窗口才提交。
    if (resizeTimerRef.current !== null) {
      window.clearTimeout(resizeTimerRef.current)
    }
    resizeTimerRef.current = window.setTimeout(() => {
      resizeTimerRef.current = null
      // 提交 pending 为 committed（无 pending / 尺寸未变 → 无提交，跳过下游同步，零开销）。
      const result = commitPendingResize(debouncerRef.current)
      debouncerRef.current = result.state
      const committed = result.committed
      if (committed === null) return
      const { width, height } = committed
      // 单一防抖路径同步渲染器 + 相机（最终尺寸 = 最后一次输入，无更新风暴）。
      gl.setSize(width, height, false)
      updateCameraAspect(camera, width, height)
      camera.updateProjectionMatrix()
      invalidate()
      // 上报 overlay 所需尺寸（上层据此更新 overlay 派生尺寸）。
      onCommittedSizeRef.current(width, height)
    }, RUNTIME_LIFECYCLE_CONFIG.resizeDebounceMs)
    return () => {
      // 卸载或 size 再变化前清理当前定时器（防抖重置 + 卸载清理）。
      if (resizeTimerRef.current !== null) {
        window.clearTimeout(resizeTimerRef.current)
        resizeTimerRef.current = null
      }
    }
  }, [size.width, size.height, gl, camera, invalidate])

  return null
}

/**
 * 把当前 committed 尺寸同步到相机 aspect（PerspectiveCamera 才有 aspect 字段）。
 *
 * 正交相机无 aspect；用 'aspect' in 判别后窄类型读写，避免给 Camera 塞不存在的字段。抽取为模块内函数
 * 使 context 恢复与 resize 提交两条路径共用同一份「相机 aspect 同步」逻辑（无重复代码）。
 */
function updateCameraAspect(camera: THREE.Camera, width: number, height: number): void {
  if ('aspect' in camera && camera instanceof THREE.PerspectiveCamera) {
    camera.aspect = width / height
  }
}
