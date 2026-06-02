/**
 * Redux Slice — 加载状态
 * 管理加载秀场的三阶段进度
 */
import { createSlice, type PayloadAction } from '@reduxjs/toolkit'

export type LoadingPhase = 'particles' | 'texture' | 'activate' | 'done'

export interface LoadingState {
  phase: LoadingPhase
  texturesLoaded: boolean
  mediapipeReady: boolean
}

const initialState: LoadingState = {
  phase: 'particles',
  texturesLoaded: false,
  mediapipeReady: false,
}

const loadingSlice = createSlice({
  name: 'loading',
  initialState,
  reducers: {
    setLoadingPhase(state, action: PayloadAction<LoadingPhase>) {
      state.phase = action.payload
    },
    setTexturesLoaded(state, action: PayloadAction<boolean>) {
      state.texturesLoaded = action.payload
    },
    setMediapipeReady(state, action: PayloadAction<boolean>) {
      state.mediapipeReady = action.payload
    },
  },
})

export const {
  setLoadingPhase,
  setTexturesLoaded,
  setMediapipeReady,
} = loadingSlice.actions

export default loadingSlice.reducer
