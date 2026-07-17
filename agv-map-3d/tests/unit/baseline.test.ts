/*
 * 工程基线断言（TASK-001 自动化证据）。
 *
 * 校验 SPEC 3.2 固定依赖、Node 版本门禁、troika 版本统一与 clean-room 禁令。
 * 任一断言失败都意味着基线偏离 SPEC，必须在合并前修正。
 */
import { describe, test, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const pkg = JSON.parse(readFileSync(resolve(here, '..', '..', 'package.json'), 'utf8'))
const allDeps: Record<string, string> = { ...pkg.dependencies, ...pkg.devDependencies }

describe('工程基线（TASK-001）', () => {
  test('所有依赖使用精确版本，禁止范围前缀与 latest', () => {
    for (const [name, version] of Object.entries(allDeps)) {
      expect(typeof version, `${name} 应为字符串`).toBe('string')
      expect(version, `${name} 禁止 ^ 或 ~ 前缀`).not.toMatch(/^[\^~]/)
      expect(version, `${name} 禁止 latest`).not.toBe('latest')
    }
  })

  test('Node 版本固定为 SPEC 3.2 的 24.16.0', () => {
    expect(pkg.engines?.node).toBe('24.16.0')
  })

  test('troika-three-text 作为直接依赖且 overrides 强制统一', () => {
    expect(pkg.dependencies['troika-three-text']).toBe('0.52.4')
    expect(pkg.overrides?.['troika-three-text']).toBe('0.52.4')
  })

  test('SPEC 3.2 固定的运行时依赖齐备', () => {
    expect(pkg.dependencies['react']).toBe('19.2.7')
    expect(pkg.dependencies['react-dom']).toBe('19.2.7')
    expect(pkg.dependencies['three']).toBe('0.185.1')
    expect(pkg.dependencies['@react-three/fiber']).toBe('9.6.1')
    expect(pkg.dependencies['@react-three/drei']).toBe('10.7.7')
  })

  test('SPEC 3.2 固定的开发依赖齐备', () => {
    expect(pkg.devDependencies['vite']).toBe('8.1.3')
    expect(pkg.devDependencies['typescript']).toBe('7.0.2')
    expect(pkg.devDependencies['vitest']).toBe('4.1.10')
    expect(pkg.devDependencies['@playwright/test']).toBe('1.60.0')
  })

  test('基线命令脚本齐备', () => {
    const scripts = pkg.scripts
    expect(scripts.lint).toBeTruthy()
    expect(scripts.test).toBeTruthy()
    expect(scripts.build).toBeTruthy()
    expect(scripts['check:layers']).toBeTruthy()
  })

  test('clean-room 禁令：依赖树不含旧系统包', () => {
    const banned = ['umi', 'konva', '@ant-design', 'antd', '@antv', 'gatsby', 'next', 'rax']
    for (const b of banned) {
      for (const name of Object.keys(allDeps)) {
        expect(name === b || name.startsWith(b + '/'), `禁止旧系统依赖 ${name}`).toBe(false)
      }
    }
  })
})
