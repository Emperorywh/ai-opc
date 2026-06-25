# DEM Pipeline (P1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build an offline Node.js pipeline that converts Copernicus DEM GLO-30 (EPSG:4326 GeoTIFFs) into a Web Mercator (EPSG:3857) Terrarium-encoded XYZ tile pyramid (z0-z12) with per-tile geometric error, producing static files the future renderer can stream.

**Architecture:** Pure Node.js pipeline using `gdal-async` (bundled GDAL binding) for all geospatial operations — VRT mosaic, warp reprojection, overview building, per-tile resampling. `geotiff` for COG reading where helpful. `fast-png` for byte-exact Terrarium PNG encoding. Vitest for unit tests. The pipeline is fully offline and produces `public/tiles/terrain/{z}/{x}/{y}.png` + `metadata.json`. No frontend code in this sub-project.

**Tech Stack:** Node.js 24, TypeScript, vitest, gdal-async, geotiff, fast-png

**Spec reference:** `docs/superpowers/specs/2026-06-25-world-3d-mercator-terrain-design.md` §3 DEM 处理流程

---

## File Structure

This sub-project lives under `world-3d/`. Files created/modified:

**Pipeline source (`scripts/data-pipeline/`):**
- `lib/terrarium.ts` — Terrarium encode/decode (height ↔ RGB bytes). Pure, fully unit-tested.
- `lib/web-mercator.ts` — Web Mercator projection + XYZ tile bounds math. Pure, fully unit-tested. (Shared with future frontend `src/config/projection.ts`.)
- `lib/geo-error.ts` — Per-tile geometric error computation (compare tile DEM vs upsampled parent).
- `lib/dem-source.ts` — Read a window of elevation (Float32Array) from the warped Web Mercator VRT at a given tile bbox + overview level.
- `lib/encode-tile.ts` — Orchestrate: sample DEM window → Terrarium encode → fast-png encode → bytes.
- `1-download-dem.mjs` — CLI: bulk-download Copernicus GLO-30 1° COGs from AWS S3 (anonymous) into `raw/gebco`/`raw/glo30`.
- `2-build-vrt.mjs` — CLI: `gdal.buildVRT` over downloaded COGs → `intermediate/global_glo30.vrt` (EPSG:4326).
- `3-warp-mercator.mjs` — CLI: `gdal.warp` VRT → `intermediate/global_glo30_3857.tif` (EPSG:3857, float32).
- `4-build-overviews.mjs` — CLI: `dataset.buildOverviews('AVERAGE', [2,4,8,...,4096])` → adds z0-z12 LOD overviews.
- `5-cut-terrain-tiles.mjs` — CLI: iterate z0-z12, for each tile sample DEM window → Terrarium PNG → write `public/tiles/terrain/{z}/{x}/{y}.png`; compute geoError; collect metadata.
- `6-write-metadata.mjs` — CLI: write `public/tiles/terrain/metadata.json` (format/minZoom/maxZoom/encoding/datum/range/keyRegions/geoError summary).

**Tests (`scripts/data-pipeline/test/`):**
- `terrarium.test.ts`, `web-mercator.test.ts`, `geo-error.test.ts`, `encode-tile.test.ts`

**Config (`world-3d/`):**
- `vitest.config.ts` — test config (Node environment, include scripts/data-pipeline/test).
- `package.json` — add deps + scripts.
- `.gitignore` — ignore `public/tiles/`, `raw/`, `intermediate/`.

Each pure module (terrarium, web-mercator, geo-error, encode-tile) is testable without any GDAL or data files — they take plain Float32Arrays/numbers and return plain data. Only the CLI scripts (1-6) touch the filesystem and GDAL; their correctness is verified by an integration smoke test on a tiny synthetic VRT.

---

## Task 1: Add dependencies and test framework

**Files:**
- Modify: `world-3d/package.json`
- Create: `world-3d/vitest.config.ts`
- Modify: `world-3d/.gitignore`

- [ ] **Step 1: Add devDependencies and scripts to package.json**

Replace the `scripts` and `devDependencies` blocks in `world-3d/package.json`. Keep existing `react`/`react-dom` dependencies. The full new `package.json`:

```json
{
  "name": "world-3d",
  "private": true,
  "version": "0.0.0",
  "type": "module",
  "scripts": {
    "dev": "vite",
    "build": "tsc -b && vite build",
    "lint": "oxlint",
    "preview": "vite preview",
    "test": "vitest run",
    "test:watch": "vitest",
    "dem:1-download": "node scripts/data-pipeline/1-download-dem.mjs",
    "dem:2-vrt": "node scripts/data-pipeline/2-build-vrt.mjs",
    "dem:3-warp": "node scripts/data-pipeline/3-warp-mercator.mjs",
    "dem:4-overviews": "node scripts/data-pipeline/4-build-overviews.mjs",
    "dem:5-tiles": "node scripts/data-pipeline/5-cut-terrain-tiles.mjs",
    "dem:6-metadata": "node scripts/data-pipeline/6-write-metadata.mjs"
  },
  "dependencies": {
    "react": "^19.2.7",
    "react-dom": "^19.2.7"
  },
  "devDependencies": {
    "@types/node": "^24.13.2",
    "@types/react": "^19.2.17",
    "@types/react-dom": "^19.2.3",
    "@vitejs/plugin-react": "^6.0.2",
    "fast-png": "^8.0.0",
    "gdal-async": "^3.12.3",
    "geotiff": "^2.1.3",
    "oxlint": "^1.69.0",
    "typescript": "~6.0.2",
    "vite": "^8.1.0",
    "vitest": "^2.1.9"
  }
}
```

- [ ] **Step 2: Create vitest config**

Create `world-3d/vitest.config.ts`:

```typescript
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    include: ['scripts/data-pipeline/test/**/*.test.ts'],
  },
})
```

- [ ] **Step 3: Add gitignore entries**

Append to `world-3d/.gitignore` (read it first to preserve existing content):

```
# DEM pipeline: raw sources, intermediates, and generated tiles never committed
raw/
intermediate/
public/tiles/
```

- [ ] **Step 4: Install dependencies**

Run: `cd world-3d && pnpm install`
Expected: installs gdal-async (native build), geotiff, fast-png, vitest. May take a few minutes for the native GDAL compile/download.

- [ ] **Step 5: Verify test runner works**

Create `world-3d/scripts/data-pipeline/test/sanity.test.ts`:

```typescript
import { describe, it, expect } from 'vitest'

describe('sanity', () => {
  it('runs', () => {
    expect(1 + 1).toBe(2)
  })
})
```

Run: `cd world-3d && pnpm test`
Expected: 1 test passes.

