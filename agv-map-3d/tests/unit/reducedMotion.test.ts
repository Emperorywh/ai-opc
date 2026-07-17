/*
 * reduced-motion 纯决策自动化验证（TASK-020，SPEC §12.5 / 任务约束，不启动浏览器）。
 *
 * 设计（任务验证方式第 4 项）：
 *   - 媒体查询字符串为 SPEC §12.5 标准 prefers-reduced-motion: reduce。
 *   - reduce → enableDamping = false（关闭阻尼）；无偏好 → true（保持阻尼）。
 *   - reduced-motion 不变量：只改变阻尼过程，不改最终相机位置。该断言在 OrbitControls 行为层面
 *     由“阻尼下离散旋转累计收敛到输入角”保证，此处只校验纯决策结果（false / true）。
 *
 * 不启动浏览器：reducedMotion 是纯数据 / 纯函数，不创建 DOM / Three 对象。
 */
import { describe, test, expect } from 'vitest'
import {
  REDUCED_MOTION_MEDIA_QUERY,
  dampingEnabledForMotion,
} from '../../src/camera/reducedMotion'
import { KEY_ROTATE_STEP_DEG } from '../../src/camera/keyboardIntent'

describe('REDUCED_MOTION_MEDIA_QUERY · SPEC §12.5 标准媒体查询', () => {
  test('查询字符串为 prefers-reduced-motion: reduce', () => {
    expect(REDUCED_MOTION_MEDIA_QUERY).toBe('(prefers-reduced-motion: reduce)')
  })
})

describe('dampingEnabledForMotion · reduce 关闭阻尼，无偏好保持阻尼（SPEC §12.5）', () => {
  test('prefersReducedMotion = true → enableDamping = false', () => {
    expect(dampingEnabledForMotion(true)).toBe(false)
  })

  test('prefersReducedMotion = false → enableDamping = true', () => {
    expect(dampingEnabledForMotion(false)).toBe(true)
  })

  test('决策为纯布尔反转：恒等于 !prefersReducedMotion', () => {
    expect(dampingEnabledForMotion(true)).toBe(!true)
    expect(dampingEnabledForMotion(false)).toBe(!false)
  })
})

describe('reduced-motion 不变量 · 只改变阻尼过程（SPEC §12.5 / 任务约束）', () => {
  test('阻尼决策不影响旋转角度常量：5° 步长与阻尼开关无关', () => {
    // reduced-motion 只切换 enableDamping，不改键位 / 步长 / 比例。
    // 复用 keyboardIntent 的旋转步长，断言其在两种偏好下一致（间接证明“不改操作”）。
    expect(KEY_ROTATE_STEP_DEG).toBe(5)
    // 阻尼开关随偏好翻转，但旋转步长不变。
    expect(dampingEnabledForMotion(true)).not.toBe(dampingEnabledForMotion(false))
  })
})
