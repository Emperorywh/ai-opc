/*
 * 标签按需帧协调纯逻辑自动化验证（TASK-022，SPEC 11.3 第 8 项 / 11.4 / 13 / 任务约束）。
 *
 * 设计：
 *   - 纯函数验证：字体门禁接入、首帧 / 运动 / 停止 / resize 的事件映射与 10Hz 节流、
 *     差量挂载、billboard 位姿、view-projection 矩阵构建。
 *   - 不启动浏览器：相机位姿以数值签名显式传入（makeCameraSignature），时钟 nowMs 显式传入，
 *     不接触 R3F / OrbitControls / DOM；billboard 数学用 Three 纯对象（无需 WebGL）。
 */
import { describe, test, expect } from 'vitest'
import { Quaternion, Vector3 } from 'three'
import {
  applyVisibilityTarget,
  buildLabelCameraInput,
  computeLabelTextTransform,
  initialLabelCoordinatorState,
  makeCameraSignature,
  planLabelFrame,
} from '../../src/scene/labelFrameCoordinator'
import { initialVisibilitySchedulerState } from '../../src/labels/labelVisibilityScheduler'
import type { LabelDescriptor } from '../../src/labels/labelDescriptor'

// ─── 测试工具 ───────────────────────────────────────────────────────────────

function sig(px: number, py: number, pz: number, qx = 0, qy = 0, qz = 0, qw = 1) {
  return makeCameraSignature(px, py, pz, qx, qy, qz, qw)!
}

function descriptor(overrides: Partial<LabelDescriptor> & { id: string }): LabelDescriptor {
  return {
    ownerId: overrides.id,
    kind: 'operational-node',
    text: overrides.id,
    anchorX: 0,
    anchorY: 0.25,
    anchorZ: 0,
    localOffsetX: 0,
    localOffsetY: 0,
    ...overrides,
  }
}

const SIZE = { width: 1920, height: 1080 }

// ─── makeCameraSignature · 有限性 ────────────────────────────────────────────

describe('makeCameraSignature · 非有限位姿返回 null（SPEC 16 / 任务约束）', () => {
  test('全有限 → 返回签名', () => {
    expect(makeCameraSignature(1, 2, 3, 0, 0, 0, 1)).not.toBeNull()
  })
  test('任一非有限 → null', () => {
    expect(makeCameraSignature(Number.NaN, 2, 3, 0, 0, 0, 1)).toBeNull()
    expect(makeCameraSignature(1, 2, 3, 0, 0, 0, Number.POSITIVE_INFINITY)).toBeNull()
  })
})

// ─── 字体门禁接入（任务“字体门禁接入”）──────────────────────────────────────────

describe('planLabelFrame · 字体门禁未通过不查询不挂载（SPEC 11.1 / 4.2 / 任务约束）', () => {
  test('fontReady=false：任意帧 / 运动都不产出查询或 invalidate', () => {
    const state = initialLabelCoordinatorState()
    const p = planLabelFrame({
      state,
      currentSignature: sig(0, 0, 10),
      size: SIZE,
      nowMs: 1000,
      fontReady: false,
    })
    // 字体门禁失败信号不产生任何查询计划，不挂载部分标签。
    expect(p.shouldQuery).toBe(false)
    expect(p.invalidate).toBe(false)
    // 状态保持初始（不更新 prevSignature / scheduler），使字体就绪后从首帧重新起算。
    expect(p.state).toBe(state)
  })
})

// ─── 首帧 / 运动 / 停止 / resize 事件映射（SPEC 11.3 第 8 项）──────────────────

describe('planLabelFrame · 首帧必然查询并 invalidate（SPEC 11.3 第 8 项 / 13）', () => {
  test('首帧（prevSignature=null + prevSize=null）→ shouldQuery + invalidate', () => {
    const state = initialLabelCoordinatorState()
    const p = planLabelFrame({
      state,
      currentSignature: sig(0, 0, 10),
      size: SIZE,
      nowMs: 1000,
      fontReady: true,
    })
    // scheduler 初始 lastQueryMs=-∞，首个 change/resize 必然通过 10Hz 节流。
    expect(p.shouldQuery).toBe(true)
    // 首帧必然 invalidate：demand 帧模式下首屏可见集计算后必有一次渲染。
    expect(p.invalidate).toBe(true)
    // 状态推进：prevSignature / prevSize 记录本帧，wasMoving=true（首帧视为位移）。
    expect(p.state.prevSignature).not.toBeNull()
    expect(p.state.prevSize).toEqual(SIZE)
    expect(p.state.wasMoving).toBe(true)
  })
})