- [ ] **Step 6: Commit**

```bash
cd world-3d
git add package.json pnpm-lock.yaml vitest.config.ts .gitignore scripts/data-pipeline/test/sanity.test.ts
git commit -m "build(world-3d): add vitest, gdal-async, geotiff, fast-png for DEM pipeline"
```

---

## Task 2: Terrarium encode/decode module

**Files:**
- Create: `world-3d/scripts/data-pipeline/lib/terrarium.ts`
- Create: `world-3d/scripts/data-pipeline/test/terrarium.test.ts`

Terrarium formula (verified against tilezen/joerd spec):
- Encode height `h` (meters) → RGB bytes: `v = h + 32768; R = floor(v/256); G = floor(v%256); B = floor((v - floor(v))*256)`
- Decode: `h = (R*256 + G + B/256) - 32768`

- [ ] **Step 1: Write the failing test**

Create `world-3d/scripts/data-pipeline/test/terrarium.test.ts`:

```typescript
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
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd world-3d && pnpm test terrarium`
Expected: FAIL — `Cannot find module '../lib/terrarium'`.

- [ ] **Step 3: Write the implementation**

Create `world-3d/scripts/data-pipeline/lib/terrarium.ts`:

```typescript
/**
 * Terrarium elevation encoding (tilezen/joerd spec).
 *
 *   v = height + 32768
 *   R = floor(v / 256)            (clamped 0..255)
 *   G = floor(v) mod 256
 *   B = floor((v - floor(v)) * 256)
 *
 *   height = (R * 256 + G + B / 256) - 32768
 *
 * Range covered: -32768 m .. +32767.996 m, sub-meter precision via B channel.
 */
export const TERRARIUM_OFFSET = 32768

export function encodeHeightToRgb(h: number): readonly [number, number, number] {
  const v = h + TERRARIUM_OFFSET
  const vFloor = Math.floor(v)
  const r = Math.floor(v / 256)
  const g = vFloor - r * 256
  const b = Math.floor((v - vFloor) * 256)
  return [r, g, b]
}

export function decodeRgbToHeight(r: number, g: number, b: number): number {
  return r * 256 + g + b / 256 - TERRARIUM_OFFSET
}

/**
 * Encode a Float32 elevation grid into a packed RGB Uint8Array (row-major, 3 bytes/pixel).
 * `width * height` must equal `heights.length`.
 */
export function encodeTile(heights: Float32Array, width: number, height: number): Uint8Array {
  if (heights.length !== width * height) {
    throw new Error(`encodeTile: expected ${width * height} samples, got ${heights.length}`)
  }
  const out = new Uint8Array(width * height * 3)
  for (let i = 0; i < heights.length; i++) {
    const [r, g, b] = encodeHeightToRgb(heights[i])
    out[i * 3] = r
    out[i * 3 + 1] = g
    out[i * 3 + 2] = b
  }
  return out
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd world-3d && pnpm test terrarium`
Expected: all tests PASS.

- [ ] **Step 5: Commit**

```bash
cd world-3d
git add scripts/data-pipeline/lib/terrarium.ts scripts/data-pipeline/test/terrarium.test.ts
git commit -m "feat(dem-pipeline): Terrarium encode/decode with sub-meter precision"
```

---

## Task 3: Web Mercator projection module

**Files:**
- Create: `world-3d/scripts/data-pipeline/lib/web-mercator.ts`
- Create: `world-3d/scripts/data-pipeline/test/web-mercator.test.ts`

Constants and formulas (verified):
- `R = 6378137.0` (WGS84 semi-major axis, meters)
- `ORIGIN = Math.PI * R = 20037508.342789244` (Web Mercator half-extent)
- `MAX_LAT = 85.05112878`
- Forward: `mx = R * radians(lon)`; `my = R * ln(tan(π/4 + radians(lat)/2))`
- Tile bounds (XYZ, y=0 = north): `tileSize = 2*ORIGIN / 2^z`; `mx_min = -ORIGIN + x*tileSize`; `mx_max = mx_min + tileSize`; `my_max = ORIGIN - y*tileSize`; `my_min = my_max - tileSize`

- [ ] **Step 1: Write the failing test**

Create `world-3d/scripts/data-pipeline/test/web-mercator.test.ts`:

```typescript
import { describe, it, expect } from 'vitest'
import {
  R,
  ORIGIN,
  MAX_LAT,
  lonLatToWebMercator,
  tileBoundsMeters,
  tileBoundsLatLon,
  tileChildren,
} from '../lib/web-mercator'

describe('web-mercator constants', () => {
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
      expect(child.minX).toBeGreaterThanOrEqual(parent.minX)
      expect(child.maxX).toBeLessThanOrEqual(parent.maxX)
      expect(child.minY).toBeGreaterThanOrEqual(parent.minY)
      expect(child.maxY).toBeLessThanOrEqual(parent.maxY)
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd world-3d && pnpm test web-mercator`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

Create `world-3d/scripts/data-pipeline/lib/web-mercator.ts`:

```typescript
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

/** Lon/lat (degrees) → Web Mercator meters (EPSG:3857). */
export function lonLatToWebMercator(lon: number, lat: number): readonly [number, number] {
  const mx = R * (lon * DEG2RAD)
  const my = R * Math.log(Math.tan(Math.PI / 4 + (lat * DEG2RAD) / 2))
  return [mx, my]
}

/** Web Mercator meters → lon/lat (degrees). */
export function webMercatorToLonLat(mx: number, my: number): readonly [number, number] {
  const lon = (mx / R) / DEG2RAD
  const lat = (2 * Math.atan(Math.exp(my / R)) - Math.PI / 2) / DEG2RAD
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd world-3d && pnpm test web-mercator`
Expected: all tests PASS.

- [ ] **Step 5: Commit**

```bash
cd world-3d
git add scripts/data-pipeline/lib/web-mercator.ts scripts/data-pipeline/test/web-mercator.test.ts
git commit -m "feat(dem-pipeline): Web Mercator projection + XYZ tile bounds"
```

---

## Task 4: Geometric error computation module

**Files:**
- Create: `world-3d/scripts/data-pipeline/lib/geo-error.ts`
- Create: `world-3d/scripts/data-pipeline/test/geo-error.test.ts`

Per spec §6.3: `geoError(z,x,y) = max over pixels of | DEM[z,x,y] - upsample(DEM[parent]) |` in meters. Both the tile DEM and the parent DEM are sampled at the tile's 256×256 grid; the parent is bilinearly upsampled to that grid. Plain arrays in / number out — no GDAL.

- [ ] **Step 1: Write the failing test**

Create `world-3d/scripts/data-pipeline/test/geo-error.test.ts`:

