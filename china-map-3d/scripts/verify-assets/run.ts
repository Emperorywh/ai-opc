/**
 * 资产契约校验 CLI（pnpm verify:assets）。
 *
 * 这是 TASK-001 提供的「非交互自动化验证入口」，后续 TASK 复用同一入口验证正常资产与
 * 损坏资产。当前各 scope 指向 tests/fixtures/legal 下的代表夹具，证明入口可用；
 * 后续生产资 产 TASK 会把对应 scope 的文件路径重定向到 public/ 下的真实资产，
 * 并在必要时追加 scope 专属的更深层不变量（如「恰好 34 个省级行政区」）。
 *
 * 依赖方向：本脚本属于离线资产生产/校验层（scripts/，devDependency tsx 运行），
 * 只单向依赖 src/geo-contracts 契约层；不进入浏览器运行时包，不被 vite 打包。
 *
 * 退出码：全部通过为 0；任一失败为 1；参数错误为 2。输出确定性文本，便于 CI 与人工定位。
 */

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  readContractKind,
  validateContractByKind,
  validateContractBundle,
  type ContractBundle,
  type ContractKind,
} from '../../src/geo-contracts/index'

const projectRoot = resolve(fileURLToPath(import.meta.url), '..', '..', '..')

/** 单个待校验文件：相对项目根的路径 + 期望契约 kind。 */
interface AssetProbe {
  readonly path: string
  readonly expectedKind: ContractKind
}

/** 单个 scope 的描述：一组待校验文件 + 是否附加跨契约引用核对。 */
interface ScopeDescriptor {
  readonly label: string
  readonly probes: readonly AssetProbe[]
  readonly runBundle?: boolean
}

/**
 * Scope 注册表。
 * 后续 TASK 新增生产资产时：把对应 scope 的 probes 路径替换/扩展为真实资产路径即可，
 * 无需新建第二条校验管线（避免重复契约/双轨入口）。
 */
const SCOPE_REGISTRY: Record<string, ScopeDescriptor> = {
  sources: {
    label: '数据来源注册表',
    probes: [{ path: 'tests/fixtures/legal/data-sources.json', expectedKind: 'data-source-registry' }],
  },
  terrain: {
    label: '地形元数据',
    probes: [{ path: 'tests/fixtures/legal/terrain.meta.json', expectedKind: 'terrain-meta' }],
  },
  provinces: {
    label: '省级行政区（目录 + 几何）',
    probes: [
      { path: 'tests/fixtures/legal/admin-directory.json', expectedKind: 'administrative-directory' },
      { path: 'tests/fixtures/legal/admin-geometry.json', expectedKind: 'administrative-geometry' },
    ],
  },
  places: {
    label: '地点目录',
    probes: [{ path: 'tests/fixtures/legal/places.json', expectedKind: 'place-directory' }],
  },
  political: {
    label: '政治边界补充数据',
    probes: [{ path: 'tests/fixtures/legal/political-boundary.json', expectedKind: 'political-boundary' }],
  },
}

/** 解析命令行参数，返回需要执行的 scope 名数组。 */
function parseArgs(argv: readonly string[]): string[] {
  const scopes: string[] = []
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i]
    // pnpm 透传 `pnpm verify:assets -- --scope x` 时可能把裸 `--` 也带入 argv，忽略它。
    if (flag === '--') {
      continue
    }
    if (flag === '--scope') {
      const next = argv[i + 1]
      if (!next) {
        throw new Error('--scope 需要一个参数，取值为：all, ' + Object.keys(SCOPE_REGISTRY).join(', '))
      }
      scopes.push(next)
      i++
    } else if (flag === '--help' || flag === '-h') {
      process.stdout.write(
        [
          '用法：pnpm verify:assets -- --scope <name>',
          '',
          '可选 scope：all, ' + Object.keys(SCOPE_REGISTRY).join(', '),
          '未提供 --scope 时等价于 --scope all。',
          '',
        ].join('\n'),
      )
      process.exit(0)
    } else {
      throw new Error(`未知参数：${flag}（仅支持 --scope <name>）`)
    }
  }
  if (scopes.length === 0) scopes.push('all')
  return scopes
}

/** 读取并解析 JSON 文件，失败时抛出带路径的可定位错误。 */
function readJsonFile(relativePath: string): unknown {
  const absolute = resolve(projectRoot, relativePath)
  try {
    return JSON.parse(readFileSync(absolute, 'utf-8')) as unknown
  } catch (cause) {
    throw new Error(`无法读取或解析 JSON：${relativePath}（绝对路径：${absolute}）`, { cause })
  }
}

