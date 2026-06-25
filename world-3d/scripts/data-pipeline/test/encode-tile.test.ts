import { describe, it, expect } from 'vitest'
import { encodeElevationGridToPng } from '../lib/encode-tile'
import { decode } from 'fast-png'

describe('encodeElevationGridToPng', () => {
  it('produces a valid 256x256 RGB PNG', () => {
    const grid = new Float32Array(256 * 256).fill(0) // sea level everywhere
    const pngBytes = encodeElevationGridToPng(grid, 256, 256)
    expect(pngBytes).toBeInstanceOf(Uint8Array)
    // PNG signature: 0x89 'P' 'N' 'G'
    expect(pngBytes[0]).toBe(0x89)
    expect(pngBytes[1]).toBe(0x50) // 'P'
    const decoded = decode(pngBytes)
    expect(decoded.width).toBe(256)
    expect(decoded.height).toBe(256)
  })

  it('encodes as RGB (3 channels), not RGBA', () => {
    const grid = new Float32Array(4).fill(0)
    const pngBytes = encodeElevationGridToPng(grid, 2, 2)
    const decoded = decode(pngBytes) as { channels: number; data: Uint8Array }
    expect(decoded.channels).toBe(3)
    expect(decoded.data.length).toBe(2 * 2 * 3)
  })

  it('round-trips a known height through PNG', () => {
    const grid = new Float32Array([0, 1000, 5000, -200])
    const pngBytes = encodeElevationGridToPng(grid, 2, 2)
    const decoded = decode(pngBytes)
    const d = decoded.data as Uint8Array
    // pixel 0 = 0m → v=32768; R=floor(32768/256)=128, G=0, B=0
    expect(d[0]).toBe(128)
    expect(d[1]).toBe(0)
    expect(d[2]).toBe(0)
    // pixel 1 = 1000m → v=33768; R=131, G=33768-131*256=232, B=0
    expect(d[3]).toBe(131)
    expect(d[4]).toBe(232)
  })
})
