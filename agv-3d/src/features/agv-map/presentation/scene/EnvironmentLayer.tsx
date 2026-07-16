import { useEffect, useLayoutEffect, useMemo, useRef } from 'react'
import { Object3D, PlaneGeometry } from 'three'
import type { DirectionalLight } from 'three'
import {
  GRID_COARSE_MULTIPLIER,
  GRID_FINE_CELL_M,
  SHADOW_BIAS,
  SHADOW_NORMAL_BIAS,
} from '../../config/environmentConfig'
import { SHADOW_MAP_SIZE_PIXELS } from '../../config/performanceConfig'
import { ENVIRONMENT_THEME } from '../../config/visualTheme'
import type { Bounds3Data } from '../../domain/renderPacket'
import { hslToCss } from './colorConvert'
import { computeEnvironmentLayout } from './environmentLayout'
import {
  createGridMaterial,
  GRID_UNIFORMS,
} from './gridShader'
import { LocalEnvironment } from './LocalEnvironment'
import { PlaneReflectionGround } from './PlaneReflectionGround'

/**
 * 深色沙盘环境图层（SPEC §8.1 EnvironmentLayer、§8.3、§8.4，TASK-012 / TASK-013）。
 *
 * 职责：由 renderBounds 推导并呈现统一的深色沙盘环境——背景、线性雾、本地程序化 PMREM 环境光照、
 * 一个带阴影的方向光与一个低强度环境光、真实平面反射地面、独立径向衰减网格。所有空间范围由
 * computeEnvironmentLayout 从 renderBounds + 统一环境边距推导，不写死 V76 世界坐标（SPEC §6.3）。
 *
 * 图层边界（SPEC §8.1、TASK-012/013 实现约束）：
 * - 不查询或修改 PathLayer / NodeLayer / CameraRig / PostEffects 内部 Three.js 对象；本图层只
 *   通过 scene 级公共属性（background、fog、environment）与场景对象贡献环境。
 * - 单一灯光配置：仅一个带阴影的方向光与一个低强度补光环境光，参数全部来自 ENVIRONMENT_THEME，
 *   不在组件内散落色值/光强（§8.2、§12）。
 * - 仅节点投射阴影：地面 receiveShadow、网格与路径不投射/不接收；本图层仅在方向光（光源侧）
 *   启用阴影投射，不在地面/网格 mesh 上开启投射（SPEC §8.3、§11.1）。
 * - 唯一地面：地面反射职责唯一归于 PlaneReflectionGround（TASK-013）；网格保持独立图层，不复制
 *   地面、不交叉修改反射材质内部对象（§8.1、TASK-013 实现约束）。
 *
 * 资源生命周期（SPEC §5.4、§11.3）：
 * - 网格 geometry 与 material 各构建一次（useMemo），经 primitive 挂接、关闭 R3F 自动释放，
 *   由卸载 effect 统一 dispose；反射地面（含反射/模糊 RenderTarget 与 BlurPass）与 PMREM 分别
 *   由 PlaneReflectionGround / LocalEnvironment 自持显式释放。
 * - 方向光 target 为独立 Object3D，随本图层卸载一并从场景移除。
 *
 * 输入范围（renderBounds）变化时，layout 重算并同步更新所有环境范围，无硬编码裁切
 * （TASK-012 异常路径：改变渲染边界尺寸与中心）。
 */

/** 网格离地高度，单位米。略高于地面 y=0 避免与地面 z-fighting，远低于扁带 0.015 m（§7.4）。 */
const GRID_HEIGHT_M = 0.002

export interface EnvironmentLayerProps {
  /** 渲染边界（世界空间 AABB，来自 RenderPacket.renderBounds）。 */
  readonly bounds: Bounds3Data
}

/**
 * 渲染深色沙盘环境。不渲染拓扑（路径/节点由各自图层负责），只贡献环境与光照。
 */
