/*
 * 可信样本供应链自动化验证（TASK-002，SPEC 2.1 / 3.1 / 4.1 / 14.1）。
 *
 * 覆盖成功与异常闭环：
 *   - 成功路径：哈希通过后按原始字节生成副本，副本与源逐字节一致。
 *   - 源样本缺失、不可读：稳定报 SAMPLE_FETCH_FAILED，不生成副本。
 *   - 单字节篡改：稳定报 SAMPLE_HASH_MISMATCH，不生成副本。
 *   - 旧生成物不得误用：哈希失败时旧副本被清理，不能作为可运行地图。
 *   - CLI 入口在失败时以非零退出码终止。
 * 所有临时数据在独立临时工作区构造，不触碰工程根的真实源样本与运行副本。
 */
import { describe, test, expect, beforeEach, afterEach } from 'vitest'
import {
  mkdtempSync,
  mkdirSync,
  copyFileSync,
  writeFileSync,
  readFileSync,
  rmSync,
  existsSync,
  statSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'
import {
  syncSample,
  computeFileSha256,
  verifySampleIdentity,
  EXPECTED_SAMPLE_SHA256,
  SAMPLE_SOURCE_RELATIVE,
  SAMPLE_GENERATED_RELATIVE,
  SAMPLE_ERRORS,
} from '../../scripts/sample-supply-chain.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '..', '..')
const REAL_SAMPLE = resolve(root, SAMPLE_SOURCE_RELATIVE)
const CLI_SCRIPT = resolve(root, 'scripts', 'sync-sample.mjs')

let workRoot: string
let sourcePath: string
let generatedPath: string

beforeEach(() => {
  workRoot = mkdtempSync(join(tmpdir(), 'sample-supply-'))
  sourcePath = join(workRoot, SAMPLE_SOURCE_RELATIVE)
  generatedPath = join(workRoot, SAMPLE_GENERATED_RELATIVE)
  mkdirSync(dirname(sourcePath), { recursive: true })
})

afterEach(() => {
  rmSync(workRoot, { recursive: true, force: true })
})

// 把真实样本复制到临时源路径，便于在其上构造各类异常。
function stageRealSample() {
  copyFileSync(REAL_SAMPLE, sourcePath)
}

// 翻转指定字节位置，构造确定性的单字节篡改。
function flipByte(path: string, offset: number) {
  const buf = readFileSync(path)
  buf[offset] = buf[offset] ^ 0xff
  writeFileSync(path, buf)
}

describe('可信样本供应链（TASK-002）', () => {
  test('真实源样本身份与 SPEC 2.1 固定值一致', async () => {
    const sha = await computeFileSha256(REAL_SAMPLE)
    expect(sha).toBe(EXPECTED_SAMPLE_SHA256)
    expect(statSync(REAL_SAMPLE).size).toBe(6_597_038)
  })

  test('稳定错误码与 SPEC 14.1 对齐', () => {
    expect(SAMPLE_ERRORS.FETCH_FAILED).toBe('SAMPLE_FETCH_FAILED')
    expect(SAMPLE_ERRORS.HASH_MISMATCH).toBe('SAMPLE_HASH_MISMATCH')
  })

  test('predev / prebuild 脚本已挂载到 npm 生命周期', () => {
    const pkg = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'))
    expect(pkg.scripts.predev).toBe('node scripts/sync-sample.mjs')
    // TASK-015：prebuild 在样本同步后追加字形门禁，缺字直接失败。
    expect(pkg.scripts.prebuild).toBe(
      'node scripts/sync-sample.mjs && node scripts/check-font-glyphs.mjs',
    )
    expect(pkg.scripts['check:font-glyphs']).toBe(
      'node scripts/check-font-glyphs.mjs',
    )
  })

  test('成功路径：哈希通过后按原始字节生成副本', async () => {
    stageRealSample()
    const result = await syncSample({ root: workRoot })
    expect(result.sha256).toBe(EXPECTED_SAMPLE_SHA256)
    expect(existsSync(generatedPath)).toBe(true)

    const srcBuf = readFileSync(sourcePath)
    const genBuf = readFileSync(generatedPath)
    expect(genBuf.byteLength).toBe(srcBuf.byteLength)
    // 逐字节一致（Buffer.compare 为 0 表示完全相同）。
    expect(Buffer.compare(srcBuf, genBuf)).toBe(0)

    const genHash = await computeFileSha256(generatedPath)
    expect(genHash).toBe(EXPECTED_SAMPLE_SHA256)
  })

  test('源样本缺失：稳定报 SAMPLE_FETCH_FAILED 且不生成副本', async () => {
    await expect(syncSample({ root: workRoot })).rejects.toMatchObject({
      code: SAMPLE_ERRORS.FETCH_FAILED,
    })
    expect(existsSync(generatedPath)).toBe(false)
  })

  test('单字节篡改：稳定报 SAMPLE_HASH_MISMATCH 且不生成副本', async () => {
    stageRealSample()
    flipByte(sourcePath, 0)
    await expect(syncSample({ root: workRoot })).rejects.toMatchObject({
      code: SAMPLE_ERRORS.HASH_MISMATCH,
    })
    expect(existsSync(generatedPath)).toBe(false)
  })

  test('源路径不可读（指向目录）：稳定报 SAMPLE_FETCH_FAILED', async () => {
    mkdirSync(sourcePath, { recursive: true })
    await expect(syncSample({ root: workRoot })).rejects.toMatchObject({
      code: SAMPLE_ERRORS.FETCH_FAILED,
    })
    expect(existsSync(generatedPath)).toBe(false)
  })

  test('旧生成物不得误用：哈希失败时旧副本被清理', async () => {
    // 预置一个“看似有效”的旧运行副本（用真实样本冒充）。
    mkdirSync(dirname(generatedPath), { recursive: true })
    copyFileSync(REAL_SAMPLE, generatedPath)
    expect(existsSync(generatedPath)).toBe(true)

    // 篡改源样本使身份校验失败。
    stageRealSample()
    flipByte(sourcePath, 0)

    await expect(syncSample({ root: workRoot })).rejects.toMatchObject({
      code: SAMPLE_ERRORS.HASH_MISMATCH,
    })
    // 旧副本必须被清理，不得残留为可运行地图。
    expect(existsSync(generatedPath)).toBe(false)
  })

  test('verifySampleIdentity 单独可用，成功时返回固定哈希', async () => {
    stageRealSample()
    const sha = await verifySampleIdentity({ sourcePath })
    expect(sha).toBe(EXPECTED_SAMPLE_SHA256)
  })

  test('CLI 入口成功时退出码 0 且生成副本', () => {
    stageRealSample()
    const out = execFileSync('node', [CLI_SCRIPT], {
      env: { ...process.env, SAMPLE_SYNC_ROOT: workRoot },
      encoding: 'utf8',
    })
    expect(out).toContain('[sync-sample]')
    expect(existsSync(generatedPath)).toBe(true)
  })

  test('CLI 入口在哈希失败时以非零退出码终止', () => {
    stageRealSample()
    flipByte(sourcePath, 0)
    expect(() =>
      execFileSync('node', [CLI_SCRIPT], {
        env: { ...process.env, SAMPLE_SYNC_ROOT: workRoot },
        encoding: 'utf8',
      }),
    ).toThrow()
    expect(existsSync(generatedPath)).toBe(false)
  })
})
