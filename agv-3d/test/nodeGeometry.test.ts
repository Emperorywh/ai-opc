import { describe, expect, it } from 'vitest'
import { BoxGeometry, Vector3 } from 'three'
import { DEFAULT_NODE_DIMENSIONS_CONFIG } from '../src/features/agv-map/config/geometryConfig'
import type { NodeDimensions } from '../src/features/agv-map/config/geometryConfig'
import type { RawNodeType } from '../src/features/agv-map/domain/rawDto'
import { buildNodeGeometry } from '../src/features/agv-map/presentation/scene/nodeGeometry'

/** 全部尺寸类型，便于统一断言。 */
const ALL_TYPES: readonly RawNodeType[] = ['node', 'work', 'charge', 'park']

/** 取几何全部顶点为 Vector3 数组（兼容索引与非索引几何）。 */
function vertices(type: RawNodeType, dim: NodeDimensions): Vector3[] {
  const geo = buildNodeGeometry(type, dim)
  const pos = geo.attributes.position
  const out: Vector3[] = []
  for (let i = 0; i < pos.count; i += 1) {
    out.push(new Vector3(pos.getX(i), pos.getY(i), pos.getZ(i)))
  }
  return out
}

/** 计算非索引几何的有符号体积（以原点为公共顶点）。 */
function signedVolume(type: RawNodeType, dim: NodeDimensions): number {
  const geo = buildNodeGeometry(type, dim)
  const pos = geo.attributes.position
  let volume = 0
  const triCount = pos.count / 3
  for (let t = 0; t < triCount; t += 1) {
    const a = new Vector3(pos.getX(t * 3), pos.getY(t * 3), pos.getZ(t * 3))
    const b = new Vector3(pos.getX(t * 3 + 1), pos.getY(t * 3 + 1), pos.getZ(t * 3 + 1))
    const c = new Vector3(pos.getX(t * 3 + 2), pos.getY(t * 3 + 2), pos.getZ(t * 3 + 2))
    volume += a.dot(b.clone().cross(c)) / 6
  }
  return volume
}

describe('buildNodeGeometry — 尺寸与居中（SPEC §7.2）', () => {
  it.each(ALL_TYPES)('%s 几何包围盒内接于配置尺寸、原点居中', (type) => {
    const dim = DEFAULT_NODE_DIMENSIONS_CONFIG.byType[type]
    const geo = buildNodeGeometry(type, dim)
    geo.computeBoundingBox()
    const box = geo.boundingBox!
    const hx = dim.sizeXM / 2
    const hy = dim.sizeYM / 2
    const hz = dim.sizeZM / 2
    // 各轴极值不超过 ±半尺寸（六棱柱内接，可能更小；不放宽下界以保持"不穿透"语义）。
    expect(box.min.x).toBeGreaterThanOrEqual(-hx - 1e-6)
    expect(box.max.x).toBeLessThanOrEqual(hx + 1e-6)
    expect(box.min.y).toBeGreaterThanOrEqual(-hy - 1e-6)
    expect(box.max.y).toBeLessThanOrEqual(hy + 1e-6)
    expect(box.min.z).toBeGreaterThanOrEqual(-hz - 1e-6)
    expect(box.max.z).toBeLessThanOrEqual(hz + 1e-6)
  })

  it.each(ALL_TYPES)('%s 底部位于 y = −sizeYM/2（贴地后底部 y=0）', (type) => {
    const dim = DEFAULT_NODE_DIMENSIONS_CONFIG.byType[type]
    const verts = vertices(type, dim)
    const minY = Math.min(...verts.map((v) => v.y))
    expect(minY).toBeCloseTo(-dim.sizeYM / 2, 6)
  })

  it.each(ALL_TYPES)('%s 顶点数为正、位置全部有限', (type) => {
    const dim = DEFAULT_NODE_DIMENSIONS_CONFIG.byType[type]
    const geo = buildNodeGeometry(type, dim)
    const pos = geo.attributes.position
    expect(pos.count).toBeGreaterThan(0)
    for (let i = 0; i < pos.count; i += 1) {
      expect(Number.isFinite(pos.getX(i))).toBe(true)
      expect(Number.isFinite(pos.getY(i))).toBe(true)
      expect(Number.isFinite(pos.getZ(i))).toBe(true)
    }
  })

  it.each(ALL_TYPES)('%s 法线全部为单位向量且有限', (type) => {
    const dim = DEFAULT_NODE_DIMENSIONS_CONFIG.byType[type]
    const geo = buildNodeGeometry(type, dim)
    const nrm = geo.attributes.normal
    expect(nrm).toBeDefined()
    for (let i = 0; i < nrm.count; i += 1) {
      const len = Math.hypot(nrm.getX(i), nrm.getY(i), nrm.getZ(i))
      expect(len, `${type} normal ${i} length`).toBeCloseTo(1, 5)
    }
  })
})

