import { ASSET_SHA256_HEX, ASSET_SIZE_BYTES } from '../domain/assetContract'

/**
 * 资产完整性校验：解析前比对字节数与 SHA-256 指纹（SPEC §10.1）。
 *
 * 使用 Web Crypto 的 SubtleCrypto 计算摘要，浏览器与 Node（globalThis.crypto）
 * 均原生支持；因此不引入 Node 专用 crypto 模块，保持基础设施层运行时中立。
 * 该模块属于 infrastructure 层，domain 层不依赖此处实现。
 */

export interface AssetIntegrityResult {
  ok: boolean
  expectedSize: number
  actualSize: number
  expectedSha256: string
  actualSha256: string
}

/**
 * 计算给定字节序列的 SHA-256 小写十六进制摘要。
 *
 * 入参显式要求 ArrayBuffer 支撑的 Uint8Array，以匹配 SubtleCrypto.digest 对
 * BufferSource 的类型约束（TS 6 起 TypedArray 默认为 ArrayBufferLike）。
 * 加载流程从网络响应构造的字节数组天然满足该类型。
 */
export async function computeSha256Hex(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes)
  return bytesToHex(new Uint8Array(digest))
}

/** 校验资产字节数与 SHA-256 是否匹配契约指纹。 */
export async function verifyAssetIntegrity(bytes: Uint8Array<ArrayBuffer>): Promise<AssetIntegrityResult> {
  const actualSize = bytes.byteLength
  const actualSha256 = await computeSha256Hex(bytes)
  return {
    ok: actualSize === ASSET_SIZE_BYTES && actualSha256 === ASSET_SHA256_HEX,
    expectedSize: ASSET_SIZE_BYTES,
    actualSize,
    expectedSha256: ASSET_SHA256_HEX,
    actualSha256,
  }
}

function bytesToHex(bytes: Uint8Array): string {
  let hex = ''
  for (let i = 0; i < bytes.length; i += 1) {
    hex += bytes[i].toString(16).padStart(2, '0')
  }
  return hex
}
