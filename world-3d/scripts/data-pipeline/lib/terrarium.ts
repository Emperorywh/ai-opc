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
