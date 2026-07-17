/*
 * 运行时样本入口契约（TASK-002，SPEC 2.1 / 3.1 / 4.1）。
 *
 * 静态扫描 src，证明：
 *   - 存在唯一的运行时样本 URL 常量，且等于 /generated/sampleMap.json；
 *   - src 中不存在内嵌样本（对 data 下源样本的直接 import）或备用 URL；
 *   - src 中不存在远程请求入口（http / https 字面量）。
 * 检测到备用 URL、内嵌地图或远程入口时，本契约必须失败。
 */
import { describe, test, expect } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { resolve, dirname, relative, join, extname } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '..', '..')
const srcRoot = resolve(root, 'src')
const CANONICAL_URL = '/generated/sampleMap.json'
const SOURCE_EXTS = ['.ts', '.tsx']

function collectSource(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry)
    if (statSync(p).isDirectory()) {
      collectSource(p, acc)
    } else if (SOURCE_EXTS.includes(extname(p))) {
      acc.push(p)
    }
  }
  return acc
}

describe('运行时样本入口契约（TASK-002）', () => {
  const files = collectSource(srcRoot).map((path) => ({
    path,
    rel: relative(root, path).replace(/\\/g, '/'),
    content: readFileSync(path, 'utf8'),
  }))

  test('存在唯一的运行时样本 URL 常量，且等于 /generated/sampleMap.json', () => {
    const ss = files.find((f) => f.rel === 'src/workers/sampleSource.ts')
    expect(ss, '必须存在 src/workers/sampleSource.ts').toBeDefined()
    expect(ss!.content).toContain(`'${CANONICAL_URL}'`)
  })

  test('src 中每个 sampleMap.json 引用都必须属于唯一运行副本地址', () => {
    const offenders: string[] = []
    for (const f of files) {
      f.content.split('\n').forEach((line, i) => {
        if (!line.includes('sampleMap.json')) return
        if (line.includes(CANONICAL_URL)) return
        offenders.push(`${f.rel}:${i + 1}: ${line.trim()}`)
      })
    }
    expect(
      offenders,
      '发现内嵌样本或备用 URL（每个 sampleMap.json 引用必须属于 /generated/sampleMap.json）：\n' +
        offenders.join('\n'),
    ).toEqual([])
  })

  test('src 中不存在远程地图请求入口（http / https 字面量）', () => {
    const offenders: string[] = []
    for (const f of files) {
      const matches = f.content.match(/https?:\/\//g)
      if (matches) offenders.push(`${f.rel}: ${matches.length} 处远程 URL`)
    }
    expect(offenders, 'src 禁止出现远程请求入口：\n' + offenders.join('\n')).toEqual([])
  })
})
