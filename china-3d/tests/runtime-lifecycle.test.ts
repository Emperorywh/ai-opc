/**
 * 大屏长时运行生命周期的确定性状态机、resize 防抖与集中编排接线测试（TASK-015，SPEC §7.4）。
 *
 * 依赖方向：测试基线（vitest，Node 环境），import src/lib/runtime-lifecycle（纯函数状态机 + 防抖纯变换）、
 * src/config/runtime-lifecycle（冻结 RUNTIME_LIFECYCLE_CONFIG）、src 源码文本（集中编排接线扫描）。
 * 不依赖浏览器 / React / Three.js / R3F——状态机与防抖是纯函数 / 纯状态变换，可在 Node 直接断言
 * 「context 状态迁移正确」「resize 防抖只产生有限次提交且最终尺寸 = 最后一次输入」「非法迁移被忽略」
 * 等不变量，无需启动浏览器 / WebGL（丢失 / 恢复与 resize 的端到端验收见
 * docs/performance-measurement-record.md 的无头验证记录）。
 *
 * 覆盖（对应 TASK-015 验收条件 1、2）：
 * - 验收 1「webglcontextlost 时暂停渲染并给出状态提示，webglcontextrestored 后 GPU 资源重建、渲染恢复」：
 *   状态机成功路径 running→context-lost→restoring→running、失败路径（重建抛错 / 恢复超时）
 *   →restore-failed 显式终态、isRuntimePaused 暂停语义；源码扫描锁定「监听器唯一（控制器）+
 *   状态提示 overlay 接线 + preventDefault + 暂停消费（EntranceController / SeaSurface 读 paused）」。
 * - 验收 2「窗口 resize debounce 后 camera/renderer 尺寸正确更新」：防抖纯变换「连续输入只保留最后一次、
 *   一次提交、尺寸未变不重复提交、非法尺寸忽略」；源码扫描锁定控制器防抖提交路径
 *   （gl.setSize + camera.updateProjectionMatrix + invalidate）。
 * - 集中编排不变量：全 src 仅 RuntimeLifecycleController 监听 webglcontextlost / webglcontextrestored，
 *   其余渲染层不各自监听；运行时模块无独立动画时钟（控制器定时器仅用于超时 / 防抖，非视觉时钟）。
 */

import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  INITIAL_RESIZE_DEBOUNCER_STATE,
  INITIAL_RUNTIME_LIFECYCLE_STATE,
  commitPendingResize,
  isRuntimeFailed,
  isRuntimePaused,
  reduceRuntimeLifecycle,
  recordResizeInput,
  type RuntimeLifecycleState,
} from '../src/lib/runtime-lifecycle'
import { RUNTIME_LIFECYCLE_CONFIG } from '../src/config/runtime-lifecycle'

const srcRoot = resolve(fileURLToPath(import.meta.url), '../../src')

/** 以 UTF-8 文本读取 src 下某个模块源码（装配接线断言用）。 */
function readSource(relativePath: string): string {
  return readFileSync(resolve(srcRoot, relativePath), 'utf-8')
}

/** 去除块注释与行注释（扫描「代码中出现 / 不出现某写法」类断言前先剥离注释，避免注释文字干扰）。 */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1')
}

/** 递归收集 src 下全部 .ts / .tsx 相对路径（集中编排唯一监听器扫描用）。 */
function collectSourceFiles(dir: string, prefix = ''): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir)) {
    const abs = resolve(dir, entry)
    const rel = prefix === '' ? entry : `${prefix}/${entry}`
    if (statSync(abs).isDirectory()) {
      out.push(...collectSourceFiles(abs, rel))
    } else if (entry.endsWith('.ts') || entry.endsWith('.tsx')) {
      out.push(rel)
    }
  }
  return out
}

/** 方便：从当前状态应用一个事件，返回新状态（链式断言用）。 */
function apply(
  state: RuntimeLifecycleState,
  event: Parameters<typeof reduceRuntimeLifecycle>[1],
): RuntimeLifecycleState {
  return reduceRuntimeLifecycle(state, event)
}

