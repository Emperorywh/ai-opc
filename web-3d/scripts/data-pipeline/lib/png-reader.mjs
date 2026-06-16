/**
 * 极简 PNG 解码器（仅用于离线 pipeline 的往返校验）。
 *
 * 解码自写编码器产出的 PNG，做「写进去什么 → 读出来是否一致」的逐像素断言，
 * 确保最高风险点（16-bit 高程）序列化无误。支持全部 5 种滤波器 + 多 IDAT 拼接。
 * 运行时不加载（前端纹理加载在 Task 03 另行实现）。
 */

import { inflateSync } from 'node:zlib'

function paeth(a, b, c) {
  const p = a + b - c
  const pa = Math.abs(p - a)
  const pb = Math.abs(p - b)
  const pc = Math.abs(p - c)
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c
}

/**
 * 解码 PNG Buffer。
 * @param {Buffer} buf
 * @returns {{width:number,height:number,bitDepth:number,colorType:number,channels:number,bpp:number,rowBytes:number,data:Uint8Array}}
 *   data 为去滤波后的原始像素字节（16-bit 为大端）。
 */
export function decodePng(buf) {
  // 校验签名
  for (let i = 0; i < 8; i++) {
    if (buf[i] !== [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a][i]) {
      throw new Error('不是合法 PNG（签名错误）')
    }
  }
  let o = 8
  let width = 0
  let height = 0
  let bitDepth = 0
  let colorType = 0
  const idatChunks = []
  while (o < buf.length) {
    const len = buf.readUInt32BE(o)
    const type = buf.toString('ascii', o + 4, o + 8)
    const data = buf.subarray(o + 8, o + 8 + len)
    if (type === 'IHDR') {
      width = data.readUInt32BE(0)
      height = data.readUInt32BE(4)
      bitDepth = data[8]
      colorType = data[9]
    } else if (type === 'IDAT') {
      idatChunks.push(data)
    } else if (type === 'IEND') {
      break
    }
    o += 12 + len
  }
  const channels = colorType === 6 ? 4 : colorType === 2 ? 3 : colorType === 4 ? 2 : 1
  const bpp = Math.max(1, channels * (bitDepth / 8))
  const rowBytes = width * bpp
  const raw = inflateSync(Buffer.concat(idatChunks))
  const out = new Uint8Array(rowBytes * height)
  const prev = new Uint8Array(rowBytes)
  for (let y = 0; y < height; y++) {
    const ftype = raw[y * (rowBytes + 1)]
    const flineStart = y * (rowBytes + 1) + 1
    const lineStart = y * rowBytes
    for (let i = 0; i < rowBytes; i++) {
      const a = i >= bpp ? out[lineStart + i - bpp] : 0
      const b = prev[i]
      const c = i >= bpp ? prev[i - bpp] : 0
      const x = raw[flineStart + i]
      let v
      switch (ftype) {
        case 0: v = x; break
        case 1: v = (x + a) & 0xff; break
        case 2: v = (x + b) & 0xff; break
        case 3: v = (x + ((a + b) >> 1)) & 0xff; break
        case 4: v = (x + paeth(a, b, c)) & 0xff; break
        default: throw new Error(`未知滤波器类型 ${ftype}`)
      }
      out[lineStart + i] = v
    }
    prev.set(out.subarray(lineStart, lineStart + rowBytes))
  }
  return { width, height, bitDepth, colorType, channels, bpp, rowBytes, data: out }
}

/** 读取 16-bit 灰度 PNG 的某像素原始值（0..65535）。须先经 decodePng。 */
export function readGray16Pixel(png, x, y) {
  const i = (y * png.width + x) * 2
  return (png.data[i] << 8) | png.data[i + 1]
}
