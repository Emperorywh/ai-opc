#!/usr/bin/env node
/**
 * Task 13 · 大洲/大洋标签数据 pipeline —— CLI 入口。
 *
 * 运行：  pnpm gen:labels
 * 产出：  public/data/labels.json（{id,zhName,kind,continent,lon,lat,priority} × 11）
 *
 * SPEC §6.5 / §12.4。M4 范围：七大洲 + 四大洋（固定常识数据，无需外部数据源 join）。
 * 数据定义与纯函数在 lib/labels-data.mjs（pipeline 与 vitest 共用，零改动即可被 Task 14 前端消费）。
 */

import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { mkdirSync, writeFileSync } from 'node:fs'
import { buildLabels, CONTINENT_LABELS, OCEAN_LABELS } from './lib/labels-data.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const OUT_DIR = resolve(__dirname, '../../public/data')
const OUT_FILE = resolve(OUT_DIR, 'labels.json')

mkdirSync(OUT_DIR, { recursive: true })

const labels = buildLabels()
writeFileSync(OUT_FILE, `${JSON.stringify(labels, null, 2)}\n`, 'utf8')

console.log(`[gen:labels] 写入 ${labels.length} 条标签 → ${OUT_FILE}`)
console.log(`  · 大洲 ${CONTINENT_LABELS.length} 条（priority ${CONTINENT_LABELS[0].priority}）`)
console.log(`  · 大洋 ${OCEAN_LABELS.length} 条（priority ${OCEAN_LABELS[0].priority}）`)
for (const l of labels) {
  console.log(`  - ${l.zhName}（${l.id}，${l.kind}，${l.lon},${l.lat}，P${l.priority}）`)
}
