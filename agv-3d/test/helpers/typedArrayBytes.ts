/**
 * 测试用：TypedArray 字节级比较工具（SPEC §7.1、TASK-004 验证方式）。
 *
 * 把 TypedArray 视为底层字节序列逐字节比较，用于断言相同输入与配置重复编译产生
 * 完全一致的可转移缓冲。该工具独立于被测实现，作为确定性验证的独立标尺：
 * 元素级比较虽与字节级比较在 IEEE 754 下等价，但字节级比较直接表达"可转移缓冲
 * 完全一致"的契约语义（逐字节比较所有 TypedArray）。
 *
 * 纯函数，不依赖被测代码，不进入 src，避免污染生产依赖。
 */

/** 取 ArrayBufferView 底层字节序列的 Uint8Array 视图（含 byteOffset 与 byteLength）。 */
function byteView(view: ArrayBufferView): Uint8Array {
  return new Uint8Array(view.buffer, view.byteOffset, view.byteLength)
}

/**
 * 逐字节比较两个 TypedArray 是否完全一致（字节长度与每个字节均相等）。
 * 不做数值容差，任一字节差异即返回 false。
 */
export function typedArrayBytesEqual(a: ArrayBufferView, b: ArrayBufferView): boolean {
  const va = byteView(a)
  const vb = byteView(b)
  if (va.length !== vb.length) return false
  for (let i = 0; i < va.length; i += 1) {
    if (va[i] !== vb[i]) return false
  }
  return true
}
