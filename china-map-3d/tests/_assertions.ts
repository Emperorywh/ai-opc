/**
 * 测试断言助手：把契约验证结果包装成更可读的断言。
 * 只服务于测试基线，不属于契约公共面。
 */

import { expect } from 'vitest'
import type { ContractValidationOutcome } from '../src/geo-contracts'

/** 断言验证通过。 */
export function expectValid(outcome: ContractValidationOutcome): void {
  expect(outcome).toStrictEqual({ ok: true })
}

/** 断言验证失败，且错误码集合恰好等于传入集合（顺序无关）。 */
export function expectInvalidWithCodes(
  outcome: ContractValidationOutcome,
  codes: readonly string[],
): void {
  expect(outcome.ok).toBe(false)
  if (!outcome.ok) {
    expect(outcome.errors.map((entry) => entry.code).sort()).toStrictEqual([...codes].sort())
  }
}

/** 断言验证失败，且错误码集合包含给定集合（允许附加错误，顺序无关）。 */
export function expectInvalidContainingCodes(
  outcome: ContractValidationOutcome,
  codes: readonly string[],
): void {
  expect(outcome.ok).toBe(false)
  if (!outcome.ok) {
    const actual = outcome.errors.map((entry) => entry.code)
    for (const code of codes) {
      expect(actual).toContain(code)
  }
  }
}
