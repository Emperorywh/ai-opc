import { BlurPass } from '@react-three/drei/materials/BlurPass'
import {
  DepthFormat,
  DepthTexture,
  HalfFloatType,
  LinearFilter,
  Matrix4,
  PerspectiveCamera,
  Plane,
  UnsignedShortType,
  Vector3,
  Vector4,
  WebGLRenderTarget,
  type Mesh,
  type Scene,
  type WebGLRenderer,
} from 'three'

/**
 * 平面反射资源会话（SPEC §8.4 真实平面反射、§5.4 显式释放、§11.1 固定预算，TASK-013）。
 *
 * 职责：把平面反射所需的 GPU 资源——反射颜色/深度 RenderTarget、模糊输出 RenderTarget 与
 * drei BlurPass——收拢为单一会话对象，并实现标准的"镜像虚相机 + 斜投影裁剪"平面反射渲染
 * （与 drei <MeshReflectorMaterial> 组件同源技术）。会话固定持有 1024×1024 的反射目标
 * （REFLECTION_TARGET_SIZE_PIXELS），每帧把场景从镜像虚相机渲染进反射 RenderTarget，经一次
 * 粗糙模糊写入模糊 RenderTarget，供 drei MeshReflectorMaterial 的反射着色器采样。
 *
 * 为什么自持资源而非使用 drei <MeshReflectorMaterial> React 组件：
 * - SPEC §5.4 要求"正常卸载时必须显式释放……反射 RenderTarget"，§11.3 要求卸载后 GPU 资源
 *   回到基线、StrictMode 重复挂载不得泄漏。drei <MeshReflectorMaterial> 组件在 useMemo 中创建
 *   反射 RenderTarget 与 BlurPass，但组件卸载时未对其调用 dispose（drei 已知限制），StrictMode
 *   重复挂载会持续累积 RenderTarget。本会话与 bakeLocalPmremSession 同构——自持资源、显式
 *   dispose，使释放路径可在 Node 环境用真实 RenderTarget 实例的 dispose 事件自动化验证
 *   （SPEC §5.4、TASK-013 输出"覆盖释放行为的自动化验证"）。
 * - 反射着色器仍来自 drei 的 MeshReflectorMaterial 类（onBeforeCompile 注入反射采样），BlurPass
 *   同样来自 drei；本会话只接管 drei 组件缺失的 FBO 生命周期，不发明替代反射管线
 *   （TASK-013 实现约束：单一平面反射方案，不用普通材质高光/环境贴图/屏幕截图 fallback）。
 *
 * 不变量：
 * - 固定预算：反射颜色/深度/模糊 RenderTarget 宽高恒为 resolution；不读取主画布 DPR、CSS 尺寸
 *   或相机姿态，resize 不重建会话（SPEC §11.1、TASK-013 resize 不变性）。
 * - 零逐帧分配：镜像反射所需的 Plane/Vector3/Vector4/Matrix4/PerspectiveCamera 等临时对象在会话
 *   内创建一次并复用，renderReflection 每帧只更新其分量（SPEC §11.1 不产生逐帧临时对象）。
 * - 确定性释放：dispose 释放反射 RenderTarget、深度纹理、模糊 RenderTarget 与 BlurPass 内部的
 *   两张中间 RenderTarget、卷积材质及其全屏三角 BufferGeometry（BlurPass 自身无 dispose，由本
 *   会话逐一释放，SPEC §5.4"必须显式释放 Geometry"）；幂等。
 *
 * 该模块位于展示层（创建 Three.js GPU 资源），不属 domain/geometry 纯数据层（SPEC §5.1）。
 */

/** 反射会话构造参数（resolution 属性能预算，blur 属视觉参数，均由调用方从集中配置汇集）。 */
export interface ReflectionSessionOptions {
  /** WebGLRenderer，供 BlurPass 构造（drei BlurPass 形参，构造期未实际使用 GL 上下文）。 */
  readonly gl: WebGLRenderer
  /** 反射 RenderTarget 分辨率，单位像素（取自 REFLECTION_TARGET_SIZE_PIXELS，固定 1024）。 */
  readonly resolution: number
  /** 一次粗糙模糊的水平扩散（取自 ReflectionTheme.blurWidth）。 */
  readonly blurWidth: number
  /** 一次粗糙模糊的垂直扩散（取自 ReflectionTheme.blurHeight）。 */
  readonly blurHeight: number
}

