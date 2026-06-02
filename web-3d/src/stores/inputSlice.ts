/**
 * Redux Slice — 输入模式状态
 * 管理鼠标/手势/空闲三模式的切换
 */
import { createSlice, type PayloadAction } from '@reduxjs/toolkit'

export type InputMode = 'mouse' | 'gesture' | 'idle'

export interface InputState {
  mode: InputMode
  lastInputTime: number
  handDetected: boolean
  palmPosition: [number, number] | null
  pinchDistance: number | null
  /** 上一次活跃的输入模式（用于空闲恢复） */
  lastActiveMode: Exclude<InputMode, 'idle'>
}

const initialState: InputState = {
  mode: 'idle',
  lastInputTime: 0,
  handDetected: false,
  palmPosition: null,
  pinchDistance: null,
  lastActiveMode: 'mouse',
}

const inputSlice = createSlice({
  name: 'input',
  initialState,
  reducers: {
    setInputMode(state, action: PayloadAction<InputMode>) {
      state.mode = action.payload
    },
    recordInput(state) {
      state.lastInputTime = Date.now()
    },
    setHandDetected(state, action: PayloadAction<boolean>) {
      state.handDetected = action.payload
    },
    setPalmPosition(
      state,
      action: PayloadAction<[number, number] | null>,
    ) {
      state.palmPosition = action.payload
    },
    setPinchDistance(state, action: PayloadAction<number | null>) {
      state.pinchDistance = action.payload
    },
    setLastActiveMode(state, action: PayloadAction<Exclude<InputMode, 'idle'>>) {
      state.lastActiveMode = action.payload
    },
  },
})

export const {
  setInputMode,
  recordInput,
  setHandDetected,
  setPalmPosition,
  setPinchDistance,
  setLastActiveMode,
} = inputSlice.actions

export default inputSlice.reducer