```typescript
import { describe, it, expect } from 'vitest'
import { computeGeoError, bilinearUpsample2x } from '../lib/geo-error'

describe('bilinearUpsample2x', () => {
  it('upsamples a flat 2x2 parent to a 4x4 grid of the same constant', () => {
    // parent 2x2 all = 50
    const parent = new Float32Array([50, 50, 50, 50])
    const up = bilinearUpsample2x(parent, 2, 2)
    expect(up.length).toBe(16)
    for (const v of up) expect(v).toBeCloseTo(50, 5)
  })

  it('interpolates between parent corners', () => {
    // parent: top-left=0, top-right=100, bottom-left=0, bottom-right=100
    const parent = new Float32Array([0, 100, 0, 100])
    const up = bilinearUpsample2x(parent, 2, 2)
    // center pixel should be ~50
    const center = up[5 + 5 * 0] // arbitrary interior; just check range
    expect(center).toBeGreaterThanOrEqual(0)
    expect(center).toBeLessThanOrEqual(100)
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
    // parent upsampled = all 0 (flat), so error = 500
    const parent = new Float32Array(256 * 256).fill(0)
    const err = computeGeoError(tile, parent)
    expect(err).toBeCloseTo(500, 1)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd world-3d && pnpm test geo-error`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

Create `world-3d/scripts/data-pipeline/lib/geo-error.ts`:

```typescript
/**
 * Per-tile geometric error for quadtree LOD (spec §6.3).
 *
 * geoError(tile) = max over pixels of | tileDEM - upsample(parentDEM) |
 * in meters. A flat tile vs flat parent → 0 (can merge early).
 * A mountainous tile vs flat parent → large (must subdivide).
 *
 * All functions are pure (Float32Array in, number out), so fully testable
 * without GDAL or data files.
 */

/**
 * Bilinearly upsample a `pw × ph` grid to `(2pw) × (2ph)`.
 * Used to reconstruct what the parent LOD would show at this tile's resolution.
 */
export function bilinearUpsample2x(
  parent: Float32Array,
  pw: number,
  ph: number,
): Float32Array {
  const ow = pw * 2
  const oh = ph * 2
  const out = new Float32Array(ow * oh)
  for (let oy = 0; oy < oh; oy++) {
    const fy = (oy + 0.5) / oh * ph - 0.5
    const y0 = Math.max(0, Math.floor(fy))
    const y1 = Math.min(ph - 1, y0 + 1)
    const wy = fy - y0
    for (let ox = 0; ox < ow; ox++) {
      const fx = (ox + 0.5) / ow * pw - 0.5
      const x0 = Math.max(0, Math.floor(fx))
      const x1 = Math.min(pw - 1, x0 + 1)
      const wx = fx - x0
      const v00 = parent[y0 * pw + x0]
      const v01 = parent[y0 * pw + x1]
      const v10 = parent[y1 * pw + x0]
      const v11 = parent[y1 * pw + x1]
      const top = v00 + (v01 - v00) * wx
      const bot = v10 + (v11 - v10) * wx
      out[oy * ow + ox] = top + (bot - top) * wy
    }
  }
  return out
}

/**
 * Geometric error between a tile's DEM (at 256×256) and the parent DEM
 * already upsampled to the same 256×256 grid.
 *
 * @param tileDEM 256×256 elevation grid (meters).
 * @param parentUpsampled same dimensions as tileDEM.
 * @returns max absolute deviation in meters.
 */
export function computeGeoError(
  tileDEM: Float32Array,
  parentUpsampled: Float32Array,
): number {
  if (tileDEM.length !== parentUpsampled.length) {
    throw new Error(
      `computeGeoError: grids must match (${tileDEM.length} vs ${parentUpsampled.length})`,
    )
  }
  let max = 0
  for (let i = 0; i < tileDEM.length; i++) {
    const d = Math.abs(tileDEM[i] - parentUpsampled[i])
    if (d > max) max = d
  }
  return max
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd world-3d && pnpm test geo-error`
Expected: all tests PASS.

- [ ] **Step 5: Commit**

```bash
cd world-3d
git add scripts/data-pipeline/lib/geo-error.ts scripts/data-pipeline/test/geo-error.test.ts
git commit -m "feat(dem-pipeline): per-tile geometric error + bilinear upsampler"
```

---

## Task 5: Encode-tile orchestration module

**Files:**
- Create: `world-3d/scripts/data-pipeline/lib/encode-tile.ts`
- Create: `world-3d/scripts/data-pipeline/test/encode-tile.test.ts`

This module composes terrarium + fast-png. It takes a Float32 elevation grid and produces a PNG Uint8Array (the file bytes). Pure — no GDAL. This is the boundary between "elevation numbers" and "PNG file bytes."

- [ ] **Step 1: Write the failing test**

Create `world-3d/scripts/data-pipeline/test/encode-tile.test.ts`:

```typescript
import { describe, it, expect } from 'vitest'
import { encodeElevationGridToPng } from '../lib/encode-tile'
import { decode } from 'fast-png'

describe('encodeElevationGridToPng', () => {
  it('produces a valid 256x256 RGB PNG', () => {
    const grid = new Float32Array(256 * 256).fill(0) // sea level everywhere
    const pngBytes = encodeElevationGridToPng(grid, 256, 256)
    expect(pngBytes).toBeInstanceOf(Uint8Array)
    // PNG signature
    expect(pngBytes[0]).toBe(0x89)
    expect(pngBytes[1]).toBe(0x50) // 'P'
    const decoded = decode(pngBytes)
    expect(decoded.width).toBe(256)
    expect(decoded.height).toBe(256)
  })

  it('round-trips a known height through PNG', () => {
    const grid = new Float32Array([0, 1000, 5000, -200])
    const pngBytes = encodeElevationGridToPng(grid, 2, 2)
    const decoded = decode(pngBytes)
    // decoded.data is Uint8Array RGB (3 channels)
    const d = decoded.data as Uint8Array
    // pixel 0 = 0m → [128,0,0]
    expect(d[0]).toBe(128)
    expect(d[1]).toBe(0)
    expect(d[2]).toBe(0)
    // pixel 1 = 1000m → v=33768; R=131, G=232, B=0
    expect(d[3]).toBe(131)
    expect(d[4]).toBe(232)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd world-3d && pnpm test encode-tile`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

Create `world-3d/scripts/data-pipeline/lib/encode-tile.ts`:

