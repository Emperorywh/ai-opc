/**
 * 相机控制组件
 * 阶段 6：鼠标拖拽旋转 + 滚轮缩放
 * 阶段 11：Redux 联动（空闲模式打断）
 * 阶段 13：手势模式（双阶段平滑旋转 + 捏合缩放）
 * 阶段 14：移除 setInputMode 调用，模式切换由 useInputPriority 统一管理
 *
 * 设计规格 §7.1：
 * - 拖拽 → 地球旋转（grab 手感：拖右地球右转）
 * - 滚轮 → 缩放
 * - 释放后惯性滑动并逐渐停下（阻尼 0.95）
 *
 * 设计规格 §7.3（阶段 13 新增）：
 * - 手掌 X 移动 → 地球 Y 轴旋转（水平拖 → 地球左右转）
 * - 手掌 Y 移动 → 地球 X 轴旋转（上下拖 → 地球上下转）
 * - 双指捏合距离变化 → 相机距离（缩放）
 *
 * 设计规格 §7.4 双阶段滤波：
 * - 阶段 1（useSmoothing）：低通滤波原始数据，截止 ~2Hz
 * - 阶段 2（本组件）：运动阻尼，dampingFactor 0.05，慢单感
 *
 * 帧序说明：
 * 手势 useFrame 注册在 useCameraState 之前，
 * 因此手势修改 theta/phi/distance 后，
 * useCameraState 的帧循环在同一帧内读取更新后的值并写入 camera。
 */
import { useEffect, useRef } from 'react'
import { useFrame, useThree } from '@react-three/fiber'
import { useCameraState, getCameraState } from '../../stores/useCameraState'
import { store } from '../../stores/store'
import { recordInput } from '../../stores/inputSlice'
import { useSmoothing } from '../../hooks/useSmoothing'
import { GESTURE_DAMPING_FACTOR } from '../../utils/constants'

// ── 鼠标参数 ────────────────────────────────────────────

/** 拖拽旋转灵敏度（弧度/像素） */
const DRAG_SENSITIVITY = 0.005
/** 滚轮缩放灵敏度（乘性因子） */
const SCROLL_SENSITIVITY = 0.001
/** 惯性转换系数：将"每事件位移"转为"每秒速度" */
const INERTIA_SCALE = 60

// ── 手势参数 ────────────────────────────────────────────

/** 手掌移动 → 旋转灵敏度（弧度 / 归一化位移） */
const GESTURE_ROTATION_SENSITIVITY = 4.0
/** 捏合距离变化 → 缩放灵敏度（距离单位 / 归一化变化） */
const GESTURE_PINCH_SENSITIVITY = 15.0
/** 手势速度衰减系数（手离开后逐渐停止，~0.5s） */
const GESTURE_VELOCITY_DECAY = 0.92

// ── 组件 ────────────────────────────────────────────────