describe('planLabelFrame · 运动映射 controls-change 10Hz 节流（SPEC 11.3 第 8 项）', () => {
  test('相机持续位移：100ms 内第二次查询被节流跳过', () => {
    // 首帧查询（lastQueryMs=1000）。
    let state = initialLabelCoordinatorState()
    state = planLabelFrame({ state, currentSignature: sig(0, 0, 10), size: SIZE, nowMs: 1000, fontReady: true }).state
    // 1050ms（50ms 后）相机继续位移 → 'controls-change'，距上次 50ms < 100ms → 节流跳过。
    const p = planLabelFrame({ state, currentSignature: sig(0, 0, 9), size: SIZE, nowMs: 1050, fontReady: true })
    expect(p.shouldQuery).toBe(false)
    // 1100ms（100ms 后）位移 → 通过节流查询。
    const p2 = planLabelFrame({ state, currentSignature: sig(0, 0, 8), size: SIZE, nowMs: 1100, fontReady: true })
    expect(p2.shouldQuery).toBe(true)
  })

  test('位移刚结束 → controls-end 立即查询，不被 10Hz 吞掉（任务关键异常路径）', () => {
    // 建立运动历史：首帧位移 lastQueryMs=1000。
    let state = initialLabelCoordinatorState()
    state = planLabelFrame({ state, currentSignature: sig(0, 0, 10), size: SIZE, nowMs: 1000, fontReady: true }).state
    // 继续位移到 1050ms（节流窗口内）。
    state = planLabelFrame({ state, currentSignature: sig(0, 0, 9), size: SIZE, nowMs: 1050, fontReady: true }).state
    // 1060ms 相机停止（签名不变）：wasMoving=true、本帧未位移 → 'controls-end' 立即查询。
    const stopped = sig(0, 0, 9)
    const p = planLabelFrame({ state, currentSignature: stopped, size: SIZE, nowMs: 1060, fontReady: true })
    expect(p.shouldQuery).toBe(true)
    expect(p.state.wasMoving).toBe(false)
  })

  test('阻尼尾段残余位移（低于 OrbitControls 阈值）→ controls-end 立即查询（TASK-022 根因修复）', () => {
    // 复刻 TASK-022 MEDIUM 缺口：OrbitControls（three 0.185.1）在 3D 距离 < 1e-3 时停止派发 'change'，
    // 但 damping 尾段每帧残余位移仍可达 ~1e-4~1e-3。旧实现把运动判定阈值取 1e-9，会把这种残余位移
    // 判为“仍在位移”（5e-4 >> 1e-9）→ 'controls-change'；而 demand 模式下该尾段帧是最后被调度的一帧，
    // 协调器再无后续帧可观察 wasMoving && !isMoving → 'controls-end' 形同死代码，违反 SPEC §11.3 第 8 项
    // “end 后立即更新一次”。修复把阈值对齐到 OrbitControls 的 'change' 派发阈值，使尾段首帧即判为静止。
    let state = initialLabelCoordinatorState()
    // 首帧：远超阈值的活跃位移（建立 wasMoving=true）。
    state = planLabelFrame({ state, currentSignature: sig(0, 0, 10), size: SIZE, nowMs: 1000, fontReady: true }).state
    // 第二帧：继续活跃位移（3D 距离 1.0 >> 1e-3，OrbitControls 必派发 'change'）。
    state = planLabelFrame({ state, currentSignature: sig(0, 0, 9), size: SIZE, nowMs: 1100, fontReady: true }).state
    // 第三帧：damping 尾段残余位移 5e-4（3D 距离平方 2.5e-7 < 1e-6 → OrbitControls 不再派发 'change'，
    // 由上一帧 'change' → invalidate 调度，是 demand 模式下最后会运行的一帧）。
    // wasMoving 仍为 true → 'controls-end' 立即查询；nowMs=1150 距上次查询 50ms < 100ms，
    // 验证 'controls-end' 不被 10Hz 节流吞掉。
    const p = planLabelFrame({
      state,
      currentSignature: sig(0, 0, 9 + 5e-4),
      size: SIZE,
      nowMs: 1150,
      fontReady: true,
    })
    expect(p.shouldQuery).toBe(true)
    expect(p.state.wasMoving).toBe(false)
  })

  test('位移刚越过 OrbitControls 阈值 → 仍判为位移 → controls-change（阈值不可过大）', () => {
    // 边界互补：3D 距离 1.2e-3（平方 1.44e-6 > 1e-6）恰越过 OrbitControls 'change' 阈值，
    // 协调器必须仍判为“仍在位移”→ 'controls-change'（受 10Hz 节流），不得误判为静止而漏查。
    let state = initialLabelCoordinatorState()
    state = planLabelFrame({ state, currentSignature: sig(0, 0, 9), size: SIZE, nowMs: 1000, fontReady: true }).state
    // 1100ms：越过阈值的位移 → 'controls-change'，距上次 100ms → 通过节流查询。
    const p = planLabelFrame({
      state,
      currentSignature: sig(0, 0, 9 + 1.2e-3),
      size: SIZE,
      nowMs: 1100,
      fontReady: true,
    })
    expect(p.shouldQuery).toBe(true)
    expect(p.state.wasMoving).toBe(true)
  })

  test('持续静止 → 无事件、不查询、不 invalidate（SPEC §15.5 静止零空转）', () => {
    // 建立已停止状态。
    let state = initialLabelCoordinatorState()
    state = planLabelFrame({ state, currentSignature: sig(0, 0, 10), size: SIZE, nowMs: 1000, fontReady: true }).state
    state = planLabelFrame({ state, currentSignature: sig(0, 0, 10), size: SIZE, nowMs: 2000, fontReady: true }).state
    // 再次同位姿：持续静止 → 不查询、不 invalidate。
    const p = planLabelFrame({ state, currentSignature: sig(0, 0, 10), size: SIZE, nowMs: 3000, fontReady: true })
    expect(p.shouldQuery).toBe(false)
    expect(p.invalidate).toBe(false)
  })
})