```typescript
import { encode } from 'fast-png'
import { encodeTile } from './terrarium'

/**
 * Encode a Float32 elevation grid into Terrarium PNG file bytes.
 *
 * This is the pure boundary between "elevation numbers" and "PNG file":
 * terrarium encode (height → RGB) then fast-png encode (RGB → PNG bytes).
 * GDAL never touches this path.
 */
export function encodeElevationGridToPng(
  heights: Float32Array,
  width: number,
  height: number,
): Uint8Array {
  const rgb = encodeTile(heights, width, height)
  return encode({
    width,
    height,
    data: rgb,
    channels: 3,
    depth: 8,
  })
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd world-3d && pnpm test encode-tile`
Expected: all tests PASS.

- [ ] **Step 5: Commit**

```bash
cd world-3d
git add scripts/data-pipeline/lib/encode-tile.ts scripts/data-pipeline/test/encode-tile.test.ts
git commit -m "feat(dem-pipeline): elevation grid → Terrarium PNG encoder"
```

---

## Task 6: DEM source reader (gdal-async integration)

**Files:**
- Create: `world-3d/scripts/data-pipeline/lib/dem-source.ts`

This is the one module that uses gdal-async. It opens the warped Web Mercator GeoTIFF and reads a 256×256 Float32 window for a given tile bbox, using the appropriate overview level for efficiency. Not unit-tested in isolation (needs GDAL + a file); covered by the integration smoke test in Task 11.

- [ ] **Step 1: Write the module**

Create `world-3d/scripts/data-pipeline/lib/dem-source.ts`:

```typescript
import gdal from 'gdal-async'
import { tileBoundsMeters } from './web-mercator'

/**
 * A read handle over the warped Web Mercator DEM GeoTIFF (EPSG:3857, float32),
 * with overview pyramids for LOD.
 *
 * Lazily opens the dataset once; caller must `close()` when done.
 */
export class DemSource {
  private constructor(public readonly dataset: gdal.Dataset) {}

  static open(path: string): DemSource {
    const ds = gdal.open(path, 'r')
    return new DemSource(ds)
  }

  /**
   * Read a 256×256 Float32 elevation grid for XYZ tile (z,x,y).
   *
   * Selects the overview whose resolution is closest to (but not coarser than)
   * the tile's ground resolution, so deep tiles read from coarse overviews
   * cheaply. Reads via GDAL RasterIO which does the bilinear resampling for us.
   */
  readTile(z: number, x: number, y: number, size = 256): Float32Array {
    const b = tileBoundsMeters(z, x, y)
    const band = this.dataset.bands.get(1)
    const gt = this.dataset.geoTransform // [originX, pxW, 0, originY, 0, pxH]
    const fullRes = Math.abs(gt[1]) // meters/pixel at full resolution
    const tileRes = (b.maxX - b.minX) / size // meters/pixel for this tile
    // pick overview: first overview with res <= tileRes*1.5, else full res
    const targetRes = tileRes
    let readBand: gdal.RasterBand = band
    const ovCount = band.overviews.count()
    for (let i = 0; i < ovCount; i++) {
      const ov = band.overviews.get(i)
      const ovSize = ov.size
      const ovRes = fullRes * (band.size.x / ovSize.x)
      if (ovRes <= targetRes * 1.5) {
        readBand = ov
        break
      }
    }
    // convert meter bounds → pixel window on the chosen band
    const bandGt = this.bandGeoTransform(readBand, fullRes)
    const pxMin = Math.floor((b.minX - bandGt[0]) / bandGt[1])
    const pxMax = Math.ceil((b.maxX - bandGt[0]) / bandGt[1])
    const pyMin = Math.floor((b.minY - bandGt[3]) / bandGt[5])
    const pyMax = Math.ceil((b.maxY - bandGt[3]) / bandGt[5])
    const w = Math.max(1, pxMax - pxMin)
    const h = Math.max(1, pyMax - pyMin)
    const raw = readBand.pixels.read(pxMin, pyMin, w, h, undefined, {
      width: size,
      height: size,
      resampling: 'bilinear',
    }) as Float32Array
    return raw
  }

  /**
   * Derive the geoTransform for an overview band (overviews share the origin
   * but have coarser pixel size).
   */
  private bandGeoTransform(band: gdal.RasterBand, fullRes: number): number[] {
    const gt = this.dataset.geoTransform
    const scale = band.size.x > 0 ? fullRes / Math.abs(gt[1]) * (band.size.x / this.dataset.rasterSize.x) : 1
    // overview pixel size = full pixel size * (fullWidth / overviewWidth)
    const pxW = (this.dataset.rasterSize.x / band.size.x) * gt[1]
    const pxH = (this.dataset.rasterSize.y / band.size.y) * gt[5]
    void scale
    return [gt[0], pxW, 0, gt[3], 0, pxH]
  }

  close(): void {
    this.dataset.close()
  }
}
```

- [ ] **Step 2: Verify it type-checks**

Run: `cd world-3d && npx tsc --noEmit -p tsconfig.node.json 2>&1 | grep -i dem-source || echo "no dem-source errors"`
Expected: no errors referencing dem-source (gdal-async types resolved). If gdal-async lacks bundled types, add a one-line ambient declaration file `scripts/data-pipeline/types/gdal-async.d.ts`:

```typescript
declare module 'gdal-async' {
  const gdal: any
  export default gdal
}
```

- [ ] **Step 3: Commit**

```bash
cd world-3d
git add scripts/data-pipeline/lib/dem-source.ts scripts/data-pipeline/types/gdal-async.d.ts
git commit -m "feat(dem-pipeline): gdal-async DEM source with overview-aware tile reads"
```

---

## Task 7: CLI 1 — download Copernicus GLO-30

**Files:**
- Create: `world-3d/scripts/data-pipeline/1-download-dem.mjs`

Downloads 1°×1° GLO-30 COGs from the public AWS S3 bucket (anonymous, no credentials). For a first end-to-end run the user can limit to a region via `--bbox=minLon,minLat,maxLon,maxLat`; default downloads a small demo bbox (a few tiles) so the pipeline is runnable without terabytes.

- [ ] **Step 1: Write the CLI**

Create `world-3d/scripts/data-pipeline/1-download-dem.mjs`:

