/**
 * 资产契约验证结果类型。
 *
 * 依赖方向：本模块只依赖 TypeScript 基础类型，处于契约层最底层，与 codes.ts 同级，
 * 不得引入渲染层或资产生产脚本。所有具体契约验证器都产出这里的统一结果，
 * 使验证入口、测试夹具与未来的 CLI 能用同一套判定与定位语义。
 *
 * 设计决策：验证失败时不抛异常、不静默修正，而是收集全部可定位错误一次性返回。
 * 原因有二：一是「确定性失败而非静默修正」是本契约的硬约束；二是一次性给出全部错误
 * 让人工或 CI 能在一次运行中看到完整问题清单，而不是逐条改完再发现下一条。
 */

/**
 * 单条契约验证错误。
 * 每个字段都为「确定性 + 可定位」服务：code 供测试断言，path 供定位到具体条目，
 * message 用简体中文给出可读说明。
 */
export interface ContractValidationError {
  /** 机器可读的错误代码（稳定标识），便于自动化测试精确断言。 */
  readonly code: string
  /** 出错位置。JSON 路径或条目标识，便于定位到具体条目而非泛泛报错。 */
  readonly path: string
  /** 面向人类的简体中文说明，解释违反的不变量。 */
  readonly message: string
}

/**
 * 验证结果判别联合。
 * ok 为 true 时表示通过；ok 为 false 时 errors 至少含一条，调用方不得忽略。
 */
export type ContractValidationOutcome =
  | { readonly ok: true }
  | { readonly ok: false; readonly errors: readonly ContractValidationError[] }

/** 构造一个通过结果。 */
export function valid(): ContractValidationOutcome {
  return { ok: true }
}

/**
 * 构造一个失败结果。
 * 入参为空时仍强制视为失败（errors 退化为单条「未给出错误详情」），
 * 避免调用方误把「没有收集到错误」当作「通过」。
 */
export function invalid(errors: readonly ContractValidationError[]): ContractValidationOutcome {
  if (errors.length === 0) {
    return {
      ok: false,
      errors: [
        {
          code: 'contract.no-error-detail',
          path: '$',
          message: '验证器判定为失败，但未给出任何错误详情，这本身违反契约。',
        },
      ],
    }
  }
  return { ok: false, errors }
}

/** 构造单条错误，省去调用处重复拼装对象字面量。 */
export function error(code: string, path: string, message: string): ContractValidationError {
  return { code, path, message }
}
