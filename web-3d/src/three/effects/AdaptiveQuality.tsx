/**
 * 自适应质量分档（SPEC §4.3 渲染管线首项 / §8 / D18，Task 11）。
 *
 * 职责：
 *  1. useDetectGPU（drei）→ 初定档（设备探测）。
 *  2. useFrame 滑动窗口统计平均 FPS（~1s/窗口）→ 滞回状态机（持续命中 + 冷却防抖动）
 *     → 升降一档 → 写 store `qualityTier`。
 *  3. dpr 应用：`setDpr(min(devicePixelRatio, dprMax))`（4K 受控防爆显存）。
 *  4. 手动覆盖：store `qualityTierOverride` 非 null 时锁定该档（冻结自适应）。
 *
 * shader 开关（海洋波数 / 地形水彩 5 效果）由 Ocean.tsx / Terrain.tsx 订阅 `qualityTier`
 * 各自切换 uniform value（M2 预留钩子，本组件不动 shader）；标签密度由 M4 LabelLayer 消费。
 *
 * 所有判定逻辑在 ./qualityState 纯函数（可单测）；本组件仅作 R3F 胶水。
 * 渲染 null（纯副作用组件，置于 Canvas 内、Scene 顶层）。
 */
import { useEffect, useRef } from 'react'
import { useThree, useFrame } from '@react-three/fiber'
import { useDetectGPU } from '@react-three/drei'
import { qualityConfigs, qualityAdaptive } from '../../config/quality'
import { useStore } from '../../state/store'
import {
  type FpsWindowState,
  initialTierFromGpu,
  initialFpsWindowState,
  stepFpsWindow,
  avgFpsFromDeltas,
  clampDpr,
} from './qualityState'

/** 单帧 delta 超过此值（秒）视为不连续（后台切回 / 长卡顿）→ 重置窗口不计入，防误判降档。 */
const DISCONTINUITY_SEC = 0.25

export function AdaptiveQuality() {
  const setDpr = useThree((s) => s.setDpr)
  const setQualityTier = useStore((s) => s.setQualityTier)
  const qualityTier = useStore((s) => s.qualityTier)
  const override = useStore((s) => s.qualityTierOverride)
  const gpu = useDetectGPU()

  // 档位状态机（init 后非空）。
  const stateRef = useRef<FpsWindowState | null>(null)
  const initedRef = useRef(false)
  // FPS 滑动窗口累加。
  const deltasRef = useRef<number[]>([])
  const windowElapsedRef = useRef(0)

  // 初定档：设备探测 → 写 store（无覆盖时）。仅在就绪后初始化一次。
  useEffect(() => {
    if (initedRef.current) return
    initedRef.current = true
    const t0 = initialTierFromGpu(gpu.tier, !!gpu.isMobile)
    stateRef.current = initialFpsWindowState(t0)
    const { qualityTierOverride } = useStore.getState()
    setQualityTier(qualityTierOverride ?? t0)
  }, [gpu.tier, gpu.isMobile, setQualityTier])

  // dpr：生效档变化 → 钳制 devicePixelRatio 到档位上限。
  useEffect(() => {
    const dprMax = qualityConfigs[qualityTier].dprMax
    setDpr(clampDpr(typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1, dprMax))
  }, [qualityTier, setDpr])

  // 手动覆盖：非 null 锁定该档；恢复 null 时立即对齐当前探测档（不等下个窗口）。
  useEffect(() => {
    if (override !== null) {
      setQualityTier(override)
    } else if (stateRef.current) {
      setQualityTier(stateRef.current.tier)
    }
  }, [override, setQualityTier])

  // FPS 滑窗 → 滞回状态机 → 升降档。
  useFrame((_, deltaRaw) => {
    const st = stateRef.current
    if (!st) return // 初定档未完成
    // 手动覆盖时冻结自适应。
    if (useStore.getState().qualityTierOverride !== null) return

    // 不连续帧（后台 / 长卡顿）重置窗口，防误判。
    if (deltaRaw > DISCONTINUITY_SEC) {
      deltasRef.current = []
      windowElapsedRef.current = 0
      return
    }
    deltasRef.current.push(deltaRaw)
    windowElapsedRef.current += deltaRaw
    if (windowElapsedRef.current < qualityAdaptive.fpsWindowSec) return

    // 窗口满：算平均 FPS → 推进状态机。
    const fps = avgFpsFromDeltas(deltasRef.current)
    const next = stepFpsWindow(st, fps, qualityAdaptive)
    stateRef.current = next
    deltasRef.current = []
    windowElapsedRef.current = 0
    if (next.tier !== useStore.getState().qualityTier) {
      setQualityTier(next.tier)
    }
  })

  return null
}
