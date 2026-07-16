import { useEffect, useLayoutEffect, useMemo, useRef } from 'react'
import { useFrame, useThree } from '@react-three/fiber'
import { PlaneGeometry, type Mesh, type PerspectiveCamera } from 'three'
import { REFLECTION_TARGET_SIZE_PIXELS } from '../../config/performanceConfig'
import { ENVIRONMENT_THEME } from '../../config/visualTheme'
import type { EnvironmentLayout } from './environmentLayout'
import { createReflectionMaterial } from './reflectionMaterial'
import { createReflectionSession, type ReflectionSession } from './reflectionSession'

/**
 * 平面反射地面图层（SPEC §8.1 EnvironmentLayer 内地面、§8.4 真实平面反射，TASK-013）。
 *
 * 职责：在 EnvironmentLayer 的地面位置呈现唯一的深色不透明真实平面反射地面——由 renderBounds
 * + 统一环境边距推导的地面尺寸与位置，使用 drei MeshReflectorMaterial 反射着色器，反射目标固定
 * 1024×1024 并带一次粗糙模糊。节点与路径在地面形成粗糙倒影，而非普通低粗糙度材质的伪反射
 * （SPEC §8.4、TASK-013 实现约束）。
 *
 * 为什么独立组件而非内联于 EnvironmentLayer：
 * - 反射地面需要 useFrame 驱动每帧镜像渲染，且持有 RenderTarget 会话；抽成独立组件使
 *   EnvironmentLayer 聚焦于静态布局/光照，反射地面的资源生命周期自成闭环（SPEC §8.1 图层边界）。
 *
 * 资源生命周期与 StrictMode（SPEC §5.4、§11.3；R3F 把外层 StrictMode 桥接进 Canvas 子树）：
 * - 反射会话（含 disposed 守卫）在 useLayoutEffect 内创建与释放，与 LocalEnvironment/bakeLocalPmremSession
 *   同构：StrictMode 初始挂载执行 setup→cleanup→setup，每次 setup 得到全新未释放会话、其 cleanup
 *   释放当次会话；真实卸载的 cleanup 释放最后一个会话。若改在 useMemo 中创建并配守卫，StrictMode
 *   cleanup 先置 disposed、真实卸载 cleanup 被守卫跳过，会导致反射 RenderTarget 泄漏——故会话必须
 *   在 effect 内成对创建/释放。useLayoutEffect 在首帧 frameloop 之前同步完成创建与材质绑定，
 *   保证首帧即有反射纹理可采样（无空帧闪烁）。
 * - 地面几何与反射材质沿用 PathLayer 的 useMemo + 卸载 effect dispose 模式：three.js 的
 *   dispose 本身幂等（重复调用只重复派发事件，渲染器侧去分配亦幂等），StrictMode 下不泄漏。
 *
 * 其余不变量：
 * - 唯一地面：整个场景仅此一个承担地面反射职责的平面（SPEC §8.1、TASK-013）；网格保持独立图层，
 *   不复制地面、不交叉修改反射材质内部对象（TASK-013 实现约束）。
 * - 空间由 renderBounds 推导：地面宽深与中心取自 computeEnvironmentLayout（renderBounds + 统一
 *   环境边距），与网格、雾共享空间基准，不写死世界坐标（SPEC §6.3、TASK-013）。
 * - 固定预算且 resize 不变：反射会话 resolution 取 REFLECTION_TARGET_SIZE_PIXELS（1024），不绑定
 *   主画布 DPR/CSS 尺寸；会话仅在 gl 变化时重建，resize 不重建（SPEC §11.1、TASK-013）。
 * - 错误归集：会话/材质创建失败（GPU 资源创建错误）在渲染期抛出，经外层 SceneErrorBoundary
 *   进入统一 error 状态（WEBGL_RESOURCE_FAILED），不静默降级（SPEC §1、§10.2）。
 */

export interface PlaneReflectionGroundProps {
  /** 环境空间布局（由 renderBounds 推导，含地面尺寸与中心）。 */
  readonly layout: EnvironmentLayout
}

