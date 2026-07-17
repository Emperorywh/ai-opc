/*
 * 应用入口（app-root 层）。
 *
 * 以 StrictMode 挂载根组件；后续 TASK 的 R3F 资源初始化与清理必须保持幂等，
 * 以满足 StrictMode 双调用与 HMR 的生命周期要求（SPEC 4.3）。
 */
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
