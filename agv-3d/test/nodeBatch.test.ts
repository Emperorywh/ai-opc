import { describe, expect, it } from 'vitest'
import type { NodeInstancePacket } from '../src/features/agv-map/domain/renderPacket'
import type { RawNodeType } from '../src/features/agv-map/domain/rawDto'
import {
  NODE_BATCH_TYPES,
  assertNodeInstancePacket,
} from '../src/features/agv-map/presentation/scene/nodeBatch'

/**
 * 节点批次契约单元测试（SPEC §7.2、§11.1、§10.2，TASK-009）。
 *
 * 覆盖：
 * - 批次数量固定为 4（SPEC §11.1 节点 DrawCall 4），穷尽 RawNodeType 封闭联合且无重复。
 * - 渲染数据包自洽校验：一致通过；不一致抛 RangeError，交由场景错误边界接入统一 error 状态
 *   （TASK-009 异常路径"不跳过坏记录"）。
 */

/** 构造一个指定 count 的自洽实例包；matrices 长度默认等于 count×16。 */
function packet(count: number, matricesLength?: number): NodeInstancePacket {
  return {
    count,
    matrices: new Float32Array(matricesLength ?? count * 16),
  }
}

describe('NODE_BATCH_TYPES — 固定四批（SPEC §7.2、§11.1）', () => {
  it('批次数量恰好为 4（节点 DrawCall 4）', () => {
    expect(NODE_BATCH_TYPES).toHaveLength(4)
  })

  it('穷尽 RawNodeType 封闭联合，不遗漏、不重复', () => {
    const set = new Set<RawNodeType>(NODE_BATCH_TYPES)
    expect(set.size).toBe(4)
    for (const type of ['node', 'work', 'charge', 'park'] as const) {
      expect(set.has(type)).toBe(true)
    }
  })

  it('顺序固定为 node → work → charge → park，保证渲染顺序与实例下标可复现', () => {
    expect([...NODE_BATCH_TYPES]).toEqual(['node', 'work', 'charge', 'park'])
  })
})

describe('assertNodeInstancePacket — 自洽通过（TASK-009 正常路径）', () => {
  it('count×16 === matrices.length 时不抛错', () => {
    for (const type of NODE_BATCH_TYPES) {
      expect(() => assertNodeInstancePacket(packet(5), type)).not.toThrow()
    }
  })

  it('空包（count=0、matrices 长度 0）通过', () => {
    expect(() => assertNodeInstancePacket(packet(0), 'node')).not.toThrow()
  })

  it('大 count（V76 规模）通过', () => {
    // V76 基线 node 类型 1304 个实例。
    expect(() => assertNodeInstancePacket(packet(1304), 'node')).not.toThrow()
  })
})

describe('assertNodeInstancePacket — 不一致抛 RangeError（TASK-009 异常路径）', () => {
  it('matrices 短于 count×16 时抛错（不静默上传越界 NaN 矩阵）', () => {
    // count 声称 3 个实例，但 matrices 只有 32 个分量（2 个矩阵）。
    expect(() => assertNodeInstancePacket(packet(3, 32), 'work')).toThrow(RangeError)
  })

  it('matrices 长于 count×16 时抛错', () => {
    expect(() => assertNodeInstancePacket(packet(1, 48), 'charge')).toThrow(RangeError)
  })

  it('负 count 抛错', () => {
    expect(() => assertNodeInstancePacket(packet(-1, 0), 'park')).toThrow(RangeError)
  })

  it('非整数 count 抛错', () => {
    const malformed: NodeInstancePacket = { count: 1.5, matrices: new Float32Array(16) }
    expect(() => assertNodeInstancePacket(malformed, 'node')).toThrow(RangeError)
  })

  it('抛错信息包含类型名，便于错误定位', () => {
    try {
      assertNodeInstancePacket(packet(2, 16), 'work')
      expect.unreachable('应抛 RangeError')
    } catch (error) {
      expect(error).toBeInstanceOf(RangeError)
      expect(String((error as Error).message)).toContain('work')
    }
  })
})
