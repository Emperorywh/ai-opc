/**
 * V76 地图资产契约常量（SPEC §4.1）。
 *
 * 资产内容发生有意变更时，必须同步更新本文件指纹、SPEC §4.2 审计统计
 * 与数据契约测试；三者任一不一致都会被完整性校验或契约测试拒绝。
 */

/** 期望的资产字节数。 */
export const ASSET_SIZE_BYTES = 6_516_343

/** 期望的资产 SHA-256 摘要（小写十六进制）。 */
export const ASSET_SHA256_HEX =
  'de2b1158fefdc274673fb7f1813d8f193961359926b238b0cc334350a87fc567'

/**
 * 资产完整性校验结果契约（SPEC §10.1）。
 *
 * 该纯数据结构描述字节数与 SHA-256 指纹的比对结果，位于 domain 层使
 * infrastructure（实现）与 worker（注入消费方）都能单向依赖此处，
 * 不在 worker 与 infrastructure 之间建立横向依赖（SPEC §5.1）。
 */
export interface AssetIntegrityResult {
  /** 字节数与 SHA-256 均与契约一致。 */
  ok: boolean
  /** 契约期望的字节数。 */
  expectedSize: number
  /** 实际下载的字节数。 */
  actualSize: number
  /** 契约期望的 SHA-256 小写十六进制摘要。 */
  expectedSha256: string
  /** 实际计算的 SHA-256 小写十六进制摘要。 */
  actualSha256: string
}
