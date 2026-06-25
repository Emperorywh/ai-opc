import { describe, it, expect } from 'vitest'
import { encodeHeightToRgb, decodeRgbToHeight, encodeTile } from '../lib/terrarium'

describe('terrarium encodeHeightToRgb', () => {
  it('encodes sea level (0 m) to (128, 0, 0)', () => {
    // v = 0 + 32768 = 32768; R = floor(32768/256) = 128; G = 32768 % 256 = 0; B = 0
    expect(encodeHeightToRgb(0)).toEqual([128, 0, 0])
  })

  it('encodes a negative height (Dead Sea ~ -430 m)', () => {
    const [r, g, b] = encodeHeightToRgb(-430)
    // v = -430 + 32768 = 32338; R = floor(32338/256) = 126; G = 32338 - 126*256 = 82; B = 0
    expect(r).toBe(126)
    expect(g).toBe(82)
    expect(b).toBe(0)
  })

  it('encodes Mt Everest (8848 m) within integer range', () => {
    const [r, g, b] = encodeHeightToRgb(8848)
    // v = 8848 + 32768 = 41616; R = 162; G = 144; B = 0
    expect(r).toBe(162)
    expect(g).toBe(144)
    expect(b).toBe(0)
  })
})

describe('terrarium decodeRgbToHeight', () => {
  it('round-trips integer heights exactly', () => {
    for (const h of [-5000, -430, 0, 100, 8848]) {
      const rgb = encodeHeightToRgb(h)
      expect(decodeRgbToHeight(rgb[0], rgb[1], rgb[2])).toBeCloseTo(h, 5)
    }
  })

  it('recovers sub-meter precision via blue channel', () => {
    // h = 100.5 m → v = 32868.5; R=128, G=100, B=floor(0.5*256)=128
    const rgb = encodeHeightToRgb(100.5)
    expect(rgb).toEqual([128, 100, 128])
    const decoded = decodeRgbToHeight(rgb[0], rgb[1], rgb[2])
    expect(decoded).toBeCloseTo(100.5, 1)
  })
})

describe('terrarium encodeTile', () => {
  it('encodes a 2x2 Float32 grid into a 12-byte RGB array', () => {
    // heights: [0, 100, 200, 300] row-major
    const heights = new Float32Array([0, 100, 200, 300])
    const rgb = encodeTile(heights, 2, 2)
    expect(rgb.length).toBe(12) // 4 px * 3 channels
    // first pixel = 0m → [128,0,0]
    expect(rgb[0]).toBe(128)
    expect(rgb[1]).toBe(0)
    expect(rgb[2]).toBe(0)
  })

  it('rejects mismatched grid dimensions', () => {
    expect(() => encodeTile(new Float32Array([1, 2, 3]), 2, 2)).toThrow()
  })
})
