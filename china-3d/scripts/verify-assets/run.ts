/**
 * 资产契约校验 CLI（pnpm verify:assets）。
 *
 * TASK-003 接入 terrain scope：校验 public/terrain 下的生产高程资产（4096² 16 位 heightmap
 * + terrain-meta 元数据 + provenance 审计 sidecar），含位深/尺寸/编码/地势抽样/审计完整性的
 * 深度不变量。后续 TASK 新增生产资产（省级边界 / 地点目录 / 政治边界）时，在 SCOPE_REGISTRY
 * 追加对应 scope 即可，无需新建第二条校验管线（避免重复契约/双轨入口）。
 *
 * 依赖方向：本脚本属于离线资产生产/校验层（scripts/，devDependency tsx 运行），
 * 只单向依赖 src/geo-contracts 契约层与同层 scripts/dem、scripts/verify-assets 模块；
 * 不进入浏览器运行时包，不被 vite 打包，pnpm build / pnpm lint / pnpm test 均不触发它。
 *
 * 退出码（输出确定性文本，便于 CI 与人工定位）：
 * - 0：全部 scope 通过。
 * - 1：任一 scope 出现校验失败（不变量被违反）。
 * - 2：参数错误。
 */

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { verifyTerrainAsset } from './terrain-deep'

const projectRoot = resolve(fileURLToPath(import.meta.url), '..', '..', '..')

/** 单个 scope 的描述：标签 + 自定义校验函数（返回失败计数）。 */
interface ScopeDescriptor {
  readonly label: string
  readonly customVerify: () => number
}

/** 生产高程资产路径（相对项目根）。terrain scope 校验这套生产资产。 */
const PRODUCTION_TERRAIN = {
  meta: 'public/terrain/china-heightmap-4096.meta.json',
  raster: 'public/terrain/china-heightmap-4096.r16',
  provenance: 'public/terrain/china-heightmap-4096.provenance.json',
} as const

