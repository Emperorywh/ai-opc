/**
 * 地球纹理加载器
 * Suspense 边界确保纹理异步加载正常工作
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
