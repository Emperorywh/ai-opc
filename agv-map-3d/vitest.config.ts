/*
 * Vitest 配置（TASK-001 基线，TASK-018 扩展集成层）。
 *
 * 默认环境为 node：覆盖 tests/unit 下的纯函数与架构断言。
 *   - 不使用 jsdom，不渲染 React 组件，不接触 WebGL；满足“自动化验证不得启动浏览器”的约束。
 *
 * tests/integration 下的集成测试可按需声明 jsdom 环境（文件首行 // @vitest-environment jsdom），
 *   以挂载 R3F 场景图层组件并验证 StrictMode 下的资源生命周期；该环境仅用于这些 React 级集成断言，
 *   不启动浏览器、不接触 WebGL（图层组件构造 Three 对象无需 WebGL 上下文）。
 * 后续 TASK 需要视觉 / 性能测试时，再以独立 include 与 project 配置扩展（留给人工 / Playwright）。
 */
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/unit/**/*.test.ts', 'tests/integration/**/*.test.ts'],
    pool: 'forks',
    // 真实样本为 6.5MB JSON，解析 / 校验 / 几何构建在 forks 池满载并行下需要更宽裕的时间预算；
    // 不影响通过用例（快速用例仍按实际耗时返回），仅为避免机器高负载下的误超时。
    testTimeout: 30000,
    hookTimeout: 30000,
  },
})
