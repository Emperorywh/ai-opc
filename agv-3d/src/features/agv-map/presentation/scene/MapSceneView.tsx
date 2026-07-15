import { useCallback, useEffect, useMemo, useState } from 'react'
import { Canvas, type RootState } from '@react-three/fiber'
import type { SceneLifecyclePort } from '../../application/mapLoadCoordinator'
import { CAMERA_FOV_DEG, CAMERA_NEAR_M, FRAMING_REFERENCE_ASPECT } from '../../config/cameraConfig'
import type { RenderPacket } from '../../domain/renderPacket'
import { CameraRig } from './CameraRig'
import { PixelBudgetDpr } from './PixelBudgetDpr'
import { computeCameraFrame } from './cameraFraming'
import { NodeLayer } from './NodeLayer'
import { PathLayer } from './PathLayer'
import { SceneErrorBoundary } from './SceneErrorBoundary'
import './sceneView.css'

/**
 * 地图场景视图（SPEC §8.1、§9、§10.1，TASK-009/010/011）。
 *
 * 职责：在渲染数据包就绪后挂载 R3F Canvas，呈现 PathLayer 与 NodeLayer，并以 CameraRig
 * 提供自动框选的倾斜沙盘视角与受控 OrbitControls 交互；同时驱动加载状态机的场景准备生命周期
 * （creating-scene → fading → ready），使加载覆盖层在首帧成功渲染并完成淡入后卸载。
 *
 * 相机与控件（TASK-011，SPEC §9）：
 * - 自动框选：computeCameraFrame 以包围盒八角点在相机空间的水平/垂直需求与 5% 安全区求解
 *   相机距离，保证 16:9 与 21:9 画面均完整容纳 renderBounds（§9.1）。
 * - 受控交互：CameraRig 挂载 OrbitControls，极角 25°～70°、距离与平移边界由 renderBounds 推导（§9.2）。
 * - 像素预算：PixelBudgetDpr 在挂载与 resize 后把有效 DPR 钳制到 3840×2160 预算内（§9.3、§11.1）。
 *
 * 边界说明（后续任务接入点）：
 * - 深色环境（反射地面、网格、雾、阴影贴图）属 TASK-012，此处仅给深色背景与最小照明。
 * - 后处理（Bloom/SMAA）属 TASK-013，此处不接入 EffectComposer；R3F 默认的 ACES 色调映射与
 *   sRGB 输出已与 SPEC §8.5 一致，节点基础色可辨识。
 * - 路径扁带与流光（TASK-010）：PathLayer 渲染合并后的单一扁带 Mesh，材质声明 fog:true，
 *   待 TASK-012 接入场景雾后自动生效，无需修改本图层。
 *
 * 生命周期（SPEC §10.1、TASK-006）：
 * 1. 组件在 preparing/creating-scene 挂载，Canvas 以 opacity:0 创建场景资源。
 * 2. onCreated（首帧提交后）经场景生命周期窄边界提交"首帧成功"事实，由应用层协调器推进
 *    creating-scene → fading，并触发 500 ms 淡入（尊重 reduced-motion）。
 * 3. 淡入结束提交"淡入完成"事实 → ready，覆盖层随之卸载，露出已淡入完成的场景。
 * 组件不持有会话控制器，只提交外部事实；状态转换由应用层决定。
 */

/** 场景淡入时长（SPEC §10.1：500 ms）。 */
const SCENE_FADE_MS = 500
/** 场景背景（SPEC §8.2：#05080F）。 */
const SCENE_BACKGROUND = '#05080F'

export interface MapSceneViewProps {
  /** 渲染数据包（preparing 或 ready 状态持有）。 */
  readonly packet: RenderPacket
  /** 场景生命周期窄边界：提交首帧成功、淡入完成或创建失败等外部事实（TASK-006）。 */
  readonly scene: SceneLifecyclePort
  /** 挂载时是否已处于 ready（如重挂/HMR）：直接显示，不重复驱动淡入生命周期。 */
  readonly initiallyReady: boolean
}

