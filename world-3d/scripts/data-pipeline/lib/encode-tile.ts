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