/**
 * 渲染唯一平面反射地面。
 *
 * 地面几何、反射材质各构建一次（useMemo，three.js dispose 幂等）；反射会话在 useLayoutEffect
 * 内创建并绑定到材质，卸载时由同一 effect 的 cleanup 释放（与 PMREM 会话同构，StrictMode 安全）。
 * 每帧 useFrame 经会话把场景以镜像虚相机渲染进反射 RenderTarget 并模糊；材质 textureMatrix 由
 * 会话原地更新。
 */
export function PlaneReflectionGround({ layout }: PlaneReflectionGroundProps) {
  const gl = useThree((state) => state.gl)
  const scene = useThree((state) => state.scene)
  // R3F 主相机为透视相机（Canvas camera prop 创建）；平面反射依赖透视投影，按此断言。
  const camera = useThree((state) => state.camera) as PerspectiveCamera
  const meshRef = useRef<Mesh>(null)
  // 反射会话由 layout effect 创建/释放；useFrame 经 ref 读取，会话未就绪（重挂瞬态）时跳过本帧。
  const sessionRef = useRef<ReflectionSession | null>(null)

  // 地面几何：宽深随 layout（renderBounds + 统一环境边距）推导，bounds 变化时重建（§6.3）。
  const geometry = useMemo(
    () => new PlaneGeometry(layout.groundWidthM, layout.groundDepthM),
    [layout.groundWidthM, layout.groundDepthM],
  )
  // 反射材质：地面基础色 + 反射参数，仅随主题构建一次。
  const material = useMemo(
    () => createReflectionMaterial(ENVIRONMENT_THEME.ground, ENVIRONMENT_THEME.reflection),
    [],
  )

  // 反射会话：固定 1024×1024 预算 + 一次粗糙模糊；在 layout effect 内创建/释放，StrictMode 安全。
  // 仅随 gl 重建，不随主画布 resize 变化（§11.1）。创建后绑定反射纹理与 textureMatrix 到材质。
  useLayoutEffect(() => {
    const session = createReflectionSession({
      gl,
      resolution: REFLECTION_TARGET_SIZE_PIXELS,
      blurWidth: ENVIRONMENT_THEME.reflection.blurWidth,
      blurHeight: ENVIRONMENT_THEME.reflection.blurHeight,
    })
    sessionRef.current = session
    material.tDiffuse = session.reflectTarget.texture
    material.tDepth = session.reflectTarget.depthTexture
    material.tDiffuseBlur = session.blurTarget.texture
    // textureMatrix 引用会话内部矩阵对象，renderReflection 每帧原地更新其元素，uniform 自动跟随。
    material.textureMatrix = session.textureMatrix
    material.hasBlur = true
    return () => {
      // cleanup 释放当次会话（反射/模糊 RenderTarget + BlurPass），并解除 ref（SPEC §5.4）。
      session.dispose()
      sessionRef.current = null
    }
  }, [gl, material])

  // 每帧渲染反射：把场景从镜像虚相机渲染进反射 RenderTarget 并做一次粗糙模糊（SPEC §8.4）。
  useFrame(() => {
    const session = sessionRef.current
    const mesh = meshRef.current
    if (session === null || mesh === null) return
    session.renderReflection({
      renderer: gl,
      scene,
      camera,
      reflectorMesh: mesh,
      reflectorOffset: 0,
    })
  })

  // 地面几何与反射材质确定性释放（SPEC §5.4）。反射会话由其 layout effect cleanup 自行释放。
  useEffect(() => {
    return () => {
      geometry.dispose()
      material.dispose()
    }
  }, [geometry, material])

  return (
    <mesh
      ref={meshRef}
      position={[layout.center[0], 0, layout.center[1]]}
      rotation-x={-Math.PI / 2}
      receiveShadow
    >
      <primitive object={geometry} attach="geometry" dispose={null} />
      <primitive object={material} attach="material" dispose={null} />
    </mesh>
  )
}