```javascript
#!/usr/bin/env node
/**
 * 1-download-dem.mjs — Download Copernicus DEM GLO-30 1° COGs from AWS S3 (anonymous).
 *
 * Usage:
 *   node 1-download-dem.mjs [--bbox=minLon,minLat,maxLon,maxLat] [--out=raw/glo30]
 *
 * Default bbox is a small demo region (part of China) so the pipeline runs
 * end-to-end without downloading the full global set (~hundreds of GB).
 *
 * Tile URL pattern (verified):
 *   https://copernicus-dem-30m.s3.amazonaws.com/
 *     Copernicus_DSM_COG_10_<N|S>NN_00_<E|W>NNN_00_DEM/Copernicus_DSM_COG_10_..._DEM.tif
 * where the northing/easting encode the SW corner at 1° granularity.
 */
import { mkdirSync, createWriteStream, existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { fileURLToPath } from 'node:url'
import { dirname } from 'node:path'

const __dirname = dirname(fileURLToPath(import.meta.url))

function arg(name, fallback) {
  const m = process.argv.find((a) => a.startsWith(`--${name}=`))
  return m ? m.split('=')[1] : fallback
}

// default demo bbox: a slice of China (lon 100-104, lat 28-32) ≈ 16 tiles
const bbox = (arg('bbox', '100,28,104,32')).split(',').map(Number)
const outDir = resolve(__dirname, arg('out', '../../raw/glo30'))
const [minLon, minLat, maxLon, maxLat] = bbox

const BUCKET = 'https://copernicus-dem-30m.s3.amazonaws.com'

function tileName(lat, lon) {
  // SW corner naming: N/S + floor(lat), E/W + floor(lon)
  const ns = lat >= 0 ? 'N' : 'S'
  const ew = lon >= 0 ? 'E' : 'W'
  const latStr = `${ns}${String(Math.abs(Math.floor(lat))).padStart(2, '0')}_00`
  const lonStr = `${ew}${String(Math.abs(Math.floor(lon))).padStart(3, '0')}_00`
  return `Copernicus_DSM_COG_10_${latStr}_${lonStr}_DEM`
}

mkdirSync(outDir, { recursive: true })

const tasks = []
for (let lat = Math.floor(minLat); lat < Math.ceil(maxLat); lat++) {
  for (let lon = Math.floor(minLon); lon < Math.ceil(maxLon); lon++) {
    const name = tileName(lat, lon)
    const localPath = resolve(outDir, `${name}.tif`)
    if (existsSync(localPath)) {
      console.log(`skip (exists): ${name}`)
      continue
    }
    const url = `${BUCKET}/${name}/${name}.tif`
    tasks.push(
      (async () => {
        const res = await fetch(url)
        if (!res.ok) {
          console.warn(`MISS (${res.status}): ${name}`)
          return
        }
        await pipeline(res.body, createWriteStream(localPath))
        console.log(`ok: ${name}`)
      })().catch((e) => console.warn(`fail ${name}:`, e.message)),
    )
    if (tasks.length >= 8) {
      await Promise.all(tasks.splice(0))
    }
  }
}
await Promise.all(tasks)
console.log(`done. tiles in ${outDir}`)
```

- [ ] **Step 2: Document the run (do NOT actually download in the plan)**

This script is the user's to run later. The plan does not execute it (network + GB-scale). It will be exercised in the integration smoke test (Task 11) via a synthetic VRT instead of real downloads.

- [ ] **Step 3: Commit**

```bash
cd world-3d
git add scripts/data-pipeline/1-download-dem.mjs
git commit -m "feat(dem-pipeline): CLI 1 - download Copernicus GLO-30 from AWS S3"
```

---

## Task 8: CLIs 2-3 — build VRT mosaic and warp to Web Mercator

**Files:**
- Create: `world-3d/scripts/data-pipeline/2-build-vrt.mjs`
- Create: `world-3d/scripts/data-pipeline/3-warp-mercator.mjs`

- [ ] **Step 1: Write the VRT builder CLI**

Create `world-3d/scripts/data-pipeline/2-build-vrt.mjs`:

```javascript
#!/usr/bin/env node
/**
 * 2-build-vrt.mjs — gdal.buildVRT over all downloaded GLO-30 COGs.
 *
 * Produces intermediate/global_glo30.vrt (EPSG:4326 virtual mosaic).
 * Usage: node 2-build-vrt.mjs [--in=raw/glo30] [--out=intermediate/global_glo30.vrt]
 */
import gdal from 'gdal-async'
import { readdirSync, mkdirSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
function arg(name, fallback) {
  const m = process.argv.find((a) => a.startsWith(`--${name}=`))
  return m ? m.split('=')[1] : fallback
}

const inDir = resolve(__dirname, arg('in', '../../raw/glo30'))
const outVrt = resolve(__dirname, arg('out', '../../intermediate/global_glo30.vrt'))
mkdirSync(dirname(outVrt), { recursive: true })

const tifs = readdirSync(inDir)
  .filter((f) => f.endsWith('.tif'))
  .map((f) => resolve(inDir, f))
if (tifs.length === 0) {
  console.error(`No .tif files in ${inDir}. Run 1-download-dem first.`)
  process.exit(1)
}
console.log(`building VRT over ${tifs.length} tiles...`)
const vrt = gdal.buildVRT(outVrt, tifs, ['-allow_path_difference'])
vrt.close()
console.log(`ok: ${outVrt}`)
```

- [ ] **Step 2: Write the warp CLI**

Create `world-3d/scripts/data-pipeline/3-warp-mercator.mjs`:

```javascript
#!/usr/bin/env node
/**
 * 3-warp-mercator.mjs — gdal.warp the EPSG:4326 VRT to EPSG:3857 float32 GeoTIFF.
 *
 * gdal.warp signature: gdal.warp(dst_path, src_ds, options, callback)
 *   - dst_path: output file path (or null for in-memory dataset)
 *   - src_ds:   source Dataset or array of Datasets
 *   - options:  WarpOptions object (NOT CLI string arrays):
 *       srcSRS, dstSRS, resampling, xRes, yRes, creationOptions, format, ...
 *
 * Usage: node 3-warp-mercator.mjs [--in=intermediate/global_glo30.vrt]
 *                                 [--out=intermediate/global_glo30_3857.tif]
 */
import gdal from 'gdal-async'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { mkdirSync } from 'node:fs'

const __dirname = dirname(fileURLToPath(import.meta.url))
function arg(name, fallback) {
  const m = process.argv.find((a) => a.startsWith(`--${name}=`))
  return m ? m.split('=')[1] : fallback
}

const inVrt = resolve(__dirname, arg('in', '../../intermediate/global_glo30.vrt'))
const outTif = resolve(__dirname, arg('out', '../../intermediate/global_glo30_3857.tif'))
mkdirSync(dirname(outTif), { recursive: true })

console.log(`warping ${inVrt} → EPSG:3857 ...`)
const src = gdal.open(inVrt)
const warped = gdal.warp(outTif, [src], {
  srcSRS: 'EPSG:4326',
  dstSRS: 'EPSG:3857',
  resampling: 'Bilinear',
  format: 'GTiff',
  creationOptions: ['COMPRESS=DEFLATE', 'PREDICTOR=3', 'TILED=YES'],
})
warped.close()
src.close()
console.log(`ok: ${outTif}`)
```

