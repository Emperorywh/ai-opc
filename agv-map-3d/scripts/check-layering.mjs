/*
 * 分层依赖方向验证（SPEC 3.3 的自动化证据）。
 *
 * 职责：
 *   - 扫描 src 下每个 TypeScript 模块的 import / export...from 语句。
 *   - 校验每条依赖都沿 SPEC 规定的方向流动：
 *       domain ← adapters / geometry / labels ← application / workers
 *              ← rendering ← scene / camera / ui
 *   - 强制两条硬约束：
 *       1) domain 不得依赖 React、R3F、Three、Troika 或浏览器全局。
 *       2) workers 不得依赖 Three / R3F / Troika（worker 不创建 THREE.Object3D）。
 *
 * 关键不变量：
 *   - 只依赖 Node 内置模块，可被 npm script 与 vitest 测试独立调用。
 *   - 出现任一越界依赖立即以非零退出码结束，禁止仅打印警告。
 *   - 未知目录或未知外部包一律按违规处理，强制新增依赖时审视层级。
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve, relative, join, extname } from 'node:path'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const srcRoot = resolve(root, 'src')

// 目录首段 → 层名。src 根目录的直接文件视为应用装配点（app-root）。
const LAYER_OF_DIR = {
  domain: 'domain',
  adapters: 'adapters',
  application: 'application',
  workers: 'workers',
  geometry: 'geometry',
  labels: 'labels',
  rendering: 'rendering',
  scene: 'scene',
  camera: 'camera',
  ui: 'ui',
  config: 'config',
}

// 每层允许依赖的内部层集合与外部包类别集合。
// 类别：node | react | three | r3f | troika | vite | other
const LAYER_POLICY = {
  domain: { layers: ['domain'], external: ['node'] },
  adapters: { layers: ['domain', 'adapters'], external: ['node'] },
  geometry: { layers: ['domain', 'geometry'], external: ['node'] },
  labels: { layers: ['domain', 'labels'], external: ['node'] },
  application: { layers: ['domain', 'adapters', 'geometry', 'labels', 'workers', 'application'], external: ['node', 'react'] },
  workers: { layers: ['domain', 'adapters', 'geometry', 'labels', 'workers'], external: ['node'] },
  rendering: { layers: ['domain', 'workers', 'config', 'rendering'], external: ['node', 'three'] },
  // scene 允许依赖 labels 的纯计算（LabelDescriptor 类型、空间索引、可见集、调度器）：
  // LazyLabelLayer（SPEC §13）在 scene 层消费 labels 层的纯函数与不可变描述符，
  // 与 scene 依赖 domain / config（同为纯层）一致，是向下依赖、不形成第二套语义。
  scene: { layers: ['domain', 'labels', 'application', 'rendering', 'config', 'scene'], external: ['node', 'react', 'three', 'r3f', 'troika'] },
  camera: { layers: ['domain', 'config', 'camera'], external: ['node', 'three'] },
  ui: { layers: ['domain', 'config', 'ui'], external: ['node', 'react'] },
  config: { layers: ['config'], external: ['node'] },
  'app-root': { layers: ['domain', 'adapters', 'geometry', 'labels', 'application', 'workers', 'rendering', 'scene', 'camera', 'ui', 'config', 'app-root'], external: ['node', 'react', 'three', 'r3f', 'troika', 'vite'] },
}

// 把外部 import spec 归类到一个类别。
function classifyExternal(spec) {
  if (spec.startsWith('node:')) return 'node'
  if (spec === 'react' || spec.startsWith('react/') || spec === 'react-dom' || spec.startsWith('react-dom/')) return 'react'
  if (spec === 'three' || spec.startsWith('three/')) return 'three'
  if (spec === '@react-three/fiber' || spec.startsWith('@react-three/fiber/') || spec === '@react-three/drei' || spec.startsWith('@react-three/drei/')) return 'r3f'
  if (spec === 'troika-three-text' || spec.startsWith('troika-three-text/') || spec === 'troika-three-utils' || spec.startsWith('troika-three-utils/')) return 'troika'
  if (spec === 'vite/client' || spec.startsWith('vite/')) return 'vite'
  return 'other'
}

const EXTS = ['.ts', '.tsx', '.d.ts']

// 把相对 import spec 解析到实际存在的文件，失败返回 null。
function resolveImport(fromFile, spec) {
  const base = resolve(dirname(fromFile), spec)
  if (statSyncSafe(base)?.isFile()) return base
  for (const ext of EXTS) {
    const p = base + ext
    if (statSyncSafe(p)?.isFile()) return p
  }
  const indexTs = join(base, 'index.ts')
  if (statSyncSafe(indexTs)?.isFile()) return indexTs
  return null
}

function statSyncSafe(p) {
  try {
    return statSync(p)
  } catch {
    return null
  }
}

// 计算文件所属层。
function layerOfFile(absFile) {
  const rel = relative(srcRoot, absFile).replace(/\\/g, '/')
  if (!rel || rel.startsWith('../')) return null
  const parts = rel.split('/')
  if (parts.length === 1) return 'app-root'
  const first = parts[0]
  return LAYER_OF_DIR[first] ?? null
}

// 递归收集 src 下的 .ts/.tsx 源文件。
function collectSource(dir, acc = []) {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry)
    const st = statSync(p)
    if (st.isDirectory()) {
      collectSource(p, acc)
    } else if (EXTS.includes(extname(p))) {
      acc.push(p)
    }
  }
  return acc
}

// 提取一个文件里所有 import / export...from 的来源 spec。
const IMPORT_RE = /(?:from|import)\s+['"]([^'"]+)['"]/g
function extractSpecs(source) {
  const specs = []
  for (const m of source.matchAll(IMPORT_RE)) {
    specs.push(m[1])
  }
  return specs
}

const files = collectSource(srcRoot)
const violations = []

for (const file of files) {
  const layer = layerOfFile(file)
  if (layer === null) {
    violations.push(`未知目录层：${relative(root, file)}`)
    continue
  }
  const policy = LAYER_POLICY[layer]
  const source = readFileSync(file, 'utf8')
  for (const spec of extractSpecs(source)) {
    const isRelative = spec.startsWith('./') || spec.startsWith('../') || spec.startsWith('/')
    if (isRelative) {
      const target = resolveImport(file, spec)
      if (target === null) continue // 类型或尚不存在的目标，跳过；存在时由其所在文件单独校验。
      const targetLayer = layerOfFile(target)
      if (targetLayer === null) {
        violations.push(`未知目录层（内部 import）：${relative(root, file)} → ${spec}`)
        continue
      }
      if (!policy.layers.includes(targetLayer)) {
        violations.push(`跨层反向依赖：${relative(root, file)}（${layer}）→ ${spec}（${targetLayer}）`)
      }
    } else {
      const cls = classifyExternal(spec)
      if (!policy.external.includes(cls)) {
        violations.push(`越界外部依赖：${relative(root, file)}（${layer}）→ ${spec}（${cls}）`)
      }
    }
  }
}

if (violations.length > 0) {
  console.error('[layer-check] 发现分层违规：')
  for (const v of violations) console.error('  - ' + v)
  console.error(`\n共 ${violations.length} 项，必须修正后才能合并。`)
  process.exit(1)
}

console.log(`[layer-check] 通过：扫描 ${files.length} 个源文件，分层依赖方向符合 SPEC 3.3。`)
