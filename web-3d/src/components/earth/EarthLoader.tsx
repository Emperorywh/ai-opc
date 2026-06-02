/**
 * 地球纹理加载器
 * Suspense 边界 + 纹理加载状态管理
 * 加载完成后渲染 Earth 组件
 */
import { Suspense } from 'react'
import { Earth } from './Earth'

export function EarthLoader() {
  return (
    <Suspense fallback={null}>
      <Earth />
    </Suspense>
  )
}
