/**
 * 加载秀场组件（阶段 15~16）
 * 粒子聚合动画 + 淡出过渡
 *
 * 设计规格 §11.1：
 * - particles 阶段：粒子从四周飞向中心聚合为球体（0~3s）
 * - texture 阶段：聚合粒子保持位置，逐渐淡出消散（~1.5s）
 */
import { useRef, useMemo } from 'react'
import { useFrame } from '@react-three/fiber'
import * as THREE from 'three'
import { store } from '../../stores/store'
import { setLoadingPhase } from '../../stores/loadingSlice'
import {
  LOADING_PARTICLE_COUNT,
  LOADING_SCATTER_RADIUS_MIN,
  LOADING_SCATTER_RADIUS_MAX,
  LOADING_TARGET_RADIUS,
  LOADING_DURATION,
  LOADING_FADE_OUT_DURATION,
} from '../../utils/constants'

import loadingVertexShader from './shaders/loading.vert?raw'
import loadingFragmentShader from './shaders/loading.frag?raw'

export function LoadingSequence() {
  const startTimeRef = useRef<number | null>(null)
  const fadeOutStartRef = useRef<number | null>(null)
  const convergenceDoneRef = useRef(false)
  const fadeOutDoneRef = useRef(false)

  const { geometry, uniforms } = useMemo(() => {
    const count = LOADING_PARTICLE_COUNT
    const geo = new THREE.BufferGeometry()

    // 虚拟 position（Three.js 要求，实际位置在 vertex shader 中计算）
    const positions = new Float32Array(count * 3)

    const aStartPos = new Float32Array(count * 3)
    const aTargetPos = new Float32Array(count * 3)
    const aDelay = new Float32Array(count)
    const aSize = new Float32Array(count)
    const aBrightness = new Float32Array(count)

    for (let i = 0; i < count; i++) {
      // ── 起始位置：大球壳上随机点（远离中心）──────────
      const startTheta = Math.random() * Math.PI * 2
      const startPhi = Math.acos(2 * Math.random() - 1)
      const startR =
        LOADING_SCATTER_RADIUS_MIN +
        Math.random() * (LOADING_SCATTER_RADIUS_MAX - LOADING_SCATTER_RADIUS_MIN)

      aStartPos[i * 3] = startR * Math.sin(startPhi) * Math.cos(startTheta)
      aStartPos[i * 3 + 1] = startR * Math.cos(startPhi)
      aStartPos[i * 3 + 2] = startR * Math.sin(startPhi) * Math.sin(startTheta)

      // ── 目标位置：单位球面上随机点（地球表面）──────────
      const targetTheta = Math.random() * Math.PI * 2
      const targetPhi = Math.acos(2 * Math.random() - 1)
      // 轻微半径变化（0.97 ~ 1.03），让聚合后不完全贴合球面
      const targetR =
        LOADING_TARGET_RADIUS * (0.97 + Math.random() * 0.06)

      aTargetPos[i * 3] = targetR * Math.sin(targetPhi) * Math.cos(targetTheta)
      aTargetPos[i * 3 + 1] = targetR * Math.cos(targetPhi)
      aTargetPos[i * 3 + 2] = targetR * Math.sin(targetPhi) * Math.sin(targetTheta)

      // ── 交错延迟：0.0 ~ 0.4（创造"流动汇聚"的视觉效果）──
      aDelay[i] = Math.random() * 0.4

      // ── 点大小：1.5 ~ 4.0 px（比轨道粒子稍大）────────
      aSize[i] = 1.5 + Math.random() * 2.5

      // ── 亮度：0.3 ~ 1.0 ──────────────────────────────
      aBrightness[i] = 0.3 + Math.random() * 0.7
    }

    geo.setAttribute('position', new THREE.BufferAttribute(positions, 3))
    geo.setAttribute('aStartPos', new THREE.BufferAttribute(aStartPos, 3))
    geo.setAttribute('aTargetPos', new THREE.BufferAttribute(aTargetPos, 3))
    geo.setAttribute('aDelay', new THREE.BufferAttribute(aDelay, 1))
    geo.setAttribute('aSize', new THREE.BufferAttribute(aSize, 1))
    geo.setAttribute('aBrightness', new THREE.BufferAttribute(aBrightness, 1))

    const uniforms = {
      uProgress: { value: 0 },
      uFadeOut: { value: 0 },
    }

    return { geometry: geo, uniforms }
  }, [])

  // 逐帧更新动画进度
  useFrame(({ clock }) => {
    if (startTimeRef.current === null) {
      startTimeRef.current = clock.getElapsedTime()
    }

    const elapsed = clock.getElapsedTime() - startTimeRef.current
    const phase = store.getState().loading.phase

    // ── particles 阶段：聚合动画 ──────────────────────
    if (phase === 'particles') {
      const progress = Math.min(elapsed / LOADING_DURATION, 1.0)
      uniforms.uProgress.value = progress

      // 聚合完成 → 推进到 texture 阶段
      if (progress >= 1.0 && !convergenceDoneRef.current) {
        convergenceDoneRef.current = true
        store.dispatch(setLoadingPhase('texture'))
      }
    }

    // ── texture 阶段：粒子淡出 ────────────────────────
    if (phase === 'texture') {
      // 确保聚合进度保持 1.0（粒子在目标位置）
      uniforms.uProgress.value = 1.0

      if (fadeOutStartRef.current === null) {
        fadeOutStartRef.current = clock.getElapsedTime()
      }

      const fadeElapsed = clock.getElapsedTime() - fadeOutStartRef.current
      const fadeOut = Math.min(fadeElapsed / LOADING_FADE_OUT_DURATION, 1.0)
      uniforms.uFadeOut.value = fadeOut

      if (fadeOut >= 1.0 && !fadeOutDoneRef.current) {
        fadeOutDoneRef.current = true
      }
    }
  })

  return (
    <points geometry={geometry} frustumCulled={false}>
      <shaderMaterial
        vertexShader={loadingVertexShader}
        fragmentShader={loadingFragmentShader}
        uniforms={uniforms}
        glslVersion={THREE.GLSL3}
        transparent
        blending={THREE.AdditiveBlending}
        depthWrite={false}
      />
    </points>
  )
}
