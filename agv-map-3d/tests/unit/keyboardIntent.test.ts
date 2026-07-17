/*
 * 统一键盘导航意图自动化验证（TASK-020，SPEC §12.5 / 任务约束，不启动浏览器）。
 *
 * 设计（任务验证方式第 3、4 项）：
 *   - 键位映射：方向键 → 平移（基准轴 + 方向符号）、+/- → 缩放（0.9 / 1.1）、Q/E → 旋转（±5°）、
 *     Home → 复位、未知键 → none。所有数值常量来自 keyboardIntent 唯一来源。
 *   - 相机平面平移步长：给定相机 right / forward 基准轴与距离，断言步长 = 距离 × 5%，方向沿
 *     地面投影（Y = 0）归一化；左 / 右、前 / 后方向符号正确；退化输入返回 null。
 *   - 焦点边界与默认行为抑制范围：decideKeyConsumption 对未知键 / 可编辑来源不消费；
 *     已知键 + 非可编辑来源才消费。
 *
 * 不启动浏览器：keyboardIntent 是纯函数，不创建 Three / WebGL / DOM 对象。
 */
import { describe, test, expect } from 'vitest'
import {
  KEY_PAN_STEP_RATIO,
  KEY_ZOOM_IN_FACTOR,
  KEY_ZOOM_OUT_FACTOR,
  KEY_ROTATE_STEP_DEG,
  rotateStepRadians,
  interpretKey,
  decideKeyConsumption,
  computeKeyboardPanOffset,
} from '../../src/camera/keyboardIntent'
import type { Vec3 } from '../../src/camera/cameraFit'

// ─── 固定常量（SPEC §12.5）────────────────────────────────────────────────────

describe('SPEC §12.5 固定常量', () => {
  test('平移步长 5%、缩放 0.9/1.1、旋转 5°', () => {
    expect(KEY_PAN_STEP_RATIO).toBe(0.05)
    expect(KEY_ZOOM_IN_FACTOR).toBe(0.9)
    expect(KEY_ZOOM_OUT_FACTOR).toBe(1.1)
    expect(KEY_ROTATE_STEP_DEG).toBe(5)
  })

  test('rotateStepRadians = deg2rad(5°)', () => {
    expect(rotateStepRadians()).toBeCloseTo((5 * Math.PI) / 180, 10)
  })
})

// ─── 键位映射（SPEC §12.5）────────────────────────────────────────────────────

describe('interpretKey · 方向键 → 相机平面平移（SPEC §12.5）', () => {
  test('ArrowLeft：沿 right 轴、sign = -1（向左）', () => {
    expect(interpretKey('ArrowLeft')).toEqual({
      kind: 'pan',
      along: 'right',
      sign: -1,
    })
  })

  test('ArrowRight：沿 right 轴、sign = +1（向右）', () => {
    expect(interpretKey('ArrowRight')).toEqual({
      kind: 'pan',
      along: 'right',
      sign: 1,
    })
  })

  test('ArrowUp：沿 forward 轴、sign = +1（向前）', () => {
    expect(interpretKey('ArrowUp')).toEqual({
      kind: 'pan',
      along: 'forward',
      sign: 1,
    })
  })

  test('ArrowDown：沿 forward 轴、sign = -1（向后）', () => {
    expect(interpretKey('ArrowDown')).toEqual({
      kind: 'pan',
      along: 'forward',
      sign: -1,
    })
  })
})

describe('interpretKey · +/- → 缩放（SPEC §12.5）', () => {
  test('+ 与 = 均映射为 zoom in（factor 0.9，靠近）', () => {
    expect(interpretKey('+')).toEqual({ kind: 'zoom', factor: KEY_ZOOM_IN_FACTOR })
    // '=' 为美式布局同键未 Shift 形态，一并接受。
    expect(interpretKey('=')).toEqual({ kind: 'zoom', factor: KEY_ZOOM_IN_FACTOR })
  })

  test('- 与 _ 均映射为 zoom out（factor 1.1，远离）', () => {
    expect(interpretKey('-')).toEqual({ kind: 'zoom', factor: KEY_ZOOM_OUT_FACTOR })
    expect(interpretKey('_')).toEqual({ kind: 'zoom', factor: KEY_ZOOM_OUT_FACTOR })
  })
})

