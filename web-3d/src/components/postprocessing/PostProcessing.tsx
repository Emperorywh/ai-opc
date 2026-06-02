/**
 * 后处理管线
 * 阶段 7：Bloom 后处理
 * 阶段 10（预留）：Vignette + Noise
 *
 * 使用 postprocessing 库（通过 @react-three/postprocessing 绑定 R3F）。
 * 效果链：场景渲染 → Bloom → [Vignette] → [Noise] → 输出
 *
 * 设计规格 §9：
 * - Bloom: intensity 1.2, luminanceThreshold 0.6, luminanceSmoothing 0.3, mipmapBlur true
 * - 发光元素（Fresnel glow、粒子）产生光晕扩散；地球表面不受影响
 */
import { EffectComposer, Bloom } from '@react-three/postprocessing'
import {
  BLOOM_INTENSITY,
  BLOOM_LUMINANCE_THRESHOLD,
  BLOOM_LUMINANCE_SMOOTHING,
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
    </EffectComposer>
  )
}
