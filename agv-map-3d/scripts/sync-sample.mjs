#!/usr/bin/env node
/*
 * predev / prebuild 样本同步 CLI 入口（SPEC 3.1 / 4.1）。
 *
 * 在 dev / build 真正启动前强制执行样本供应链：
 *   1. 校验 data/sampleMap.json 的 SHA-256 与 SPEC 2.1 固定值一致；
 *   2. 通过后按原始字节生成 public/generated/sampleMap.json 运行副本；
 *   3. 任何失败都以非零退出码终止，使 npm 在 predev / prebuild 阶段即停止，
 *      不进入 dev server 或构建产物装配。
 *
 * 源 / 生成物所有权、失败原子性与不可降级不变量由 sample-supply-chain.mjs 统一保证。
 * 本脚本不读取 src 分层，也不实现领域解析、几何推导或 UI fallback。
 *
 * 测试钩子：SAMPLE_SYNC_ROOT 环境变量仅用于把工作根重定向到临时工作区，
 * 不改变哈希校验或引入降级路径。
 */
import { syncSample } from './sample-supply-chain.mjs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const scriptDir = dirname(fileURLToPath(import.meta.url))
const root = process.env.SAMPLE_SYNC_ROOT
  ? resolve(process.env.SAMPLE_SYNC_ROOT)
  : resolve(scriptDir, '..')

try {
  const result = await syncSample({ root })
  console.log(`[sync-sample] 样本身份校验通过：${result.sha256}`)
  console.log(`[sync-sample] 已按原始字节生成运行副本：${result.generatedPath}`)
} catch (err) {
  const code = err?.code ?? 'UNKNOWN'
  console.error(`[sync-sample] 失败（${code}）：${err.message}`)
  process.exit(1)
}
