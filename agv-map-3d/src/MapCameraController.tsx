/*
 * 受约束且不打断视图的相机浏览控制器（app-root 层，SPEC §12.2~§12.4 / §13 / 任务约束）。
 *
 * 定位（TASK-019）：
 *   - 本组件是 Canvas 内的相机浏览唯一装配点：消费 TASK-017 的 computeCameraFit / computeClipPlanes
 *     与 TASK-017 的 computeGroundBounds 结果（groundBounds 由 app-root 计算后作为只读数值传入），
 *     把唯一内容范围 + 有限地面范围 + 当前画布尺寸推导为相机位置 / 朝向 / 裁剪面，并接入
 *     OrbitControls 提供 orbit / pan / zoom 浏览（SPEC §12.4）。替代 TASK-018 的静态相机装配。
 *
 * 单一相机状态所有者不变量（任务约束）：
 *   - OrbitControls.target 与 camera.position 是 target / 距离 / 朝向的唯一事实来源；
 *     hasUserNavigated 标记唯一由本组件的 ref 持有。不在 controls、本组件、键盘模块中各维护第二套
 *     target、距离或导航标记。所有 clamp / fit / near-far 更新复用 TASK-017 的纯计算能力
 *     （computeCameraFit / computeClipPlanes / clampTargetToGround），不在事件回调中复制公式。
 *
 * target clamp 不变量（SPEC §12.4 / 任务约束）：
 *   - 每次 controls change 后把 target.x/z 限制在 Ground 范围内、target.y 固定为 0；
 *     clamp 产生的修正向量同时加到 camera.position，保持 camera-target offset 不变
 *     （offset 改变会破坏 OrbitControls 的 spherical 状态）。
 *   - 相机始终位于地面上方：target.y = 0、polar ∈ [15°, 85°] → camera.y = distance × cos(polar) > 0。
 *
 * resize 分支与 Home 复位不变量（SPEC §12.4 / 任务约束）：
 *   - 首次非零尺寸 fit；未导航 resize 重新 fit；已导航 resize 仅更新 aspect / 裁剪面 / invalidate，
 *     保留 target / 距离 / 朝向（resize 不打断用户视图）。
 *   - Home 重新执行标准 3/4 fit 并把 hasUserNavigated 置回 false（与 TASK-017 标准 fit 完全一致）。
 *
 * 按需渲染不变量（SPEC §13 / 任务约束）：
 *   - controls change / 有效 resize / Home 后显式 invalidate 请求 demand 帧；不切换为常驻帧循环。
 *   - useFrame 仅推进 damping：update() 仅在仍有位移时 dispatch change（由 commitCameraState 接管
 *     invalidate），damping 收敛后不再 dispatch、循环自停，idle 不持续提交帧（SPEC §15.5）。
 *
 * 只读浏览不变量（SPEC §1.3 / 任务约束）：
 *   - 相机交互属只读浏览，不挂对象点击 / hover / raycaster 业务逻辑。
 *
 * 生命周期不变量（SPEC §4.3 / 任务约束）：
 *   - controls 事件注册与解除成对且可重复；本任务不用全局可变 controls 规避生命周期，
 *     完整的 StrictMode / HMR / WebGL 恢复闭环在 TASK-023 验收。
 *
 * 依赖方向（SPEC 3.3）：app-root 允许 camera / r3f / three / domain / config。
 */
import { useCallback, useEffect, useLayoutEffect, useRef } from 'react'
import { useFrame, useThree } from '@react-three/fiber'
import { OrbitControls } from 'three/addons/controls/OrbitControls.js'
import { PerspectiveCamera } from 'three'
import type { NumericBox3 } from './domain/sceneMap'
import { computeCameraFit, PERSPECTIVE_FOV_DEG } from './camera/cameraFit'
import type { Vec3 } from './camera/cameraFit'
import { computeClipPlanes } from './camera/clipPlanes'
import { clampTargetToGround } from './camera/targetClamp'
import {
  applyOrbitContract,
  buildOrbitContract,
  computeMaxDistance,
} from './camera/orbitControlsContract'
import {
  decideHomeReset,
  decideResizeAction,
  onUserInteractionStart,
} from './camera/navigationState'

/*
 * 控制器入参。
 *   - contentBounds：SceneModel 的唯一数值内容范围（排除标签与地面）。
 *   - groundBounds：TASK-017 computeGroundBounds 交付的有限地面范围（参与裁剪面推导与 target clamp，
 *     不参与 fit）。
 */
export interface MapCameraControllerProps {
  readonly contentBounds: NumericBox3
  readonly groundBounds: NumericBox3
}

/*
 * fit 派生数据：扩张内容范围（复用作裁剪面的 expanded content bounds）与拟合半径 R。
 * 裁剪面与 maxDistance 共享同一 R，避免第二套半径。
 */
interface FitData {
  readonly expandedBounds: NumericBox3
  readonly radius: number
}

