/*
 * Vitest 配置（TASK-001 基线）。
 *
 * 仅运行 tests/unit 下的纯函数与架构断言，环境为 node：
 *   - 不使用 jsdom，不渲染 React 组件，不接触 WebGL。
 *   - 满足“自动化验证不得启动浏览器”的约束。
 * 后续 TASK 需要集成 / 视觉 / 性能测试时，再以独立 include 与 project 配置扩展。
 */
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/unit/**/*.test.ts'],
    pool: 'forks',
  },
})
