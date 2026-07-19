/**
 * 受约束东南斜俯视轨道控制器（TASK-011）。
 *
 * 角色与依赖方向（清晰的相机 / 控制层边界，TASK-011 实现约束）：
 * - 本组件属于渲染层的交互子层（src/three），只负责「把纯计算契约（camera-constraints）装配到
 *   drei 的 OrbitControls」：约束数值（距离 / 极角 / target 边界）全部来自 MAP_CAMERA_CONSTRAINTS，
 *   默认机位来自 DEFAULT_CAMERA_POSE，target 钳制来自 clampTarget——本组件不复制任何约束常量，
 *   也不在组件内维护隐式相机状态（实现约束「相机约束不得散落魔法坐标」「没有隐式组件状态」）。
 * - 本组件依赖：drei OrbitControls（SPEC §10 确认的 OrbitControls 来源）、R3F useFrame / useThree、
 *   three（Vector3 读写）、本层 camera-constraints。**不**读取 GeoJSON / 行政区业务数据 / 地形资产，
 *   不做 click 下钻 / 飞焦 / tooltip（SPEC §4.2、实现约束「只有自由受限探索」）。
 *
 * 交互启停契约（TASK-011 实现约束「相机状态可被后续入场状态机统一启停」）：
 * - enabled 由父场景（ChinaMapScreen）受控传入，本组件不自持：后续入场状态机（TASK-013）在升起动画
 *   期间置 enabled=false 锁定相机，结束后置 true 释放——启停走显式 prop，而非组件内部猜测 DOM 状态。
 *   这让本 TASK 的受约束探索与后续入场编排可以「统一启停」，不存在第二套交互开关。
 *
 * 约束装配（距离 / 极角 / target 三道边界，SPEC §4.1、TASK-011 可验证结果）：
 * - 距离：minDistance / maxDistance 由 OrbitControls 内置强制（禁止无限拉近 / 拉远）。
 * - 极角：maxPolarAngle≈88° 由 OrbitControls 内置强制（禁止翻面 / 看到地底）。
 * - target 边界：OrbitControls 无内置 target 钳制，由本组件 useFrame 每帧调用 clampTarget 拉回
 *   地图包围盒（禁止把观察目标拖出版图）。钳制时同步平移相机（target 与 camera 按同一差量回拉），
 *   保持 camera→target 向量不变，视图「顶回」边界而非跳变，也不破坏距离 / 轨道约束。
 * - screenSpacePanning=false：平移始终在 y=target.y 的地表平面内，方向与地图方位一致
 *   （SPEC §4.1「禁用 screenSpacePanning 或以可证明不会造成方向错乱的方式配置」）。
 */

import { useEffect, useRef } from 'react'
import type { ElementRef, ReactNode } from 'react'
import { useFrame, useThree } from '@react-three/fiber'
import { OrbitControls } from '@react-three/drei'
import {
  DEFAULT_CAMERA_POSE,
  MAP_CAMERA_CONSTRAINTS,
  clampTarget,
} from './camera-constraints'

/**
 * drei OrbitControls 转发的实例类型（three-stdlib 的 OrbitControlsImpl）。
 *
 * 不直接 import 'three-stdlib' 的类型——它是 drei 的传递依赖，在 pnpm 严格 node_modules 布局下
 * 非本包直接依赖、不可从本源码解析。改用 React 的 ElementRef 从 OrbitControls 组件本身反推其实例
 * 类型，零新增依赖且与 drei 声明的 ref 类型完全一致。
 */
type OrbitControlsInstance = ElementRef<typeof OrbitControls>

export interface MapOrbitControlsProps {
  /**
   * 是否启用旋转 / 俯仰 / 缩放 / 平移交互。父场景受控传入（启停契约）：后续入场状态机在
   * 升起动画期间置 false 锁定相机，结束后置 true 释放。本组件不自持该状态——无隐式组件状态。
   */
  readonly enabled: boolean
}

/**
 * 装配受约束的东南斜俯视 OrbitControls。
 *
 * 挂载时把相机摆到 DEFAULT_CAMERA_POSE 并令其看向默认 target，随后由 OrbitControls 接管相机姿态。
 * 每帧把 target 钳回地图包围盒（target 与相机按同一差量回拉，保持 camera→target 向量不变）。
 */
export function MapOrbitControls({ enabled }: MapOrbitControlsProps): ReactNode {
  const controls = useRef<OrbitControlsInstance | null>(null)
  const camera = useThree((state) => state.camera)

  // 挂载时摆好默认东南斜俯视机位并看向默认 target；后续由 OrbitControls 接管，避免首帧相机朝向
  // R3F 默认方向（看向 -Z）产生的瞬时错位。OrbitControls 的 target prop 同步写入默认 target。
  useEffect(() => {
    const pose = DEFAULT_CAMERA_POSE
    camera.position.set(pose.position.x, pose.position.y, pose.position.z)
    camera.lookAt(pose.target.x, pose.target.y, pose.target.z)
    camera.updateProjectionMatrix()
  }, [camera])

  // 每帧把 target 钳回地图包围盒：OrbitControls 内置钳距离 / 极角，target 边界由本回调钳。
  // 平移会把 target 与相机一同推出；按钳制差量同时回拉二者，保持 camera→target 向量不变（视图「顶回」
  // 边界而非跳变），从而不破坏距离 / 轨道约束。clampTarget 幂等，target 已在界内时本帧零开销。
  useFrame(() => {
    const ctrl = controls.current
    if (ctrl === null) return
    const t = ctrl.target
    const clamped = clampTarget({ x: t.x, y: t.y, z: t.z })
    const dx = clamped.x - t.x
    const dy = clamped.y - t.y
    const dz = clamped.z - t.z
    if (dx !== 0 || dy !== 0 || dz !== 0) {
      t.set(clamped.x, clamped.y, clamped.z)
      camera.position.x += dx
      camera.position.y += dy
      camera.position.z += dz
    }
  })

  return (
    <OrbitControls
      ref={controls}
      makeDefault
      enabled={enabled}
      enableRotate
      enablePan
      enableZoom
      // 默认观察目标：主图世界中心在地表的点（由纯计算契约 DEFAULT_CAMERA_POSE 派生，非魔法坐标）。
      target={[DEFAULT_CAMERA_POSE.target.x, DEFAULT_CAMERA_POSE.target.y, DEFAULT_CAMERA_POSE.target.z]}
      // SPEC §4.1：距离钳制——禁止无限拉近 / 拉远。
      minDistance={MAP_CAMERA_CONSTRAINTS.minDistance}
      maxDistance={MAP_CAMERA_CONSTRAINTS.maxDistance}
      // SPEC §4.1：极角钳制——禁止翻到地图背面 / 看到地底（maxPolarAngle≈88°）。
      maxPolarAngle={MAP_CAMERA_CONSTRAINTS.maxPolarAngleRad}
      // SPEC §4.1：禁用屏幕空间平移，使平移始终在地表平面（y=target.y）内，避免方向错乱。
      screenSpacePanning={false}
      // 阻尼使受限探索手感顺滑；不影响约束不变量（每帧仍由 useFrame 钳 target，OrbitControls 钳距离/极角）。
      enableDamping
      dampingFactor={0.08}
    />
  )
}
