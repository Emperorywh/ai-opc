/**
 * fast-png 8.0.0 不附带类型定义（package.json 无 types 字段），此为最小 ambient 声明。
 * 仅覆盖 `src/data/assets.ts` 用到的 `decode`：把 16-bit 灰度 PNG 解码为 Uint16Array。
 */
declare module 'fast-png' {
  /** 解码后的 PNG（仅列出本项目用到的字段）。 */
  export type DecodedPng = {
    width: number
    height: number
    /** 位深；16-bit 灰度高程图 = 16。 */
    depth: 1 | 2 | 4 | 8 | 16
    /** 通道数；灰度 = 1，RGB = 3，RGBA = 4。 */
    channels: 1 | 2 | 3 | 4
    /** depth=16 时为 Uint16Array，否则 Uint8Array。 */
    data: Uint8Array | Uint16Array
    palette?: Array<[number, number, number]>
  }

  /** 解码 PNG（支持 16-bit）。 */
  export function decode(data: ArrayBuffer | Uint8Array): DecodedPng

  /** 编码 PNG（本项目暂不用，留作对称声明）。 */
  export function encode(png: {
    width: number
    height: number
    data: Uint8Array | Uint16Array
    depth?: number
    channels?: number
  }): Uint8Array
}
