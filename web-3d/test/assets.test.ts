import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import * as THREE from 'three'
import {
  parseMeta,
  decodeHeightmap,
  createHeightTexture,
  sampleHeight,
  sampleWorldY,
} from '../src/data/assets'
import { heightToMeters, heightToWorldY, type ElevationMeta } from '../src/config/projection'

const PUBLIC_DATA = resolve('public/data')
const realMetaRaw = JSON.parse(readFileSync(resolve(PUBLIC_DATA, 'meta.json'), 'utf8'))

describe('parseMeta', () => {
  it('解析真实 meta.json 通过校验', () => {
    const m = parseMeta(realMetaRaw)
    expect(m.width).toBe(1024)
    expect(m.height).toBe(512)
    expect(m.projection).toBe('equirectangular')
    expect(m.elevationMin).toBe(-5000)
    expect(m.elevationMax).toBe(6500)
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

describe('sampleHeight（合成小缓冲，确定性）', () => {
  // 2×2 缓冲：col0=0、col1=65535（两行相同）→ h ∈ {0,1}
  const elev = {
    width: 2,
    height: 2,
    data: new Uint16Array([0, 65535, 0, 65535]),
  }

  it('像素中心返回该像素的归一化值', () => {
    // 2×2：像素 (0,0) 中心 lon=-90, lat=45；(1,0) 中心 lon=90, lat=45
    expect(sampleHeight(elev, -90, 45)).toBeCloseTo(0, 5)
    expect(sampleHeight(elev, 90, 45)).toBeCloseTo(1, 5)
  })

  it('经度环绕：−180° 与 +180° 同值', () => {
    const a = sampleHeight(elev, -180, 0)
    const b = sampleHeight(elev, 180, 0)
    expect(a).toBeCloseTo(b, 5)
  })

  it('采样值始终在 [0,1]', () => {
    const pts: Array<[number, number]> = [
      [-90, 45],
      [90, 45],
      [-90, -45],
      [90, -45],
      [0, 0],
      [179, 89],
    ]
    for (const [lon, lat] of pts) {
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