/** renderReflection 的单帧渲染入参。 */
export interface RenderReflectionParams {
  readonly renderer: WebGLRenderer
  readonly scene: Scene
  /** 主相机（R3F 主透视相机），虚相机继承其投影与远面。平面反射依赖透视投影。 */
  readonly camera: PerspectiveCamera
  /** 承载反射材质的地面 mesh：取其 matrixWorld 推导反射平面，渲染期临时隐藏避免自反射。 */
  readonly reflectorMesh: Mesh
  /** 反射平面沿法线偏移，单位米（默认 0，平面贴地 y=0）。 */
  readonly reflectorOffset: number
}

/** 反射会话句柄：持有固定预算的反射/模糊 RenderTarget 并提供显式释放（SPEC §5.4）。 */
export interface ReflectionSession {
  /** 反射颜色 RenderTarget（含深度纹理），材质 tDiffuse/tDepth 采样源。固定 resolution×resolution。 */
  readonly reflectTarget: WebGLRenderTarget
  /** 模糊输出 RenderTarget，材质 tDiffuseBlur 采样源。固定 resolution×resolution。 */
  readonly blurTarget: WebGLRenderTarget
  /** 镜像投影纹理矩阵（每帧原地更新）；材质 textureMatrix uniform 引用此对象。 */
  readonly textureMatrix: Matrix4
  /**
   * 渲染一帧反射：把场景从镜像虚相机以斜投影渲染进 reflectTarget，经一次粗糙模糊写入 blurTarget，
   * 并把镜像投影纹理矩阵写回 material.textureMatrix（原地更新，材质 uniform 自动跟随）。
   */
  renderReflection(params: RenderReflectionParams): void
  /** 释放反射/模糊 RenderTarget、深度纹理与 BlurPass 内部资源；幂等（SPEC §5.4）。 */
  dispose(): void
}

/**
 * 创建平面反射资源会话（SPEC §8.4、§11.1，TASK-013）。
 *
 * 资源布局（固定 1024×1024 预算，HalfFloat 兼顾倒影动态范围与显存）：
 * - reflectTarget：反射颜色 RenderTarget，附带 UnsignedShort 深度纹理（深度纹理为深度相关模糊
 *   预留，本期 depthScale=0 不启用，仅保持与 drei 同构以便后续按需开启而不改资源结构）。
 * - blurTarget：模糊输出 RenderTarget，承接 BlurPass 最终模糊结果。
 * - blurPass：drei BlurPass（内部两张中间 RenderTarget + 卷积材质），完成"一次粗糙模糊"。
 *
 * @param options 构造参数（gl、固定分辨率、模糊扩散）。
 */
