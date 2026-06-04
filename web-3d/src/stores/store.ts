/**
 * Redux Toolkit Store 配置
 * 保留空 store 以维持架构一致性
 */
import { configureStore } from '@reduxjs/toolkit'

export const store = configureStore({
  reducer: {
    // loading 和 input slice 已删除
  },
})

export type RootState = ReturnType<typeof store.getState>
export type AppDispatch = typeof store.dispatch
