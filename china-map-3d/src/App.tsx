/**
 * 大屏页面根（TASK-009）。
 *
 * 默认 Vite 脚手架模板已被替换为独立大屏 3D 地势场景。本文件只做「挂载场景」一件事——
 * 场景装配、资产访问、领域配置、GPU 位移渲染都在各自分层内（见 src/scenes、src/three、src/config），
 * App 不内联任何渲染 / 取数 / 配置逻辑（TASK-009 输出约束「没有巨型组件或跨层读取」）。
 */

import type { ReactNode } from 'react'
import { ChinaMapScreen } from './scenes/ChinaMapScreen'
import './App.css'

function App(): ReactNode {
  return <ChinaMapScreen />
}

export default App
