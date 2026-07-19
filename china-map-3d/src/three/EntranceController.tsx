/**
 * 入场状态机的单一帧循环驱动器（TASK-020）。
 *
 * 角色与依赖方向：
 * - 本组件属于渲染层（src/three），挂在 Canvas 内，是「加载 / 入场编排」的**唯一**时间源与状态驱动器。
 *   它每帧从 R3F 共享 clock（state.clock.getElapsedTime()）派生入场 elapsed、调用领域层纯函数
 *   （src/lib/entrance-state）派生当前阶段，把「阶段 + elapsed」写入共享入场帧 ref（供各渲染层 useFrame
 *   只读消费），并在阶段切换时回调上层（ChinaMapScreen）以驱动 DOM 加载反馈与相机交互锁。
 * - 本组件**只**依赖：领域层（entrance-state 的纯函数 + 类型）、配置层（ENTRANCE_DURATIONS 冻结时序）、
 *   R3F useFrame。**不**持有资产数据、不复制时序常量、不维护第二份 clock / 计时器 / 布尔组合
 *   （TASK-020 实现约束「入场必须由单一显式状态流编排」「所有动画使用统一 R3F 帧循环 / 时钟，禁止多 Clock
 *   漂移和逐帧对象分配」）。
 *
 * 统一时间源与幂等起始捕获（TASK-020 实现约束「禁止多 Clock 漂移」「重复渲染、StrictMode 和资源完成顺序
 *   变化不会导致动画多次启动或提前解锁」）：
 * - 入场 elapsed = R3F 共享 clock − 起始时刻。起始时刻在「资产全部就绪且无失败」的**首帧**幂等捕获一次
 *   （startClockRef.current === null 时才写），之后不再改写。StrictMode 重挂载不重建 ref（同一 fiber 同一 ref
 *   对象），故起始时刻只捕获一次、动画只启动一次；资产完成顺序变化只影响「何时 ready」，不影响「ready 后
 *   单调递增的 elapsed」——阶段顺序固定、每阶段只进一次。
 * - 无 new THREE.Clock()、无 setInterval / setTimeout：唯一时钟是 R3F 的共享 clock（与海面波动 SeaSurface、
 *   标签遮挡 PlaceLabels 的 useFrame 同源），无独立漂移时钟。
 *
 * 运行时暂停（TASK-022 集中编排）：注入共享 runtimeFrame 时，本组件每帧先检查 runtimeFrame.paused。
 *   context-lost / restoring 期间 paused=true，本组件冻结入场 elapsed（不派生 / 不写 entranceFrame，保留暂停前
 *   最后一帧），并把暂停时长折叠进起始时刻偏移，使恢复后入场从原位继续、无跳变。本组件**不**监听 context
 *   事件——paused 由 RuntimeLifecycleController 单点写入 runtimeFrame，本组件只读消费（集中编排契约）。
 *
 * 阶段切换回调（驱动 DOM 与相机锁，非每帧）：
 * - 阶段切换约 4 次（loading→terrain-rise→labels-fade-in→scene-layers-fade-in→interactive，或 loading→error），
 *   仅在切换帧回调 onPhaseChange，使 ChinaMapScreen 以普通 React state 更新 DOM 加载文本与相机 enabled——
 *   不是每帧 setState（避免 60fps 全场景重渲染）。各渲染层的逐帧 rise / 透明度由它们各自 useFrame 读共享
 *   入场帧直接写入材质 uniform / opacity，不经过 React state。
 *
 * 失败终态（TASK-020 实现约束「加载失败必须显式终止状态机并保留诊断，不得自动回退」）：
 * - readiness.failed=true 时，起始时刻永不捕获（条件含 !failed），elapsed 恒 0，deriveEntrancePhase 返回
 *   error 终态。各渲染层 rise=0 / 透明度=0（elapsed=0），入场动画不继续；DOM 由上层显示可诊断错误信息、
 *   保持交互关闭。绝不退化为低清 / 平面 / 旧资产 / 远程请求。
 */

import { useRef } from 'react'
import type { ReactNode, RefObject } from 'react'
import { useFrame } from '@react-three/fiber'
import { ENTRANCE_DURATIONS } from '../config/entrance'
import {
  deriveEntrancePhase,
  type AssetReadiness,
  type EntranceFrame,
  type EntrancePhase,
} from '../lib/entrance-state'
import type { RuntimeFrame } from '../lib/runtime-lifecycle'

/** EntranceController 的 props：资产就绪状态 + 阶段切换回调 + 共享入场帧 ref（上层创建并下发）。 */
export interface EntranceControllerProps {
  /** 受跟踪资产的聚合就绪状态（由 ChinaMapScreen 从五个资产 hook 派生）。 */
  readonly readiness: AssetReadiness
  /** 阶段切换回调（仅切换帧调用，驱动 DOM 加载反馈与相机交互锁）。 */
  readonly onPhaseChange: (phase: EntrancePhase) => void
  /** 共享入场帧 ref：本组件每帧写入 phase + elapsed，各渲染层 useFrame 只读消费。 */
  readonly entranceFrame: RefObject<EntranceFrame>
  /**
   * 共享运行时帧（TASK-022 集中编排）。注入时本组件每帧先检查 runtimeFrame.paused：context-lost / restoring
   * 期间冻结入场 elapsed（不推进视觉状态），并把暂停时长折叠进起始时刻偏移，使恢复后入场从原位继续、
   * 无跳变。未注入（回退 TASK-022）时不检查暂停、入场始终推进（回退边界）。
   */
  readonly runtimeFrame?: RefObject<RuntimeFrame> | null
}