describe('planLabelFrame · resize 立即查询（SPEC 11.3 第 8 项）', () => {
  test('画布尺寸变化 → shouldQuery + invalidate，独立于运动判定', () => {
    // 建立已停止、已观测尺寸的状态。
    let state = initialLabelCoordinatorState()
    state = planLabelFrame({ state, currentSignature: sig(0, 0, 10), size: SIZE, nowMs: 1000, fontReady: true }).state
    // 尺寸变化（相机静止）：resize 立即查询。
    const p = planLabelFrame({
      state,
      currentSignature: sig(0, 0, 10),
      size: { width: 1080, height: 1920 },
      nowMs: 1050,
      fontReady: true,
    })
    expect(p.shouldQuery).toBe(true)
    expect(p.invalidate).toBe(true)
  })
})

describe('planLabelFrame · 退化位姿跳过（SPEC 16 / 任务约束）', () => {
  test('currentSignature=null → 不查询、保留状态', () => {
    const state = initialLabelCoordinatorState()
    const p = planLabelFrame({
      state,
      currentSignature: null,
      size: SIZE,
      nowMs: 1000,
      fontReady: true,
    })
    expect(p.shouldQuery).toBe(false)
    expect(p.invalidate).toBe(false)
  })
})

// ─── 差量挂载（SPEC 11.3 第 7 项）────────────────────────────────────────────

describe('applyVisibilityTarget · 只在目标变化时标记 changed（SPEC 11.3 第 7 项）', () => {
  test('目标与当前相同 → changed=false（不触发 setMountedIds / invalidate）', () => {
    const cur = ['a', 'b']
    const applied = applyVisibilityTarget(cur, ['a', 'b'])
    expect(applied.changed).toBe(false)
    expect(applied.nextMounted).toBe(cur)
  })
  test('长度不同 → changed=true', () => {
    expect(applyVisibilityTarget(['a'], ['a', 'b']).changed).toBe(true)
    expect(applyVisibilityTarget(['a', 'b'], ['a']).changed).toBe(true)
  })
  test('同长度不同元素 → changed=true', () => {
    expect(applyVisibilityTarget(['a', 'b'], ['a', 'c']).changed).toBe(true)
  })
})

// ─── billboard 位姿（SPEC 11.4 / 11.2）────────────────────────────────────────

