/**
 * GPU 资源恢复遍历测试（TASK-015，SPEC §7.4「恢复时重建」）。
 *
 * 依赖方向：测试基线（vitest，Node 环境），import src/three/gpu-resource-restore（纯遍历副作用函数）+
 * three（构造 Material / Texture / Mesh / Scene 对象，构造不需 WebGL——只有渲染才需）。可在 Node 内构造
 * 含 ShaderMaterial + DataTexture 的最小场景，断言遍历后全部纹理 / 材质被标记重建（version > 0）、函数不抛错、
 * 且 CPU 源数据（DataTexture.image.data）引用不变（不重新解码 / 重新下载），无需启动浏览器 / WebGL。
 *
 * 关于 needsUpdate 与 version（three 0.185）：Texture / Material 的 needsUpdate 是只写 setter（置 true → 内部
 * version++），读取返回 undefined。故本测试以 version > 0 作为「已被标记重建」的可观测信号——这与 Three.js
 * WebGLRenderer 上传纹理 / 编译着色器的实际判据一致（上传 / 编译检查 version，非 needsUpdate 的读取值）。
 */

import { describe, it, expect } from 'vitest'
import * as THREE from 'three'
import {
  restoreMaterialGpuResources,
  restoreSceneGpuResources,
} from '../src/three/gpu-resource-restore'

/**
 * 构造一份 DataTexture（模拟 heightmap / ramp 类数据纹理），CPU 源数据 = 给定 Uint8Array。
 *
 * DataTexture 在 Node 构造不需 WebGL——只分配 JS 对象。version 初值 0（未标记重建）。
 * three 0.185 的 DataTexture 把源数据存在 .image.data（非 .data）。
 */
function makeDataTexture(data: Uint8Array, width = 4, height = 1): THREE.DataTexture {
  const tex = new THREE.DataTexture(data, width, height, THREE.RGBAFormat, THREE.UnsignedByteType)
  expect(tex.version).toBe(0)
  return tex
}

/** 构造一份带 uniforms（含 Texture 槽 + 非纹理槽）的 ShaderMaterial，模拟地形 mesh 材质。 */
function makeTerrainLikeMaterial(heightmap: THREE.Texture, ramp: THREE.Texture): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: {
      uHeightmap: { value: heightmap },
      uElevationRamp: { value: ramp },
      uExaggeration: { value: 2.0 },
      uTime: { value: 0 },
    },
    vertexShader: 'void main(){}',
    fragmentShader: 'void main(){}',
  })
}

/** 「纹理 / 材质已被标记重建」的判据：version > 0（three 0.185 的实际上传 / 编译判据）。 */
function wasMarkedForUpdate(obj: { version: number }): boolean {
  return obj.version > 0
}

describe('restoreMaterialGpuResources：ShaderMaterial uniforms 中的纹理被标记重建', () => {
  it('地形类 ShaderMaterial：uHeightmap / uElevationRamp 被标记重建（version > 0）', () => {
    const heightmap = makeDataTexture(new Uint8Array(16))
    const ramp = makeDataTexture(new Uint8Array(4 * 256), 256, 1)
    const mat = makeTerrainLikeMaterial(heightmap, ramp)

    restoreMaterialGpuResources(mat)

    expect(wasMarkedForUpdate(heightmap)).toBe(true)
    expect(wasMarkedForUpdate(ramp)).toBe(true)
    expect(wasMarkedForUpdate(mat)).toBe(true)
  })

  it('非纹理 uniform（uExaggeration / uTime）不受影响（不报错、不改值）', () => {
    const heightmap = makeDataTexture(new Uint8Array(16))
    const mat = makeTerrainLikeMaterial(heightmap, makeDataTexture(new Uint8Array(4)))
    mat.uniforms.uExaggeration.value = 2.0
    mat.uniforms.uTime.value = 3.5

    expect(() => restoreMaterialGpuResources(mat)).not.toThrow()
    expect(mat.uniforms.uExaggeration.value).toBe(2.0)
    expect(mat.uniforms.uTime.value).toBe(3.5)
  })

  it('数组材质：每个材质及其纹理都被标记', () => {
    const tex1 = makeDataTexture(new Uint8Array(16))
    const tex2 = makeDataTexture(new Uint8Array(16))
    const mat1 = makeTerrainLikeMaterial(tex1, makeDataTexture(new Uint8Array(4)))
    const mat2 = makeTerrainLikeMaterial(tex2, makeDataTexture(new Uint8Array(4)))

    restoreMaterialGpuResources([mat1, mat2])

    expect(wasMarkedForUpdate(tex1)).toBe(true)
    expect(wasMarkedForUpdate(tex2)).toBe(true)
    expect(wasMarkedForUpdate(mat1)).toBe(true)
    expect(wasMarkedForUpdate(mat2)).toBe(true)
  })

  it('幂等：对已标记的纹理 / 材质重复置位安全（不抛错，version 持续递增）', () => {
    const heightmap = makeDataTexture(new Uint8Array(16))
    const mat = makeTerrainLikeMaterial(heightmap, makeDataTexture(new Uint8Array(4)))
    const versionBefore = heightmap.version
    // 多次重复调用（模拟 context 多次丢失 / 恢复）。
    expect(() => {
      restoreMaterialGpuResources(mat)
      restoreMaterialGpuResources(mat)
      restoreMaterialGpuResources(mat)
    }).not.toThrow()
    // version 持续递增（每次 needsUpdate=true → version++），> 0 即「已标记重建」。
    expect(heightmap.version).toBeGreaterThan(versionBefore)
    expect(wasMarkedForUpdate(heightmap)).toBe(true)
    expect(wasMarkedForUpdate(mat)).toBe(true)
  })
})

