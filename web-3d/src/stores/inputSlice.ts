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
}

const initialState: InputState = {
  mode: 'idle',
  lastInputTime: 0,
  handDetected: false,
  palmPosition: null,
  pinchDistance: null,
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
  },
})

export const {
  setInputMode,
  recordInput,
  setHandDetected,
  setPalmPosition,
  setPinchDistance,
} = inputSlice.actions

export default inputSlice.reducer