describe('computeLabelTextTransform · billboard 朝向与屏幕偏移（SPEC 11.4 / 11.2）', () => {
  test('quaternion 恒为 camera world quaternion（始终面向相机）', () => {
    const desc = descriptor({ id: 'n', anchorX: 5, anchorZ: 3 })
    const q = { x: 0.1, y: 0.2, z: 0.3, w: 0.9 }
    const t = computeLabelTextTransform(q, desc)
    expect(t.quaternion).toEqual([0.1, 0.2, 0.3, 0.9])
  })

  test('单位四元数：偏移沿世界 +X / +Y（屏幕右下方语义在朝向相机时退化）', () => {
    // node 半径 0.15 → 局部偏移 (0.225, -0.225)。
    const desc = descriptor({ id: 'n', anchorX: 5, anchorY: 0.25, anchorZ: 3, localOffsetX: 0.225, localOffsetY: -0.225 })
    const t = computeLabelTextTransform({ x: 0, y: 0, z: 0, w: 1 }, desc)
    // right=(1,0,0)、up=(0,1,0)：position = anchor + (0.225, -0.225, 0)。
    expect(t.position[0]).toBeCloseTo(5.225, 10)
    expect(t.position[1]).toBeCloseTo(0.025, 10)
    expect(t.position[2]).toBeCloseTo(3, 10)
  })

  test('边标签 localOffset=0：position = 世界锚点', () => {
    const desc = descriptor({ id: 'e', kind: 'edge', anchorX: -2, anchorY: 0.25, anchorZ: 7, localOffsetX: 0, localOffsetY: 0 })
    const t = computeLabelTextTransform({ x: 0, y: 0, z: 0, w: 1 }, desc)
    expect(t.position).toEqual([-2, 0.25, 7])
  })

  test('旋转相机后偏移沿 cameraRight / cameraUp（屏幕方向，非固定世界轴）', () => {
    // 绕 +Y 旋转 90°：用 Three 计算旋转后的相机右轴 / 上轴。
    const q = new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), Math.PI / 2)
    const right = new Vector3(1, 0, 0).applyQuaternion(q)
    const up = new Vector3(0, 1, 0).applyQuaternion(q)
    const anchorX = 2, anchorY = 0.25, anchorZ = 4
    const desc = descriptor({ id: 'n', anchorX, anchorY, anchorZ, localOffsetX: 1, localOffsetY: 0.5 })
    const t = computeLabelTextTransform(
      { x: q.x, y: q.y, z: q.z, w: q.w },
      desc,
    )
    // position = anchor + right×localOffsetX + up×localOffsetY（屏幕方向，非固定世界轴）。
    expect(t.position[0]).toBeCloseTo(anchorX + right.x * 1 + up.x * 0.5, 10)
    expect(t.position[1]).toBeCloseTo(anchorY + right.y * 1 + up.y * 0.5, 10)
    expect(t.position[2]).toBeCloseTo(anchorZ + right.z * 1 + up.z * 0.5, 10)
    // 单位四元数旋转保持轴单位长度。
    expect(up.length()).toBeCloseTo(1, 10)
    expect(right.length()).toBeCloseTo(1, 10)
  })
})

// ─── view-projection 构建（SPEC 11.3 第 1 项）──────────────────────────────────

describe('buildLabelCameraInput · VP = P × V + 四元数 + 画布尺寸（SPEC 11.3 第 1 项）', () => {
  test('返回 16 元素列主序 VP 与显式四元数 / 尺寸', () => {
    // 单位投影 × 单位 view → 单位 VP；与 labelProjection 约定一致。
    const proj = [
      1, 0, 0, 0,
      0, 1, 0, 0,
      0, 0, 1, 0,
      0, 0, 0, 1,
    ]
    const view = [
      1, 0, 0, 0,
      0, 1, 0, 0,
      0, 0, 1, 0,
      5, 6, 7, 1,
    ]
    const input = buildLabelCameraInput({
      projectionMatrix: proj,
      matrixWorldInverse: view,
      quaternion: { x: 0.1, y: 0.2, z: 0.3, w: 0.4 },
      size: { width: 800, height: 600 },
    })
    expect(input.viewProjectionMatrix.length).toBe(16)
    // VP = P × V：平移列（索引 12/13/14）取自 view 的平移（单位投影不改变）。
    expect(input.viewProjectionMatrix[12]).toBeCloseTo(5, 10)
    expect(input.viewProjectionMatrix[13]).toBeCloseTo(6, 10)
    expect(input.viewProjectionMatrix[14]).toBeCloseTo(7, 10)
    expect(input.cameraWorldQuaternion).toEqual([0.1, 0.2, 0.3, 0.4])
    expect(input.canvasWidthPx).toBe(800)
    expect(input.canvasHeightPx).toBe(600)
  })
})

// ─── 初始状态契约 ─────────────────────────────────────────────────────────────

describe('initialLabelCoordinatorState · 首帧与首查询必然触发', () => {
  test('prevSignature=null、prevSize=null、scheduler 初始 -∞', () => {
    const s = initialLabelCoordinatorState()
    expect(s.prevSignature).toBeNull()
    expect(s.prevSize).toBeNull()
    expect(s.wasMoving).toBe(false)
    expect(s.scheduler).toEqual(initialVisibilitySchedulerState())
  })
})
