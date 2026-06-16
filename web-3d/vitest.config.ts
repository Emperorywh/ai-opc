import { defineConfig } from 'vitest/config'

// 测试基建（Task 03 引入）。测试置于 src 外的 test/，避免被 tsconfig.app 纳入 tsc -b 构建；
// vitest 经 esbuild 转译运行，不阻塞 `pnpm build`。
export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
  },
})