describe('interpretKey · Q/E → 绕 target 旋转（SPEC §12.5）', () => {
  test('q/Q 映射为向左旋转（+5°，逆时针俯视）', () => {
    const step = rotateStepRadians()
    expect(interpretKey('q')).toEqual({ kind: 'rotate', deltaRadians: step })
    expect(interpretKey('Q')).toEqual({ kind: 'rotate', deltaRadians: step })
  })

  test('e/E 映射为向右旋转（-5°，顺时针俯视）', () => {
    const step = rotateStepRadians()
    expect(interpretKey('e')).toEqual({ kind: 'rotate', deltaRadians: -step })
    expect(interpretKey('E')).toEqual({ kind: 'rotate', deltaRadians: -step })
  })

  test('Q/E 旋转角度互为相反数（左右对称）', () => {
    expect(interpretKey('q').kind === 'rotate' && (interpretKey('q') as { deltaRadians: number }).deltaRadians)
      .toBe(
        -(interpretKey('e').kind === 'rotate'
          ? (interpretKey('e') as { deltaRadians: number }).deltaRadians
          : NaN),
      )
  })
})

describe('interpretKey · Home → 复位（SPEC §12.5）', () => {
  test('Home 映射为 home 意图', () => {
    expect(interpretKey('Home')).toEqual({ kind: 'home' })
  })
})

describe('interpretKey · 未知键 → none（SPEC §12.5 / 任务“未消费按键不触发渲染”）', () => {
  test.each([
    'a',
    'Enter',
    ' ',
    'Tab',
    'Escape',
    'F1',
    'PageUp',
    'PageDown',
    'End',
    'Insert',
    'Delete',
    '0',
    'w',
    'd',
    's',
    '',
  ])('未知键 %s → none', (key) => {
    expect(interpretKey(key)).toEqual({ kind: 'none' })
  })
})

// ─── 相机平面平移步长（SPEC §12.5 / 任务“平移方向必须来自当前相机平面”）──────────

describe('computeKeyboardPanOffset · 步长 = 距离 × 5%，方向沿地面投影（SPEC §12.5）', () => {
  // 相机正对 -Z（forward = (0,0,-1)）、right = (1,0,0)：水平投影即自身。
  const right: Vec3 = { x: 1, y: 0, z: 0 }
  const forward: Vec3 = { x: 0, y: 0, z: -1 }
  const distance = 100

  test('ArrowRight 语义：沿 right、+1 → 步长 = +5% × distance，方向 +X', () => {
    const off = computeKeyboardPanOffset({
      cameraRight: right,
      cameraForward: forward,
      distance,
      along: 'right',
      sign: 1,
    })
    expect(off).not.toBeNull()
    expect(off!.dx).toBeCloseTo(distance * KEY_PAN_STEP_RATIO, 10)
    expect(off!.dz).toBeCloseTo(0, 10)
  })

  test('ArrowLeft 语义：沿 right、-1 → 步长 = -5% × distance，方向 -X', () => {
    const off = computeKeyboardPanOffset({
      cameraRight: right,
      cameraForward: forward,
      distance,
      along: 'right',
      sign: -1,
    })
    expect(off).not.toBeNull()
    expect(off!.dx).toBeCloseTo(-distance * KEY_PAN_STEP_RATIO, 10)
    expect(off!.dz).toBeCloseTo(0, 10)
  })

  test('ArrowUp 语义：沿 forward、+1 → 步长 = +5% × distance，方向 -Z（视线前方）', () => {
    const off = computeKeyboardPanOffset({
      cameraRight: right,
      cameraForward: forward,
      distance,
      along: 'forward',
      sign: 1,
    })
    expect(off).not.toBeNull()
    expect(off!.dx).toBeCloseTo(0, 10)
    expect(off!.dz).toBeCloseTo(-distance * KEY_PAN_STEP_RATIO, 10)
  })

  test('ArrowDown 语义：沿 forward、-1 → 步长 = -5% × distance，方向 +Z', () => {
    const off = computeKeyboardPanOffset({
      cameraRight: right,
      cameraForward: forward,
      distance,
      along: 'forward',
      sign: -1,
    })
    expect(off).not.toBeNull()
    expect(off!.dx).toBeCloseTo(0, 10)
    expect(off!.dz).toBeCloseTo(distance * KEY_PAN_STEP_RATIO, 10)
  })

  test('距离按比例：distance = 50 步长减半', () => {
    const off = computeKeyboardPanOffset({
      cameraRight: right,
      cameraForward: forward,
      distance: 50,
      along: 'right',
      sign: 1,
    })
    expect(off!.dx).toBeCloseTo(50 * KEY_PAN_STEP_RATIO, 10)
  })
})

