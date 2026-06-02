/**
 * 后处理管线
 * 阶段 7：Bloom 后处理
 * 阶段 10：Vignette + Noise 后处理
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
import { EffectComposer, Bloom, Vignette, Noise } from '@react-three/postprocessing'
import {
  BLOOM_INTENSITY,
  BLOOM_LUMINANCE_THRESHOLD,
  BLOOM_LUMINANCE_SMOOTHING,
  VIGNETTE_DARKNESS,
  VIGNETTE_OFFSET,
  NOISE_OPACITY,
} from '../../utils/constants'

export function PostProcessing() {
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
