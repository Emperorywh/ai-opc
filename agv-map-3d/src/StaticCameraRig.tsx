/*
 * 静态相机装配（app-root 层，SPEC 12.2 / 12.3 / 13 / 任务约束）。
 *
 * 定位（TASK-018）：
 *   - 本组件是 Canvas 内的静态相机装配点：消费 TASK-017 的 computeCameraFit / computeClipPlanes
 *     把唯一内容范围 + 有限地面范围 + 当前画布尺寸推导为相机位置 / 朝向 / 裁剪面，写入 R3F 相机。
 *   - 相机控制器（OrbitControls / 键盘 / target clamp）属于后续 TASK；本任务只交付标准 3/4 静态视角，
 *     不注册 useFrame、不维护用户浏览状态、不创建 controls 对象（任务“只交付静态实体场景”）。
 *
 * 分层约束（SPEC 3.3）：
 *   - scene 层禁止依赖 camera；camera 层禁止依赖 react / r3f。只有 app-root 可同时消费相机数学与 R3F，
 *     故相机装配唯一归本 app-root 组件，不向 scene 层泄漏相机依赖。
 *
 * fit 球心与裁剪面不变量（SPEC 12.2 / 12.3 / 任务约束）：
 *   - fit 以 controls target 为球心（Y=0），先定 3/4 方向再算距离；地面不参与 fit。
 *   - near / far 由 camera-space clipBounds 与拟合半径推导，不使用任意大常量；无效输入保持未提交。
 *   - 首次非零尺寸 fit；之后每次 resize 重新 fit（无用户浏览状态时 resize 重 fit，SPEC 12.4）。
 *
 * 按需渲染不变量（SPEC 13 / 任务约束）：
 *   - demand 帧模式下，fit / resize 后显式 invalidate 请求一次渲染；不切换为常驻帧循环。
 *   - 零尺寸画布（aspect ≤ 0）时 computeCameraFit 返回 null，保持未提交、不 invalidate、不产生 NaN。
 *
 * 依赖方向（SPEC 3.3）：app-root 允许 camera / r3f / three / domain / config。
 */
import { useLayoutEffect } from 'react'
import { useThree } from '@react-three/fiber'
import { PerspectiveCamera } from 'three'
import type { NumericBox3 } from './domain/sceneMap'
import { computeCameraFit, PERSPECTIVE_FOV_DEG } from './camera/cameraFit'
import { computeClipPlanes, MIN_NEAR_METERS } from './camera/clipPlanes'

/*
 * 静态相机装配入参。
 *   - contentBounds：SceneModel 的唯一数值内容范围（排除标签与地面）。
 *   - groundBounds：TASK-017 computeGroundBounds 交付的有限地面范围（参与裁剪面推导，不参与 fit）。
 */
export interface StaticCameraRigProps {
  readonly contentBounds: NumericBox3
  readonly groundBounds: NumericBox3
}

/*
 * 静态相机装配主组件：fit + 裁剪面推导 + 写入 R3F 相机 + invalidate。
 *
 * 依赖项：contentBounds / groundBounds（场景加载后固定）与 size（resize 变化）。
 * 任一变化重新 fit；TASK-018 无用户浏览状态，resize 即重 fit（SPEC 12.4 hasUserNavigated=false）。
 */
export function StaticCameraRig({
  contentBounds,
  groundBounds,
}: StaticCameraRigProps): null {
  // 选择性订阅 camera / size / invalidate，避免无关 R3F 状态变更触发重渲染。
  const camera = useThree((s) => s.camera)
  const size = useThree((s) => s.size)
  const invalidate = useThree((s) => s.invalidate)

  useLayoutEffect(() => {
    // 使用 useLayoutEffect 而非 useEffect：demand 帧模式下，layout effect 在浏览器绘制前同步写入
    // 3/4 fit 结果，避免 loading→ready 切换瞬间先用 Canvas 默认相机提交一帧再“弹”到标准视角。
    // 零尺寸画布：aspect ≤ 0，computeCameraFit 返回 null，保持未提交（SPEC 12.2 / 任务异常路径）。
    const aspect = size.height > 0 ? size.width / size.height : 0
    const fit = computeCameraFit(contentBounds, aspect)
    if (fit === null) {
      return
    }
    // 动态裁剪面：clipBounds = expanded content bounds ∪ ground bounds（SPEC 12.3）。
    const clip = computeClipPlanes(
      fit.expandedBounds,
      groundBounds,
      fit.position,
      fit.target,
      fit.radius,
    )
    // 写入相机位置与朝向：标准 3/4 视角，lookAt fit 球心（Y=0）。
    camera.position.set(fit.position.x, fit.position.y, fit.position.z)
    camera.lookAt(fit.target.x, fit.target.y, fit.target.z)
    if (camera instanceof PerspectiveCamera) {
      camera.fov = PERSPECTIVE_FOV_DEG
      camera.aspect = aspect
      // 裁剪面无效（理论不可达，contentBounds / groundBounds 已校验）时回落到 near 下限与 far 余量。
      camera.near = clip !== null ? clip.near : MIN_NEAR_METERS
      camera.far = clip !== null ? clip.far : fit.distance + fit.radius * 4
      camera.updateProjectionMatrix()
    }
    // demand 帧模式：fit / resize 后显式请求一次渲染（SPEC 13 / 任务“资源首次提交和有效 resize 显式请求渲染”）。
    invalidate()
  }, [contentBounds, groundBounds, size.width, size.height, camera, invalidate])

  // 本组件不渲染可见对象，只副作用装配相机。
  return null
}
