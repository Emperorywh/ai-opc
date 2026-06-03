/**
 * 地球纹理加载器
 * Suspense 边界 + 纹理加载状态管理
 * 加载完成后渲染 Earth 组件
 *
 * 阶段 15：dispatch setTexturesLoaded(true) 通知 Redux 纹理已就绪
 */
import { Suspense, useEffect } from 'react'
import { Earth } from './Earth'
import { store } from '../../stores/store'
import { setTexturesLoaded } from '../../stores/loadingSlice'

/** 纹理加载成功后通知 Redux */
function EarthWithLoader() {
  useEffect(() => {
    store.dispatch(setTexturesLoaded(true))
  }, [])

  return <Earth />
}

export function EarthLoader() {
  return (
    <Suspense fallback={null}>
      <EarthWithLoader />
    </Suspense>
  )
}