describe('computeKeyboardPanOffset · 基准轴投影到地面（不写死世界轴，SPEC §12.5）', () => {
  test('相机绕 Y 偏航 90°：right = (0,0,1)、forward = (1,0,0)，右移步长方向变为 +Z', () => {
    const off = computeKeyboardPanOffset({
      cameraRight: { x: 0, y: 0, z: 1 },
      cameraForward: { x: 1, y: 0, z: 0 },
      distance: 80,
      along: 'right',
      sign: 1,
    })
    expect(off).not.toBeNull()
    expect(off!.dx).toBeCloseTo(0, 10)
    expect(off!.dz).toBeCloseTo(80 * KEY_PAN_STEP_RATIO, 10)
  })

  test('right 轴带 Y 分量（俯视角）：投影到 XZ 后归一化，Y 不影响步长', () => {
    // right = (1, 0.5, 0) 含上仰分量；水平投影 = (1, 0)，归一化仍为 +X。
    const off = computeKeyboardPanOffset({
      cameraRight: { x: 1, y: 0.5, z: 0 },
      cameraForward: { x: 0, y: 0.5, z: -1 },
      distance: 40,
      along: 'right',
      sign: 1,
    })
    expect(off).not.toBeNull()
    // 水平投影长度 = 1，步长 = 40 × 5% = 2，方向 +X。
    expect(off!.dx).toBeCloseTo(2, 10)
    expect(off!.dz).toBeCloseTo(0, 10)
  })
})

describe('computeKeyboardPanOffset · 退化输入返回 null（SPEC §16 / 任务约束）', () => {
  const right: Vec3 = { x: 1, y: 0, z: 0 }
  const forward: Vec3 = { x: 0, y: 0, z: -1 }

  test('距离非正 → null', () => {
    expect(
      computeKeyboardPanOffset({
        cameraRight: right,
        cameraForward: forward,
        distance: 0,
        along: 'right',
        sign: 1,
      }),
    ).toBeNull()
    expect(
      computeKeyboardPanOffset({
        cameraRight: right,
        cameraForward: forward,
        distance: -10,
        along: 'right',
        sign: 1,
      }),
    ).toBeNull()
  })

  test('距离非有限 → null', () => {
    expect(
      computeKeyboardPanOffset({
        cameraRight: right,
        cameraForward: forward,
        distance: Number.NaN,
        along: 'right',
        sign: 1,
      }),
    ).toBeNull()
    expect(
      computeKeyboardPanOffset({
        cameraRight: right,
        cameraForward: forward,
        distance: Number.POSITIVE_INFINITY,
        along: 'right',
        sign: 1,
      }),
    ).toBeNull()
  })

  test('基准轴水平投影退化为零（近乎正俯视）→ null', () => {
    // right = (0, 1, 0)：纯竖直，水平投影为零。
    expect(
      computeKeyboardPanOffset({
        cameraRight: { x: 0, y: 1, z: 0 },
        cameraForward: forward,
        distance: 100,
        along: 'right',
        sign: 1,
      }),
    ).toBeNull()
  })
})

// ─── 焦点边界与默认行为抑制范围（SPEC §12.5 / 任务约束）─────────────────────────

describe('decideKeyConsumption · 已知键 + 非可编辑来源 → 消费（SPEC §12.5）', () => {
  test.each(['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', '+', '-', 'q', 'Q', 'e', 'E', 'Home'])(
    '已知键 %s + 非可编辑来源 → consume = true',
    (key) => {
      const d = decideKeyConsumption({ key, isFromEditableTarget: false })
      expect(d.consume).toBe(true)
      expect(d.intent.kind).not.toBe('none')
    },
  )
})

describe('decideKeyConsumption · 未知键 → 不消费（SPEC §12.5 / 任务“不劫持全局键盘”）', () => {
  test.each(['Enter', 'Tab', ' ', 'Escape', 'a', 'PageDown'])(
    '未知键 %s → consume = false、intent = none',
    (key) => {
      const d = decideKeyConsumption({ key, isFromEditableTarget: false })
      expect(d.consume).toBe(false)
      expect(d.intent.kind).toBe('none')
    },
  )
})

describe('decideKeyConsumption · 可编辑控件来源 → 不消费（任务异常路径）', () => {
  test.each(['ArrowLeft', '+', 'q', 'Home'])(
    '来自可编辑控件的 %s → consume = false（不劫持文本输入）',
    (key) => {
      const d = decideKeyConsumption({ key, isFromEditableTarget: true })
      expect(d.consume).toBe(false)
      expect(d.intent.kind).toBe('none')
    },
  )
})