/*
 * 受约束且不打断视图的相机浏览控制器主组件。
 *
 * 单一相机状态所有者：controlsRef（OrbitControls 实例）+ fitDataRef（fit 派生数据）+
 *   hasUserNavigatedRef（用户是否已浏览）。事件回调经 latest ref 读最新 props，无需重新订阅。
 */
export function MapCameraController({
  contentBounds,
  groundBounds,
}: MapCameraControllerProps): null {
  // 选择性订阅 camera / size / invalidate / gl，避免无关 R3F 状态变更触发重渲染。
  const camera = useThree((s) => s.camera)
  const size = useThree((s) => s.size)
  const invalidate = useThree((s) => s.invalidate)
  const gl = useThree((s) => s.gl)

  // 单一相机状态所有者：OrbitControls（target / camera 经其驱动）+ 下列 ref。
  const controlsRef = useRef<OrbitControls | null>(null)
  const fitDataRef = useRef<FitData | null>(null)
  // hasUserNavigated 是用户是否已浏览的唯一标记（SPEC §12.4）；
  // 由 start 事件置 true、Home 复位置 false，resize 据此选择 fit / preserve 分支。
  const hasUserNavigatedRef = useRef<boolean>(false)

  // latest ref：让事件回调读到最新 props / size 而无需重新订阅（成对事件保持稳定）。
  const contentBoundsRef = useRef<NumericBox3>(contentBounds)
  contentBoundsRef.current = contentBounds
  const groundBoundsRef = useRef<NumericBox3>(groundBounds)
  groundBoundsRef.current = groundBounds
  const sizeRef = useRef(size)
  sizeRef.current = size

  /*
   * 复用 TASK-017 computeClipPlanes 推导当前 near / far 并写入相机（SPEC §12.3）。
   * 不在事件回调中复制裁剪面公式；position / target 取自唯一相机状态（camera + controls.target）。
   * 依赖 [camera]（R3F 稳定引用），故回调身份稳定，不引发 controls effect 重新订阅。
   */
  const applyClipPlanes = useCallback(() => {
    const controls = controlsRef.current
    const fitData = fitDataRef.current
    if (controls === null || fitData === null) return
    if (!(camera instanceof PerspectiveCamera)) return
    const position: Vec3 = {
      x: camera.position.x,
      y: camera.position.y,
      z: camera.position.z,
    }
    const target: Vec3 = {
      x: controls.target.x,
      y: controls.target.y,
      z: controls.target.z,
    }
    const clip = computeClipPlanes(
      fitData.expandedBounds,
      groundBoundsRef.current,
      position,
      target,
      fitData.radius,
    )
    if (clip === null) return
    camera.near = clip.near
    camera.far = clip.far
    camera.updateProjectionMatrix()
  }, [camera])

  /*
   * commitCameraState：target clamp（offset 保持）+ near/far + invalidate（SPEC §12.4）。
   * controls 'change' 与 Home 共用此路径，保证“同一相机状态更新后请求 demand 帧”
   * （任务约束），不在多处复制 clamp / 裁剪面公式。
   */
  const commitCameraState = useCallback(() => {
    const controls = controlsRef.current
    if (controls === null) return
    // SPEC §12.4：target.x/z 限制到 Ground、y 固定为 0；修正向量同时加到 camera.position 保持 offset。
    const clamp = clampTargetToGround(
      controls.target.x,
      controls.target.z,
      groundBoundsRef.current,
    )
    if (clamp !== null) {
      controls.target.x = clamp.clampedX
      controls.target.z = clamp.clampedZ
      controls.target.y = 0
      camera.position.x += clamp.correctionX
      camera.position.z += clamp.correctionZ
    }
    applyClipPlanes()
    invalidate()
  }, [camera, invalidate, applyClipPlanes])

  /*
   * 标准 3/4 fit（SPEC §12.2）：首次非零尺寸、未导航 resize、Home 共用此路径。
   * 复用 computeCameraFit 推导位置 / 朝向 / R；maxDistance = 8 × R（SPEC §12.4）；
   * fitDataRef 保存扩张范围与 R，供后续裁剪面与 maxDistance 共享。
   */
  const applyStandardFit = useCallback(
    (aspect: number) => {
      const fit = computeCameraFit(contentBoundsRef.current, aspect)
      // 零尺寸 / 非有限：保持未提交，不产生 NaN（SPEC §12.2 / 任务异常路径）。
      if (fit === null) return
      const controls = controlsRef.current
      // 写入相机位置与标准 3/4 朝向；lookAt 保证首帧（update 前）已对准 fit 球心。
      camera.position.set(fit.position.x, fit.position.y, fit.position.z)
      camera.lookAt(fit.target.x, fit.target.y, fit.target.z)
      if (camera instanceof PerspectiveCamera) {
        camera.fov = PERSPECTIVE_FOV_DEG
        camera.aspect = aspect
      }
      if (controls !== null) {
        controls.target.set(fit.target.x, fit.target.y, fit.target.z)
        // maxDistance = 8 × R（SPEC §12.4）；R 非有限时保持原值（理论不可达）。
        const maxDistance = computeMaxDistance(fit.radius)
        if (maxDistance !== null) {
          controls.maxDistance = maxDistance
        }
      }
      fitDataRef.current = {
        expandedBounds: fit.expandedBounds,
        radius: fit.radius,
      }
      applyClipPlanes()
      invalidate()
    },
    [camera, invalidate, applyClipPlanes],
  )

  /*
   * damping 驱动（SPEC §12.4 / §13 demand frameloop）：每个被 invalidate 的帧推进一次 update()。
   * update() 内部从 camera.position - target 重建 spherical（故 commitCameraState 的 offset 保持
   * 写法与之相容），仅在仍有位移时 dispatch change（由 commitCameraState 接管 clamp + 裁剪面 +
   * invalidate）；damping 收敛后不再 dispatch、循环自停，idle 不持续提交帧（SPEC §15.5）。
   * 该 useFrame 不替代 change / resize 的显式 invalidate（任务“不得用常驻帧循环弥补事件遗漏”）。
   */
  useFrame(() => {
    const controls = controlsRef.current
    if (controls !== null) {
      controls.update()
    }
  })

  /*
   * OrbitControls 生命周期：创建 + 固定契约 + 事件 + 清理（SPEC §12.4 / §4.3）。
   * useLayoutEffect（先于 fit effect）：保证 fit effect 运行时 controlsRef 已就绪。
   * 成对 add/removeEventListener + dispose：cleanup 幂等，StrictMode setup→cleanup→setup 不泄漏、
   * 不产生重复监听（任务“重复 change/end 事件不产生重复监听”）。
   */
  useLayoutEffect(() => {
    const controls = new OrbitControls(camera, gl.domElement)
    // 写入固定契约（maxDistance 为 +∞ 占位，首次 fit 用 8 × R 覆盖）。
    applyOrbitContract(controls, buildOrbitContract())
    controlsRef.current = controls

    // change：target clamp + 裁剪面 + invalidate（任务“change 后显式请求 demand 帧”）。
    const onChange = () => commitCameraState()
    // start：用户开始 orbit / pan / zoom → 标记已浏览，后续 resize 进入保留分支（SPEC §12.4）。
    const onStart = () => {
      hasUserNavigatedRef.current = onUserInteractionStart().flag
    }
    controls.addEventListener('change', onChange)
    controls.addEventListener('start', onStart)

    return () => {
      controls.removeEventListener('change', onChange)
      controls.removeEventListener('start', onStart)
      controls.dispose()
      controlsRef.current = null
    }
  }, [camera, gl, commitCameraState])

  /*
   * fit + resize 分支（SPEC §12.4 / 任务“resize 不会在用户已导航后重置视图”）。
   * useLayoutEffect（次于 controls effect）：首次与未导航 resize 重新 fit；已导航 resize 保留视图，
   * 仅更新 aspect / 裁剪面 / invalidate。零尺寸画布保持未提交，不产生 NaN。
   */
  useLayoutEffect(() => {
    const aspect = size.height > 0 ? size.width / size.height : 0
    if (!(aspect > 0)) return // 零尺寸画布：保持未提交（SPEC §12.2 / 任务异常路径）。
    const decision = decideResizeAction(hasUserNavigatedRef.current)
    if (decision.action === 'fit') {
      // 未导航（含首次）：重新执行标准 3/4 fit（与 TASK-017 标准结果完全一致）。
      applyStandardFit(aspect)
    } else {
      // 已导航：保留 target / 距离 / 朝向，仅更新 aspect / 裁剪面 / invalidate。
      if (camera instanceof PerspectiveCamera) {
        camera.aspect = aspect
      }
      applyClipPlanes()
      invalidate()
    }
  }, [
    size.width,
    size.height,
    contentBounds,
    groundBounds,
    camera,
    applyStandardFit,
    applyClipPlanes,
    invalidate,
  ])

  /*
   * Home 复位（SPEC §12.4）：重新执行标准 3/4 fit + 清除 hasUserNavigated。
   * 监听 window keydown 的 Home 键；完整的键盘导航（方向键 / +/- / Q/E）与外层可聚焦容器属
   * SPEC §12.5 后续 TASK，本任务只交付 Home 复位这一 §12.4 能力。applyStandardFit 身份稳定，
   * 监听注册一次，cleanup 解除，成对可重复。
   */
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Home') return
      event.preventDefault()
      const home = decideHomeReset()
      hasUserNavigatedRef.current = home.flag
      const current = sizeRef.current
      const aspect = current.height > 0 ? current.width / current.height : 0
      applyStandardFit(aspect)
    }
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('keydown', onKey)
    }
  }, [applyStandardFit])

  // 本组件不渲染可见对象，只副作用装配相机浏览。
  return null
}