describe('初始状态：挂载即 running（context 尚未丢失）', () => {
  it('INITIAL_RUNTIME_LIFECYCLE_STATE.phase === running、无诊断', () => {
    expect(INITIAL_RUNTIME_LIFECYCLE_STATE.phase).toBe('running')
    expect(INITIAL_RUNTIME_LIFECYCLE_STATE.failureMessage).toBeNull()
  })

  it('INITIAL_RUNTIME_LIFECYCLE_STATE 已冻结（运行时不可被偷偷改）', () => {
    expect(Object.isFrozen(INITIAL_RUNTIME_LIFECYCLE_STATE)).toBe(true)
  })
})

describe('context 状态迁移：running→lost→restoring→running（验收 1 成功路径）', () => {
  it('模拟完整成功恢复：running → context-lost → restoring → running', () => {
    let s: RuntimeLifecycleState = INITIAL_RUNTIME_LIFECYCLE_STATE
    expect(s.phase).toBe('running')

    // context 丢失：running → context-lost。
    s = apply(s, { type: 'context-lost' })
    expect(s.phase).toBe('context-lost')
    expect(s.failureMessage).toBeNull()

    // context 恢复：context-lost → restoring。
    s = apply(s, { type: 'context-restored' })
    expect(s.phase).toBe('restoring')

    // GPU 重建成功：restoring → running（回归正常运行）。
    s = apply(s, { type: 'restore-succeeded' })
    expect(s.phase).toBe('running')
    expect(s.failureMessage).toBeNull()
  })

  it('context-lost / restoring 期间 isRuntimePaused=true（各渲染层据此冻结视觉推进）', () => {
    expect(isRuntimePaused('context-lost')).toBe(true)
    expect(isRuntimePaused('restoring')).toBe(true)
    expect(isRuntimePaused('running')).toBe(false)
    expect(isRuntimePaused('restore-failed')).toBe(false)
  })
})

describe('context 状态迁移：running→lost→restoring→failed（验收 1 失败路径）', () => {
  it('GPU 重建抛错：restoring → restore-failed（显式终态 + 诊断）', () => {
    let s: RuntimeLifecycleState = INITIAL_RUNTIME_LIFECYCLE_STATE
    s = apply(s, { type: 'context-lost' })
    s = apply(s, { type: 'context-restored' })
    expect(s.phase).toBe('restoring')

    // GPU 重建失败：restoring → restore-failed，携带诊断。
    s = apply(s, { type: 'restore-failed', message: 'GPU 资源重建失败：纹理上传异常。' })
    expect(s.phase).toBe('restore-failed')
    expect(s.failureMessage).toBe('GPU 资源重建失败：纹理上传异常。')
    expect(isRuntimeFailed('restore-failed')).toBe(true)
  })

  it('context 恢复超时：context-lost → restore-failed（不进入空白死循环）', () => {
    let s: RuntimeLifecycleState = INITIAL_RUNTIME_LIFECYCLE_STATE
    s = apply(s, { type: 'context-lost' })
    expect(s.phase).toBe('context-lost')

    // 浏览器未在超时内触发 restored：context-lost → restore-failed（超时路径）。
    s = apply(s, { type: 'restore-failed', message: 'WebGL context 恢复超时（8 秒内未恢复）。' })
    expect(s.phase).toBe('restore-failed')
    expect(s.failureMessage).toContain('恢复超时')
  })

  it('restore-failed 为终态：后续 restore-succeeded / context-restored 不改变状态（不自动重试 / 不回退）', () => {
    let s: RuntimeLifecycleState = INITIAL_RUNTIME_LIFECYCLE_STATE
    s = apply(s, { type: 'context-lost' })
    s = apply(s, { type: 'context-restored' })
    s = apply(s, { type: 'restore-failed', message: 'GPU 资源重建失败。' })
    expect(s.phase).toBe('restore-failed')

    // 终态下：restore-succeeded 被忽略（restoring 才接受）。
    s = apply(s, { type: 'restore-succeeded' })
    expect(s.phase).toBe('restore-failed')
    // 终态下：context-restored 被忽略（context-lost 才接受）。
    s = apply(s, { type: 'context-restored' })
    expect(s.phase).toBe('restore-failed')
    // 诊断信息保留（不丢失）。
    expect(s.failureMessage).toBe('GPU 资源重建失败。')
  })

  it('restore-failed 后再次丢失 / 恢复可自愈：restore-failed → context-lost → restoring → running', () => {
    let s: RuntimeLifecycleState = INITIAL_RUNTIME_LIFECYCLE_STATE
    s = apply(s, { type: 'context-lost' })
    s = apply(s, { type: 'context-restored' })
    s = apply(s, { type: 'restore-failed', message: '首次重建失败。' })
    expect(s.phase).toBe('restore-failed')

    // 再次丢失（restore-failed 属运行类态，可丢失）：restore-failed → context-lost。
    s = apply(s, { type: 'context-lost' })
    expect(s.phase).toBe('context-lost')
    expect(s.failureMessage).toBeNull()

    // 恢复 + 重建成功：→ restoring → running（大屏自愈）。
    s = apply(s, { type: 'context-restored' })
    expect(s.phase).toBe('restoring')
    s = apply(s, { type: 'restore-succeeded' })
    expect(s.phase).toBe('running')
  })
})

