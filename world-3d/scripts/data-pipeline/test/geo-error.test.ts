import { describe, it, expect } from 'vitest'
import { computeGeoError, bilinearUpsample2x } from '../lib/geo-error'

describe('bilinearUpsample2x', () => {
  it('upsamples a flat 2x2 parent to a 4x4 grid of the same constant', () => {
    const parent = new Float32Array([50, 50, 50, 50])
    const up = bilinearUpsample2x(parent, 2, 2)
    expect(up.length).toBe(16)
    for (const v of up) expect(v).toBeCloseTo(50, 5)
  })

  it('interpolates between parent corners', () => {
    // parent: top-left=0, top-right=100, bottom-left=0, bottom-right=100
    const parent = new Float32Array([0, 100, 0, 100])
    const up = bilinearUpsample2x(parent, 2, 2)
    // interior values should be within the [0,100] range
    for (const v of up) {
      expect(v).toBeGreaterThanOrEqual(-0.001)
      expect(v).toBeLessThanOrEqual(100.001)
    }
  })

  it('doubles both dimensions', () => {
    const parent = new Float32Array(3 * 3).fill(10)
    const up = bilinearUpsample2x(parent, 3, 3)
    expect(up.length).toBe(6 * 6)
  })
})

describe('computeGeoError', () => {
  it('returns 0 when tile exactly matches upsampled parent', () => {
    const flat = new Float32Array(256 * 256).fill(42)
    const err = computeGeoError(flat, flat)
    expect(err).toBeCloseTo(0, 5)
  })

  it('returns the max deviation when tile has a spike', () => {
    // tile: flat 0 except one pixel at 500
    const tile = new Float32Array(256 * 256).fill(0)
    tile[1000] = 500
    // parent upsampled = all 0 (flat)
    const parent = new Float32Array(256 * 256).fill(0)
    const err = computeGeoError(tile, parent)
    expect(err).toBeCloseTo(500, 1)
  })

  it('rejects mismatched grid sizes', () => {
    expect(() => computeGeoError(new Float32Array(4), new Float32Array(9))).toThrow()
  })
})
