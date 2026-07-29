/**
 * Vitest 配置。
 *
 * 为什么独立于 vite.config.ts：测试在 Node 环境运行即可，不需要
 * @vitejs/plugin-react 参与。单独配置避免 React 插件把测试误当作组件处理，
 * 也保证 vitest 与生产构建互不影响。
 *
 * 依赖方向：本文件只属于测试基线（devDependency），不进入浏览器运行时包。
 */
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
  },
})