describe('非法迁移被忽略（保持原状态，错误事件不破坏不变量）', () => {
  it('running 收到 context-restored：忽略（context 未丢失谈不上恢复）', () => {
    const s = apply(INITIAL_RUNTIME_LIFECYCLE_STATE, { type: 'context-restored' })
    expect(s.phase).toBe('running')
  })

  it('running 收到 restore-succeeded / restore-failed：忽略（未进入 restoring）', () => {
    let s = apply(INITIAL_RUNTIME_LIFECYCLE_STATE, { type: 'restore-succeeded' })
    expect(s.phase).toBe('running')
    s = apply(s, { type: 'restore-failed', message: 'x' })
    expect(s.phase).toBe('running')
  })

  it('context-lost 收到 restore-succeeded：忽略（未进入 restoring）', () => {
    let s = apply(INITIAL_RUNTIME_LIFECYCLE_STATE, { type: 'context-lost' })
    s = apply(s, { type: 'restore-succeeded' })
    expect(s.phase).toBe('context-lost')
  })

  it('restoring 收到 context-lost：忽略（restoring 期间丢失由恢复路径覆盖，不在状态机层重复）', () => {
    let s = apply(INITIAL_RUNTIME_LIFECYCLE_STATE, { type: 'context-lost' })
    s = apply(s, { type: 'context-restored' })
    expect(s.phase).toBe('restoring')
    s = apply(s, { type: 'context-lost' })
    expect(s.phase).toBe('restoring')
  })

  it('非法迁移返回同一引用（可被控制器用引用相等判定「无变化」跳过下游通知）', () => {
    const before = INITIAL_RUNTIME_LIFECYCLE_STATE
    const after = apply(before, { type: 'context-restored' })
    expect(after).toBe(before)
  })
})

describe('重复 context 丢失 / 恢复：状态机幂等、无累加状态', () => {
  it('多次完整恢复循环后状态回归 running、无残留', () => {
    let s: RuntimeLifecycleState = INITIAL_RUNTIME_LIFECYCLE_STATE
    for (let i = 0; i < 5; i++) {
      s = apply(s, { type: 'context-lost' })
      expect(s.phase).toBe('context-lost')
      s = apply(s, { type: 'context-restored' })
      expect(s.phase).toBe('restoring')
      s = apply(s, { type: 'restore-succeeded' })
      expect(s.phase).toBe('running')
    }
    // 5 次循环后仍为 running、无诊断残留。
    expect(s.phase).toBe('running')
    expect(s.failureMessage).toBeNull()
  })

  it('状态机是纯函数：相同 (state, event) 永远得同一输出（无内部计数器 / 隐式状态）', () => {
    const s0 = INITIAL_RUNTIME_LIFECYCLE_STATE
    const a = reduceRuntimeLifecycle(s0, { type: 'context-lost' })
    const b = reduceRuntimeLifecycle(s0, { type: 'context-lost' })
    expect(a).toEqual(b)
  })
})

