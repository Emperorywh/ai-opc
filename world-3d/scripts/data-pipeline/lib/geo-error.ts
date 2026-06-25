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
    // sample at the center of each output cell, mapped to parent coordinates
    const fy = ((oy + 0.5) / oh) * ph - 0.5
    const y0 = Math.min(ph - 1, Math.max(0, Math.floor(fy)))
    const y1 = Math.min(ph - 1, y0 + 1)
    // weight clamped to [0,1] so edge samples don't extrapolate outside the parent range
    const wyRaw = fy - y0
    const wy = Math.min(1, Math.max(0, wyRaw))
    for (let ox = 0; ox < ow; ox++) {
      const fx = ((ox + 0.5) / ow) * pw - 0.5
      const x0 = Math.min(pw - 1, Math.max(0, Math.floor(fx)))
      const x1 = Math.min(pw - 1, x0 + 1)
      const wxRaw = fx - x0
      const wx = Math.min(1, Math.max(0, wxRaw))
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
 * Geometric error between a tile's DEM and the parent DEM already upsampled
 * to the same grid dimensions.
 *
 * @param tileDEM elevation grid (meters).
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