describe('buildNodeGeometry — 模型前向 +X（SPEC §6.2、§7.2）', () => {
  it('普通节点为立方体：±X 均为完整面、无方向性', () => {
    const dim = DEFAULT_NODE_DIMENSIONS_CONFIG.byType.node
    const geo = buildNodeGeometry('node', dim)
    expect(geo).toBeInstanceOf(BoxGeometry)
    // 立方体关于 X 对称：前后端面各有 4 顶点位于 ±hx。
    const verts = vertices('node', dim)
    const hx = dim.sizeXM / 2
    const atPlusX = verts.filter((v) => Math.abs(v.x - hx) < 1e-6)
    const atMinusX = verts.filter((v) => Math.abs(v.x + hx) < 1e-6)
    expect(atPlusX.length).toBeGreaterThanOrEqual(4)
    expect(atMinusX.length).toBeGreaterThanOrEqual(4)
  })

  it('工作节点为楔形：前端尖端位于 +X、中线高度', () => {
    const dim = DEFAULT_NODE_DIMENSIONS_CONFIG.byType.work
    const verts = vertices('work', dim)
    const hx = dim.sizeXM / 2
    // +X 侧顶点全部位于 y≈0（前端收成一个沿 Z 的尖端边）。
    const atPlusX = verts.filter((v) => Math.abs(v.x - hx) < 1e-6)
    expect(atPlusX.length).toBeGreaterThan(0)
    for (const v of atPlusX) {
      expect(v.y).toBeCloseTo(0, 6)
    }
    // 后端（−X）占满全高，证明形状由后向前收尖。
    const atMinusX = verts.filter((v) => Math.abs(v.x + hx) < 1e-6)
    const ys = new Set(atMinusX.map((v) => v.y.toPrecision(4)))
    expect(ys.size).toBeGreaterThanOrEqual(2)
  })

  it('充电节点为六棱柱带尖端：apex 唯一位于 +X 且在轴线 (y=0,z=0)', () => {
    const dim = DEFAULT_NODE_DIMENSIONS_CONFIG.byType.charge
    const verts = vertices('charge', dim)
    const hx = dim.sizeXM / 2
    // +X 极值顶点即为锥尖 apex：y、z 均为 0。
    const atPlusX = verts.filter((v) => Math.abs(v.x - hx) < 1e-6)
    expect(atPlusX.length).toBeGreaterThan(0)
    for (const v of atPlusX) {
      expect(v.y).toBeCloseTo(0, 6)
      expect(v.z).toBeCloseTo(0, 6)
    }
  })

  it('停车节点为切角长方体：前端面（+X）比后端面收窄', () => {
    const dim = DEFAULT_NODE_DIMENSIONS_CONFIG.byType.park
    const verts = vertices('park', dim)
    const hx = dim.sizeXM / 2
    const front = verts.filter((v) => Math.abs(v.x - hx) < 1e-6)
    const back = verts.filter((v) => Math.abs(v.x + hx) < 1e-6)
    expect(front.length).toBeGreaterThan(0)
    expect(back.length).toBeGreaterThan(0)
    // 后端面半高/半深 = 完整尺寸；前端面严格更小。
    const backHalfY = Math.max(...back.map((v) => Math.abs(v.y)))
    const frontHalfY = Math.max(...front.map((v) => Math.abs(v.y)))
    expect(backHalfY).toBeCloseTo(dim.sizeYM / 2, 6)
    expect(frontHalfY).toBeLessThan(dim.sizeYM / 2 - 1e-3)
  })
})