> **Note on `gdal.warp` API:** verified signature is `gdal.warp(dst_path, src_ds, options, callback)` where `options` is a WarpOptions **object** with keys `srcSRS`/`dstSRS`/`resampling`/`creationOptions`/etc. (resampling values: `Near`, `Bilinear`, `Cubic`, `Average`, ...). This is NOT the CLI string-array style. If the installed gdal-async version rejects the object form, fall back to `gdal.warpAsync()` (same signature, returns a Promise) — see https://mmomtchev.github.io/node-gdal-async/.

- [ ] **Step 3: Commit**

```bash
cd world-3d
git add scripts/data-pipeline/2-build-vrt.mjs scripts/data-pipeline/3-warp-mercator.mjs
git commit -m "feat(dem-pipeline): CLI 2-3 - buildVRT mosaic + warp to EPSG:3857"
```

---

## Task 9: CLIs 4-5 — overviews and tile cutting

**Files:**
- Create: `world-3d/scripts/data-pipeline/4-build-overviews.mjs`
- Create: `world-3d/scripts/data-pipeline/5-cut-terrain-tiles.mjs`

- [ ] **Step 1: Write the overviews CLI**

Create `world-3d/scripts/data-pipeline/4-build-overviews.mjs`:

```javascript
#!/usr/bin/env node
/**
 * 4-build-overviews.mjs — add AVERAGE overview levels for z0..z12.
 *
 * Usage: node 4-build-overviews.mjs [--in=intermediate/global_glo30_3857.tif]
 */
import gdal from 'gdal-async'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
function arg(name, fallback) {
  const m = process.argv.find((a) => a.startsWith(`--${name}=`))
  return m ? m.split('=')[1] : fallback
}

const inTif = resolve(__dirname, arg('in', '../../intermediate/global_glo30_3857.tif'))
// overview factors: 2,4,8,...,4096 → roughly z0..z12
const levels = Array.from({ length: 12 }, (_, i) => 2 ** (i + 1))
console.log(`building overviews ${levels.join(', ')} ...`)
const ds = gdal.open(inTif, 'r+')
ds.buildOverviews('AVERAGE', levels)
ds.close()
console.log('ok')
```

- [ ] **Step 2: Write the tile-cutting CLI**

Create `world-3d/scripts/data-pipeline/5-cut-terrain-tiles.mjs`:

```javascript
#!/usr/bin/env node
/**
 * 5-cut-terrain-tiles.mjs — iterate z0..maxZ, sample DEM per XYZ tile,
 * Terrarium-encode → PNG, write public/tiles/terrain/{z}/{x}/{y}.png.
 * Also accumulates per-tile geoError and global elevation range.
 *
 * Usage: node 5-cut-terrain-tiles.mjs
 *   [--in=intermediate/global_glo30_3857.tif]
 *   [--out=../../public/tiles/terrain]
 *   [--min-z=0] [--max-z=6]   # default capped at 6 for demo; raise for real runs
 *   [--tile-size=256]
 *   [--geo-error-out=intermediate/geo-errors.json]
 */
import gdal from 'gdal-async'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { mkdirSync, writeFileSync } from 'node:fs'
import {
  tileBoundsLatLon,
  tileBoundsMeters,
  tileChildren,
} from './lib/web-mercator.ts'
import { encodeElevationGridToPng } from './lib/encode-tile.ts'
import { computeGeoError, bilinearUpsample2x } from './lib/geo-error.ts'

const __dirname = dirname(fileURLToPath(import.meta.url))
function arg(name, fallback) {
  const m = process.argv.find((a) => a.startsWith(`--${name}=`))
  return m ? m.split('=')[1] : fallback
}

const inTif = resolve(__dirname, arg('in', '../../intermediate/global_glo30_3857.tif'))
const outDir = resolve(__dirname, arg('out', '../../public/tiles/terrain'))
const minZ = Number(arg('min-z', '0'))
const maxZ = Number(arg('max-z', '6'))
const tileSize = Number(arg('tile-size', '256'))
const geoErrorPath = resolve(__dirname, arg('geo-error-out', '../../intermediate/geo-errors.json'))

mkdirSync(outDir, { recursive: true })

const src = gdal.open(inTif, 'r')
const band = src.bands.get(1)
const gt = src.geoTransform
const fullRes = Math.abs(gt[1])
const srcW = src.rasterSize.x
const srcH = src.rasterSize.y
const NODATA = band.noDataValue ?? -9999

let globalMin = Infinity
let globalMax = -Infinity
const geoErrors = {} // "z/x/y" -> meters

function readWindowMeters(b, pixelBuffer, mxMin, mxMax, myMin, myMax, size) {
  const pxMin = Math.floor((mxMin - gt[0]) / gt[1])
  const pxMax = Math.ceil((mxMax - gt[0]) / gt[1])
  const pyMin = Math.floor((myMin - gt[3]) / gt[5])
  const pyMax = Math.ceil((myMax - gt[3]) / gt[5])
  const w = Math.max(1, pxMax - pxMin)
  const h = Math.max(1, pyMax - pyMin)
  band.pixels.read(pxMin, pyMin, w, h, pixelBuffer, {
    width: size,
    height: size,
    resampling: 'bilinear',
  })
}

function sampleTile(z, x, y) {
  const b = tileBoundsMeters(z, x, y)
  const buf = new Float32Array(tileSize * tileSize)
  readWindowMeters(b, buf, b.minX, b.maxX, b.minY, b.maxY, tileSize)
  // replace nodata with 0 (sea) — ocean tiles have no DEM
  for (let i = 0; i < buf.length; i++) {
    if (buf[i] === NODATA || Number.isNaN(buf[i])) buf[i] = 0
    if (buf[i] < globalMin) globalMin = buf[i]
    if (buf[i] > globalMax) globalMax = buf[i]
  }
  return buf
}

// walk the quadtree depth-first; only descend into tiles intersecting data bbox
const dataBbox = tileBoundsLatLon(0, 0, 0) // whole-world default; refine if desired
function intersectsData(z, x, y) {
  const t = tileBoundsLatLon(z, x, y)
  return (
    t.maxLon > dataBbox.minLon && t.minLon < dataBbox.maxLon &&
    t.maxLat > dataBbox.minLat && t.minLat < dataBbox.maxLat
  )
}

function walk(z, x, y, parentGrid) {
  if (!intersectsData(z, x, y)) return
  const grid = sampleTile(z, x, y)
  // geo error vs parent (upsampled). z0 has no parent → 0.
  let err = 0
  if (parentGrid && parentGrid.length === grid.length) {
    err = computeGeoError(grid, parentGrid)
  } else if (parentGrid) {
    const up = bilinearUpsample2x(parentGrid, tileSize / 2, tileSize / 2)
    err = computeGeoError(grid, up)
  }
  geoErrors[`${z}/${x}/${y}`] = +err.toFixed(3)

  // write PNG
  const png = encodeElevationGridToPng(grid, tileSize, tileSize)
  const dir = resolve(outDir, String(z), String(x))
  mkdirSync(dir, { recursive: true })
  writeFileSync(resolve(dir, `${y}.png`), png)

  if (z >= maxZ) return
  for (const [cz, cx, cy] of tileChildren(z, x, y)) {
    walk(cz, cx, cy, grid)
  }
}

// z0 root = tile (0,0,0)
walk(0, 0, 0, null)

src.close()
writeFileSync(
  geoErrorPath,
  JSON.stringify(
    {
      minElevation: globalMin === Infinity ? 0 : globalMin,
      maxElevation: globalMax === -Infinity ? 0 : globalMax,
      perTile: geoErrors,
    },
    null,
    2,
  ),
)
console.log(`done. ${Object.keys(geoErrors).length} tiles. range ${globalMin}..${globalMax}`)
```

