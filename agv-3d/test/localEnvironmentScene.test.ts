import { describe, expect, it } from 'vitest'
import { Mesh, MeshBasicMaterial, Scene, SphereGeometry } from 'three'
import { ENVIRONMENT_THEME } from '../src/features/agv-map/config/visualTheme'
import { PMREM_SCENE_RADIUS_M } from '../src/features/agv-map/config/environmentConfig'
import { hslToLinearColor } from '../src/features/agv-map/presentation/scene/colorConvert'
import { buildEnvironmentScene } from '../src/features/agv-map/presentation/scene/localEnvironmentScene'

/**
 * 程序化 PMREM 环境场景构建单元测试（SPEC §8.3 本地程序化环境，TASK-012）。
 *
 * 不做 PMREM 烘焙验证（需 WebGLRenderer），只断言程序化场景的结构、渐变与释放：
 * - 返回 Three.js Scene，含一个渐变球面网格（BackSide）。
 * - 顶点色按 Y 在底/顶色之间线性插值（底部深、顶部亮）。
 * - 显式释放路径可观测（geometry 与 material dispose，SPEC §5.4）。
 * - 纯函数确定性：相同输入产生相同顶点色。
 */

describe('buildEnvironmentScene — 程序化场景结构（SPEC §8.3）', () => {
  it('返回 Three.js Scene 实例', () => {
    const { scene } = buildEnvironmentScene(ENVIRONMENT_THEME.pmremGradient, PMREM_SCENE_RADIUS_M)
    expect(scene).toBeInstanceOf(Scene)
  })

  it('场景含一个渐变球面网格（MeshBasicMaterial + 顶点色 + BackSide）', () => {
    const { scene } = buildEnvironmentScene(ENVIRONMENT_THEME.pmremGradient, PMREM_SCENE_RADIUS_M)
    const mesh = scene.children[0]
    expect(mesh).toBeInstanceOf(Mesh)
    expect((mesh as Mesh).geometry).toBeInstanceOf(SphereGeometry)
    const material = (mesh as Mesh).material as MeshBasicMaterial
    expect(material).toBeInstanceOf(MeshBasicMaterial)
    expect(material.vertexColors).toBe(true)
    // BackSide = 1：渲染球面内表面，使 fromScene 内部相机捕获环绕渐变。
    expect(material.side).toBe(1)
  })
})

describe('buildEnvironmentScene — 渐变插值（SPEC §8.3 程序化）', () => {
  it('球面顶点含 color 属性，顶点数为 SphereGeometry 顶点数', () => {
    const { scene } = buildEnvironmentScene(ENVIRONMENT_THEME.pmremGradient, PMREM_SCENE_RADIUS_M)
    const geo = (scene.children[0] as Mesh).geometry as SphereGeometry
    const colorAttr = geo.attributes.color
    expect(colorAttr).toBeDefined()
    expect(colorAttr.itemSize).toBe(3)
    expect(colorAttr.count).toBe(geo.attributes.position.count)
  })

  it('顶点色在底部色与顶部色之间：底部顶点近底色、顶部顶点近顶色', () => {
    const { scene } = buildEnvironmentScene(ENVIRONMENT_THEME.pmremGradient, PMREM_SCENE_RADIUS_M)
    const geo = (scene.children[0] as Mesh).geometry as SphereGeometry
    const pos = geo.attributes.position
    const col = geo.attributes.color
    const bottomLinear = hslToLinearColor(ENVIRONMENT_THEME.pmremGradient.bottom)
    const topLinear = hslToLinearColor(ENVIRONMENT_THEME.pmremGradient.top)

    // 找到最低/最高 Y 顶点，断言其颜色分别接近底色/顶色（线性空间，容差吸收分段插值离散）。
    let minI = 0
    let maxI = 0
    let minY = Infinity
    let maxY = -Infinity
    for (let i = 0; i < pos.count; i += 1) {
      const y = pos.getY(i)
      if (y < minY) {
        minY = y
        minI = i
      }
      if (y > maxY) {
        maxY = y
        maxI = i
      }
    }
    // 底部顶点色（itemSize=3：getX/getY/getZ 对应 r/g/b）应接近底色线性值。
    expect(col.getX(minI)).toBeCloseTo(bottomLinear.r, 4)
    expect(col.getY(minI)).toBeCloseTo(bottomLinear.g, 4)
    expect(col.getZ(minI)).toBeCloseTo(bottomLinear.b, 4)
    // 顶部顶点色应接近顶色线性值。
    expect(col.getX(maxI)).toBeCloseTo(topLinear.r, 4)
    expect(col.getY(maxI)).toBeCloseTo(topLinear.g, 4)
    expect(col.getZ(maxI)).toBeCloseTo(topLinear.b, 4)
  })
})

describe('buildEnvironmentScene — 纯函数确定性（SPEC §7.1 精神）', () => {
  it('相同梯度与半径两次构建产生相同顶点色序列', () => {
    const a = buildEnvironmentScene(ENVIRONMENT_THEME.pmremGradient, PMREM_SCENE_RADIUS_M)
    const b = buildEnvironmentScene(ENVIRONMENT_THEME.pmremGradient, PMREM_SCENE_RADIUS_M)
    const ca = ((a.scene.children[0] as Mesh).geometry as SphereGeometry).attributes.color
    const cb = ((b.scene.children[0] as Mesh).geometry as SphereGeometry).attributes.color
    expect(ca.count).toBe(cb.count)
    for (let i = 0; i < ca.count * 3; i += 1) {
      expect(ca.array[i]).toBe(cb.array[i])
    }
    a.dispose()
    b.dispose()
  })
})

describe('buildEnvironmentScene — 释放生命周期（SPEC §5.4，TASK-012）', () => {
  it('dispose 释放 geometry 与 material（触发各自 dispose 事件）', () => {
    const handle = buildEnvironmentScene(ENVIRONMENT_THEME.pmremGradient, PMREM_SCENE_RADIUS_M)
    const mesh = handle.scene.children[0] as Mesh
    const geo = mesh.geometry as SphereGeometry
    const mat = mesh.material as MeshBasicMaterial
    let geoDisposed = false
    let matDisposed = false
    geo.addEventListener('dispose', () => {
      geoDisposed = true
    })
    mat.addEventListener('dispose', () => {
      matDisposed = true
    })
    handle.dispose()
    expect(geoDisposed).toBe(true)
    expect(matDisposed).toBe(true)
  })

  it('dispose 幂等：重复调用不抛错', () => {
    const handle = buildEnvironmentScene(ENVIRONMENT_THEME.pmremGradient, PMREM_SCENE_RADIUS_M)
    expect(() => {
      handle.dispose()
      handle.dispose()
    }).not.toThrow()
  })
})