describe('restoreMaterialGpuResources：标准材质内置纹理槽被标记', () => {
  it('MeshStandardMaterial 的 map / normalMap 被标记重建', () => {
    const map = makeDataTexture(new Uint8Array(16))
    const normalMap = makeDataTexture(new Uint8Array(16))
    const mat = new THREE.MeshStandardMaterial({ map, normalMap })

    restoreMaterialGpuResources(mat)

    expect(wasMarkedForUpdate(map)).toBe(true)
    expect(wasMarkedForUpdate(normalMap)).toBe(true)
    expect(wasMarkedForUpdate(mat)).toBe(true)
  })

  it('无纹理的标准材质：只标记 material 重建，不抛错', () => {
    const mat = new THREE.MeshStandardMaterial()
    expect(() => restoreMaterialGpuResources(mat)).not.toThrow()
    expect(wasMarkedForUpdate(mat)).toBe(true)
  })
})

describe('restoreMaterialGpuResources：CPU 源数据生命周期分离（不重新解码 / 下载）', () => {
  it('DataTexture 的 .image.data 引用遍历前后不变（复用同一份 CPU 像素，不重新分配）', () => {
    // 模拟 32MB CPU 高程像素：一份 Uint8Array（测试用小尺寸）。
    const pixels = new Uint8Array(16)
    const heightmap = makeDataTexture(pixels)
    const mat = makeTerrainLikeMaterial(heightmap, makeDataTexture(new Uint8Array(4)))
    const dataBefore = heightmap.image.data

    restoreMaterialGpuResources(mat)

    // 关键不变量：GPU 资源恢复只对纹理置 needsUpdate（version++），CPU 源数据（.image.data）引用
    // 不变——绝不重新 fetch / 重新解码 .r16。遍历函数不接触 / 不替换 .image.data。
    expect(heightmap.image.data).toBe(dataBefore)
    expect(heightmap.image.data).toBe(pixels)
  })
})

describe('restoreSceneGpuResources：遍历场景标记全部 mesh 材质', () => {
  it('场景含多个 mesh：全部材质 / 纹理被标记重建', () => {
    const scene = new THREE.Scene()
    // mesh1：地形类 ShaderMaterial（heightmap + ramp）。
    const heightmap = makeDataTexture(new Uint8Array(16))
    const ramp = makeDataTexture(new Uint8Array(4))
    const mat1 = makeTerrainLikeMaterial(heightmap, ramp)
    const mesh1 = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), mat1)
    scene.add(mesh1)
    // mesh2：标准材质。
    const map = makeDataTexture(new Uint8Array(16))
    const mat2 = new THREE.MeshStandardMaterial({ map })
    const mesh2 = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), mat2)
    scene.add(mesh2)

    restoreSceneGpuResources(scene)

    expect(wasMarkedForUpdate(heightmap)).toBe(true)
    expect(wasMarkedForUpdate(ramp)).toBe(true)
    expect(wasMarkedForUpdate(mat1)).toBe(true)
    expect(wasMarkedForUpdate(map)).toBe(true)
    expect(wasMarkedForUpdate(mat2)).toBe(true)
  })

  it('空场景：不抛错（traverse 无对象，零副作用）', () => {
    const scene = new THREE.Scene()
    expect(() => restoreSceneGpuResources(scene)).not.toThrow()
  })

  it('嵌套分组：traverse 进入子节点标记其材质', () => {
    const scene = new THREE.Scene()
    const group = new THREE.Group()
    const heightmap = makeDataTexture(new Uint8Array(16))
    const mat = makeTerrainLikeMaterial(heightmap, makeDataTexture(new Uint8Array(4)))
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), mat)
    group.add(mesh)
    scene.add(group)

    restoreSceneGpuResources(scene)

    expect(wasMarkedForUpdate(heightmap)).toBe(true)
    expect(wasMarkedForUpdate(mat)).toBe(true)
  })

  it('无材质对象（Group / Light 等）：不抛错、跳过', () => {
    const scene = new THREE.Scene()
    scene.add(new THREE.Group())
    scene.add(new THREE.AmbientLight())
    expect(() => restoreSceneGpuResources(scene)).not.toThrow()
  })
})