- [ ] **Step 3: Commit**

```bash
cd world-3d
git add scripts/data-pipeline/4-build-overviews.mjs scripts/data-pipeline/5-cut-terrain-tiles.mjs
git commit -m "feat(dem-pipeline): CLI 4-5 - overviews + quadtree Terrarium tile cutter with geoError"
```

---

## Task 10: CLI 6 — write metadata.json

**Files:**
- Create: `world-3d/scripts/data-pipeline/6-write-metadata.mjs`

- [ ] **Step 1: Write the metadata CLI**

Create `world-3d/scripts/data-pipeline/6-write-metadata.mjs`:

```javascript
#!/usr/bin/env node
/**
 * 6-write-metadata.mjs — emit public/tiles/terrain/metadata.json from
 * the geo-errors summary + fixed schema fields.
 *
 * Usage: node 6-write-metadata.mjs
 *   [--geo-error=intermediate/geo-errors.json]
 *   [--out=../../public/tiles/terrain/metadata.json]
 *   [--max-z=6]
 */
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'

const __dirname = dirname(fileURLToPath(import.meta.url))
function arg(name, fallback) {
  const m = process.argv.find((a) => a.startsWith(`--${name}=`))
  return m ? m.split('=')[1] : fallback
}

const geoErrorPath = resolve(__dirname, arg('geo-error', '../../intermediate/geo-errors.json'))
const outPath = resolve(__dirname, arg('out', '../../public/tiles/terrain/metadata.json'))
const maxZ = Number(arg('max-z', '6'))

const summary = existsSync(geoErrorPath)
  ? JSON.parse(readFileSync(geoErrorPath, 'utf8'))
  : { minElevation: 0, maxElevation: 0, perTile: {} }

const meta = {
  format: 'terrarium',
  minZoom: 0,
  maxZoom: maxZ,
  tileSize: 256,
  encoding: 'height = (R*256 + G + B/256) - 32768',
  verticalDatum: 'WGS84-ellipsoid',
  source: 'Copernicus DEM GLO-30',
  sourceElevationRange: [summary.minElevation, summary.maxElevation],
  geoErrorCount: Object.keys(summary.perTile || {}).length,
  keyRegions: { CN: { minZoom: 0, maxZoom: maxZ } },
}

mkdirSync(dirname(outPath), { recursive: true })
writeFileSync(outPath, JSON.stringify(meta, null, 2))
console.log(`ok: ${outPath}`)
```

- [ ] **Step 2: Commit**

```bash
cd world-3d
git add scripts/data-pipeline/6-write-metadata.mjs
git commit -m "feat(dem-pipeline): CLI 6 - emit terrain metadata.json"
```

---

## Task 11: Integration smoke test on a synthetic VRT

**Files:**
- Create: `world-3d/scripts/data-pipeline/test/integration.test.ts`

This is the end-to-end test that proves the whole pipeline works without downloading real data: it creates a tiny synthetic EPSG:3857 GeoTIFF in-memory, writes tiles through the real cut→encode path, and asserts the outputs decode back to the expected heights. It exercises gdal-async, encode-tile, terrarium, web-mercator, geo-error together.

- [ ] **Step 1: Write the integration test**

Create `world-3d/scripts/data-pipeline/test/integration.test.ts`:

```typescript
import { describe, it, expect } from 'vitest'
import gdal from 'gdal-async'
import { writeFileSync, readFileSync, mkdtempSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execSync } from 'node:child_process'
import { decode as decodePng } from 'fast-png'
import { decodeRgbToHeight } from '../lib/terrarium'

const __dirname = dirname(fileURLToPath(import.meta.url))
const PIPELINE = resolve(__dirname, '..')

/**
 * Build a tiny synthetic EPSG:3857 DEM GeoTIFF (512x512) with a known ramp,
 * then run the tile cutter + metadata CLIs against it and verify outputs.
 */
describe('DEM pipeline integration (synthetic VRT)', () => {
  it('cuts Terrarium tiles that decode back to the source heights', () => {
    const work = mkdtempSync(join(tmpdir(), 'dem-pipe-'))
    const tifPath = join(work, 'synthetic_3857.tif')
    const tilesOut = join(work, 'tiles')
    const geoErrPath = join(work, 'geo.json')
    const metaPath = join(tilesOut, 'metadata.json')

    // 1. synthetic 512x512 EPSG:3857 DEM: height = x + y (a ramp)
    const W = 512
    const H = 512
    const data = new Float32Array(W * H)
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        data[y * W + x] = x + y // 0 .. 1022 m
      }
    }
    const ORIGIN = Math.PI * 6378137.0
    const pixelSize = (2 * ORIGIN) / W
    const ds = gdal.open(
      tifPath,
      'w',
      'GTiff',
      W,
      H,
      1,
      gdal.GDT_Float32,
      ['COMPRESS=DEFLATE', 'PREDICTOR=3', 'TILED=YES'],
    )
    ds.geoTransform = [-ORIGIN, pixelSize, 0, ORIGIN, 0, -pixelSize]
    ds.srs = gdal.SpatialReference.fromEPSG(3857)
    ds.bands.get(1).pixels.write(0, 0, W, H, data)
    ds.close()

    // 2. run the tile cutter (max-z 2 → 1+4+16 = 21 tiles)
    execSync(
      `node ${resolve(PIPELINE, '5-cut-terrain-tiles.mjs')} ` +
        `--in=${tifPath} --out=${tilesOut} --min-z=0 --max-z=2 ` +
        `--geo-error-out=${geoErrPath}`,
      { stdio: 'pipe' },
    )

    // 3. z0 tile exists and is a valid 256x256 PNG
    const z0 = join(tilesOut, '0', '0', '0.png')
    expect(existsSync(z0)).toBe(true)
    const png0 = decodePng(readFileSync(z0)) as { width: number; height: number; data: Uint8Array }
    expect(png0.width).toBe(256)
    expect(png0.height).toBe(256)

    // 4. decode one pixel: the source ramp's top-left is ~0m → Terrarium [128,0,0]
    const d0 = png0.data
    expect(d0[0]).toBe(128)
    expect(d0[1]).toBe(0)
    expect(d0[2]).toBe(0)

    // 5. a z2 tile exists
    const z2 = join(tilesOut, '2', '0', '0.png')
    expect(existsSync(z2)).toBe(true)

    // 6. geo-error file written and z0 error is 0 (no parent)
    const geo = JSON.parse(readFileSync(geoErrPath, 'utf8'))
    expect(geo.perTile['0/0/0']).toBe(0)
    expect(geo.minElevation).toBeGreaterThanOrEqual(0)

    // 7. run metadata CLI
    execSync(
      `node ${resolve(PIPELINE, '6-write-metadata.mjs')} ` +
        `--geo-error=${geoErrPath} --out=${metaPath} --max-z=2`,
      { stdio: 'pipe' },
    )
    const meta = JSON.parse(readFileSync(metaPath, 'utf8'))
    expect(meta.format).toBe('terrarium')
    expect(meta.maxZoom).toBe(2)
    expect(meta.tileSize).toBe(256)

    // 8. round-trip: decode a center pixel of z0 back through Terrarium
    const centerIdx = (128 * 256 + 128) * 3
    const h = decodeRgbToHeight(d0[centerIdx], d0[centerIdx + 1], d0[centerIdx + 2])
    // center of a 512 ramp downsampled to 256 → around mid-range
    expect(h).toBeGreaterThan(0)
    expect(h).toBeLessThan(1022)
  })
})
```