describe('buildNodeGeometry — 外法线与封闭性', () => {
  // 仅校验自定义（非索引）几何：有符号体积为正 ⟺ 三角形朝外（散度定理）。
  const CUSTOM_TYPES: readonly RawNodeType[] = ['work', 'charge', 'park']

  it.each(CUSTOM_TYPES)('%s 有符号体积为正（外法线、封闭网格）', (type) => {
    const dim = DEFAULT_NODE_DIMENSIONS_CONFIG.byType[type]
    expect(signedVolume(type, dim)).toBeGreaterThan(0)
  })

  it.each(CUSTOM_TYPES)(
    '%s 每个三角面法线指向远离原点一侧（凸体外法线）',
    (type) => {
      const dim = DEFAULT_NODE_DIMENSIONS_CONFIG.byType[type]
      const geo = buildNodeGeometry(type, dim)
      const pos = geo.attributes.position
      const nrm = geo.attributes.normal
      const triCount = pos.count / 3
      for (let t = 0; t < triCount; t += 1) {
        const a = new Vector3(pos.getX(t * 3), pos.getY(t * 3), pos.getZ(t * 3))
        const b = new Vector3(pos.getX(t * 3 + 1), pos.getY(t * 3 + 1), pos.getZ(t * 3 + 1))
        const c = new Vector3(pos.getX(t * 3 + 2), pos.getY(t * 3 + 2), pos.getZ(t * 3 + 2))
        const centroid = a.clone().add(b).add(c).multiplyScalar(1 / 3)
        // 面法线取三顶点法线均值（非索引逐面法线，三者相同）。
        const faceNormal = new Vector3(
          nrm.getX(t * 3),
          nrm.getY(t * 3),
          nrm.getZ(t * 3),
        )
        // 外法线应与"从原点指向面心"同向（凸体、原点居中）。
        expect(faceNormal.dot(centroid), `${type} tri ${t}`).toBeGreaterThan(1e-6)
      }
    },
  )
})

describe('buildNodeGeometry — 确定性', () => {
  it.each(ALL_TYPES)('%s 两次构建顶点位置字节级一致', (type) => {
    const dim = DEFAULT_NODE_DIMENSIONS_CONFIG.byType[type]
    const a = buildNodeGeometry(type, dim).attributes.position.array as Float32Array
    const b = buildNodeGeometry(type, dim).attributes.position.array as Float32Array
    expect(a.length).toBe(b.length)
    for (let i = 0; i < a.length; i += 1) {
      expect(a[i]).toBe(b[i])
    }
  })
})

describe('buildNodeGeometry — 释放生命周期（SPEC §5.4，TASK-009）', () => {
  it.each(ALL_TYPES)('%s dispose 触发 dispose 事件，使释放路径可自动化验证', (type) => {
    const dim = DEFAULT_NODE_DIMENSIONS_CONFIG.byType[type]
    const geo = buildNodeGeometry(type, dim)
    let disposed = false
    geo.addEventListener('dispose', () => {
      disposed = true
    })
    // NodeLayer 卸载 effect 调用 geometry.dispose()；此处验证该调用确实释放资源，
    // 不依赖后续 TASK 或浏览器环境即可证明释放路径有效。
    geo.dispose()
    expect(disposed).toBe(true)
  })
})