/** Scope 注册表。后续 TASK 新增生产资产时在此追加 scope。 */
const SCOPE_REGISTRY: Record<string, ScopeDescriptor> = {
  terrain: {
    label: '生产高程资产（深度校验：位深/尺寸/编码/地势抽样/审计完整性）',
    customVerify: verifyProductionTerrain,
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
          '退出码：0=全部通过；1=存在校验失败；2=参数错误。',
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

/**
 * 读取 .r16 裸字节并解码为小端 uint16 像素数组，同时回传原始字节。
 * 故意不按元数据 width/height 截断——把「实际像元数」原样交给 verifyTerrainAsset，
 * 让「栅格尺寸与元数据一致」这条不变量在 CLI 路径也能被真正检查（而非恒真）。
 * 原始字节（bytes）与 .r16 落盘字节同源，供 verifyTerrainAsset 复算 SHA-256 防篡改锚点。
 */
function readRasterPixelsLittleEndian(relativePath: string): { bytes: Uint8Array; pixels: Uint16Array } {
  const absolute = resolve(projectRoot, relativePath)
  const bytes = readFileSync(absolute)
  if (bytes.length % 2 !== 0) {
    throw new Error(`栅格字节长度 ${bytes.length} 非偶数，无法按 uint16 解码：${relativePath}`)
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const pixels = new Uint16Array(bytes.length / 2)
  for (let i = 0; i < pixels.length; i++) {
    pixels[i] = view.getUint16(i * 2, true)
  }
  return { bytes, pixels }
}

/**
 * 生产高程资产深度校验（TASK-003 terrain scope）。
 * 加载元数据、栅格与审计 sidecar，调用 verifyTerrainAsset 一次性给出
 * 位深/尺寸/编码/地势抽样/审计完整性的全部结论，并打印抽样摘要便于人工读图。
 */
function verifyProductionTerrain(): number {
  console.log('▶ 校验 scope：terrain（生产高程资产 · 深度校验）')
  let failures = 0
  let meta: unknown
  let pixels: Uint16Array
  let rasterBytes: Uint8Array
  let width = 0
  let height = 0
  let provenance: unknown = undefined
  try {
    meta = readJsonFile(PRODUCTION_TERRAIN.meta)
    const raster = readRasterPixelsLittleEndian(PRODUCTION_TERRAIN.raster)
    pixels = raster.pixels
    rasterBytes = raster.bytes
    const resolution = (meta as { resolution?: { widthPixels?: number; heightPixels?: number } }).resolution
    width = resolution?.widthPixels ?? 0
    height = resolution?.heightPixels ?? 0
    provenance = readJsonFile(PRODUCTION_TERRAIN.provenance)
  } catch (cause) {
    failures++
    console.error(`  ✗ 生产高程资产文件读取失败：${(cause as Error).message}`)
    return failures
  }

  const outcome = verifyTerrainAsset({
    meta,
    pixels,
    width,
    height,
    provenance,
    rasterBytes,
  })
  if (outcome.ok) {
    console.log(`  ✓ ${PRODUCTION_TERRAIN.meta}（元数据契约通过）`)
    console.log(`  ✓ ${PRODUCTION_TERRAIN.raster}（位深 ${outcome.samples.distinctCodes} 个不同编码，16 位精度保持）`)
    console.log(
      `  · 抽样（米）：青藏 ${outcome.samples.tibetanMeters.toFixed(0)} / 东部 ${outcome.samples.easternMeters.toFixed(0)} / ` +
        `四川盆地 ${outcome.samples.sichuanBasinMeters.toFixed(0)} / 周边山地 ${outcome.samples.sichuanSurroundingsMeters.toFixed(0)} / ` +
        `塔里木盆地 ${outcome.samples.tarimBasinMeters.toFixed(0)} / 天山 ${outcome.samples.tarimNorthRimMeters.toFixed(0)} / 昆仑 ${outcome.samples.tarimSouthRimMeters.toFixed(0)} / ` +
        `东海陆架 ${outcome.samples.eastChinaSeaShelfMeters.toFixed(0)} / 南海深海 ${outcome.samples.southChinaSeaDeepMeters.toFixed(0)}`,
    )
    console.log(
      `  · 编码端点：code=0 → ${outcome.samples.decodedAtZeroCode}m / code=65535 → ${outcome.samples.decodedAtMaxCode}m / ` +
        `实测 [${outcome.samples.observedMinMeters.toFixed(0)}, ${outcome.samples.observedMaxMeters.toFixed(0)}]`,
    )
    console.log('  ✓ 地势抽样不变量通过：青藏高于东部、四川/塔里木盆地低于周边山地、浅海含负高程、深海截断到下限')
    console.log(
      `  ✓ ${PRODUCTION_TERRAIN.provenance}（来源与元数据一致 + 完整性摘要逐项一致：SHA-256 / 字节数 / 统计量）`,
    )
  } else {
    failures++
    for (const err of outcome.errors) {
      console.error(`  ✗ [${err.code}] ${err.path}: ${err.message}`)
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

  // 展开 all 为全部已登记 scope。
  const expanded: string[] = []
  for (const scope of scopes) {
    if (scope === 'all') {
      expanded.push(...Object.keys(SCOPE_REGISTRY))
    } else if (scope in SCOPE_REGISTRY) {
      expanded.push(scope)
    } else {
      console.error(`未知 scope：${scope}。可选：all, ${Object.keys(SCOPE_REGISTRY).join(', ')}`)
      process.exit(2)
    }
  }

  let totalFailures = 0
  for (const scope of expanded) {
    totalFailures += SCOPE_REGISTRY[scope].customVerify()
  }

  if (totalFailures > 0) {
    console.error(`\n校验完成，存在 ${totalFailures} 项失败。`)
    process.exit(1)
  }
  console.log('\n校验完成，全部通过。')
}

main()
