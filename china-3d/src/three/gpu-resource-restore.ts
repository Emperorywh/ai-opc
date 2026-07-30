/**
 * GPU 资源恢复遍历（渲染层，TASK-015，SPEC §7.4）。
 *
 * 角色与依赖方向：
 * - 本模块属于渲染层（src/three），只负责「在 WebGL context 恢复后，遍历场景把所有纹理 / 材质标记为
 *   needsUpdate=true，使 Three.js 在下一帧重新上传 GPU 资源（纹理像元 / 着色器编译）」。它**只**依赖
 *   three.js（Scene / Material / Texture / ShaderMaterial 类型与 instanceof 判别），不依赖 React / R3F / DOM。
 * - 本模块**不**接触 CPU 领域数据（heightmap 像素 Uint16Array / GeoJSON / 字体）——GPU 资源恢复只对
 *   「纹理对象」打 needsUpdate 标记，纹理对象的 .image / .data 字段（CPU 源数据）由 App 根部的资产 hook
 *   在挂载期一次性加载、跨 context 丢失 / 恢复保持同一引用，Three.js 据此 .data 重新上传 GPU——绝不在
 *   本模块重新 fetch / 重新解码（GPU 资源恢复与 CPU 领域数据生命周期分离，不得因 context 丢失重复解码
 *   32MB 高程数组或重复下载资产）。
 *
 * 为什么 needsUpdate=true 足以恢复（Three.js GPU 资源生命周期）：
 * - context 丢失时，浏览器回收所有 GPU 资源（纹理 / buffer / 着色器）。Three.js 在 WebGLRenderer 内部
 *   把每个纹理的初始化标记（properties.get(texture).__webglInit）保留为「已初始化」的旧值——但底层 GPU
 *   对象已失效。对纹理置 needsUpdate=true 会令 Three.js 在下次上传时重新走 initTexture 路径，重新分配 GPU
 *   纹理并从 .data（CPU 源）重新上传——这是「复用 CPU 数据、只重建 GPU 表示」的标准 Three.js 恢复路径。
 * - 材质置 needsUpdate=true 令 Three.js 重新编译着色器程序（context 丢失后 GLSL 程序也被回收）。
 * - 几何 buffer：Three.js 在 context 丢失后会重建 attribute buffer（它内部追踪 buffer 版本），无需应用手动
 *   标记——本模块只处理纹理与材质。
 *
 * 通用遍历（不要求组件注册）：
 * - 本模块对场景做一次 traverse，对每个 Mesh 的 material（含数组材质）调用 restoreMaterialGpuResources。
 *   它既覆盖标准材质（map / normalMap 等内置纹理槽），也覆盖 ShaderMaterial（uniforms.*.value 为 Texture 的
 *   槽，如本项目的 uHeightmap / uElevationRamp / uTime 等）。组件无需向某注册表登记纹理——避免注册 / 注销
 *   的生命周期耦合与重复所有权（不存在重复资源所有权）。
 *
 * 可测试性（重复 context 丢失 / 恢复时 GPU 资源所有权数量稳定）：
 * - restoreMaterialGpuResources 是纯副作用函数（对传入材质置标记），可在 Node 环境用真实 Three.js 材质 /
 *   纹理对象（构造不需 WebGL）构造一个含 ShaderMaterial + DataTexture 的最小场景，断言遍历后全部纹理与
 *   材质的 needsUpdate=true、且函数不抛错、不重新分配 CPU 源数据。
 */

import * as THREE from 'three'

/**
 * 把单个材质（或数组材质）的全部 GPU 资源标记为待重建。
 *
 * 覆盖两类材质：
 * - 标准材质（MeshStandardMaterial 等）：内置纹理槽 map / normalMap / roughnessMap / metalnessMap /
 *   emissiveMap / aoMap / bumpMap / displacementMap / alphaMap / envMap。
 * - ShaderMaterial / RawShaderMaterial：uniforms 中 value 为 Texture 的全部槽（如本项目的 uHeightmap、
 *   uElevationRamp）。
 *
 * 同时把 material.needsUpdate=true，令 Three.js 重新编译着色器程序。对已经是 needsUpdate=true 的材质 /
 * 纹理重复置位是幂等的（boolean 赋值，无副作用），故 context 多次丢失 / 恢复下重复调用安全。
 */
export function restoreMaterialGpuResources(material: THREE.Material | THREE.Material[]): void {
  const materials = Array.isArray(material) ? material : [material]
  for (const mat of materials) {
    if (mat === null || mat === undefined) continue
    // 标准材质内置纹理槽（存在则标记）。
    const slots = readStandardTextureSlots(mat)
    for (const tex of slots) {
      if (tex instanceof THREE.Texture) {
        tex.needsUpdate = true
      }
    }
    // ShaderMaterial uniforms 中的纹理槽（本项目 heightmap / ramp 走此路径）。
    const uniforms = readShaderUniforms(mat)
    if (uniforms !== null) {
      for (const key of Object.keys(uniforms)) {
        const entry = uniforms[key]
        if (entry !== null && entry !== undefined) {
          const value = (entry as { value: unknown }).value
          if (value instanceof THREE.Texture) {
            value.needsUpdate = true
          }
        }
      }
    }
    // 重新编译着色器程序（context 丢失后 GLSL 程序被回收）。
    mat.needsUpdate = true
  }
}

/**
 * 遍历场景，对每个 Mesh 的 material 调用 restoreMaterialGpuResources。
 *
 * 单次 traverse、幂等。不创建 / 不销毁任何对象——只对既有纹理 / 材质置标记。在 context 恢复后由
 * RuntimeLifecycleController 调用一次（restoring 阶段），使下一帧重新上传全部 GPU 资源。
 */
export function restoreSceneGpuResources(scene: THREE.Scene): void {
  scene.traverse((obj) => {
    const mesh = obj as THREE.Mesh
    const material = mesh.material
    if (material === null || material === undefined) return
    restoreMaterialGpuResources(material)
  })
}

/**
 * 读取标准材质的内置纹理槽（类型安全的窄读）。
 *
 * 以数组收集非空槽，供调用方 instanceof 判别。不在本函数内置位 needsUpdate——保持「读取」与「置位」
 * 职责分离，使 restoreMaterialGpuResources 的置位路径单一可审。
 */
function readStandardTextureSlots(mat: THREE.Material): readonly unknown[] {
  // 以 unknown 读再交调用方 instanceof 判别，避免给 Material 类型塞不存在的字段。
  const m = mat as unknown as Record<string, unknown>
  const keys = [
    'map',
    'normalMap',
    'roughnessMap',
    'metalnessMap',
    'emissiveMap',
    'aoMap',
    'bumpMap',
    'displacementMap',
    'alphaMap',
    'envMap',
  ]
  const out: unknown[] = []
  for (const k of keys) {
    const v = m[k]
    if (v !== null && v !== undefined) {
      out.push(v)
    }
  }
  return out
}

/**
 * 读取 ShaderMaterial 的 uniforms（若该材质不是 ShaderMaterial 则返回 null）。
 *
 * 用 'uniforms' in 判别而非 instanceof ShaderMaterial——RawShaderMaterial 也带 uniforms，且避免与
 * three.js 内部模块解析耦合。读取后交调用方遍历 value 为 Texture 的槽。
 */
function readShaderUniforms(mat: THREE.Material): Record<string, unknown> | null {
  if (!('uniforms' in mat)) return null
  const uniforms = (mat as { uniforms?: unknown }).uniforms
  if (uniforms === null || uniforms === undefined || typeof uniforms !== 'object') {
    return null
  }
  return uniforms as Record<string, unknown>
}
