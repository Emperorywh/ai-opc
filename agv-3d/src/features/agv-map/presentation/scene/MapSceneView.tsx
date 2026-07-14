import { useCallback, useEffect, useState } from 'react'
import { Canvas, type RootState } from '@react-three/fiber'
import type { LoadSessionController } from '../../application/loadSession'
import type { RenderPacket } from '../../domain/renderPacket'
import { NodeLayer } from './NodeLayer'
import { PathLayer } from './PathLayer'
import { computeBasicFraming } from './basicFraming'
import './sceneView.css'

/**
 * 地图场景视图（SPEC §8.1、§10.1、TASK-009）。
 *
 * 职责：在渲染数据包就绪后挂载 R3F Canvas，呈现 NodeLayer（本期交付），并以最小可用的
 * 相机与照明保证四类节点在沙盘视角下可辨识；同时驱动加载状态机的场景准备生命周期
 * （creating-scene → fading → ready），使加载覆盖层在首帧成功渲染并完成淡入后卸载。
 *
 * 边界说明（后续任务接入点）：
 * - 相机框选与控件属 TASK-011，此处只用基础框选（computeBasicFraming），不挂 OrbitControls。
 * - 深色环境（反射地面、网格、雾、阴影贴图）属 TASK-012，此处仅给深色背景与最小照明。
 * - 后处理（Bloom/SMAA）属 TASK-013，此处不接入 EffectComposer；R3F 默认的 ACES 色调映射与
 *   sRGB 输出已与 SPEC §8.5 一致，节点基础色可辨识。
 * - 路径扁带与流光（TASK-010）：PathLayer 渲染合并后的单一扁带 Mesh，材质声明 fog:true，
 *   待 TASK-012 接入场景雾后自动生效，无需修改本图层。
 *
 * 生命周期（SPEC §10.1）：
 * 1. 组件在 preparing/creating-scene 挂载，Canvas 以 opacity:0 创建场景资源。
 * 2. onCreated（首帧提交后）推进状态机到 fading，并触发 500 ms 淡入（尊重 reduced-motion）。
 * 3. 淡入结束调用 complete → ready，覆盖层随之卸载，露出已淡入完成的场景。
 */

/** 场景淡入时长（SPEC §10.1：500 ms）。 */
const SCENE_FADE_MS = 500
/** 场景背景（SPEC §8.2：#05080F）。 */
const SCENE_BACKGROUND = '#05080F'

export interface MapSceneViewProps {
  /** 渲染数据包（preparing 或 ready 状态持有）。 */
  readonly packet: RenderPacket
  /** 加载会话控制器，用于驱动 creating-scene → fading → ready。 */
  readonly controller: LoadSessionController
}

export function MapSceneView({ packet, controller }: MapSceneViewProps) {
  const [opacity, setOpacity] = useState(0)
  const [fadeStarted, setFadeStarted] = useState(false)

  const frame = computeBasicFraming(packet.renderBounds)

  // 对准框选目标并推进到 fading。
  // R3F 默认透视相机保持单位旋转、朝世界 -Z 看，不会自动 lookAt 场景中心；只给 position 会
  // 让整张地图落在 45° FOV 的半角 22.5° 之外、画面不可见，故首帧后显式 lookAt(target)，
  // 使四类节点进入视锥（SPEC §9.1）。OrbitControls 与八角点 framing 精算属 TASK-011，
  // 届时由控件接管 target 朝向；本处只做一次性定向，运行期不再修改相机姿态。
  // 已 ready（如重挂）时只补 lookAt 并直接显示，不重复驱动生命周期。
  const handleCreated = useCallback(
    ({ camera }: RootState) => {
      camera.lookAt(frame.target[0], frame.target[1], frame.target[2])
      const state = controller.getState()
      if (state?.status === 'ready') {
        setOpacity(1)
        return
      }
      const requestId = controller.getCurrentRequestId()
      controller.apply({ type: 'advance', to: 'fading' }, requestId)
      setFadeStarted(true)
    },
    [controller, frame],
  )

  // fading：opacity 0→1 过渡，结束后 complete。
  useEffect(() => {
    if (!fadeStarted) return
    // 下一帧置 1 以触发 CSS 过渡（从 0 起始）。
    const raf = window.requestAnimationFrame(() => setOpacity(1))
    const reduce = prefersReducedMotion()
    const ms = reduce ? 0 : SCENE_FADE_MS
    const timer = window.setTimeout(() => {
      controller.apply({ type: 'complete' }, controller.getCurrentRequestId())
    }, ms)
    return () => {
      window.cancelAnimationFrame(raf)
      window.clearTimeout(timer)
    }
  }, [fadeStarted, controller])

  return (
    <div className="agv-map-scene" style={{ opacity }}>
      <Canvas
        // DPR 上限 2，避免高 DPI 屏过度膨胀物理像素；TASK-011 按 §11.1 公式精算 effectiveDpr。
        dpr={[1, 2]}
        // SPEC §8.5：Canvas 原生抗锯齿关闭，由 TASK-013 的 SMAA 负责。
        gl={{ antialias: false, powerPreference: 'high-performance' }}
        camera={{
          fov: 45,
          near: 0.1,
          far: frame.far,
          position: frame.position,
        }}
        onCreated={handleCreated}
      >
        <color attach="background" args={[SCENE_BACKGROUND]} />
        {/* 最小照明：环境光补底、方向光塑形。TASK-012 接入阴影贴图与完整环境光。 */}
        <ambientLight intensity={0.7} />
        <directionalLight position={[1, 2.5, 1.5]} intensity={2.8} />
        {/* SPEC §8.1 图层顺序：PathLayer 位于 NodeLayer 之下（扁带离地 0.015 m，节点贴地）。 */}
        <PathLayer geometry={packet.pathGeometry} />
        <NodeLayer instances={packet.nodeInstances} />
      </Canvas>
    </div>
  )
}

/** 读取系统减少动态效果设置（SPEC §10.1）。SSR 安全（window 不存在时视作未启用）。 */
function prefersReducedMotion(): boolean {
  if (typeof window === 'undefined' || window.matchMedia === undefined) return false
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches
}
