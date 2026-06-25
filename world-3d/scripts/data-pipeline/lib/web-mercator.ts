/**
 * Web Mercator (EPSG:3857) projection + XYZ tile math.
 *
 * Pure functions, no deps. Shared contract: the future frontend
 * `src/config/projection.ts` will reuse these exact constants so that
 * pipeline and renderer agree on coordinates.
 */
export const R = 6378137.0 // WGS84 semi-major axis (meters)
export const ORIGIN = Math.PI * R // 20037508.342789244 — Web Mercator half-extent
export const MAX_LAT = 85.05112878 // Web Mercator latitude limit

export interface BoundsMeters {
  minX: number
  maxX: number
  minY: number
  maxY: number
}

export interface BoundsLatLon {
  minLon: number
  maxLon: number
  minLat: number
  maxLat: number
}

const DEG2RAD = Math.PI / 180
const RAD2DEG = 180 / Math.PI

/** Lon/lat (degrees) → Web Mercator meters (EPSG:3857). */
export function lonLatToWebMercator(lon: number, lat: number): readonly [number, number] {
  const mx = R * (lon * DEG2RAD)
  const my = R * Math.log(Math.tan(Math.PI / 4 + (lat * DEG2RAD) / 2))
  return [mx, my]
}

/** Web Mercator meters → lon/lat (degrees). */
export function webMercatorToLonLat(mx: number, my: number): readonly [number, number] {
  const lon = (mx / R) * RAD2DEG
  const lat = (2 * Math.atan(Math.exp(my / R)) - Math.PI / 2) * RAD2DEG
  return [lon, lat]
}

/** Edge length (meters) of an XYZ tile at zoom z. */
export function tileSizeMeters(z: number): number {
  return (2 * ORIGIN) / Math.pow(2, z)
}

/**
 * XYZ tile (z,x,y) → Web Mercator meter bounds.
 * y=0 is the north (top). Standard slippy-map / OSM convention (NOT TMS).
 */
export function tileBoundsMeters(z: number, x: number, y: number): BoundsMeters {
  const ts = tileSizeMeters(z)
  return {
    minX: -ORIGIN + x * ts,
    maxX: -ORIGIN + (x + 1) * ts,
    maxY: ORIGIN - y * ts,
    minY: ORIGIN - (y + 1) * ts,
  }
}

/** XYZ tile (z,x,y) → lon/lat bounds. */
export function tileBoundsLatLon(z: number, x: number, y: number): BoundsLatLon {
  const b = tileBoundsMeters(z, x, y)
  const [minLon, minLat] = webMercatorToLonLat(b.minX, b.minY)
  const [maxLon, maxLat] = webMercatorToLonLat(b.maxX, b.maxY)
  return { minLon, maxLon, minLat, maxLat }
}

/**
 * The 4 quadtree children of an XYZ tile.
 * Child order: NW, NE, SW, SE (in XYZ coords where +x=east, +y=south).
 */
export function tileChildren(
  z: number,
  x: number,
  y: number,
): readonly [number, number, number][] {
  return [
    [z + 1, 2 * x, 2 * y],
    [z + 1, 2 * x + 1, 2 * y],
    [z + 1, 2 * x, 2 * y + 1],
    [z + 1, 2 * x + 1, 2 * y + 1],
  ]
}
