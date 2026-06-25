import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    include: ['scripts/data-pipeline/test/**/*.test.ts'],
  },
})
