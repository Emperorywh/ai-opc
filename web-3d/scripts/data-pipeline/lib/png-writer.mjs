/**
 * 极简 PNG 编码器（纯 Node zlib + fs，零原生依赖）。
 *
 * 用途：合成 DEM pipeline 离线烘焙 16-bit 灰度高程图 + 8-bit RGB 法线贴图。
 * 为何手写而非用 pngjs：pngjs 的 16-bit 写入路径对 data buffer 的解释不直观且易错，
 * 而 16-bit 高程是本项目最高风险点（SPEC §6.1 / M1 风险 #2），需逐字节可控 + 确定性输出。
 *
 * 支持：
 *   - 16-bit 灰度（colorType 0, bitDepth 16）→ heightmap.png
 *   - 8-bit RGB（colorType 2, bitDepth 8）    → normal.png
 * 每条扫描线自适应选 5 种 PNG 滤波器（None/Sub/Up/Average/Paeth）中绝对值和最小者，
 * 以获得良好压缩（用 zlib level 9）。
 */

import { deflateSync } from 'node:zlib'
import { writeFileSync } from 'node:fs'

/** PNG 文件签名。 */
const SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

/** 预计算 CRC32 表（PNG 用 IEEE CRC-32）。 */
const CRC_TABLE = (() => {
  const t = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c
  }
  return t
})()

function crc32(buf) {
  let c = 0xffffffff
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

/** 组装一个 PNG chunk：length(4 BE) + type(4) + data + crc(4)。 */
function chunk(type, data) {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length, 0)
  const typeBuf = Buffer.from(type, 'ascii')
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0)
  return Buffer.concat([len, typeBuf, data, crc])
}

/** Paeth 预测器（PNG 滤波器 4）。 */
function paeth(a, b, c) {
  const p = a + b - c
  const pa = Math.abs(p - a)
  const pb = Math.abs(p - b)
  const pc = Math.abs(p - c)
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c
}

/**
 * 通用编码核心。
 * @param {number} width
 * @param {number} height
 * @param {number} colorType  0=灰度, 2=RGB
 * @param {number} bitDepth   8 或 16
 * @param {number} bpp        每像素字节数（灰度16=2，RGB8=3）
 * @param {Uint8Array[]} rows 每行的像素字节（16-bit 须为大端；由调用方准备）
 * @returns {Buffer} 完整 PNG 字节
 */
function encode(width, height, colorType, bitDepth, bpp, rows) {
  const rowBytes = width * bpp
  const out = Buffer.alloc((rowBytes + 1) * height)
  const prev = new Uint8Array(rowBytes)
  const cand = [
    new Uint8Array(rowBytes),
    new Uint8Array(rowBytes),
    new Uint8Array(rowBytes),
    new Uint8Array(rowBytes),
    new Uint8Array(rowBytes),
  ]
  for (let y = 0; y < height; y++) {
    const row = rows[y]
    const sums = [0, 0, 0, 0, 0]
    for (let i = 0; i < rowBytes; i++) {
      const x = row[i]
      const a = i >= bpp ? row[i - bpp] : 0
      const b = prev[i]
      const c = i >= bpp ? prev[i - bpp] : 0
      // 0 None
      cand[0][i] = x
      sums[0] += Math.abs((x << 24) >> 24)
      // 1 Sub
      const v1 = (x - a) & 0xff
      cand[1][i] = v1
      sums[1] += Math.abs((v1 << 24) >> 24)
      // 2 Up
      const v2 = (x - b) & 0xff
      cand[2][i] = v2
      sums[2] += Math.abs((v2 << 24) >> 24)
      // 3 Average
      const v3 = (x - ((a + b) >> 1)) & 0xff
      cand[3][i] = v3
      sums[3] += Math.abs((v3 << 24) >> 24)
      // 4 Paeth
      const v4 = (x - paeth(a, b, c)) & 0xff
      cand[4][i] = v4
      sums[4] += Math.abs((v4 << 24) >> 24)
    }
    let best = 0
    for (let f = 1; f < 5; f++) if (sums[f] < sums[best]) best = f
    const off = y * (rowBytes + 1)
    out[off] = best
    out.set(cand[best], off + 1)
    prev.set(row)
  }
  const idat = deflateSync(out, { level: 9 })
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = bitDepth
  ihdr[9] = colorType
  ihdr[10] = 0 // compression: deflate
  ihdr[11] = 0 // filter: adaptive
  ihdr[12] = 0 // interlace: none
  return Buffer.concat([SIG, chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0))])
}

/**
 * 写 16-bit 灰度 PNG（colorType 0, bitDepth 16）。
 * @param {string} filePath
 * @param {number} width
 * @param {number} height
 * @param {Uint16Array} u16 长度 width*height，值域 [0,65535]（系统字节序）
 */
export function writeGray16(filePath, width, height, u16) {
  const rows = new Array(height)
  for (let y = 0; y < height; y++) {
    const row = new Uint8Array(width * 2)
    const base = y * width
    for (let x = 0; x < width; x++) {
      const v = u16[base + x]
      row[x * 2] = (v >>> 8) & 0xff // 大端高位
      row[x * 2 + 1] = v & 0xff // 大端低位
    }
    rows[y] = row
  }
  writeFileSync(filePath, encode(width, height, 0, 16, 2, rows))
}

/**
 * 写 8-bit RGB PNG（colorType 2, bitDepth 8）。
 * @param {string} filePath
 * @param {number} width
 * @param {number} height
 * @param {Uint8Array} rgb 长度 width*height*3，每像素 R,G,B（0..255）
 */
export function writeRGB8(filePath, width, height, rgb) {
  const rows = new Array(height)
  const rowBytes = width * 3
  for (let y = 0; y < height; y++) {
    rows[y] = rgb.subarray(y * rowBytes, (y + 1) * rowBytes)
  }
  writeFileSync(filePath, encode(width, height, 2, 8, 3, rows))
}