export function createReflectionSession(options: ReflectionSessionOptions): ReflectionSession {
  const { gl, resolution, blurWidth, blurHeight } = options

  // 反射 RenderTarget：HalfFloat 扩展动态范围，LinearFilter 避免镜像边缘锯齿。
  const reflectTarget = new WebGLRenderTarget(resolution, resolution, {
    minFilter: LinearFilter,
    magFilter: LinearFilter,
    type: HalfFloatType,
  })
  // 深度缓冲与深度纹理：斜投影反射需要深度缓冲正确剔除；深度纹理与 drei 同构预留。
  reflectTarget.depthBuffer = true
  reflectTarget.depthTexture = new DepthTexture(resolution, resolution)
  reflectTarget.depthTexture.format = DepthFormat
  reflectTarget.depthTexture.type = UnsignedShortType

  // 模糊输出 RenderTarget：承接 BlurPass 最终一帧模糊结果，供材质 tDiffuseBlur 采样。
  const blurTarget = new WebGLRenderTarget(resolution, resolution, {
    minFilter: LinearFilter,
    magFilter: LinearFilter,
    type: HalfFloatType,
  })

  // drei BlurPass：对反射 RenderTarget 做多次可分离高斯卷积，输出到 blurTarget（一次粗糙模糊）。
  // BlurPass 形参含 gl 但构造期未使用；resolution 决定其内部中间 RenderTarget 尺寸（同固定预算）。
  const blurPass = new BlurPass({
    gl,
    resolution,
    width: blurWidth,
    height: blurHeight,
  })

  // 镜像反射临时对象：会话内创建一次，renderReflection 每帧复用、只更新分量（SPEC §11.1）。
  const tmp = {
    reflectorPlane: new Plane(),
    normal: new Vector3(),
    reflectorWorldPosition: new Vector3(),
    cameraWorldPosition: new Vector3(),
    rotationMatrix: new Matrix4(),
    lookAtPosition: new Vector3(0, 0, -1),
    clipPlane: new Vector4(),
    view: new Vector3(),
    target: new Vector3(),
    q: new Vector4(),
    textureMatrix: new Matrix4(),
  }
  // 镜像虚相机：每帧拷贝主相机投影并施加斜裁剪；自身位置/朝向由镜像推导。不复用主相机实例。
  const virtualCamera = new PerspectiveCamera()

  /**
   * 渲染一帧平面反射（标准"镜像虚相机 + 斜投影"技术，与 drei MeshReflectorMaterial 同源）。
   *
   * 步骤（参考 terathon 斜投影与 Lengyel 论文，drei 组件同实现）：
   * 1. 由 reflectorMesh.matrixWorld 取反射平面世界位置，以其世界旋转把本地 +Z 法线变到世界
   *    （地面 mesh 旋转 −90° 绕 X，本地 +Z → 世界 +Y，即地面法线朝上）。
   * 2. 镜像主相机：把主相机位置与视线目标相对反射平面镜像，得到位于地面以下的虚相机位置与
   *    lookAt 目标；虚相机 up 随主相机旋转并镜像。若反射平面背向相机（view·normal>0）直接跳过。
   * 3. 虚相机投影拷贝主相机投影；textureMatrix = 偏移矩阵 × 虚相机投影 × 虚相机逆世界 × 地面
   *    世界矩阵，把反射 RenderTarget 的采样坐标映射到地面顶点（材质 textureMatrix uniform）。
   * 4. 斜投影裁剪：以反射平面在虚相机空间的平面方程改写投影矩阵第三行，使反射 RenderTarget
   *    只包含地面以上的场景（避免地面下方物体出现在倒影中）。
   * 5. 临时隐藏反射地面 mesh（避免地面反射自身），关闭 WebXR 与阴影自动更新（复用本帧阴影贴图），
   *    把场景以虚相机渲染进 reflectTarget，BlurPass 模糊到 blurTarget，恢复可见性与渲染状态。
   */
  const renderReflection = (params: RenderReflectionParams): void => {
    const { renderer, scene, camera, reflectorMesh, reflectorOffset } = params

    // 1. 反射平面世界位置与法线。
    tmp.reflectorWorldPosition.setFromMatrixPosition(reflectorMesh.matrixWorld)
    tmp.cameraWorldPosition.setFromMatrixPosition(camera.matrixWorld)
    tmp.rotationMatrix.extractRotation(reflectorMesh.matrixWorld)
    tmp.normal.set(0, 0, 1).applyMatrix4(tmp.rotationMatrix)
    tmp.reflectorWorldPosition.addScaledVector(tmp.normal, reflectorOffset)

    // 背向剔除：反射平面背向相机时不渲染倒影（节省一次完整场景渲染）。
    tmp.view.subVectors(tmp.reflectorWorldPosition, tmp.cameraWorldPosition)
    if (tmp.view.dot(tmp.normal) > 0) return

    // 2. 镜像虚相机位置与 lookAt 目标。
    tmp.view.reflect(tmp.normal).negate()
    tmp.view.add(tmp.reflectorWorldPosition)
    tmp.rotationMatrix.extractRotation(camera.matrixWorld)
    tmp.lookAtPosition.set(0, 0, -1).applyMatrix4(tmp.rotationMatrix)
    tmp.lookAtPosition.add(tmp.cameraWorldPosition)
    tmp.target.subVectors(tmp.reflectorWorldPosition, tmp.lookAtPosition)
    tmp.target.reflect(tmp.normal).negate()
    tmp.target.add(tmp.reflectorWorldPosition)
    virtualCamera.position.copy(tmp.view)
    virtualCamera.up.set(0, 1, 0).applyMatrix4(tmp.rotationMatrix)
    virtualCamera.up.reflect(tmp.normal)
    virtualCamera.lookAt(tmp.target)
    virtualCamera.far = camera.far
    virtualCamera.updateMatrixWorld()
    virtualCamera.projectionMatrix.copy(camera.projectionMatrix)

    // 3. 镜像投影纹理矩阵（偏移 0.5 把裁剪空间 [−1,1] 映射到纹理 [0,1]）。材质 textureMatrix uniform
    //    在挂载时被指向 tmp.textureMatrix（同一对象引用），此处原地更新其元素即同步 uniform，无需每帧重设。
    tmp.textureMatrix.set(0.5, 0.0, 0.0, 0.5, 0.0, 0.5, 0.0, 0.5, 0.0, 0.0, 0.5, 0.5, 0.0, 0.0, 0.0, 1.0)
    tmp.textureMatrix.multiply(virtualCamera.projectionMatrix)
    tmp.textureMatrix.multiply(virtualCamera.matrixWorldInverse)
    tmp.textureMatrix.multiply(reflectorMesh.matrixWorld)

    // 4. 斜投影裁剪：以反射平面改写虚相机投影矩阵第三行（terathon 实现节，见会话顶部说明）。
    tmp.reflectorPlane.setFromNormalAndCoplanarPoint(tmp.normal, tmp.reflectorWorldPosition)
    tmp.reflectorPlane.applyMatrix4(virtualCamera.matrixWorldInverse)
    tmp.clipPlane.set(
      tmp.reflectorPlane.normal.x,
      tmp.reflectorPlane.normal.y,
      tmp.reflectorPlane.normal.z,
      tmp.reflectorPlane.constant,
    )
    const proj = virtualCamera.projectionMatrix.elements
    tmp.q.x = (Math.sign(tmp.clipPlane.x) + proj[8]) / proj[0]
    tmp.q.y = (Math.sign(tmp.clipPlane.y) + proj[9]) / proj[5]
    tmp.q.z = -1.0
    tmp.q.w = (1.0 + proj[10]) / proj[14]
    tmp.clipPlane.multiplyScalar(2.0 / tmp.clipPlane.dot(tmp.q))
    proj[2] = tmp.clipPlane.x
    proj[6] = tmp.clipPlane.y
    proj[10] = tmp.clipPlane.z + 1.0
    proj[14] = tmp.clipPlane.w

    // 5. 渲染反射：隐藏地面、关闭 WebXR/阴影自动更新，渲染进 reflectTarget 后模糊到 blurTarget。
    reflectorMesh.visible = false
    const prevXrEnabled = renderer.xr.enabled
    const prevShadowAutoUpdate = renderer.shadowMap.autoUpdate
    renderer.xr.enabled = false
    renderer.shadowMap.autoUpdate = false
    renderer.setRenderTarget(reflectTarget)
    renderer.state.buffers.depth.setMask(true)
    if (!renderer.autoClear) renderer.clear()
    renderer.render(scene, virtualCamera)
    blurPass.render(renderer, reflectTarget, blurTarget)
    renderer.xr.enabled = prevXrEnabled
    renderer.shadowMap.autoUpdate = prevShadowAutoUpdate
    reflectorMesh.visible = true
    renderer.setRenderTarget(null)
  }

  let disposed = false
  const dispose = (): void => {
    if (disposed) return
    disposed = true
    // 释放顺序：反射 RenderTarget 的深度纹理（WebGLRenderTarget.dispose 不自动释放其 depthTexture，
    // 须显式释放避免深度纹理泄漏）→ 反射/模糊 RenderTarget（含其颜色纹理）→ BlurPass 内部两张中间
    // RenderTarget、卷积材质及其全屏三角 BufferGeometry（BlurPass 自身无 dispose，逐一显式释放）。
    // screen.geometry 在 BlurPass 构造期创建、render 期上传 GPU（计入 renderer.info.memory.geometries），
    // 必须显式释放以使卸载后 geometry 计数归零（SPEC §5.4"必须显式释放 Geometry"、§11.3 卸载回基线）。
    reflectTarget.depthTexture?.dispose()
    reflectTarget.dispose()
    blurTarget.dispose()
    blurPass.renderTargetA.dispose()
    blurPass.renderTargetB.dispose()
    blurPass.convolutionMaterial.dispose()
    blurPass.screen.geometry?.dispose()
  }

  return {
    reflectTarget,
    blurTarget,
    textureMatrix: tmp.textureMatrix,
    renderReflection,
    dispose,
  }
}
