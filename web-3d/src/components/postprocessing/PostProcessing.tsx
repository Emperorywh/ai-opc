/**
 * 后处理管线
 * 阶段 7：Bloom 后处理
 * 阶段 10：Vignette + Noise 后处理
 * 阶段 16：activate 阶段淡入动画 + 推进到 done
 *
 * 使用 postprocessing 库（通过 @react-three/postprocessing 绑定 R3F）。
 * 效果链：场景渲染 → Bloom → Vignette → Noise → 输出
 *
 * 设计规格 §9：
 * - Bloom: intensity 1.2, luminanceThreshold 0.6, luminanceSmoothing 0.3, mipmapBlur true
 * - 发光元素（Fresnel glow、粒子）产生光晕扩散；地球表面不受影响
 * - Vignette: darkness 0.4, offset 0.5 — 边缘变暗，视觉焦点集中在地球
 * - Noise: opacity 0.02 — 极轻微噪点，模拟胶片质感
 */
import { useRef } from 'react'
import { useFrame } from '@react-three/fiber'
import { EffectComposer, Bloom, Vignette, Noise } from '@react-three/postprocessing'
import {
  BLOOM_INTENSITY,
  BLOOM_LUMINANCE_THRESHOLD,
  BLOOM_LUMINANCE_SMOOTHING,
  VIGNETTE_DARKNESS,
  VIGNETTE_OFFSET,
  NOISE_OPACITY,
  LOADING_ACTIVATE_DURATION,
} from '../../utils/constants'
import { store } from '../../stores/store'
import { setLoadingPhase } from '../../stores/loadingSlice'

export function PostProcessing() {
  const fadeInStartRef = useRef<number | null>(null)
  const doneRef = useRef(false)

  useFrame(({ clock }) => {
    const phase = store.getState().loading.phase

    if (phase === 'activate') {
      if (fadeInStartRef.current === null) {
        fadeInStartRef.current = clock.getElapsedTime()
      }

      const elapsed = clock.getElapsedTime() - fadeInStartRef.current
      const t = Math.min(elapsed / LOADING_ACTIVATE_DURATION, 1.0)

      // 淡入完成 → 推进到 done 阶段
      if (t >= 1.0 && !doneRef.current) {
        doneRef.current = true
        store.dispatch(setLoadingPhase('done'))
      }
    }
  })

  return (
    <EffectComposer>
      <Bloom
        intensity={BLOOM_INTENSITY}
        luminanceThreshold={BLOOM_LUMINANCE_THRESHOLD}
        luminanceSmoothing={BLOOM_LUMINANCE_SMOOTHING}
        mipmapBlur
      />
      <Vignette
        darkness={VIGNETTE_DARKNESS}
        offset={VIGNETTE_OFFSET}
      />
      <Noise
        opacity={NOISE_OPACITY}
      />
    </EffectComposer>
  )
}