export function EnvironmentLayer({ bounds }: EnvironmentLayerProps) {
  // 环境空间布局：相同 bounds 产生相同布局，bounds 变化时重算（§6.3 由 renderBounds 推导）。
  const layout = useMemo(() => computeEnvironmentLayout(bounds), [bounds])

  // 反射地面由 PlaneReflectionGround 自持资源生命周期（geometry/material/反射会话），此处不重复
  // 创建地面几何或材质（TASK-013：地面反射职责唯一归于 PlaneReflectionGround）。
  const coarseCellM = GRID_FINE_CELL_M * GRID_COARSE_MULTIPLIER
  const gridGeometry = useMemo(
    () => new PlaneGeometry(layout.gridWidthM, layout.gridDepthM),
    [layout.gridWidthM, layout.gridDepthM],
  )
  const gridMaterial = useMemo(
    () => createGridMaterial(ENVIRONMENT_THEME.grid, GRID_FINE_CELL_M, coarseCellM),
    [coarseCellM],
  )

  // 方向光目标：独立 Object3D，置于边界中心地面投影；赋给 light.target 使光指向中心。
  const lightTarget = useMemo(() => new Object3D(), [])
  const lightRef = useRef<DirectionalLight>(null)

  // bounds 变化时同步方向光目标、阴影正交范围与网格径向衰减中心/半径。
  // 阴影相机 left/right/top/bottom/near/far 改变后必须显式 updateProjectionMatrix：
  // R3F 的 shadow-camera-* 属性只赋值不触发投影矩阵重算（见 applyProps），不调用会使阴影
  // 使用默认 10 m 正交范围而非 environmentBounds 推导的范围（SPEC §8.3 阴影覆盖完整节点足迹）。
  useLayoutEffect(() => {
    lightTarget.position.set(
      layout.lightTarget[0],
      layout.lightTarget[1],
      layout.lightTarget[2],
    )
    const light = lightRef.current
    if (light !== null) {
      light.target = lightTarget
      const cam = light.shadow.camera
      cam.left = -layout.shadowExtentM
      cam.right = layout.shadowExtentM
      cam.top = layout.shadowExtentM
      cam.bottom = -layout.shadowExtentM
      cam.near = layout.shadowCameraNearM
      cam.far = layout.shadowCameraFarM
      cam.updateProjectionMatrix()
    }
    const u = gridMaterial.uniforms
    ;(u[GRID_UNIFORMS.center].value as [number, number])[0] = layout.center[0]
    ;(u[GRID_UNIFORMS.center].value as [number, number])[1] = layout.center[1]
    u[GRID_UNIFORMS.fadeInner].value = layout.gridFadeInnerM
    u[GRID_UNIFORMS.fadeOuter].value = layout.gridFadeOuterM
  }, [layout, lightTarget, gridMaterial])

  // 网格 geometry 与 material 确定性释放（SPEC §5.4）。反射地面资源由 PlaneReflectionGround 自行释放。
  useEffect(() => {
    return () => {
      gridGeometry.dispose()
      gridMaterial.dispose()
    }
  }, [gridGeometry, gridMaterial])

  return (
    <>
      {/* SPEC §8.2 背景 #05080F。R3F 卸载时自动恢复 scene.background。 */}
      <color attach="background" args={[ENVIRONMENT_THEME.backgroundHex]} />
      {/* SPEC §8.4 线性 Fog：雾色与背景一致，近远由 renderBounds 推导（§6.3）。 */}
      <fog attach="fog" args={[ENVIRONMENT_THEME.fogHex, layout.fogNearM, layout.fogFarM]} />
      {/* SPEC §8.3 本地程序化 PMREM 环境光照（不请求远程 HDR）。 */}
      <LocalEnvironment />
      {/* SPEC §8.3 低强度环境光补底；颜色与光强来自主题。 */}
      <ambientLight
        color={hslToCss(ENVIRONMENT_THEME.ambientLight.color)}
        intensity={ENVIRONMENT_THEME.ambientLight.intensity}
      />
      {/* SPEC §8.3 一个带阴影的方向光；目标与阴影正交范围由 useLayoutEffect 按 renderBounds 写入。 */}
      <directionalLight
        ref={lightRef}
        color={hslToCss(ENVIRONMENT_THEME.directionalLight.color)}
        intensity={ENVIRONMENT_THEME.directionalLight.intensity}
        position={[
          layout.lightPosition[0],
          layout.lightPosition[1],
          layout.lightPosition[2],
        ]}
        castShadow
        shadow-mapSize-width={SHADOW_MAP_SIZE_PIXELS}
        shadow-mapSize-height={SHADOW_MAP_SIZE_PIXELS}
        shadow-bias={SHADOW_BIAS}
        shadow-normalBias={SHADOW_NORMAL_BIAS}
      />
      <primitive object={lightTarget} />
      {/*
        SPEC §8.4 真实平面反射地面（TASK-013）：唯一承担地面反射职责的平面，由 renderBounds +
        统一环境边距推导尺寸与位置，反射目标固定 1024×1024 并带一次粗糙模糊；接收节点阴影，不投射。
        网格为独立图层（见下方），不复制地面、不交叉修改反射材质内部对象（TASK-013 实现约束）。
      */}
      <PlaneReflectionGround layout={layout} />
      {/* SPEC §8.4 独立网格图层：径向衰减，不投射/不接收阴影，半透明不写深度。 */}
      <mesh
        position={[layout.center[0], GRID_HEIGHT_M, layout.center[1]]}
        rotation-x={-Math.PI / 2}
      >
        <primitive object={gridGeometry} attach="geometry" dispose={null} />
        <primitive object={gridMaterial} attach="material" dispose={null} />
      </mesh>
    </>
  )
}
