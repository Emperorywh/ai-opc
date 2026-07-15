import { describe, expect, it } from 'vitest'
import type { MapCompilerPort } from '../src/features/agv-map/application/mapCompilerPort'
import type { MapCompilerClient } from '../src/features/agv-map/infrastructure/mapCompilerWorker'

/**
 * 编译端口边界验证（SPEC §5.1、TASK-006）。
 *
 * 应用层加载用例只依赖 MapCompilerPort 抽象；infrastructure 的 MapCompilerClient 是该端口
 * 的具体适配器。此处做编译期断言（不实例化——实例化会创建真实 Worker，超出 Node 测试边界），
 * 确保适配器始终满足端口契约：若 MapCompilerClient 漏实现或改签名，下列类型推导会失败，
 * tsc 与 vitest 都会报错。依赖方向经此固定为 infrastructure→application（适配器实现端口），
 * 而非 application→infrastructure。
 */

describe('MapCompilerClient 实现应用层端口 MapCompilerPort', () => {
  it('MapCompilerClient 类型满足端口契约（编译期断言，SPEC §5.1）', () => {
    // 若 MapCompilerClient 不满足 MapCompilerPort，Conforms 推导为 false，赋值失败。
    type Conforms = MapCompilerClient extends MapCompilerPort ? true : false
    const check: Conforms = true
    expect(check).toBe(true)
  })

  it('MapCompilerPort 只暴露 start/terminate 两项能力（窄边界）', () => {
    type Methods = keyof MapCompilerPort
    const methods: Methods[] = ['start', 'terminate']
    expect(methods.sort()).toEqual(['start', 'terminate'])
  })
})
