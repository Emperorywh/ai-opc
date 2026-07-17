/*
 * 可信样本供应链核心（SPEC 2.1 / 3.1 / 4.1 / 14.1）。
 *
 * 本模块是构建期样本同步的唯一事实实现，被 predev / prebuild 复用。
 *
 * 源 / 生成物所有权：
 *   - data/sampleMap.json 是唯一可编辑地图样本（SPEC 2.1），其 SHA-256 固定为
 *     EXPECTED_SAMPLE_SHA256。该值由 SPEC 给定，本模块不得猜测、放宽或绕过。
 *   - public/generated/sampleMap.json 是运行副本，由本模块按原始字节生成；
 *     它被 .gitignore 忽略，不可手工维护、不可提交，也不是第二事实来源。
 *
 * 失败原子性：
 *   - 哈希校验必须发生在复制之前；任何失败都不得生成或保留运行副本。
 *   - 一旦校验失败，已存在的旧生成副本必须立即删除，避免“看似有效”的旧文件
 *     在后续 dev / build 中被当作可运行地图。
 *
 * 不可降级不变量：
 *   - 不引入远程下载、备用样本、内嵌小样本或失败后的跳过开关。
 *   - 复制保持字节完全一致：禁止 JSON 重序列化、换行转换、压缩或字符编码重写。
 *   - 本模块只做身份校验与字节同步，不实现领域解析、几何推导或 UI fallback。
 */
import { createHash } from 'node:crypto'
import { createReadStream, existsSync, mkdirSync, copyFileSync, rmSync } from 'node:fs'
import { dirname, resolve } from 'node:path'

// SPEC 2.1 固定的样本身份（大写十六进制 SHA-256）。
export const EXPECTED_SAMPLE_SHA256 =
  'DCE8427D3516E2F8F571AB66CF97D4A645939EE13CC62C7EB1A04846B376B813'

// SPEC 2.1 / 3.1 固定的源样本与运行副本路径（相对工程根）。
export const SAMPLE_SOURCE_RELATIVE = 'data/sampleMap.json'
export const SAMPLE_GENERATED_RELATIVE = 'public/generated/sampleMap.json'

// 稳定错误码，与 SPEC 14.1 对齐。供应链只产出这两个码。
export const SAMPLE_ERRORS = Object.freeze({
  FETCH_FAILED: 'SAMPLE_FETCH_FAILED',
  HASH_MISMATCH: 'SAMPLE_HASH_MISMATCH',
})

// 结构化失败：携带稳定 code 与上下文，便于 overlay / 日志定位。
export class SampleSupplyChainError extends Error {
  constructor(code, message, context = {}) {
    super(message)
    this.name = 'SampleSupplyChainError'
    this.code = code
    this.context = context
  }
}

// 以流式方式计算文件 SHA-256，返回大写十六进制摘要。
// 读取失败（含把目录当文件、权限不足等）以 rejected promise 上报。
export function computeFileSha256(filePath) {
  return new Promise((resolveP, rejectP) => {
    const hash = createHash('sha256')
    const stream = createReadStream(filePath)
    stream.on('data', (chunk) => hash.update(chunk))
    stream.once('error', (err) => rejectP(err))
    stream.once('end', () => resolveP(hash.digest('hex').toUpperCase()))
  })
}

// 把“读取或哈希”过程中的底层错误包装成稳定供应链错误。
async function hashOrFail(path, code, label) {
  let digest
  try {
    digest = await computeFileSha256(path)
  } catch (err) {
    throw new SampleSupplyChainError(code, `${label}不可读或损坏：${err.message}`, { path })
  }
  return digest
}

// 仅校验源样本身份：缺失或不可读 → FETCH_FAILED；哈希不符 → HASH_MISMATCH。
export async function verifySampleIdentity({ sourcePath, expected = EXPECTED_SAMPLE_SHA256 }) {
  if (!existsSync(sourcePath)) {
    throw new SampleSupplyChainError(
      SAMPLE_ERRORS.FETCH_FAILED,
      `源样本缺失：${sourcePath}`,
      { sourcePath },
    )
  }
  const actual = await hashOrFail(sourcePath, SAMPLE_ERRORS.FETCH_FAILED, '源样本')
  if (actual !== expected) {
    throw new SampleSupplyChainError(
      SAMPLE_ERRORS.HASH_MISMATCH,
      `样本哈希不匹配：期望 ${expected}，实际 ${actual}`,
      { sourcePath, expected, actual },
    )
  }
  return actual
}

// 失败时清理旧生成副本的原子性保证：校验未通过则运行副本必须消失。
function purgeGenerated(generatedPath) {
  try {
    rmSync(generatedPath, { force: true })
  } catch {
    // 清理失败不掩盖原始失败；忽略二次错误。
  }
}

// 完整供应链：先校验身份，再按原始字节复制，最后复核副本哈希。
// 任何步骤失败都抛出 SampleSupplyChainError，且不保留可运行副本。
export async function syncSample({
  root = process.cwd(),
  source = SAMPLE_SOURCE_RELATIVE,
  generated = SAMPLE_GENERATED_RELATIVE,
  expected = EXPECTED_SAMPLE_SHA256,
} = {}) {
  const sourcePath = resolve(root, source)
  const generatedPath = resolve(root, generated)

  // 1. 身份校验（复制之前）；失败时清理旧副本后向上抛出。
  let actual
  try {
    actual = await verifySampleIdentity({ sourcePath, expected })
  } catch (err) {
    purgeGenerated(generatedPath)
    throw err
  }

  // 2. 原始字节复制：copyFileSync 不做任何编码 / 换行转换。
  mkdirSync(dirname(generatedPath), { recursive: true })
  copyFileSync(sourcePath, generatedPath)

  // 3. 复制后复核：证明字节完全一致，防御文件系统损坏。
  const copied = await hashOrFail(generatedPath, SAMPLE_ERRORS.FETCH_FAILED, '运行副本')
  if (copied !== expected) {
    purgeGenerated(generatedPath)
    throw new SampleSupplyChainError(
      SAMPLE_ERRORS.HASH_MISMATCH,
      `运行副本哈希与固定值不一致：期望 ${expected}，实际 ${copied}`,
      { generatedPath, expected, actual: copied },
    )
  }

  return { sourcePath, generatedPath, sha256: actual }
}
