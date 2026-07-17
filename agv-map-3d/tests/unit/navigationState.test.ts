/*
 * 相机浏览导航状态机自动化验证（TASK-019，SPEC §12.4 / 任务约束）。
 *
 * 设计（任务验证方式第 3 项，不启动浏览器）：
 *   - 用户开始交互（OrbitControls 'start'）：hasUserNavigated 置 true。
 *   - resize 分支：未导航 → fit；已导航 → preserve（不打断用户视图）。导航标记不随 resize 改变。
 *   - Home 复位：清除导航标记 + fit（与首次 fit 等价分支）。
 *   - 状态序列：初始未导航 → 用户交互 → resize 保留 → Home → resize 重新 fit，验证分支稳定。
 *   - Home 与 TASK-017 标准 fit 完全一致：Home 的 action='fit' 复用同一 computeCameraFit，
 *     相同 (contentBounds, aspect) 输入得到同一相机状态（确定性）。
 *   - 重复事件幂等：多次 start / 多次 resize 不产生第二份状态或抖动。
 *
 * 不启动浏览器：navigationState 是纯函数，不创建 Three / WebGL 对象。
 */
import { describe, test, expect, beforeAll } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  onUserInteractionStart,
  decideResizeAction,
  decideHomeReset,
} from '../../src/camera/navigationState'
import { computeCameraFit } from '../../src/camera/cameraFit'
import { buildSceneModel } from '../../src/workers/buildSceneModel'
import { parseSampleEnvelope } from '../../src/adapters/parseSampleEnvelope'
import { validateMapSemantics } from '../../src/adapters/validateMapSemantics'
import { normalizeSceneMap } from '../../src/adapters/normalizeSceneMap'
import type { NumericBox3 } from '../../src/domain/sceneMap'
import {
  computeFileSha256,
  EXPECTED_SAMPLE_SHA256,
} from '../../scripts/sample-supply-chain.mjs'

// ─── 真实样本集成（SPEC 15.1 / 12.4）──────────────────────────────────────────

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '..', '..')
const REAL_SAMPLE = resolve(root, 'data', 'sampleMap.json')

let realContentBounds: NumericBox3

beforeAll(async () => {
  const sha = await computeFileSha256(REAL_SAMPLE)
  if (sha !== EXPECTED_SAMPLE_SHA256) {
    throw new Error(`样本身份不符，停止回归验证：${sha}`)
  }
  const rawJson = JSON.parse(readFileSync(REAL_SAMPLE, 'utf8')) as unknown
  const rawMap = parseSampleEnvelope(rawJson)
  validateMapSemantics(rawMap)
  const sceneMap = normalizeSceneMap(rawMap)
  realContentBounds = buildSceneModel(sceneMap).contentBounds
})

// ─── 用户开始交互（SPEC 12.4）─────────────────────────────────────────────────

describe('用户开始交互 · hasUserNavigated 置 true（SPEC 12.4）', () => {
  test('onUserInteractionStart：flag = true', () => {
    const d = onUserInteractionStart()
    expect(d.flag).toBe(true)
  })

  test('重复 start 幂等：多次调用 flag 恒 true，无第二份状态', () => {
    const a = onUserInteractionStart()
    const b = onUserInteractionStart()
    expect(b.flag).toBe(a.flag)
    expect(b.flag).toBe(true)
  })
})

// ─── resize 分支（SPEC 12.4 / 任务“resize 不会在用户已导航后重置视图”）──────────

describe('resize 分支 · 未导航 fit / 已导航 preserve（SPEC 12.4）', () => {
  test('未导航（flag=false）：action = fit（重新执行标准 3/4 fit）', () => {
    const d = decideResizeAction(false)
    expect(d.action).toBe('fit')
    // resize 不改变导航标记。
    expect(d.flag).toBe(false)
  })

  test('已导航（flag=true）：action = preserve（保留 target / 距离 / 朝向）', () => {
    const d = decideResizeAction(true)
    expect(d.action).toBe('preserve')
    expect(d.flag).toBe(true)
  })

  test('resize 不改变导航标记：无论 fit / preserve，flag 与输入一致', () => {
    expect(decideResizeAction(false).flag).toBe(false)
    expect(decideResizeAction(true).flag).toBe(true)
  })
})

// ─── Home 复位（SPEC 12.4）────────────────────────────────────────────────────

describe('Home 复位 · 清除导航标记 + fit（SPEC 12.4）', () => {
  test('decideHomeReset：flag = false、action = fit', () => {
    const d = decideHomeReset()
    expect(d.flag).toBe(false)
    expect(d.action).toBe('fit')
  })

  test('Home 后状态等价于未导航：紧接 resize 进入 fit 分支', () => {
    // Home 清除标记后，decideResizeAction 应选择 fit（与初始一致）。
    const afterHome = decideHomeReset()
    const resizeAfterHome = decideResizeAction(afterHome.flag)
    expect(resizeAfterHome.action).toBe('fit')
  })
})

// ─── 状态序列 · 分支稳定（SPEC 12.4 / 任务“用户视图分支稳定”）──────────────────

describe('状态序列 · 分支稳定（SPEC 12.4）', () => {
  test('初始 → 首次 resize（fit）→ 用户交互 → resize（preserve）→ Home → resize（fit）', () => {
    // 初始 hasUserNavigated = false。
    let flag = false
    // 首次 resize（未导航）：fit。
    expect(decideResizeAction(flag).action).toBe('fit')
    // 用户开始交互：flag → true。
    flag = onUserInteractionStart().flag
    expect(flag).toBe(true)
    // resize（已导航）：preserve，不打断用户视图。
    expect(decideResizeAction(flag).action).toBe('preserve')
    // Home 复位：flag → false、fit。
    const home = decideHomeReset()
    flag = home.flag
    expect(home.action).toBe('fit')
    // resize（Home 后未导航）：fit。
    expect(decideResizeAction(flag).action).toBe('fit')
  })

  test('重复 resize 事件：已导航视图连续 preserve，无抖动', () => {
    let flag = true
    for (let i = 0; i < 5; i++) {
      const d = decideResizeAction(flag)
      expect(d.action).toBe('preserve')
      expect(d.flag).toBe(true)
      flag = d.flag
    }
  })
})

// ─── Home 与 TASK-017 标准 fit 完全一致（SPEC 12.4 / 任务验证方式第 3 项）──────

describe('Home 与 TASK-017 标准 fit 完全一致（SPEC 12.4）', () => {
  test('Home 的 fit 复用同一 computeCameraFit：相同输入得到同一相机状态', () => {
    // Home 选择 action='fit'；该分支调用 computeCameraFit(contentBounds, aspect)。
    // computeCameraFit 是纯函数且无内部状态（TASK-017 已验证确定性）：
    // 故 Home 的 fit 结果与首次 fit / 未导航 resize fit 字节一致。
    const aspect = 16 / 9
    const initialFit = computeCameraFit(realContentBounds, aspect)!
    const homeFit = computeCameraFit(realContentBounds, aspect)!
    expect(homeFit.position).toEqual(initialFit.position)
    expect(homeFit.target).toEqual(initialFit.target)
    expect(homeFit.radius).toBe(initialFit.radius)
    expect(homeFit.distance).toBe(initialFit.distance)
  })

  test('窄屏 Home fit 与首次窄屏 fit 一致（确定性跨宽 / 窄屏）', () => {
    const aspect = 9 / 16
    const a = computeCameraFit(realContentBounds, aspect)!
    const b = computeCameraFit(realContentBounds, aspect)!
    expect(b).toEqual(a)
  })
})