describe('resize 防抖：连续输入只产生有限次提交，最终尺寸 = 最后一次输入（验收 2）', () => {
  it('连续 N 次输入 + 单次提交：committed = 最后一次输入、commitCount=1', () => {
    let s = INITIAL_RESIZE_DEBOUNCER_STATE
    // 模拟连续 resize：1920x1080 → 1600x900 → 1280x720 → 1920x1200（拖拽中的多次变化）。
    s = recordResizeInput(s, 1920, 1080)
    s = recordResizeInput(s, 1600, 900)
    s = recordResizeInput(s, 1280, 720)
    s = recordResizeInput(s, 1920, 1200)
    // 防抖窗口内：pending = 最后一次输入，未提交。
    expect(s.pending).toEqual({ width: 1920, height: 1200 })
    expect(s.committed).toBeNull()
    expect(s.commitCount).toBe(0)

    // 防抖窗口结束、提交：committed = 最后一次输入、commitCount=1。
    const result = commitPendingResize(s)
    s = result.state
    expect(result.committed).toEqual({ width: 1920, height: 1200 })
    expect(s.committed).toEqual({ width: 1920, height: 1200 })
    expect(s.commitCount).toBe(1)
  })

  it('防抖窗口结束后无新输入：再次提交为无操作（commitCount 不增）', () => {
    let s = INITIAL_RESIZE_DEBOUNCER_STATE
    s = recordResizeInput(s, 1920, 1080)
    let result = commitPendingResize(s)
    s = result.state
    expect(s.commitCount).toBe(1)

    // 无新输入再次提交：pending 已清空 → 无操作。
    result = commitPendingResize(s)
    expect(result.committed).toBeNull()
    expect(result.state.commitCount).toBe(1)
  })

  it('尺寸未变：提交为无操作（不重复提交，commitCount 不增）', () => {
    let s = INITIAL_RESIZE_DEBOUNCER_STATE
    s = recordResizeInput(s, 1920, 1080)
    let result = commitPendingResize(s)
    s = result.state
    expect(s.commitCount).toBe(1)

    // 再次输入相同尺寸并提交：尺寸未变 → 无操作。
    s = recordResizeInput(s, 1920, 1080)
    result = commitPendingResize(s)
    expect(result.committed).toBeNull()
    expect(result.state.commitCount).toBe(1)
  })

  it('非法尺寸（非有限 / 非正）被忽略，不污染 pending', () => {
    let s = INITIAL_RESIZE_DEBOUNCER_STATE
    s = recordResizeInput(s, 1920, 1080)
    // 非法输入：NaN / Infinity / 0 / 负值。
    s = recordResizeInput(s, Number.NaN, 1080)
    s = recordResizeInput(s, 1920, Number.POSITIVE_INFINITY)
    s = recordResizeInput(s, 0, 1080)
    s = recordResizeInput(s, 1920, -100)
    // pending 保持最后一次合法输入。
    expect(s.pending).toEqual({ width: 1920, height: 1080 })
  })

  it('初始无输入即提交：无操作（不产生空提交）', () => {
    const result = commitPendingResize(INITIAL_RESIZE_DEBOUNCER_STATE)
    expect(result.committed).toBeNull()
    expect(result.state.commitCount).toBe(0)
  })

  it('多轮防抖：每轮连续输入只提交一次最终尺寸（commitCount = 轮数）', () => {
    // 模拟 3 轮独立 resize（每轮多次抖动后稳定）。
    let s = INITIAL_RESIZE_DEBOUNCER_STATE
    const rounds: ReadonlyArray<readonly [number, number]> = [
      [1920, 1080],
      [1600, 900],
      [2560, 1440],
    ]
    for (const [w, h] of rounds) {
      // 每轮抖动若干次。
      s = recordResizeInput(s, w, h)
      s = recordResizeInput(s, w + 10, h)
      s = recordResizeInput(s, w, h)
      const result = commitPendingResize(s)
      s = result.state
      expect(result.committed).toEqual({ width: w, height: h })
    }
    expect(s.commitCount).toBe(3)
    expect(s.committed).toEqual({ width: 2560, height: 1440 })
  })

  it('小数输入取整提交（渲染器尺寸必须整数像素）', () => {
    let s = INITIAL_RESIZE_DEBOUNCER_STATE
    s = recordResizeInput(s, 1920.6, 1080.4)
    const result = commitPendingResize(s)
    expect(result.committed).toEqual({ width: 1921, height: 1080 })
  })
})