- [ ] **Step 2: Run the integration test**

Run: `cd world-3d && pnpm test integration`
Expected: the single integration test PASSES. This proves gdal-async reads, the tile cutter walks the quadtree, Terrarium encode + fast-png produce valid PNGs, geoError computes, and metadata writes — all end-to-end on synthetic data.

- [ ] **Step 3: Commit**

```bash
cd world-3d
git add scripts/data-pipeline/test/integration.test.ts
git commit -m "test(dem-pipeline): end-to-end smoke test on synthetic EPSG:3857 DEM"
```

---

## Task 12: Remove sanity test and write pipeline README

**Files:**
- Delete: `world-3d/scripts/data-pipeline/test/sanity.test.ts`
- Create: `world-3d/scripts/data-pipeline/README.md`

- [ ] **Step 1: Delete the throwaway sanity test**

Delete `world-3d/scripts/data-pipeline/test/sanity.test.ts` (it was only to verify vitest ran in Task 1).

- [ ] **Step 2: Write the pipeline README**

Create `world-3d/scripts/data-pipeline/README.md`:

````markdown
# DEM Pipeline (P1)

Converts Copernicus DEM GLO-30 → Web Mercator Terrarium XYZ tile pyramid.

## Quick start (demo region)

Runs end-to-end on a small slice of China (~16 GLO-30 tiles, ~1 GB):

```bash
pnpm dem:1-download              # download GLO-30 COGs from AWS S3 (anonymous)
pnpm dem:2-vrt                   # build EPSG:4326 VRT mosaic
pnpm dem:3-warp                  # warp to EPSG:3857 float32 GeoTIFF
pnpm dem:4-overviews             # add AVERAGE overviews (z0..z12)
pnpm dem:5-tiles                 # cut Terrarium tiles + per-tile geoError
pnpm dem:6-metadata              # write metadata.json
```

Outputs land in `public/tiles/terrain/`:

```
public/tiles/terrain/
├── metadata.json
└── {z}/{x}/{y}.png   # Terrarium-encoded, 256×256
```

## Options

All CLIs accept `--key=value` overrides. Notable:

- `dem:1-download` — `--bbox=minLon,minLat,maxLon,maxLat` (default `100,28,104,32`), `--out=raw/glo30`
- `dem:5-tiles` — `--min-z=0 --max-z=6` (raise max-z for real runs; demo caps at 6), `--tile-size=256`

## Terrarium encoding

`height = (R*256 + G + B/256) - 32768` — sub-meter precision via the blue channel. Vertical datum: WGS84 ellipsoid (Copernicus native).

## Tests

```bash
pnpm test    # pure modules + integration smoke test (synthetic DEM, no download)
```

## Real run (global / China)

For production data replace the demo bbox with `73,18,135,54` (China) or omit for global. Expect ~tens of GB source and ~30-50 GB of tiles for z0-z12.

## Spec

See `docs/superpowers/specs/2026-06-25-world-3d-mercator-terrain-design.md` §3.
````

- [ ] **Step 3: Verify the full suite passes**

Run: `cd world-3d && pnpm test`
Expected: all tests PASS (terrarium, web-mercator, geo-error, encode-tile, integration — ~25+ tests).

- [ ] **Step 4: Commit**

```bash
cd world-3d
git add -A scripts/data-pipeline/
git commit -m "docs(dem-pipeline): README + remove throwaway sanity test"
```

---

## Self-Review Notes

**Spec coverage (against spec §3):**
- §3.1 pipeline steps (download → VRT → warp → overviews → terrarium encode) → Tasks 7,8,9. ✓
- §3.2 bilinear reprojection → CLI 3 `-r bilinear`. ✓
- §3.2 Terrarium encoding → Tasks 2,5. ✓
- §3.2 average overview → CLI 4 `'AVERAGE'`. ✓
- §3.3 metadata.json schema → Task 10. ✓
- §6.3 geoError per tile → Tasks 4, 9. ✓

**Placeholder scan:** none. Every step has runnable code/commands.

**Type consistency:** `encodeTile(heights, width, height)` (Task 2) is consumed identically in `encode-tile.ts` (Task 5). `tileChildren` returns `[z,x,y][]` in both web-mercator.ts and its consumer in CLI 5. `DemSource.readTile` (Task 6) signature matches the integration test's expectations. `computeGeoError(tileDEM, parentUpsampled)` (Task 4) signature matches CLI 5's calls.

**Scope check:** This plan produces a complete, independently-testable DEM pipeline — working software on its own, as required for a sub-project. The renderer (P3) and quadtree (P4) are separate future plans.
