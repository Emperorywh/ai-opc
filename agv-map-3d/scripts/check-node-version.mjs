/*
 * Node 版本门禁（preinstall 阶段执行）。
 *
 * 职责：
 *   - 在 npm install / npm ci 真正解析依赖树之前，强制当前 Node 版本与
 *     package.json#engines.node 完全一致。
 *   - 任何偏离都立即以非零退出码终止安装，避免在错误工具链下生成或使用
 *     与 SPEC 3.2 固定版本不一致的 lockfile。
 *
 * 关键不变量：
 *   - 只依赖 Node 内置模块，preinstall 时 node_modules 尚未安装也能运行。
 *   - 采用精确字符串比对，不做语义化范围解析；SPEC 固定的就是单一版本号。
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const pkgPath = resolve(here, '..', 'package.json')
const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'))

const expected = pkg?.engines?.node
const actual = process.versions.node

if (typeof expected !== 'string' || expected.length === 0) {
  console.error('[node-gate] package.json 缺少 engines.node 声明。')
  process.exit(1)
}

if (actual !== expected) {
  console.error(
    `[node-gate] Node 版本不符：期望 "${expected}"，实际 "${actual}"。` +
      '请使用 nvm use 24.16.0 或同等方式切换后再安装。',
  )
  process.exit(1)
}

console.log(`[node-gate] Node 版本核对通过：${actual}`)