/** 把校验通过的载荷按 kind 归位到 bundle，供跨契约核对消费。 */
function addToBundle(bundle: ContractBundle, kind: ContractKind, payload: unknown): void {
  switch (kind) {
    case 'data-source-registry':
      bundle.sources = payload as ContractBundle['sources']
      break
    case 'administrative-directory':
      bundle.administrativeDirectory = payload
      break
    case 'administrative-geometry':
      bundle.administrativeGeometry = payload
      break
    case 'place-directory':
      bundle.placeDirectory = payload
      break
    case 'political-boundary':
      bundle.politicalBoundary = payload
      break
    case 'terrain-meta':
      bundle.terrainMeta = payload
      break
    default:
      break
  }
}

/** 校验单个 scope，返回失败计数。把所有错误一次性打印，避免逐条往复。 */
function verifyScope(scopeName: string, descriptor: ScopeDescriptor): number {
  console.log(`▶ 校验 scope：${scopeName}（${descriptor.label}）`)
  let failures = 0

  const bundlePayload: ContractBundle = {}
  for (const probe of descriptor.probes) {
    const payload = readJsonFile(probe.path)
    const actualKind = readContractKind(payload)
    if (actualKind !== probe.expectedKind) {
      console.error(`  ✗ ${probe.path}：期望 kind=${probe.expectedKind}，实际为 ${String(actualKind)}`)
      failures++
      continue
    }
    const outcome = validateContractByKind(payload)
    if (outcome.ok) {
      console.log(`  ✓ ${probe.path}`)
      addToBundle(bundlePayload, probe.expectedKind, payload)
    } else {
      failures++
      console.error(`  ✗ ${probe.path}`)
      for (const err of outcome.errors) {
        console.error(`      [${err.code}] ${err.path}: ${err.message}`)
      }
    }
  }

  if (descriptor.runBundle) {
    const bundleOutcome = validateContractBundle(bundlePayload)
    if (bundleOutcome.ok) {
      console.log('  ✓ 该 scope 跨契约引用核对通过')
    } else {
      failures++
      console.error('  ✗ 该 scope 跨契约引用核对失败')
      for (const err of bundleOutcome.errors) {
        console.error(`      [${err.code}] ${err.path}: ${err.message}`)
      }
    }
  }

  return failures
}

function main(): void {
  let scopes: string[]
  try {
    scopes = parseArgs(process.argv.slice(2))
  } catch (cause) {
    console.error(String((cause as Error).message ?? cause))
    process.exit(2)
  }

  // 展开 all 为全部已登记 scope，并在末尾追加一次跨契约 bundle 核对。
  const expanded: string[] = []
  let wantBundle = false
  for (const scope of scopes) {
    if (scope === 'all') {
      expanded.push(...Object.keys(SCOPE_REGISTRY))
      wantBundle = true
    } else if (scope in SCOPE_REGISTRY) {
      expanded.push(scope)
    } else {
      console.error(`未知 scope：${scope}。可选：all, ${Object.keys(SCOPE_REGISTRY).join(', ')}`)
      process.exit(2)
    }
  }

  let totalFailures = 0
  for (const scope of expanded) {
    totalFailures += verifyScope(scope, SCOPE_REGISTRY[scope])
  }

  // 末尾跨契约核对：把全部 scope 的合法夹具放在一起检查 sourceId / adminId 引用是否解析。
  if (wantBundle) {
    console.log('▶ 校验 scope：bundle（全量跨契约引用核对）')
    const bundle: ContractBundle = {}
    for (const scope of expanded) {
      for (const probe of SCOPE_REGISTRY[scope].probes) {
        addToBundle(bundle, probe.expectedKind, readJsonFile(probe.path))
      }
    }
    const outcome = validateContractBundle(bundle)
    if (outcome.ok) {
      console.log('  ✓ 跨契约引用核对（sourceId / adminId 全部解析）')
    } else {
      totalFailures++
      console.error('  ✗ 跨契约引用核对失败')
      for (const err of outcome.errors) {
        console.error(`      [${err.code}] ${err.path}: ${err.message}`)
      }
    }
  }

  if (totalFailures > 0) {
    console.error(`\n校验完成，存在 ${totalFailures} 项失败。`)
    process.exit(1)
  }
  console.log('\n校验完成，全部通过。')
}

main()
