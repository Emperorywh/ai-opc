// 改为从 vitest/config 引入 defineConfig，
// 这样 defineConfig 的入参类型会带上 vitest 的 `test` 字段，
// 无需额外 triple-slash 引用即可直接配置测试。
import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  test: {
    // Phase 1 的单测仅覆盖纯逻辑模块
    // （loader / bezier / laneOffset / geometry / arrows），
    // 它们不依赖任何 DOM API，因此使用 node 环境即可，
    // 避免引入 jsdom 的额外体积与配置。
    // 后续若要单测 React 层组件，再单独切换到 jsdom。
    environment: 'node',
  },
})
