/*
 * 分层依赖方向自动化证据（SPEC 3.3）。
 *
 * 通过 spawn 独立脚本 scripts/check-layering.mjs，断言其在 src 上扫描通过、退出码为 0。
 * 该脚本对 domain / workers 等层的 React、Three、Troika 越界依赖与跨层反向依赖硬性报错，
 * 为“分层依赖方向具有自动化证据”提供可复现的验收点。
 */
import { test, expect } from 'vitest'
import { execFileSync } from 'node:child_process'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '..', '..')

test('分层依赖方向符合 SPEC 3.3', () => {
  const output = execFileSync('node', ['scripts/check-layering.mjs'], {
    cwd: root,
    encoding: 'utf8',
  })
  expect(output, 'check-layering.mjs 必须报告通过').toContain('layer-check')
  expect(output).toContain('通过')
})