export function MapSceneView({ packet, scene, initiallyReady }: MapSceneViewProps) {
  const [opacity, setOpacity] = useState(0)
  const [fadeStarted, setFadeStarted] = useState(false)

  // 自动框选：以 16:9 为参考宽高比求解，保证 16:9 与 21:9 均完整容纳（SPEC §9.1、cameraConfig）。
  // packet 在 preparing/ready 间为同一引用，frame 随之稳定，不因状态推进而重算。
  const frame = useMemo(
    () => computeCameraFrame(packet.renderBounds, FRAMING_REFERENCE_ASPECT),
    [packet.renderBounds],
  )

  // onCreated 经窄边界提交"首帧成功"事实。相机姿态由 CameraRig（OrbitControls）接管，此处不再手动 lookAt。
  // 已 ready（如重挂）时直接显示，不重复驱动生命周期。
  const handleCreated = useCallback(
    (_state: RootState) => {
      if (initiallyReady) {
        setOpacity(1)
        return
      }
      scene.notifyFirstFrameRendered()
      setFadeStarted(true)
    },
    [scene, initiallyReady],
  )

  // fading：opacity 0→1 过渡，结束后提交"淡入完成"事实。
  useEffect(() => {
    if (!fadeStarted) return
    // 下一帧置 1 以触发 CSS 过渡（从 0 起始）。
    const raf = window.requestAnimationFrame(() => setOpacity(1))
    const reduce = prefersReducedMotion()
    const ms = reduce ? 0 : SCENE_FADE_MS
    const timer = window.setTimeout(() => {
      scene.notifyFadeComplete()
    }, ms)
    return () => {
      window.cancelAnimationFrame(raf)
      window.clearTimeout(timer)
    }
  }, [fadeStarted, scene])

  return (
    <div className="agv-map-scene" style={{ opacity }}>
      <Canvas
        // 初始 DPR 占位为 1，PixelBudgetDpr 在挂载后立即按像素预算精算并写入（§9.3、§11.1）。
        // 淡入期间画布 opacity:0，DPR 切换的潜在首帧重排对用户不可见。
        dpr={1}
        // SPEC §8.5：Canvas 原生抗锯齿关闭，由 TASK-013 的 SMAA 负责。
        gl={{ antialias: false, powerPreference: 'high-performance' }}
        camera={{
          // SPEC §9.1：FOV 45°、near 0.1 m 固定；far 由 framing 推导。数值取自 cameraConfig，
          // 不在组件内散落重复常量（§12、TASK-011）。
          fov: CAMERA_FOV_DEG,
          near: CAMERA_NEAR_M,
          far: frame.far,
          position: [frame.position[0], frame.position[1], frame.position[2]],
        }}
        onCreated={handleCreated}
      >
        <PixelBudgetDpr />
        <color attach="background" args={[SCENE_BACKGROUND]} />
        {/* 最小照明：环境光补底、方向光塑形。TASK-012 接入阴影贴图与完整环境光。 */}
        <ambientLight intensity={0.7} />
        <directionalLight position={[1, 2.5, 1.5]} intensity={2.8} />
        {/* SPEC §8.1 图层顺序：PathLayer 位于 NodeLayer 之下（扁带离地 0.015 m，节点贴地）。 */}
        {/* 数据驱动 GPU 图层纳入场景错误边界：任一图层渲染期抛错（如节点包不自洽、GPU 创建失败）
            经 notifySceneCreateFailed 进入统一 error 状态，不展示半成品场景（SPEC §10.2、TASK-009）。 */}
        <SceneErrorBoundary scene={scene}>
          <PathLayer geometry={packet.pathGeometry} />
          <NodeLayer instances={packet.nodeInstances} />
        </SceneErrorBoundary>
        {/* SPEC §8.1 CameraRig：受控 OrbitControls，提供旋转/缩放/平移与自动框选目标。 */}
        <CameraRig bounds={packet.renderBounds} frame={frame} />
      </Canvas>
    </div>
  )
}

/** 读取系统减少动态效果设置（SPEC §10.1）。SSR 安全（window 不存在时视作未启用）。 */
function prefersReducedMotion(): boolean {
  if (typeof window === 'undefined' || window.matchMedia === undefined) return false
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches
}