describe('运行时配置不变量（冻结、有限、正）', () => {
  it('RUNTIME_LIFECYCLE_CONFIG 全部冻结、字段有限为正', () => {
    expect(Object.isFrozen(RUNTIME_LIFECYCLE_CONFIG)).toBe(true)
    expect(Number.isFinite(RUNTIME_LIFECYCLE_CONFIG.contextRestoreTimeoutMs)).toBe(true)
    expect(RUNTIME_LIFECYCLE_CONFIG.contextRestoreTimeoutMs).toBeGreaterThan(0)
    expect(Number.isFinite(RUNTIME_LIFECYCLE_CONFIG.resizeDebounceMs)).toBe(true)
    expect(RUNTIME_LIFECYCLE_CONFIG.resizeDebounceMs).toBeGreaterThan(0)
  })

  it('context 恢复超时（8 秒）远长于浏览器常规恢复延迟（< 1 秒）', () => {
    expect(RUNTIME_LIFECYCLE_CONFIG.contextRestoreTimeoutMs).toBeGreaterThanOrEqual(5000)
  })

  it('resize 防抖窗口（160ms）在「过滤连续拖拽」与「无明显延迟」之间', () => {
    expect(RUNTIME_LIFECYCLE_CONFIG.resizeDebounceMs).toBeGreaterThanOrEqual(50)
    expect(RUNTIME_LIFECYCLE_CONFIG.resizeDebounceMs).toBeLessThanOrEqual(500)
  })
})

