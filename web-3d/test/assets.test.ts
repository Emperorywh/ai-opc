import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import * as THREE from 'three'
import {
  parseMeta,
  decodeHeightmap,
  createHeightTexture,
  sampleHeight,
  sampleHeightAtWorld,
  sampleWorldY,
} from '../src/data/assets'
import { project } from '../src/config/projection'
import { heightToMeters, heightToWorldY, type ElevationMeta } from '../src/config/projection'

const PUBLIC_DATA = resolve('public/data')
const realMetaRaw = JSON.parse(readFileSync(resolve(PUBLIC_DATA, 'meta.json'), 'utf8'))

describe('parseMeta', () => {
  it('解析真实 meta.json 通过校验（round-trip：解析值 = 真实 meta 原值，数据源无关）', () => {
    const m = parseMeta(realMetaRaw)
    // 不写死具体数值：真实 meta 从合成(1024×512/-5000~6500) 换成 GEBCO(4096×2048/-10000~9000)
    // 后，本测试无需改动 —— parseMeta 只需忠实还原真实文件即可（Task 02b 可插拔数据源契约）。
    expect(m.width).toBe(realMetaRaw.width)
    expect(m.height).toBe(realMetaRaw.height)
    expect(m.projection).toBe(realMetaRaw.projection)
    expect(m.elevationMin).toBe(realMetaRaw.elevationMin)
    expect(m.elevationMax).toBe(realMetaRaw.elevationMax)
    expect(m.source).toBe(realMetaRaw.source)
    expect(m.heightExaggeration).toBe(2.5)
  })

  it('拒绝非法输入', () => {
    expect(() => parseMeta(null)).toThrow()
    expect(() => parseMeta({ version: 1 })).toThrow()
    expect(() => parseMeta({ ...realMetaRaw, heightExaggeration: -1 })).toThrow()
    expect(() => parseMeta({ ...realMetaRaw, projection: 'mercator' })).toThrow()
  })
})

describe('decodeHeightmap（真实 16-bit PNG，无损校验）', () => {
  it('解码为 Uint16Array，尺寸 = meta', () => {
    const elev = decodeHeightmap(readFileSync(resolve(PUBLIC_DATA, 'heightmap.png')))
    expect(elev.width).toBe(realMetaRaw.width)
    expect(elev.height).toBe(realMetaRaw.height)
    expect(elev.data).toBeInstanceOf(Uint16Array)
    expect(elev.data.length).toBe(realMetaRaw.width * realMetaRaw.height)
  })

  it('像素值在 [0,65535]，且确实用到 16-bit 动态范围（证明未降为 8-bit）', () => {
    const elev = decodeHeightmap(readFileSync(resolve(PUBLIC_DATA, 'heightmap.png')))
    let min = Infinity
    let max = -Infinity
    for (let i = 0; i < elev.data.length; i++) {
      const v = elev.data[i]
      if (v < min) min = v
      if (v > max) max = v
    }
    expect(min).toBeGreaterThanOrEqual(0)
    expect(max).toBeLessThanOrEqual(65535)
    expect(max).toBeGreaterThan(255) // 8-bit 上限 255；真实 16-bit 高程必远超
  })

  it('已知海洋点高程 < 海平面，已知高山点 > 海平面（大陆轮廓可辨认）', () => {
    const elev = decodeHeightmap(readFileSync(resolve(PUBLIC_DATA, 'heightmap.png')))
    const meta = parseMeta(realMetaRaw) as ElevationMeta
    const ocean = heightToMeters(sampleHeight(elev, -30, 0), meta) // 大西洋中部
    const himalaya = heightToMeters(sampleHeight(elev, 86.9, 27.9), meta)
    expect(ocean).toBeLessThan(meta.seaLevelMeters)
    expect(himalaya).toBeGreaterThan(meta.seaLevelMeters)
  })
})

describe('sampleHeightAtWorld（合成小缓冲，投影无关 · worldXY→UV 与 shader 同源）', () => {
  // 2×2 缓冲：col0=0、col1=65535（两行相同）→ h ∈ {0,1}
  const elev = {
    width: 2,
    height: 2,
    data: new Uint16Array([0, 65535, 0, 65535]),
  }

  it('像素中心返回该像素的归一化值（worldXY → 像素中心）', () => {
    // 2×2 像素中心：worldX ∈ {-0.5, 0.5}（PLANE_WIDTH=2，每像素跨 1），worldZ ∈ {-0.25, 0.25}
    expect(sampleHeightAtWorld(elev, -0.5, -0.25)).toBeCloseTo(0, 5) // 像素 (0,0)
    expect(sampleHeightAtWorld(elev, 0.5, -0.25)).toBeCloseTo(1, 5) // 像素 (1,0)
  })

  it('经度方向环绕：worldX=-1 与 worldX=+1 同值（像素网格左右边缘环绕）', () => {
    expect(sampleHeightAtWorld(elev, -1, 0)).toBeCloseTo(sampleHeightAtWorld(elev, 1, 0), 5)
  })

  it('采样值始终在 [0,1]', () => {
    const pts: Array<[number, number]> = [
      [-0.5, -0.25],
      [0.5, -0.25],
      [-0.5, 0.25],
      [0.5, 0.25],
      [0, 0],
      [0.99, -0.49],
    ]
    for (const [wx, wz] of pts) {
      const h = sampleHeightAtWorld(elev, wx, wz)
      expect(h).toBeGreaterThanOrEqual(0)
      expect(h).toBeLessThanOrEqual(1)
    }
  })
})

