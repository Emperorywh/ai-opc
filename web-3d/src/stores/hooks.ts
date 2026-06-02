/**
 * 类型化的 Redux hooks
 * 在 useFrame 中需要读取 Redux 状态时，使用 store.getState() 直接读取，
 * 不使用 useSelector（避免 re-render）
 */
import { useDispatch, useSelector } from 'react-redux'
import type { RootState, AppDispatch } from './store'

export const useAppDispatch = useDispatch.withTypes<AppDispatch>()
export const useAppSelector = useSelector.withTypes<RootState>()