describe('集中编排接线（验收 1、2：监听器唯一、状态提示与暂停消费接线）', () => {
  it('全 src 仅 RuntimeLifecycleController 监听 webglcontextlost / webglcontextrestored（无第二监听点）', () => {
    const files = collectSourceFiles(srcRoot)
    const listeners = files.filter((f) => {
      const code = stripComments(readSource(f))
      return code.includes('webglcontextlost') || code.includes('webglcontextrestored')
    })
    expect(listeners).toEqual(['three/RuntimeLifecycleController.tsx'])
  })

  it('控制器丢失时 preventDefault（阻止默认不可恢复行为）+ 注册 / 移除监听成对', () => {
    const source = readSource('three/RuntimeLifecycleController.tsx')
    expect(source).toContain('event.preventDefault()')
    expect(source).toContain("canvas.addEventListener('webglcontextlost', onContextLost)")
    expect(source).toContain("canvas.addEventListener('webglcontextrestored', onContextRestored)")
    expect(source).toContain("canvas.removeEventListener('webglcontextlost', onContextLost)")
    expect(source).toContain("canvas.removeEventListener('webglcontextrestored', onContextRestored)")
  })

  it('控制器恢复时重建 GPU 资源（restoreSceneGpuResources）+ 同步渲染器 / 相机（setSize + updateProjectionMatrix）', () => {
    const source = readSource('three/RuntimeLifecycleController.tsx')
    expect(source).toContain('restoreSceneGpuResources(scene)')
    expect(source).toContain('gl.setSize(width, height, false)')
    expect(source).toContain('camera.updateProjectionMatrix()')
    // 防抖提交路径携带 overlay 尺寸回调（验收 2 的「camera/renderer 尺寸正确更新」单一路径）。
    expect(source).toContain('onCommittedSizeRef.current(width, height)')
    // 防抖窗口来自配置唯一源（不复制常量）。
    expect(source).toContain('RUNTIME_LIFECYCLE_CONFIG.resizeDebounceMs')
    expect(source).toContain('RUNTIME_LIFECYCLE_CONFIG.contextRestoreTimeoutMs')
  })

  it('EntranceController / SeaSurface 只读 runtimeFrame.paused 冻结视觉推进（不各自监听 context）', () => {
    const entrance = readSource('three/EntranceController.tsx')
    const sea = readSource('three/SeaSurface.tsx')
    for (const code of [entrance, sea]) {
      expect(code).toContain('runtimeFrame')
      expect(code).toContain('.paused')
      expect(code).not.toContain('webglcontextlost')
      expect(code).not.toContain('webglcontextrestored')
      expect(code).not.toContain('addEventListener')
    }
    // 入场控制器恢复后把暂停时长折叠进起始偏移（elapsed 从原位继续、无跳变）。
    expect(entrance).toContain('pauseStartRef')
    expect(entrance).toContain('startClockRef.current += pausedFor')
  })

  it('App 总装：控制器挂在 Canvas 内、状态提示 overlay 挂在 Canvas 外、运行时帧单一 ref 下发', () => {
    const source = readSource('App.tsx')
    expect(source).toContain("from './three/RuntimeLifecycleController'")
    expect(source).toContain("from './components/ui/RuntimeStatusOverlay'")
    expect(source).toContain("useRef<RuntimeFrame>({ phase: 'running', paused: false })")
    // 控制器在 Canvas 内（</Canvas> 之前），overlay 在 Canvas 外（</Canvas> 之后）。
    const controllerIndex = source.indexOf('<RuntimeLifecycleController')
    const canvasCloseIndex = source.indexOf('</Canvas>')
    const overlayIndex = source.indexOf('<RuntimeStatusOverlay')
    expect(controllerIndex).toBeGreaterThan(-1)
    expect(controllerIndex).toBeLessThan(canvasCloseIndex)
    expect(overlayIndex).toBeGreaterThan(canvasCloseIndex)
    // 运行时帧下发到控制器 / 入场控制器 / 海面（同一 ref，无第二份运行时帧）。
    const runtimeFramePassCount = (source.match(/runtimeFrame=\{runtimeFrameRef\}/g) ?? []).length
    expect(runtimeFramePassCount).toBe(3)
    // overlay 消费阶段 state（来自 onPhaseChange 回调，非每帧 setState）。
    expect(source).toContain('onPhaseChange={handleRuntimePhaseChange}')
    expect(source).toContain('phase={runtimePhase}')
    expect(source).toContain('failureMessage={runtimeFailureMessage}')
  })

  it('运行时模块无独立动画时钟（领域层 / 配置层无计时器；控制器定时器仅用于超时与防抖）', () => {
    const lib = stripComments(readSource('lib/runtime-lifecycle.ts'))
    const config = stripComments(readSource('config/runtime-lifecycle.ts'))
    for (const code of [lib, config]) {
      expect(code).not.toContain('new THREE.Clock')
      expect(code).not.toContain('setTimeout(')
      expect(code).not.toContain('setInterval(')
      expect(code).not.toContain('Date.now(')
      expect(code).not.toContain('performance.now(')
    }
    const controller = stripComments(readSource('three/RuntimeLifecycleController.tsx'))
    expect(controller).not.toContain('new THREE.Clock')
    expect(controller).not.toContain('setInterval(')
    // 控制器的 setTimeout 仅两条路径：context 恢复超时 + resize 防抖（生命周期定时，非视觉时钟）。
    const timeoutCount = (controller.match(/window\.setTimeout\(/g) ?? []).length
    expect(timeoutCount).toBe(2)
  })
})
