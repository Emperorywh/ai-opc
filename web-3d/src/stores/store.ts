/**
 * Redux Toolkit Store 配置
 * 仅注册 input + loading 两个低频 UI 状态 slice
 */
import { configureStore } from '@reduxjs/toolkit'
import inputReducer from './inputSlice'
import loadingReducer from './loadingSlice'

export const store = configureStore({
  reducer: {
    input: inputReducer,
    loading: loadingReducer,
  },
})

export type RootState = ReturnType<typeof store.getState>
export type AppDispatch = typeof store.dispatch
