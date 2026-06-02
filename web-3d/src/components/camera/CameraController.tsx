/**
 * 相机控制组件（阶段 6：鼠标模式 → 阶段 11：Redux 集成）
 * 鼠标拖拽旋转 + 滚轮缩放 + 空闲模式联动
 *
 * 设计规格 §7.1：
 * - 拖拽 → 地球旋转（grab 手感：拖右地球右转）
 * - 滚轮 → 缩放
 * - 释放后惯性滑动并逐渐停下（阻尼 0.95）
 *
 * 设计规格 §7.2（阶段 11 新增）：
 * - 任何鼠标操作 → dispatch recordInput() + setInputMode('mouse')
 * - 与 IdleOrbit 联动：操作时打断空闲公转
 *
 * 实现：
 * - 拖拽时直接更新球坐标 theta/phi（即时响应）
 * - 释放时将最近移动速度写入 velocity（惯性）
 * - useCameraState 的 useFrame 处理速度应用和阻尼
 */
import { useEffect, useRef } from 'react'
import { useThree } from '@react-three/fiber'
import { useCameraState } from '../../stores/useCameraState'
import { store } from '../../stores/store'
import { recordInput, setInputMode } from '../../stores/inputSlice'

/** 拖拽旋转灵敏度（弧度/像素） */
const DRAG_SENSITIVITY = 0.005
/** 滚轮缩放灵敏度（乘性因子） */
const SCROLL_SENSITIVITY = 0.001
/** 惯性转换系数：将"每事件位移"转为"每秒速度" */
const INERTIA_SCALE = 60

/** 记录用户输入并切换为鼠标模式 */
function markMouseInput() {
  store.dispatch(recordInput())
  store.dispatch(setInputMode('mouse'))
}

export function CameraController() {
  const cameraState = useCameraState()
  const { gl } = useThree()

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

      // 记录用户输入，打断空闲公转
      markMouseInput()

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
      markMouseInput()
    }

    const onPointerUp = (e: PointerEvent) => {
      if (!isDragging.current) return

      isDragging.current = false
      canvas.releasePointerCapture(e.pointerId)

      // 将最近速度写入 velocity，useFrame 会接管阻尼衰减
      cameraState.current.velocity.theta = recentVelocity.current.theta
      cameraState.current.velocity.phi = recentVelocity.current.phi

      // 释放时也记录输入时间（松手也是交互）
      markMouseInput()
    }

    const onWheel = (e: WheelEvent) => {
      e.preventDefault()

      // 乘性缩放（距离无关的统一缩放感）
      const factor = 1 + e.deltaY * SCROLL_SENSITIVITY
      cameraState.current.distance *= factor

      // 滚轮操作记录输入
      markMouseInput()
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
