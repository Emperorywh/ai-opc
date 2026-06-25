import { describe, it, expect } from 'vitest'
import {
  R,
  ORIGIN,
  MAX_LAT,
  lonLatToWebMercator,
  webMercatorToLonLat,
  tileBoundsMeters,
  tileBoundsLatLon,
  tileChildren,
  tileSizeMeters,
} from '../lib/web-mercator'

describe('web-mercator constants', () => {
  it('R is the WGS84 semi-major axis', () => {
    expect(R).toBe(6378137.0)
  })

  it('ORIGIN equals half the Web Mercator extent', () => {
    expect(ORIGIN).toBeCloseTo(20037508.342789244, 4)
  })

  it('MAX_LAT is the Web Mercator latitude limit', () => {
    expect(MAX_LAT).toBeCloseTo(85.05112878, 6)
  })
})

describe('lonLatToWebMercator', () => {
  it('maps origin (0,0) to (0,0)', () => {
    const [mx, my] = lonLatToWebMercator(0, 0)
    expect(mx).toBeCloseTo(0, 1)
    expect(my).toBeCloseTo(0, 1)
  })

  it('maps (180, 0) to the eastern extent', () => {
    const [mx] = lonLatToWebMercator(180, 0)
    expect(mx).toBeCloseTo(ORIGIN, -1)
  })

  it('maps (0, MAX_LAT) to near the northern extent', () => {
    const [, my] = lonLatToWebMercator(0, MAX_LAT)
    expect(my).toBeCloseTo(ORIGIN, -1)
  })

  it('is symmetric about the equator and prime meridian', () => {
    const [px, py] = lonLatToWebMercator(30, 40)
    const [nx, ny] = lonLatToWebMercator(-30, -40)
    expect(px).toBeCloseTo(-nx, 1)
    expect(py).toBeCloseTo(-ny, 1)
  })
})

describe('webMercatorToLonLat (inverse)', () => {
  it('round-trips lon/lat', () => {
    for (const [lon, lat] of [
      [0, 0],
      [45, 45],
      [-120, -33],
      [100, 30], // China
    ]) {
      const [mx, my] = lonLatToWebMercator(lon, lat)
      const [lon2, lat2] = webMercatorToLonLat(mx, my)
      expect(lon2).toBeCloseTo(lon, 5)
      expect(lat2).toBeCloseTo(lat, 5)
    }
  })
})

describe('tileSizeMeters', () => {
  it('z0 tile spans the full width', () => {
    expect(tileSizeMeters(0)).toBeCloseTo(2 * ORIGIN, -1)
  })

  it('halves each zoom', () => {
    expect(tileSizeMeters(1)).toBeCloseTo(tileSizeMeters(0) / 2, -1)
    expect(tileSizeMeters(5)).toBeCloseTo(tileSizeMeters(0) / 32, -1)
  })
})

describe('tileBoundsMeters', () => {
  it('z0 tile 0,0 spans the full extent [-ORIGIN, ORIGIN]', () => {
    const b = tileBoundsMeters(0, 0, 0)
    expect(b.minX).toBeCloseTo(-ORIGIN, -1)
    expect(b.maxX).toBeCloseTo(ORIGIN, -1)
    expect(b.minY).toBeCloseTo(-ORIGIN, -1)
    expect(b.maxY).toBeCloseTo(ORIGIN, -1)
  })

  it('z1 tile 1,0 (top-right quadrant) sits in +x, +y', () => {
    const b = tileBoundsMeters(1, 1, 0)
    expect(b.minX).toBeCloseTo(0, -1)
    expect(b.maxX).toBeCloseTo(ORIGIN, -1)
    expect(b.minY).toBeCloseTo(0, -1)
    expect(b.maxY).toBeCloseTo(ORIGIN, -1)
  })

  it('each child tile fits inside its parent', () => {
    const parent = tileBoundsMeters(3, 5, 2)
    for (const [cz, cx, cy] of tileChildren(3, 5, 2)) {
      const child = tileBoundsMeters(cz, cx, cy)
      expect(child.minX).toBeGreaterThanOrEqual(parent.minX - 1)
      expect(child.maxX).toBeLessThanOrEqual(parent.maxX + 1)
      expect(child.minY).toBeGreaterThanOrEqual(parent.minY - 1)
      expect(child.maxY).toBeLessThanOrEqual(parent.maxY + 1)
    }
  })
})

describe('tileBoundsLatLon', () => {
  it('z0 covers near-global bounds', () => {
    const b = tileBoundsLatLon(0, 0, 0)
    expect(b.minLon).toBeCloseTo(-180, 1)
    expect(b.maxLon).toBeCloseTo(180, 1)
    expect(b.minLat).toBeLessThan(-85)
    expect(b.maxLat).toBeGreaterThan(85)
  })
})

describe('tileChildren', () => {
  it('produces the 4 standard quadtree children', () => {
    const kids = tileChildren(2, 3, 1)
    expect(kids).toEqual([
      [3, 6, 2],
      [3, 7, 2],
      [3, 6, 3],
      [3, 7, 3],
    ])
  })
})