export function CameraController() {
  const { smoothStage1, reset: resetSmoothing } = useSmoothing()
  const { gl } = useThree()

  // ── 手势状态 ref ──────────────────────────────────────
  /** 上一帧平滑后的手势数据（用于计算增量） */
  const prevSmoothed = useRef<{
    palm: [number, number]
    pinch: number
  } | null>(null)
  /** 阶段 2 阻尼后的手势速度（每帧位移量） */
  const gestureVelocity = useRef({ theta: 0, phi: 0, zoom: 0 })
  /** 上一帧手是否被检测到（检测手进入/离开的边沿） */
  const wasHandDetected = useRef(false)

  // ── 手势帧循环（注册在 useCameraState 之前，确保先执行） ──
  useFrame((_, delta) => {
    const { input } = store.getState()

    if (input.handDetected && input.palmPosition && input.pinchDistance !== null) {
      // ── 手势模式：检测到手部 ─────────────────────────

      // 手刚进入画面 → 重置平滑状态和参考帧
      if (!wasHandDetected.current) {
        resetSmoothing()
        prevSmoothed.current = null
        gestureVelocity.current = { theta: 0, phi: 0, zoom: 0 }
        wasHandDetected.current = true
      }

      // 阶段 1：低通滤波平滑原始数据
      const smoothed = smoothStage1(
        input.palmPosition,
        input.pinchDistance,
        delta,
      )

      if (prevSmoothed.current) {
        // 计算平滑后的增量
        const dx = smoothed.palmCenter[0] - prevSmoothed.current.palm[0]
        const dy = smoothed.palmCenter[1] - prevSmoothed.current.palm[1]
        const dPinch = smoothed.pinchDistance - prevSmoothed.current.pinch

        // 映射到旋转和缩放
        // MediaPipe 自拍镜像：x 向右增加 → theta 减小（grab 手感，与鼠标一致）
        const targetTheta = -dx * GESTURE_ROTATION_SENSITIVITY
        // y 向下增加 → phi 增加（手掌下压 → 看南方）
        const targetPhi = dy * GESTURE_ROTATION_SENSITIVITY
        // 捏合距离减小（手指合拢）→ zoom in → distance 减小
        const targetZoom = -dPinch * GESTURE_PINCH_SENSITIVITY

        // 阶段 2：阻尼平滑
        // 每帧仅将速度向目标移动 5%，实现"慢单感"
        gestureVelocity.current.theta +=
          (targetTheta - gestureVelocity.current.theta) * GESTURE_DAMPING_FACTOR
        gestureVelocity.current.phi +=
          (targetPhi - gestureVelocity.current.phi) * GESTURE_DAMPING_FACTOR
        gestureVelocity.current.zoom +=
          (targetZoom - gestureVelocity.current.zoom) * GESTURE_DAMPING_FACTOR

        // 应用到共享相机状态（直接修改 theta/phi/distance）
        const cam = getCameraState()
        cam.theta += gestureVelocity.current.theta
        cam.phi += gestureVelocity.current.phi
        cam.distance += gestureVelocity.current.zoom
      }

      // 记录当前帧平滑值，作为下一帧的参考
      prevSmoothed.current = {
        palm: [smoothed.palmCenter[0], smoothed.palmCenter[1]],
        pinch: smoothed.pinchDistance,
      }

      // 记录输入（防止进入空闲模式）
      // 阶段 14：不再 dispatch setInputMode，由 useInputPriority 统一管理
      store.dispatch(recordInput())
    } else {
      // ── 手离开画面 ───────────────────────────────────

      if (wasHandDetected.current) {
        wasHandDetected.current = false
        prevSmoothed.current = null
        // 不立即清零速度，让手势惯性自然衰减
      }

      // 手势速度衰减（逐渐停止，产生惯性滑行感）
      const gv = gestureVelocity.current
      if (
        Math.abs(gv.theta) > 0.00001 ||
        Math.abs(gv.phi) > 0.00001 ||
        Math.abs(gv.zoom) > 0.00001
      ) {
        gv.theta *= GESTURE_VELOCITY_DECAY
        gv.phi *= GESTURE_VELOCITY_DECAY
        gv.zoom *= GESTURE_VELOCITY_DECAY

        // 衰减后继续应用到相机（惯性滑行）
        const cam = getCameraState()
        cam.theta += gv.theta
        cam.phi += gv.phi
        cam.distance += gv.zoom

        // 极小速度归零（避免无限微振动）
        if (Math.abs(gv.theta) < 0.00001) gv.theta = 0
        if (Math.abs(gv.phi) < 0.00001) gv.phi = 0
        if (Math.abs(gv.zoom) < 0.00001) gv.zoom = 0
      }
    }
  })

  // ── 鼠标控制（阶段 6） ──────────────────────────────────

  const cameraState = useCameraState()

  const isDragging = useRef(false)
  const prevPointer = useRef({ x: 0, y: 0 })
  /** 最近一次移动的速度（用于释放后惯性） */
  const recentVelocity = useRef({ theta: 0, phi: 0 })

  useEffect(() => {
    const canvas = gl.domElement

    const onPointerDown = (e: PointerEvent) => {
      // 仅响应左键
      if (e.button !== 0) return

      isDragging.current = true
      prevPointer.current = { x: e.clientX, y: e.clientY }
      recentVelocity.current = { theta: 0, phi: 0 }

      // 拖拽开始时清零速度（防止上次惯性叠加）
      cameraState.current.velocity.theta = 0
      cameraState.current.velocity.phi = 0

      // 阶段 14：仅记录输入，模式切换由 useInputPriority 管理
      store.dispatch(recordInput())

      // 捕获指针——即使鼠标移出 canvas 也持续接收事件
      canvas.setPointerCapture(e.pointerId)
    }

    const onPointerMove = (e: PointerEvent) => {
      if (!isDragging.current) return

      const dx = e.clientX - prevPointer.current.x
      const dy = e.clientY - prevPointer.current.y
      prevPointer.current = { x: e.clientX, y: e.clientY }

      // grab 手感：拖右 → 地球右转 → theta 减小
      const dTheta = -dx * DRAG_SENSITIVITY
      // 拖上 → 相机升高（看北极）→ phi 减小
      const dPhi = dy * DRAG_SENSITIVITY

      // 拖拽中直接更新位置（即时响应，不经过 velocity）
      cameraState.current.theta += dTheta
      cameraState.current.phi += dPhi

      // 记录速度（用于释放后惯性）
      recentVelocity.current.theta = dTheta * INERTIA_SCALE
      recentVelocity.current.phi = dPhi * INERTIA_SCALE

      // 持续记录用户输入
      store.dispatch(recordInput())
    }

    const onPointerUp = (e: PointerEvent) => {
      if (!isDragging.current) return

      isDragging.current = false
      canvas.releasePointerCapture(e.pointerId)

      // 将最近速度写入 velocity，useFrame 会接管阻尼衰减
      cameraState.current.velocity.theta = recentVelocity.current.theta
      cameraState.current.velocity.phi = recentVelocity.current.phi

      // 释放时也记录输入时间（松手也是交互）
      store.dispatch(recordInput())
    }

    const onWheel = (e: WheelEvent) => {
      e.preventDefault()

      // 乘性缩放（距离无关的统一缩放感）
      const factor = 1 + e.deltaY * SCROLL_SENSITIVITY
      cameraState.current.distance *= factor

      // 滚轮操作记录输入
      store.dispatch(recordInput())
    }

    // 绑定原生事件（不与 R3F raycaster 事件冲突）
    canvas.addEventListener('pointerdown', onPointerDown)
    canvas.addEventListener('pointermove', onPointerMove)
    canvas.addEventListener('pointerup', onPointerUp)
    canvas.addEventListener('pointerleave', onPointerUp)
    canvas.addEventListener('wheel', onWheel, { passive: false })

    return () => {
      canvas.removeEventListener('pointerdown', onPointerDown)
      canvas.removeEventListener('pointermove', onPointerMove)
      canvas.removeEventListener('pointerup', onPointerUp)
      canvas.removeEventListener('pointerleave', onPointerUp)
      canvas.removeEventListener('wheel', onWheel)
    }
  }, [gl, cameraState])

  return null
}
