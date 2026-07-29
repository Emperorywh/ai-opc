/**
 * 测试夹具加载助手。
 *
 * 这里只属于测试基线（vitest），不在 src/ 内，不会被 tsc -b（tsconfig.app）纳入
 * 浏览器运行时构建，也不会被 vite 打包进生产包。资产校验入口（pnpm verify:assets）
 * 与运行时数据访问层不依赖本助手——它们各自有自己的加载方式。
 */

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const testsDir = resolve(fileURLToPath(import.meta.url), '..')

/** 以 UTF-8 文本读取 tests/fixtures 下的某个 JSON 夹具并解析为对象。 */
export function loadFixture(pathSegments: string[]): unknown {
  const filePath = resolve(testsDir, 'fixtures', ...pathSegments)
  return JSON.parse(readFileSync(filePath, 'utf-8')) as unknown
}

/** 读取夹具的原始文本（用于「字段被删除」类负面夹具的快速拼装）。 */
export function loadFixtureText(pathSegments: string[]): string {
  const filePath = resolve(testsDir, 'fixtures', ...pathSegments)
  return readFileSync(filePath, 'utf-8')
}