/**
 * 入场状态机的单一帧循环驱动器（Canvas 内，无可见输出）。
 *
 * 挂载后每帧：幂等捕获起始时刻 → 派生 elapsed → deriveEntrancePhase 得当前阶段 → 写共享入场帧 →
 * 阶段切换时回调 onPhaseChange。无几何 / 无材质 / 无 DOM 输出（return null）。
 */
export function EntranceController({
  readiness,
  onPhaseChange,
  entranceFrame,
  runtimeFrame = null,
}: EntranceControllerProps): ReactNode {
  // 入场起始时刻（R3F 共享 clock 的 getElapsedTime()，秒）；null=尚未捕获（资产未全部就绪）。
  // useRef 在 StrictMode 重挂载下保持同一对象（同 fiber），故起始时刻只捕获一次、动画只启动一次。
  const startClockRef = useRef<number | null>(null)
  // 上一次回调的阶段（用于检测阶段切换、仅切换帧回调 onPhaseChange）。初值与首帧派生一致以避免冗余回调。
  const lastPhaseRef = useRef<EntrancePhase>(readiness.failed ? 'error' : 'loading')
  // 运行时暂停追踪（TASK-022）：暂停开始时刻（R3F 共享 clock 秒）；null=未暂停。
  // 恢复时把「暂停时长」折叠进 startClockRef（起始时刻后移暂停时长），使入场 elapsed 从原位继续、无跳变。
  const pauseStartRef = useRef<number | null>(null)

  // 单一帧循环（R3F 共享 clock）：派生入场 elapsed + 阶段，原地写共享帧的两个标量字段，阶段切换时回调。
  // 每帧只读 clock、**原地改写** entranceFrame.current 的 phase / elapsedSeconds 两个标量——零对象分配
  // （不 new clock / 不建数组 / 不整对象替换 ref.current）。EntranceFrame 字段刻意非 readonly 正为此写法，
  // 与仓库其余 useFrame 热循环（SeaSurface「原始数字赋值，不创建新对象」等）一致，避免 24h 大屏的 GC 抖动。
  useFrame((state) => {
    const clockNow = state.clock.getElapsedTime()

    // 运行时暂停（TASK-022）：context-lost / restoring 期间冻结入场推进。注入 runtimeFrame 时检查 paused：
    // 进入暂停记录起始（仅一次）；暂停期间直接 return（不派生 / 不写 entranceFrame），entranceFrame 保留
    // 暂停前最后一帧的值——各渲染层据此保持冻结画面（地形 rise / 标签 / 水面边界透明度不变）。
    if (runtimeFrame !== null && runtimeFrame.current.paused) {
      if (pauseStartRef.current === null) {
        pauseStartRef.current = clockNow
      }
      return
    }
    // 恢复（paused 由 true→false）：把暂停时长折叠进起始时刻偏移，使 elapsed 从原位继续。
    // startClockRef 已捕获（入场进行中 / 完成）时后移暂停时长；未捕获（loading 期间暂停）时无需调整
    // （起始尚未捕获，elapsed 仍为 0）。pauseStartRef 清零，下次暂停重新记录。
    if (pauseStartRef.current !== null) {
      const pausedFor = clockNow - pauseStartRef.current
      if (startClockRef.current !== null) {
        startClockRef.current += pausedFor
      }
      pauseStartRef.current = null
    }

    // 幂等起始捕获：仅在「起始未捕获 && 资产全部就绪 && 无失败」的首帧写一次。
    // 失败时永不捕获（条件含 !failed）→ elapsed 恒 0 → error 终态下入场动画不继续。
    if (startClockRef.current === null && readiness.ready && !readiness.failed) {
      startClockRef.current = clockNow
    }
    // 入场 elapsed = clock − 起始（起始未捕获时为 0，对应 loading / error 态）。
    const elapsed =
      startClockRef.current !== null ? Math.max(0, clockNow - startClockRef.current) : 0
    // 由「elapsed + 就绪 / 失败」确定性派生阶段（纯函数，单调）。
    const phase = deriveEntrancePhase(elapsed, readiness.ready, readiness.failed, ENTRANCE_DURATIONS)
    // 原地改写共享入场帧的两个标量字段：各渲染层 useFrame 读此 ref 派生各自 rise / 透明度（同一时间源）。
    // 不替换整对象——entranceFrame.current 自始至终是 ChinaMapScreen useRef 创建的那一个，跨帧引用稳定。
    entranceFrame.current.phase = phase
    entranceFrame.current.elapsedSeconds = elapsed
    // 阶段切换时回调上层（约 4 次：loading→terrain-rise→...→interactive，或 loading→error），
    // 驱动 DOM 加载反馈与相机交互锁。非每帧 setState——逐帧视觉值由渲染层直接写材质。
    if (phase !== lastPhaseRef.current) {
      lastPhaseRef.current = phase
      onPhaseChange(phase)
    }
  })

  return null
}