describe('sampleHeight（经 project 衔接 sampleHeightAtWorld · R2/R3 同源）', () => {
  const elev = {
    width: 2,
    height: 2,
    data: new Uint16Array([0, 65535, 0, 65535]),
  }

  it('sampleHeight(lon,lat) === sampleHeightAtWorld(...project(lon,lat))', () => {
    for (const [lon, lat] of [
      [0, 0],
      [116.4, 39.9],
      [-70, -15],
      [90, 60],
    ]) {
      const [x, z] = project(lon, lat)
      expect(sampleHeight(elev, lon, lat)).toBeCloseTo(sampleHeightAtWorld(elev, x, z), 9)
    }
  })

  it('采样值始终在 [0,1]', () => {
    for (const [lon, lat] of [
      [-90, 45],
      [90, 45],
      [0, 0],
      [179, 89],
    ]) {
      const h = sampleHeight(elev, lon, lat)
      expect(h).toBeGreaterThanOrEqual(0)
      expect(h).toBeLessThanOrEqual(1)
    }
  })
})

describe('sampleWorldY（CPU/GPU 同源公式）', () => {
  it('世界 Y = heightToWorldY(sampleHeight(...))，且与 uniform 公式一致', () => {
    const elev = decodeHeightmap(readFileSync(resolve(PUBLIC_DATA, 'heightmap.png')))
    const meta = parseMeta(realMetaRaw) as ElevationMeta
    const lon = 86.9
    const lat = 27.9
    const direct = heightToWorldY(sampleHeight(elev, lon, lat), meta)
    const viaQuery = sampleWorldY(elev, meta, lon, lat)
    expect(viaQuery).toBe(direct)
  })
})

describe('createHeightTexture（R32F 构建，node 安全）', () => {
  it('构建 R32F 纹理，属性正确', () => {
    const elev = {
      width: 4,
      height: 2,
      data: new Uint16Array([0, 16384, 32768, 49152, 65535, 0, 100, 200]),
    }
    const tex = createHeightTexture(elev)
    expect(tex.image.width).toBe(4)
    expect(tex.image.height).toBe(2)
    expect(tex.format).toBe(THREE.RedFormat)
    expect(tex.type).toBe(THREE.FloatType)
    expect(tex.magFilter).toBe(THREE.LinearFilter)
    expect(tex.minFilter).toBe(THREE.LinearFilter)
    expect(tex.wrapS).toBe(THREE.RepeatWrapping)
    expect(tex.wrapT).toBe(THREE.ClampToEdgeWrapping)
    const img = tex.image as { data: Float32Array }
    expect(img.data[0]).toBeCloseTo(0, 6) // raw 0 → 0
    expect(img.data[4]).toBeCloseTo(1, 6) // raw 65535 → 1
    expect(img.data.length).toBe(8)
  })
})

describe('真实 GEBCO DEM 大陆轮廓回归（Task 02b 闭环 · M1 验收第 4 条）', () => {
  // 整块共享一次解码（11.7MB PNG），避免每个 it 重复 decode。
  const elev = decodeHeightmap(readFileSync(resolve(PUBLIC_DATA, 'heightmap.png')))
  const meta = parseMeta(realMetaRaw) as ElevationMeta
  const sea = meta.seaLevelMeters

  // 已知陆地代表点：高程应高于海平面（七大洲各取一点 + 南极冰盖）
  const land: ReadonlyArray<readonly [string, number, number]> = [
    ['北京', 116.4, 39.9],
    ['北美中部', -98, 41], // 内陆大平原，避开海岸双线性跨海（纽约 -74,40.7 落在 -0.5m 近海）
    ['亚马逊', -62, -4],
    ['撒哈拉', 10, 23],
    ['澳洲中部', 134, -25],
    ['南极点', 0, -89],
  ]
  for (const [name, lon, lat] of land) {
    it(`陆地·${name} (${lon}, ${lat}) 高于海平面`, () => {
      expect(heightToMeters(sampleHeight(elev, lon, lat), meta)).toBeGreaterThan(sea)
    })
  }

  // 已知海洋代表点：高程应低于海平面（四大洋各取一点）
  const ocean: ReadonlyArray<readonly [string, number, number]> = [
    ['太平洋中部', -160, 0],
    ['大西洋中部', -30, 0],
    ['印度洋', 80, -20],
    ['北冰洋', 0, 85],
  ]
  for (const [name, lon, lat] of ocean) {
    it(`海洋·${name} (${lon}, ${lat}) 低于海平面`, () => {
      expect(heightToMeters(sampleHeight(elev, lon, lat), meta)).toBeLessThan(sea)
    })
  }

  it('真实地形显著起伏 —— 区分真实 GEBCO 与合成噪声（基于 elevationMin/Max 硬上下界，物理严格）', () => {
    // 合成 DEM(Task 02)：elevationMin=-5000/max=6500 是烘焙硬上下界 → maxM≤6500、minM≥-5000，本断言必失败。
    // 真实 GEBCO equirect(4096×2048)：maxM≈7628（珠峰区降采样至 ~9.8km/px 被邻域平均，<真实 8848m）。
    // Task 26 Robinson 重烘焙对 equirect DEM 双线性重采样，峰值再平滑至 ~6917m（重采样固有效应，非数据错误），
    //   但仍 > 合成 6500 上限；minM≈-9988（深海沟 clamp 到 elevationMin）→ 通过。「真实 DEM 已接入」回归保护。
    let maxM = -Infinity
    let minM = Infinity
    for (let i = 0; i < elev.data.length; i++) {
      const m = heightToMeters(elev.data[i] / 65535, meta)
      if (m > maxM) maxM = m
      if (m < minM) minM = m
    }
    expect(maxM).toBeGreaterThan(6500) // 合成硬上限 6500；真实 Robinson 重采样 ~6917
    expect(minM).toBeLessThan(-9000)
  })
})
